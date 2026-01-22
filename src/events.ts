// All events emitted by pushpak-mavlink

export type MavlinkEvent =
  // Connection & transport lifecycle
  | { type: "mavlink:connecting" }
  | { type: "mavlink:connected" }
  | { type: "mavlink:disconnected"; reason?: string }
  | { type: "mavlink:error"; error: Error | string }

  // Transport layer
  | { type: "mavlink:transport_opened"; transport: string }
  | { type: "mavlink:transport_closed"; transport: string }
  | { type: "mavlink:transport_error"; transport: string; error: Error | string }

  // Protocol-level facts
  | {
      type: "mavlink:heartbeat";
      sysid: number;
      compid: number;
      autopilot: number;
    }

  | {
      type: "mavlink:message";
      messageName: string;
      payload: unknown;
      sysid: number;
      compid: number;
    }

  | {
      type: "mavlink:message_sent";
      messageName: string;
      payload: unknown;
    }

  | {
      type: "mavlink:message_parse_error";
      raw: unknown;
      error: Error | string;
    };
