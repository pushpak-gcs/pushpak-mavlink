import { MavlinkService } from "./src/MavlinkService";
import { UdpTransport } from "./src/transports/UdpTransport";

const transport = new UdpTransport(14550);
const mavlink = new MavlinkService(transport);

mavlink.on("mavlink:connected", () => {
  console.log("MAVLink connected");
});

mavlink.connect();
