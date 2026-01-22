import dgram from "dgram";
import { Transport } from "./Transport";

export class UdpTransport implements Transport {
  private socket = dgram.createSocket("udp4");

  constructor(private port = 14550) {}

  open(): void {
    this.socket.bind(this.port);
  }

  close(): void {
    this.socket.close();
  }

//   TODO: left this part 
  send(_data: Buffer): void {
    // not needed yet
  }

  onData(cb: (data: Buffer) => void): void {
    this.socket.on("message", cb);
  }

  onError(cb: (err: Error) => void): void {
    this.socket.on("error", cb);
  }
}
