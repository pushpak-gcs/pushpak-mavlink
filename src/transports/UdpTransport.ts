import dgram from "dgram";
import { Transport } from "./Transport";

export class UdpTransport implements Transport {
  private socket = dgram.createSocket("udp4");
  private targetHost = "127.0.0.1";
  private targetPort = 14550;

  constructor(private port = 14551, targetHost?: string, targetPort?: number) {
    if (targetHost) this.targetHost = targetHost;
    if (targetPort) this.targetPort = targetPort;
  }

  open(): void {
    this.socket.bind(this.port);
    
    // When we receive the first message, update target from actual sender
    this.socket.once("message", (_msg, rinfo) => {
      this.targetHost = rinfo.address;
      this.targetPort = rinfo.port;
    });
  }

  close(): void {
    this.socket.close();
  }

  send(data: Buffer): void {
    this.socket.send(data, this.targetPort, this.targetHost, (err) => {
      if (err) {
        this.socket.emit("error", err);
      }
    });
  }

  onData(cb: (data: Buffer) => void): void {
    this.socket.on("message", cb);
  }

  onError(cb: (err: Error) => void): void {
    this.socket.on("error", cb);
  }
}
