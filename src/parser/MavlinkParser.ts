import { EventEmitter } from "events";
import { MavLinkPacketSplitter, MavLinkPacketParser, common, minimal } from "node-mavlink";

interface ParsedMessage {
  name: string;
  payload: any;
  sysid: number;
  compid: number;
  msgid: number;
}

export class MavlinkParser extends EventEmitter {
  private readonly splitter: MavLinkPacketSplitter;
  private readonly parser: MavLinkPacketParser;
  // Combined registry: minimal dialect (HEARTBEAT at ID 0) + common dialect
  private readonly registry: Record<number, any>;
  // Message ID to name mapping
  private readonly msgIdToName: Map<number, string> = new Map();

  constructor() {
    super();

    // HEARTBEAT (MSG_ID=0) lives in the minimal dialect, not common.
    // Merge both so ID 0 is recognised.
    this.registry = { ...minimal.REGISTRY, ...common.REGISTRY };

    // Build message ID → name lookup from the merged registry
    for (const [msgIdStr, MessageClass] of Object.entries(this.registry)) {
      const msgId = parseInt(msgIdStr, 10);
      this.msgIdToName.set(
        msgId,
        (MessageClass as any).MSG_NAME ||
        (MessageClass as any).name ||
        `MSG_${msgId}`
      );
    }

    this.splitter = new MavLinkPacketSplitter();
    this.parser = new MavLinkPacketParser();
    this.splitter.pipe(this.parser);

    // MavLinkPacketParser emits raw MavLinkPacket objects (header + payload Buffer)
    this.parser.on('data', (packet: any) => {
      const msgId: number = packet.header.msgid;
      const sysid: number = packet.header.sysid;
      const compid: number = packet.header.compid;
      const messageName = this.msgIdToName.get(msgId) || `MSG_${msgId}`;

      // Decode payload using the library's own protocol.data() method
      let decodedPayload: any = packet.payload;
      const MessageClass = this.registry[msgId];
      if (MessageClass) {
        try {
          decodedPayload = packet.protocol.data(packet.payload, MessageClass);
        } catch (_err) {
          // fallback to raw Buffer
        }
      }

      this.emitMessage({ name: messageName, payload: decodedPayload, sysid, compid, msgid: msgId });
    });



    // for errors
    this.parser.on('error', (err: Error) => {
      this.emit("parse_error", {
        raw: null,
        error: err
      });
    });
  }

  parse(data: Buffer): void {
    // Write data to splitter stream
    this.splitter.write(data);
  }



  private emitMessage(message: ParsedMessage): void {
    // Detect heartbeat by msgid (0) — more reliable than name matching
    if (message.msgid === 0 || message.name.toUpperCase() === "HEARTBEAT") {
      const p = message.payload;
      this.emit("heartbeat", {
        sysid: message.sysid,
        compid: message.compid,
        autopilot: p?.autopilot ?? 0,
        type: p?.type ?? 0,
        baseMode: p?.baseMode ?? 0,
        customMode: p?.customMode ?? 0,
        systemStatus: p?.systemStatus ?? 0
      });
    }

    // Emit generic message event
    this.emit("message", message);
  }
}
