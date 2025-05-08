import usb from 'usb'
import EventEmitter from 'events'
import { MessageHeader, HeaderBuildError } from './messages/common.js'
import { PhoneType } from './messages/readable.js'
import {
  SendableMessage,
  SendNumber,
  FileAddress,
  SendOpen,
  SendBoolean,
  SendString,
  SendBoxSettings,
  SendCommand,
  HeartBeat,
} from './messages/sendable.js'

const CONFIG_NUMBER = 1
const MAX_ERROR_COUNT = 5

export enum HandDriveType {
  LHD = 0,
  RHD = 1,
}

export type PhoneTypeConfig = {
  frameInterval: number | null
}

type PhoneTypeConfigMap = {
  [K in PhoneType]: PhoneTypeConfig
}

export type DongleConfig = {
  androidWorkMode?: boolean
  width: number
  height: number
  fps: number
  dpi: number
  format: number
  iBoxVersion: number
  packetMax: number
  phoneWorkMode: number
  nightMode: boolean
  boxName: string
  hand: HandDriveType
  mediaDelay: number
  audioTransferMode: boolean
  wifiType: '2.4ghz' | '5ghz'
  micType: 'box' | 'os'
  phoneConfig: Partial<PhoneTypeConfigMap>
}

export const DEFAULT_CONFIG: DongleConfig = {
  width: 800,
  height: 480,
  fps: 30,
  dpi: 140,
  format: 5,
  iBoxVersion: 2,
  phoneWorkMode: 2,
  packetMax: 49152,
  boxName: 'nodePlay',
  nightMode: true,
  hand: HandDriveType.LHD,
  mediaDelay: 300,
  audioTransferMode: false,
  wifiType: '5ghz',
  micType: 'os',
  phoneConfig: {
    [PhoneType.CarPlay]: { frameInterval: 5000 },
    [PhoneType.AndroidAuto]: { frameInterval: null },
  },
}

export class DriverStateError extends Error {}

export class DongleDriver extends EventEmitter {
  private _heartbeatInterval: ReturnType<typeof setInterval> | null = null
  private _device: usb.Device | null = null
  private _inEP: usb.Endpoint | null = null
  private _outEP: usb.Endpoint | null = null
  private errorCount = 0

  static knownDevices = [
    { vendorId: 0x1314, productId: 0x1520 },
    { vendorId: 0x1314, productId: 0x1521 },
  ]

  initialise = async (device: usb.Device) => {
    if (this._device) return
    try {
      this._device = device
      console.debug('initializing')
      if (!device.interfaces || device.interfaces.length === 0) {
        throw new DriverStateError('Illegal state - device not opened')
      }
      await new Promise<void>((resolve, reject) => {
        device.setConfiguration(CONFIG_NUMBER, err => {
          if (err) reject(err)
          else resolve()
        })
      })

      const iface = device.interfaces[0]
      const endpoints = iface.endpoints
      const inEndpoint = endpoints.find(e => e.direction === 'in')
      const outEndpoint = endpoints.find(e => e.direction === 'out')

      if (!inEndpoint) throw new DriverStateError('No IN endpoint found')
      if (!outEndpoint) throw new DriverStateError('No OUT endpoint found')

      this._inEP = inEndpoint
      this._outEP = outEndpoint

      console.debug('claiming interface', iface.interfaceNumber)
      iface.claim()
    } catch (err) {
      this.close()
      throw err
    }
  }

  send = async (message: SendableMessage): Promise<boolean | null> => {
    if (!this._device || !this._outEP) return null
    try {
      const payload = message.serialise()
      return await new Promise<boolean>(resolve => {
        ;(this._outEP as any).transfer(payload, (err: any) => {
          if (err) {
            console.error('TransferOut error', err)
            resolve(false)
          } else resolve(true)
        })
      })
    } catch (err) {
      console.error('Failure sending message', err)
      return false
    }
  }

  private readLoop = () => {
    if (!this._device || !this._inEP) return
    const loop = async () => {
      if (this.errorCount >= MAX_ERROR_COUNT) {
        this.close()
        this.emit('failure')
        return
      }
      try {
        const headerBuf: Buffer = await new Promise((resolve, reject) => {
          ;(this._inEP as any).transfer(MessageHeader.dataLength, (err: any, data: Buffer) => {
            if (err) reject(err)
            else resolve(data)
          })
        })
        if (!headerBuf) throw new HeaderBuildError('Failed to read header')
        const header = MessageHeader.fromBuffer(Buffer.from(headerBuf))
        let extra: Buffer | undefined
        if (header.length) {
          const extraBuf: Buffer = await new Promise((resolve, reject) => {
            ;(this._inEP as any).transfer(header.length, (err: any, data: Buffer) => {
              if (err) reject(err)
              else resolve(data)
            })
          })
          if (!extraBuf) throw new HeaderBuildError('Failed to read extra data')
          extra = Buffer.from(extraBuf)
        }
        const message = header.toMessage(extra)
        if (message) this.emit('message', message)
      } catch (error) {
        console.error('ReadLoop error', error)
        this.errorCount++
      }
      setImmediate(loop)
    }
    setImmediate(loop)
  }

  start = async (config: DongleConfig) => {
    if (!this._device) throw new DriverStateError('Call initialise first')
    this.errorCount = 0
    const initMsgs = [
      new SendNumber(config.dpi, FileAddress.DPI),
      new SendOpen(config),
      new SendBoolean(config.nightMode, FileAddress.NIGHT_MODE),
      new SendNumber(config.hand, FileAddress.HAND_DRIVE_MODE),
      new SendBoolean(true, FileAddress.CHARGE_MODE),
      new SendString(config.boxName, FileAddress.BOX_NAME),
      new SendBoxSettings(config),
      new SendCommand('wifiEnable'),
      new SendCommand(config.wifiType === '5ghz' ? 'wifi5g' : 'wifi24g'),
      new SendCommand(config.micType === 'box' ? 'boxMic' : 'mic'),
      new SendCommand(config.audioTransferMode ? 'audioTransferOn' : 'audioTransferOff'),
    ]
    if (config.androidWorkMode) {
      initMsgs.push(new SendBoolean(config.androidWorkMode, FileAddress.ANDROID_WORK_MODE))
    }
    await Promise.all(initMsgs.map(msg => this.send(msg)))
    setTimeout(() => this.send(new SendCommand('wifiConnect')), 1000)
    this.readLoop()
    this._heartbeatInterval = setInterval(() => this.send(new HeartBeat()), 2000)
  }

  close = async () => {
    if (this._heartbeatInterval) clearInterval(this._heartbeatInterval)
    if (this._device) {
      this._inEP = null
      this._outEP = null
      try { this._device.close() } catch {}
      this._device = null
    }
  }
}
