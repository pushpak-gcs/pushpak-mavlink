import { EventEmitter } from "events";
import { MavlinkEvent } from "./events";
import { Transport } from "./transports/Transport";
import { MavlinkParser } from "./parser/MavlinkParser";
import { common, minimal, MavLinkProtocolV2 } from "node-mavlink";

export class MavlinkService extends EventEmitter {
  private connected = false;
  private readonly transport: Transport;
  private readonly parser: MavlinkParser;
  private readonly protocol: MavLinkProtocolV2;
  private sequence = 0;
  private systemId = 255; // GCS system ID
  private componentId = 190; // GCS component ID
  
  // Vehicle presence tracking
  private vehiclePresent = false;
  private vehicleSystemId?: number;
  private lastHeartbeatTime = 0;
  private heartbeatTimeout?: NodeJS.Timeout;
  private readonly heartbeatTimeoutMs = 3000;

  constructor(transport: Transport, systemId = 255, componentId = 190) {
    super();
    this.transport = transport;
    this.parser = new MavlinkParser();
    this.systemId = systemId;
    this.componentId = componentId;
    this.protocol = new MavLinkProtocolV2();

    // Listen to parser events
    this.parser.on("heartbeat", hb => {
      this.handleHeartbeat(hb);
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

    this.stopHeartbeatMonitoring();
    this.transport.close();
    this.connected = false;
    this.vehiclePresent = false;
    this.vehicleSystemId = undefined;

    this.emitEvent({ type: "mavlink:disconnected", reason });
  }

  /**
   * Send a MAVLink message
   * @param messageName - Name of the message (e.g., "Heartbeat", "CommandLong")
   * @param payload - Message payload object
   * @param targetSystem - Target system ID (optional)
   * @param targetComponent - Target component ID (optional)
   */
  sendMessage(
    messageName: string,
    payload: any,
    targetSystem?: number,
    targetComponent?: number
  ): void {
    if (!this.connected) {
      throw new Error("Cannot send message: not connected");
    }

    try {
      // Look up message class in minimal first (HEARTBEAT lives there), then common
      const MessageClass = (minimal as any)[messageName] ?? (common as any)[messageName];
      if (!MessageClass) {
        throw new Error(`Unknown message type: ${messageName}`);
      }

      // Build payload, adding target system/component if provided
      const fullPayload = { ...payload };
      if (targetSystem !== undefined) fullPayload.targetSystem = targetSystem;
      if (targetComponent !== undefined) fullPayload.targetComponent = targetComponent;

      // Create message instance and assign all payload fields
      const message = new MessageClass();
      Object.assign(message, fullPayload);

      // Serialize using protocol
      const buffer = this.protocol.serialize(message, this.sequence);

      this.transport.send(buffer);
      
      this.sequence = (this.sequence + 1) % 256;

      this.emitEvent({
        type: "mavlink:message_sent",
        messageName,
        payload: fullPayload
      });
    } catch (err) {
      this.emitEvent({
        type: "mavlink:error",
        error: err instanceof Error ? err : String(err)
      });
      throw err;
    }
  }

  /**
   * Send HEARTBEAT message
   */
  sendHeartbeat(): void {
    this.sendMessage("Heartbeat", {
      type: 6, // MAV_TYPE_GCS
      autopilot: 0, // MAV_AUTOPILOT_GENERIC
      baseMode: 0,
      customMode: 0,
      systemStatus: 4, // MAV_STATE_ACTIVE
      mavlinkVersion: 3
    });
  }

  /**
   * Request data stream
   * @param streamId - Stream ID (e.g., MAV_DATA_STREAM_ALL = 0)
   * @param rate - Rate in Hz
   * @param targetSystem - Target system ID
   */
  requestDataStream(streamId: number, rate: number, targetSystem = 1): void {
    this.sendMessage(
      "RequestDataStream",
      {
        reqStreamId: streamId,
        reqMessageRate: rate,
        startStop: rate > 0 ? 1 : 0
      },
      targetSystem,
      0
    );
  }

  /**
   * Arm/disarm the vehicle
   * @param arm - true to arm, false to disarm
   * @param targetSystem - Target system ID
   */
  armDisarm(arm: boolean, targetSystem = 1): void {
    this.sendMessage(
      "CommandLong",
      {
        command: 400, // MAV_CMD_COMPONENT_ARM_DISARM
        confirmation: 0,
        param1: arm ? 1 : 0,
        param2: 0,
        param3: 0,
        param4: 0,
        param5: 0,
        param6: 0,
        param7: 0
      },
      targetSystem,
      0
    );
  }

  /**
   * Set flight mode
   * @param baseMode - Base mode flags
   * @param customMode - Custom mode (vehicle-specific)
   * @param targetSystem - Target system ID
   */
  setMode(baseMode: number, customMode: number, targetSystem = 1): void {
    this.sendMessage(
      "SetMode",
      {
        baseMode,
        customMode
      },
      targetSystem,
      0
    );
  }

  getSystemId(): number {
    return this.systemId;
  }

  getComponentId(): number {
    return this.componentId;
  }

  isVehiclePresent(): boolean {
    return this.vehiclePresent;
  }

  getVehicleSystemId(): number | undefined {
    return this.vehicleSystemId;
  }

  private handleHeartbeat(hb: { sysid: number; compid: number; autopilot: number }): void {
    const now = Date.now();
    const wasPresent = this.vehiclePresent;

    // Update state
    this.lastHeartbeatTime = now;
    this.vehicleSystemId = hb.sysid;

    if (!wasPresent) {
      // Vehicle found
      this.vehiclePresent = true;
      this.emitEvent({
        type: "mavlink:vehicle_found",
        sysid: hb.sysid
      });
    }

    // Reset timeout
    this.resetHeartbeatTimeout();
  }

  private resetHeartbeatTimeout(): void {
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout);
    }

    this.heartbeatTimeout = setTimeout(() => {
      if (this.vehiclePresent) {
        this.vehiclePresent = false;
        this.emitEvent({
          type: "mavlink:vehicle_lost",
          sysid: this.vehicleSystemId!,
          lastSeen: this.lastHeartbeatTime
        });
      }
    }, this.heartbeatTimeoutMs);
  }

  private stopHeartbeatMonitoring(): void {
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = undefined;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  private emitEvent(event: MavlinkEvent): void {
    this.emit(event.type, event);
  }
}
