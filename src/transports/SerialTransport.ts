import { SerialPort } from "serialport";
import { Transport } from "./Transport.js";

export interface SerialTransportOptions {
  /** Serial port path */
  path: string;
  /** Baud rate */
  baudRate?: number;
}

export class SerialTransport implements Transport {
  private port?: SerialPort;
  private dataCallback?: (data: Buffer) => void;
  private errorCallback?: (err: Error) => void;
  private readonly options: Required<SerialTransportOptions>;

  constructor(options: SerialTransportOptions) {
    this.options = {
      path: options.path,
      baudRate: options.baudRate ?? 57600
    };
  }

  open(): void {
    this.port = new SerialPort({
      path: this.options.path,
      baudRate: this.options.baudRate,
      autoOpen: false
    });

    this.port.on("data", (data: Buffer) => {
      if (this.dataCallback) {
        this.dataCallback(data);
      }
    });

    this.port.on("error", (err: Error) => {
      if (this.errorCallback) {
        this.errorCallback(err);
      }
    });

    this.port.on("close", () => {
      if (this.errorCallback) {
        this.errorCallback(new Error("Serial port closed"));
      }
    });

    this.port.open((err) => {
      if (err && this.errorCallback) {
        this.errorCallback(err);
      }
    });
  }

  close(): void {
    if (this.port && this.port.isOpen) {
      this.port.close((err) => {
        if (err && this.errorCallback) {
          this.errorCallback(err);
        }
      });
    }
    this.port = undefined;
  }

  send(data: Buffer): void {
    if (!this.port || !this.port.isOpen) {
      throw new Error("Serial port not open");
    }

    this.port.write(data, (err) => {
      if (err && this.errorCallback) {
        this.errorCallback(err);
      }
    });
  }

  onData(cb: (data: Buffer) => void): void {
    this.dataCallback = cb;
  }

  onError(cb: (err: Error) => void): void {
    this.errorCallback = cb;
  }

  /**
   * List available serial ports
   * @returns Promise<Array<{path: string, manufacturer?: string}>>
   */
  static async listPorts(): Promise<Array<{ path: string; manufacturer?: string; serialNumber?: string }>> {
    return SerialPort.list();
  }
}
