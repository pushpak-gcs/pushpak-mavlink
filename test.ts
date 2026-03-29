import { MavlinkService } from "./src/MavlinkService";
import { UdpTransport } from "./src/transports/UdpTransport";
import { CopterMode } from "./src/modes";

// SITL typically broadcasts on port 14550
// We listen on 14550 and send back to 14550
const transport = new UdpTransport(14550, "127.0.0.1", 14550);
const mavlink = new MavlinkService(transport);

// Track vehicle state
let vehicleConnected = false;
let vehicleSystemId = 0;

// Connection events
mavlink.on("mavlink:connecting", () => {
  console.log("🔄 Connecting to MAVLink...");
});

mavlink.on("mavlink:connected", () => {
  console.log("✅ MAVLink transport opened");
  console.log("📡 Listening for SITL on UDP port 14550");
  console.log("⏳ Waiting for HEARTBEAT from vehicle...\n");
});

mavlink.on("mavlink:disconnected", (event: any) => {
  console.log("❌ MAVLink disconnected:", event.reason || "unknown");
});
mavlink.on("mavlink:vehicle_found", (event: any) => {
  console.log(`✅ Vehicle found (sysid=${event.sysid})`);
});

mavlink.on("mavlink:vehicle_lost", (event: any) => {
  const secondsAgo = ((Date.now() - event.lastSeen) / 1000).toFixed(1);
  console.log(`⚠️  Vehicle lost (sysid=${event.sysid}, last seen ${secondsAgo}s ago)`);
});
mavlink.on("mavlink:error", (event: any) => {
  console.error("⚠️  MAVLink error:", event.error);
});

// Heartbeat handling
mavlink.on("mavlink:heartbeat", (event: any) => {
  if (!vehicleConnected) {
    vehicleConnected = true;
    vehicleSystemId = event.sysid;
    console.log("🚁 Vehicle HEARTBEAT received!");
    console.log(`   System ID: ${event.sysid}`);
    console.log(`   Component ID: ${event.compid}`);
    console.log(`   Autopilot: ${event.autopilot}\n`);

    // Start sending GCS heartbeat
    console.log("💓 Starting GCS heartbeat...\n");
    setInterval(() => {
      mavlink.sendHeartbeat();
    }, 1000);

    // Request data streams
    console.log("📊 Requesting data streams...\n");
    mavlink.requestDataStream(0, 4, vehicleSystemId); // All streams at 4 Hz
  }
});

// Message handling
const messageCounts: Record<string, number> = {};
let lastPrintTime = Date.now();

mavlink.on("mavlink:message", (event: any) => {
  // Count messages
  messageCounts[event.messageName] = (messageCounts[event.messageName] || 0) + 1;

  // Print interesting messages
  switch (event.messageName) {
    case "ATTITUDE":
      // Print attitude occasionally
      if (Date.now() - lastPrintTime > 2000) {
        console.log(`✈️  Attitude: roll=${(event.payload.roll * 57.2958).toFixed(1)}° pitch=${(event.payload.pitch * 57.2958).toFixed(1)}° yaw=${(event.payload.yaw * 57.2958).toFixed(1)}°`);
      }
      break;

    case "GLOBAL_POSITION_INT":
      if (Date.now() - lastPrintTime > 2000) {
        const lat = event.payload.lat / 1e7;
        const lon = event.payload.lon / 1e7;
        const alt = event.payload.alt / 1000;
        console.log(`📍 Position: ${lat.toFixed(6)}°, ${lon.toFixed(6)}° @ ${alt.toFixed(1)}m`);
      }
      break;

    case "SYS_STATUS":
      if (Date.now() - lastPrintTime > 2000) {
        console.log(`🔋 Battery: ${(event.payload.voltageBattery / 1000).toFixed(2)}V, ${event.payload.batteryRemaining}%`);
      }
      break;

    case "VFR_HUD":
      if (Date.now() - lastPrintTime > 2000) {
        console.log(`📊 Speed: ${event.payload.groundspeed.toFixed(1)} m/s, Alt: ${event.payload.alt.toFixed(1)} m, Heading: ${event.payload.heading}°`);
        lastPrintTime = Date.now();
      }
      break;

    case "STATUSTEXT":
      console.log(`📝 Status: [${event.payload.severity}] ${event.payload.text}`);
      break;

    case "COMMAND_ACK":
      const cmdNames: Record<number, string> = {
        400: "ARM_DISARM",
        176: "DO_SET_MODE",
        20: "NAV_RETURN_TO_LAUNCH",
        22: "NAV_TAKEOFF",
      };
      const cmdName = cmdNames[event.payload.command] || `CMD_${event.payload.command}`;
      const result = event.payload.result === 0 ? "✅ SUCCESS" : `❌ FAILED (${event.payload.result})`;
      console.log(`🎯 Command ${cmdName}: ${result}`);
      break;
  }
});

// Print statistics every 10 seconds
setInterval(() => {
  console.log("\n📊 Message Statistics:");
  const sorted = Object.entries(messageCounts).sort((a, b) => b[1] - a[1]);
  sorted.slice(0, 10).forEach(([name, count]) => {
    console.log(`   ${name}: ${count}`);
  });
  console.log("");
}, 10000);

// Connect
mavlink.connect();

// Example commands (uncomment to test)
// After 5 seconds, try arming
setTimeout(() => {
  if (vehicleConnected) {
    console.log("\n🔧 Attempting to ARM vehicle...");
    mavlink.armDisarm(true, vehicleSystemId);
  }
}, 5000);
// After 10 seconds, switch to GUIDED mode
setTimeout(() => {
  if (vehicleConnected) {
    console.log("\n🎮 Switching to GUIDED mode...");
    mavlink.setFlightMode(CopterMode.GUIDED, vehicleSystemId);
  }
}, 10000);

// After 15 seconds, takeoff to 10m
setTimeout(() => {
  if (vehicleConnected) {
    console.log("\n🚁 Taking off to 10m (GUIDED mode)...");
    mavlink.guidedTakeoff(10, vehicleSystemId);
  }
}, 15000);
// Cleanup on exit
process.on("SIGINT", () => {
  console.log("\n\n👋 Shutting down...");
  mavlink.disconnect("User interrupt");
  process.exit(0);
});
