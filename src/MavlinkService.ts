import { EventEmitter } from "events";
import { MavlinkEvent } from "./events";
import { Transport } from "./transports/Transport";
import { MavlinkParser } from "./parser/MavlinkParser";

export class MavlinkService extends EventEmitter {
  private connected = false;
  private readonly transport: Transport;
  private readonly parser: MavlinkParser;

  constructor(transport: Transport) {
    super();
    this.transport = transport;
    this.parser = new MavlinkParser();

    // Listen to parser events
    this.parser.on("heartbeat", hb => {
      this.emitEvent({
        type: "mavlink:heartbeat",
        sysid: hb.sysid,
        compid: hb.compid,
        autopilot: hb.autopilot
      });
    });

    this.parser.on("message", msg => {
      this.emitEvent({
        type: "mavlink:message",
        messageName: msg.name,
        payload: msg.payload,
        sysid: msg.sysid,
        compid: msg.compid
      });
    });

    this.parser.on("parse_error", err => {
      this.emitEvent({
        type: "mavlink:message_parse_error",
        raw: err.raw,
        error: err.error
      });
    });
  }

  connect(): void {
    if (this.connected) return;

    this.emitEvent({ type: "mavlink:connecting" });

    this.transport.onData(data => {
      // console.log("[DEBUG] RX bytes:", data.length);
      this.parser.parse(data);
    });

    this.transport.onError(err => {
      this.emitEvent({ type: "mavlink:error", error: err });
    });

    this.transport.open();
    this.connected = true;

    this.emitEvent({ type: "mavlink:connected" });
  }

  disconnect(reason?: string): void {
    if (!this.connected) return;

    this.transport.close();
    this.connected = false;

    this.emitEvent({ type: "mavlink:disconnected", reason });
  }

  private emitEvent(event: MavlinkEvent): void {
    this.emit(event.type, event);
  }
}
