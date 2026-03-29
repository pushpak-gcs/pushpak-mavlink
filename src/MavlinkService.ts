import { EventEmitter } from "events";
import { MavlinkEvent } from "./events.js";
import { Transport } from "./transports/Transport.js";
import { MavlinkParser } from "./parser/MavlinkParser.js";
import { common, minimal, MavLinkProtocolV2 } from "node-mavlink";
import { CopterMode, PlaneMode, RoverMode, MavCmd } from "./modes.js";

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
  
  // Command acknowledgment tracking
  private commandCallbacks = new Map<number, { resolve: (result: any) => void, reject: (error: Error) => void, timeout: NodeJS.Timeout }>();
  private commandSequence = 0;

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
      // Handle COMMAND_ACK specially
      if (msg.name === "COMMAND_ACK") {
        this.handleCommandAck(msg.payload);
      }
      
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
   * @param force - Force arming (bypass pre-arm checks) - default true
   * @returns Promise that resolves with COMMAND_ACK result
   */
  armDisarm(arm: boolean, targetSystem = 1, force = true): Promise<any> {
    console.log(`[MavlinkService] Sending ARM command: arm=${arm}, force=${force}, targetSystem=${targetSystem}`);
    console.log(`[MavlinkService] ARM parameters: param1=${arm ? 1 : 0}, param2=${force ? 21196 : 0}`);
    
    // For ARM commands, we don't use confirmation field for tracking
    // Instead we'll just wait for any COMMAND_ACK with command=400
    const promise = new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`ARM/DISARM command timeout (no COMMAND_ACK received)`));
      }, 5000);
      
      // Store with command ID 400 (MAV_CMD_COMPONENT_ARM_DISARM)
      this.commandCallbacks.set(400, { resolve, reject, timeout });
    });
    
    this.sendMessage(
      "CommandLong",
      {
        command: 400, // MAV_CMD_COMPONENT_ARM_DISARM
        confirmation: 0,  // Always 0 for ARM command
        param1: arm ? 1.0 : 0.0,  // 1.0 = arm, 0.0 = disarm
        param2: force ? 21196.0 : 0.0, // Magic number to force arm and bypass checks
        param3: 0,
        param4: 0,
        param5: 0,
        param6: 0,
        param7: 0
      },
      targetSystem,
      0
    );
    
    return promise;
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

  // ==================== Typed Command Helpers ====================

  /**
   * Set ArduPilot flight mode (Copter/Plane/Rover)
   * @param mode - Flight mode enum value
   * @param targetSystem - Target system ID
   */
  setFlightMode(mode: CopterMode | PlaneMode | RoverMode, targetSystem = 1): void {
    // MAV_MODE_FLAG_CUSTOM_MODE_ENABLED = 1
    this.setMode(1, mode, targetSystem);
  }

  /**
   * Takeoff to specified altitude (for AUTO/mission mode)
   * Note: For GUIDED mode copter, use guidedTakeoff() instead
   * @param altitude - Target altitude in meters (AGL)
   * @param options - Optional lat/lon coordinates and target system
   */
  takeoff(altitude: number, options?: { lat?: number; lon?: number; targetSystem?: number }): void {
    const targetSystem = options?.targetSystem ?? 1;
    this.sendMessage(
      "CommandLong",
      {
        command: MavCmd.NAV_TAKEOFF,
        confirmation: 0,
        param1: 0, // pitch
        param2: 0,
        param3: 0,
        param4: NaN, // yaw
        param5: options?.lat ?? NaN,
        param6: options?.lon ?? NaN,
        param7: altitude
      },
      targetSystem,
      0
    );
  }

  /**
   * Takeoff in GUIDED mode (ArduCopter)
   * Sends altitude target repeatedly for smooth takeoff
   * @param altitude - Target altitude in meters (relative to home)
   * @param durationMs - How long to send the command (default: 15000ms)
   * @param targetSystem - Target system ID
   * @returns Interval ID that can be cleared to stop sending
   */
  guidedTakeoff(altitude: number, durationMs = 15000, targetSystem = 1): NodeJS.Timeout {
    // Send position setpoint repeatedly at 10Hz
    const interval = setInterval(() => {
      this.sendMessage(
        "SetPositionTargetLocalNed",
        {
          timeBootMs: 0,
          coordinateFrame: 1, // MAV_FRAME_LOCAL_NED
          typeMask: 0x0FFB, // Ignore everything except Z position
          x: 0,
          y: 0,
          z: -altitude, // NED: negative = up
          vx: 0,
          vy: 0,
          vz: 0,
          afx: 0,
          afy: 0,
          afz: 0,
          yaw: 0,
          yawRate: 0
        },
        targetSystem,
        0
      );
    }, 100); // 10Hz

    // Auto-stop after duration
    setTimeout(() => {
      clearInterval(interval);
    }, durationMs);

    return interval;
  }

  /**
   * Land at current position or specified coordinates
   * @param options - Optional lat/lon coordinates and target system
   */
  land(options?: { lat?: number; lon?: number; targetSystem?: number }): void {
    const targetSystem = options?.targetSystem ?? 1;
    this.sendMessage(
      "CommandLong",
      {
        command: MavCmd.NAV_LAND,
        confirmation: 0,
        param1: 0, // abort altitude
        param2: 0, // land mode
        param3: 0,
        param4: NaN, // yaw
        param5: options?.lat ?? NaN,
        param6: options?.lon ?? NaN,
        param7: 0 // altitude
      },
      targetSystem,
      0
    );
  }

  /**
   * Return to launch (home position)
   * @param targetSystem - Target system ID
   */
  returnToLaunch(targetSystem = 1): void {
    this.sendMessage(
      "CommandLong",
      {
        command: MavCmd.NAV_RETURN_TO_LAUNCH,
        confirmation: 0,
        param1: 0,
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
   * Fly to specified GPS coordinates at given altitude
   * @param lat - Latitude in degrees
   * @param lon - Longitude in degrees
   * @param altitude - Altitude in meters (MSL)
   * @param targetSystem - Target system ID
   */
  goto(lat: number, lon: number, altitude: number, targetSystem = 1): void {
    this.sendMessage(
      "CommandLong",
      {
        command: MavCmd.NAV_WAYPOINT,
        confirmation: 0,
        param1: 0, // hold time
        param2: 0, // acceptance radius
        param3: 0, // pass radius
        param4: NaN, // yaw
        param5: lat,
        param6: lon,
        param7: altitude
      },
      targetSystem,
      0
    );
  }

  /**
   * Request a specific MAVLink message
   * @param messageId - MAVLink message ID to request
   * @param targetSystem - Target system ID
   */
  requestMessage(messageId: number, targetSystem = 1): void {
    this.sendMessage(
      "CommandLong",
      {
        command: MavCmd.REQUEST_MESSAGE,
        confirmation: 0,
        param1: messageId,
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
   * Set message streaming interval
   * @param messageId - MAVLink message ID
   * @param intervalUs - Interval in microseconds (0 to disable)
   * @param targetSystem - Target system ID
   */
  setMessageInterval(messageId: number, intervalUs: number, targetSystem = 1): void {
    this.sendMessage(
      "CommandLong",
      {
        command: MavCmd.SET_MESSAGE_INTERVAL,
        confirmation: 0,
        param1: messageId,
        param2: intervalUs,
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
   * Change vehicle speed
   * @param speedType - 0=Airspeed, 1=Ground speed
   * @param speed - Speed in m/s (-1 to ignore)
   * @param throttle - Throttle percentage (-1 to ignore)
   * @param targetSystem - Target system ID
   */
  changeSpeed(speedType: number, speed: number, throttle = -1, targetSystem = 1): void {
    this.sendMessage(
      "CommandLong",
      {
        command: MavCmd.DO_CHANGE_SPEED,
        confirmation: 0,
        param1: speedType,
        param2: speed,
        param3: throttle,
        param4: 0,
        param5: 0,
        param6: 0,
        param7: 0
      },
      targetSystem,
      0
    );
  }

  // ==================== End Typed Command Helpers ====================

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
  
  private handleCommandAck(ack: any): void {
    console.log(`[MavlinkService] COMMAND_ACK received - command: ${ack.command}, result: ${ack.result}, progress: ${ack.progress}`);
    
    // Try to match by command ID (for ARM/DISARM and other commands)
    const callback = this.commandCallbacks.get(ack.command);
    
    if (callback) {
      clearTimeout(callback.timeout);
      this.commandCallbacks.delete(ack.command);
      
      // MAV_RESULT: 0=ACCEPTED, 1=TEMPORARILY_REJECTED, 2=DENIED, 3=UNSUPPORTED, 4=FAILED, 5=IN_PROGRESS
      const resultNames = ['ACCEPTED', 'TEMPORARILY_REJECTED', 'DENIED', 'UNSUPPORTED', 'FAILED', 'IN_PROGRESS', 'CANCELLED'];
      const resultName = resultNames[ack.result] || `UNKNOWN(${ack.result})`;
      
      console.log(`[MavlinkService] Command ${ack.command} result: ${resultName}`);
      
      if (ack.result === 0) {
        callback.resolve(ack);
      } else {
        callback.reject(new Error(`Command failed: ${resultName}`));
      }
    } else {
      console.log(`[MavlinkService] No callback found for command ${ack.command}`);
    }
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
