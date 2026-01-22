import { EventEmitter } from "events";

export class MavlinkParser extends EventEmitter {
  parse(buffer: Buffer) {
    // TEMP: we will improve this
    // For now, just detecting heartbeat by message id
    for (const byte of buffer) {
      // placeholder
    }
  }
}
