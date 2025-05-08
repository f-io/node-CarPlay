import usb from 'usb'
import {
  Message,
  Plugged,
  Unplugged,
  VideoData,
  AudioData,
  MediaData,
  SendCommand,
  Command,
  DongleDriver,
  DongleConfig,
  DEFAULT_CONFIG,
} from '../modules/index.js'

export type CarplayMessage =
  | { type: 'plugged'; message?: undefined }
  | { type: 'unplugged'; message?: undefined }
  | { type: 'failure'; message?: undefined }
  | { type: 'audio'; message: AudioData }
  | { type: 'video'; message: VideoData }
  | { type: 'media'; message: MediaData }
  | { type: 'command'; message: Command }

const USB_WAIT_PERIOD_MS = 1000

export const isCarplayDongle = (device: usb.Device): boolean => {
  const { idVendor, idProduct } = device.deviceDescriptor
  return DongleDriver.knownDevices.some(
    kd => kd.vendorId === idVendor && kd.productId === idProduct
  )
}

export const findDevice = async (): Promise<usb.Device> => {
  while (true) {
    const devices = usb.getDeviceList()
    const found = devices.find(isCarplayDongle)
    if (found) return found
    await new Promise(res => setTimeout(res, USB_WAIT_PERIOD_MS))
  }
}

// alias for consistency with previous API
export const requestDevice = findDevice

export default class CarplayWeb {
  private _started = false
  private _pairTimeout: NodeJS.Timeout | null = null
  private _frameInterval: NodeJS.Timeout | null = null
  private _config: DongleConfig
  public dongleDriver: DongleDriver

  constructor(config: Partial<DongleConfig>) {
    this._config = Object.assign({}, DEFAULT_CONFIG, config)
    const driver = new DongleDriver()
    driver.on('message', (message: Message) => this.handleMessage(message))
    driver.on('failure', () => this.onmessage?.({ type: 'failure' }))
    this.dongleDriver = driver
  }

  private handleMessage(message: Message) {
    this.clearPairTimeout()
    switch (true) {
      case message instanceof Plugged: {
        const phoneCfg = this._config.phoneConfig[message.phoneType]
        if (phoneCfg?.frameInterval) {
          this._frameInterval = setInterval(
            () => this.dongleDriver.send(new SendCommand('frame')),
            phoneCfg.frameInterval
          )
        }
        this.onmessage?.({ type: 'plugged' })
        break
      }
      case message instanceof Unplugged:
        this.onmessage?.({ type: 'unplugged' })
        break
      case message instanceof VideoData:
        this.onmessage?.({ type: 'video', message })
        break
      case message instanceof AudioData:
        this.onmessage?.({ type: 'audio', message })
        break
      case message instanceof MediaData:
        this.onmessage?.({ type: 'media', message })
        break
      case message instanceof Command:
        this.onmessage?.({ type: 'command', message })
        break
    }
  }

  private clearPairTimeout() {
    if (this._pairTimeout) {
      clearTimeout(this._pairTimeout)
      this._pairTimeout = null
    }
  }

  private clearFrameInterval() {
    if (this._frameInterval) {
      clearInterval(this._frameInterval)
      this._frameInterval = null
    }
  }

  public onmessage: ((ev: CarplayMessage) => void) | null = null

  public start = async () => {
    if (this._started) return
    const device = await findDevice()
    console.debug('opening device')
    device.open()
    await new Promise<void>(res => device.reset(err => res()))
    await this.dongleDriver.initialise(device)
    await this.dongleDriver.start(this._config)
    this._pairTimeout = setTimeout(
      () => this.dongleDriver.send(new SendCommand('wifiPair')),
      15000
    )
    this._started = true
  }

  public stop = async () => {
    try {
      this.clearFrameInterval()
      this.clearPairTimeout()
      await this.dongleDriver.close()
    } catch (err) {
      console.error(err)
    } finally {
      this._started = false
    }
  }
}
