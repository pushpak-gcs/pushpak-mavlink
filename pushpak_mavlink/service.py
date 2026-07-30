import asyncio
import time
import logging
from pymavlink import mavutil
from .models import VehicleState, TelemetryState, Attitude, Position, Velocity, Battery, GPS

logger = logging.getLogger(__name__)

# ArduCopter modes I got from Docs 
COPTER_MODES = {
    0: 'STABILIZE', 1: 'ACRO', 2: 'ALT_HOLD', 3: 'AUTO',
    4: 'GUIDED', 5: 'LOITER', 6: 'RTL', 7: 'CIRCLE',
    9: 'LAND', 11: 'DRIFT', 13: 'SPORT', 15: 'AUTOTUNE',
    16: 'POSHOLD', 17: 'BRAKE', 20: 'GUIDED_NOGPS', 21: 'SMART_RTL'
}
COPTER_MODE_NAMES = {v: k for k, v in COPTER_MODES.items()}

class MavlinkService:
    def __init__(self, connection_string: str = "udp:127.0.0.1:14550", callback=None):
        self.connection_string = connection_string
        self.master = None
        self.running = False
        
        self.vehicle_state = VehicleState()
        self.telemetry_state = TelemetryState()
        
        self.uploading_mission = False
        self.uploading_mission_waypoints = []
        
        self.callback = callback

    def connect(self, baudrate=115200):
        logger.info(f"Connecting to MAVLink on {self.connection_string} at {baudrate} baud")
        try:
            self.master = mavutil.mavlink_connection(self.connection_string, baud=baudrate)
            self.master.wait_heartbeat(timeout=10)
            if self.master.target_system:
                logger.info(f"Connected to system {self.master.target_system}")
                self.vehicle_state.connected = True
                self.vehicle_state.systemId = self.master.target_system
                self.vehicle_state.componentId = self.master.target_component
                self._emit('mavlink:vehicle-found', self.master.target_system)
                
                # Request data streams
                self.master.mav.request_data_stream_send(
                    self.master.target_system, self.master.target_component,
                    mavutil.mavlink.MAV_DATA_STREAM_ALL, 4, 1
                )
            else:
                logger.warning("Timeout waiting for heartbeat.")
        except Exception as e:
            logger.error(f"Error connecting: {e}")

    def stop(self):
        self.running = False
        if self.master:
            self.master.close()
            self.master = None
            self.vehicle_state.connected = False
            self._emit('mavlink:disconnected', "stop called")
            self._emit('mavlink:state', self.vehicle_state.__dict__)

    async def start_listening(self):
        self.running = True
        while self.running:
            if not self.master:
                await asyncio.sleep(1)
                continue

            try:
                msg = self.master.recv_match(blocking=False)
                if msg and msg.get_type() != 'BAD_DATA':
                    self._handle_message(msg)
                else:
                    await asyncio.sleep(0.01)
            except Exception as e:
                logger.error(f"Error reading message: {e}")
                await asyncio.sleep(1)

    def _emit(self, event_type: str, data):
        if self.callback:
            self.callback(event_type, data)

    def _handle_message(self, msg):
        msg_type = msg.get_type()
        msg_dict = msg.to_dict()
        sysid = msg.get_srcSystem()

        # Handle heartbeat specifically
        if msg_type == 'HEARTBEAT':
            if sysid >= 254:
                return # Ignore GCS heartbeats
            
            self.vehicle_state.lastHeartbeat = time.time()
            is_armed = bool(msg_dict.get('base_mode', 0) & mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED)
            self.vehicle_state.armed = is_armed
            
            custom_mode = msg_dict.get('custom_mode', 0)
            self.vehicle_state.modeNumber = custom_mode
            self.vehicle_state.mode = COPTER_MODES.get(custom_mode, f"MODE_{custom_mode}")
            
            self._emit('mavlink:state', self.vehicle_state.__dict__)

        elif msg_type == 'ATTITUDE':
            self.telemetry_state.attitude = Attitude(
                roll=msg_dict.get('roll', 0),
                pitch=msg_dict.get('pitch', 0),
                yaw=msg_dict.get('yaw', 0)
            )
            self._emit('mavlink:telemetry', self.telemetry_state.to_dict())

        elif msg_type == 'GLOBAL_POSITION_INT':
            self.telemetry_state.position = Position(
                lat=msg_dict.get('lat', 0) / 1e7,
                lon=msg_dict.get('lon', 0) / 1e7,
                alt=msg_dict.get('alt', 0) / 1000.0,
                relativeAlt=msg_dict.get('relative_alt', 0) / 1000.0
            )
            self.telemetry_state.velocity = Velocity(
                vx=msg_dict.get('vx', 0) / 100.0,
                vy=msg_dict.get('vy', 0) / 100.0,
                vz=msg_dict.get('vz', 0) / 100.0
            )
            self.telemetry_state.heading = msg_dict.get('hdg', 0) / 100.0
            self._emit('mavlink:telemetry', self.telemetry_state.to_dict())

        elif msg_type == 'VFR_HUD':
            self.telemetry_state.groundspeed = msg_dict.get('groundspeed', 0)
            self.telemetry_state.airspeed = msg_dict.get('airspeed', 0)
            self.telemetry_state.heading = msg_dict.get('heading', 0)
            self.telemetry_state.throttle = msg_dict.get('throttle', 0)
            self.telemetry_state.climbRate = msg_dict.get('climb', 0)
            self._emit('mavlink:telemetry', self.telemetry_state.to_dict())

        elif msg_type == 'SYS_STATUS':
            self.telemetry_state.battery = Battery(
                voltage=msg_dict.get('voltage_battery', 0) / 1000.0,
                current=msg_dict.get('current_battery', 0) / 100.0,
                remaining=msg_dict.get('battery_remaining', 0)
            )
            self._emit('mavlink:telemetry', self.telemetry_state.to_dict())

        elif msg_type == 'GPS_RAW_INT':
            self.telemetry_state.gps = GPS(
                fix=msg_dict.get('fix_type', 0),
                satellites=msg_dict.get('satellites_visible', 0)
            )
            self._emit('mavlink:telemetry', self.telemetry_state.to_dict())

        elif msg_type in ['MISSION_REQUEST', 'MISSION_REQUEST_INT']:
            seq = msg.seq
            if self.uploading_mission and seq < len(self.uploading_mission_waypoints):
                wp = self.uploading_mission_waypoints[seq]
                cmd = wp.get('command', mavutil.mavlink.MAV_CMD_NAV_WAYPOINT)
                self.master.mav.mission_item_int_send(
                    self.master.target_system,
                    self.master.target_component,
                    seq,
                    mavutil.mavlink.MAV_FRAME_GLOBAL_RELATIVE_ALT,
                    cmd,
                    0, # current
                    1, # autocontinue
                    wp.get('param1', 0), 
                    wp.get('param2', 0), 
                    wp.get('param3', 0), 
                    wp.get('param4', 0),
                    int(wp['lat'] * 1e7),
                    int(wp['lon'] * 1e7),
                    wp['alt']
                )
                logger.info(f"Sent MISSION_ITEM_INT for seq {seq} (cmd: {cmd})")

        elif msg_type == 'MISSION_ACK':
            if self.uploading_mission:
                logger.info(f"Mission upload complete, ack type: {msg.type}")
                self.uploading_mission = False

        elif msg_type == 'STATUSTEXT':
            text = msg_dict.get('text', '')
            severity = msg_dict.get('severity', 6)
            logger.info(f"STATUSTEXT [Sev:{severity}]: {text}")

#  Commands ===================================
    
    def upload_mission(self, waypoints: list, end_action='LOITER'):
        if not self.master:
            raise Exception("Vehicle not connected")
            
        logger.info(f"Uploading mission with {len(waypoints)} waypoints and end_action {end_action}")
        
        mission_items = []
        
        # Seq 0: Home position (required by ArduPilot)
        mission_items.append({
            'command': mavutil.mavlink.MAV_CMD_NAV_WAYPOINT,
            'lat': waypoints[0]['lat'] if waypoints else 0,
            'lon': waypoints[0]['lon'] if waypoints else 0,
            'alt': 0
        })
        
        # Seq 1: Takeoff
        if waypoints:
            mission_items.append({
                'command': mavutil.mavlink.MAV_CMD_NAV_TAKEOFF,
                'lat': waypoints[0]['lat'],
                'lon': waypoints[0]['lon'],
                'alt': waypoints[0]['alt']
            })
            
        # Seq 2+: Waypoints
        for wp in waypoints:
            loiter = wp.get('loiterTime', 0)
            cmd = mavutil.mavlink.MAV_CMD_NAV_LOITER_TIME if loiter > 0 else mavutil.mavlink.MAV_CMD_NAV_WAYPOINT
            mission_items.append({
                'command': cmd,
                'lat': wp['lat'],
                'lon': wp['lon'],
                'alt': wp['alt'],
                'param1': loiter
            })
            
        # Append End Action (RTL or Land or Loiter otherwise)
        if end_action == 'RTL':
            mission_items.append({
                'command': mavutil.mavlink.MAV_CMD_NAV_RETURN_TO_LAUNCH,
                'lat': 0, 'lon': 0, 'alt': 0
            })
        elif end_action == 'LAND':
            mission_items.append({
                'command': mavutil.mavlink.MAV_CMD_NAV_LAND,
                'lat': 0, 'lon': 0, 'alt': 0
            })
            
        self.uploading_mission = True
        self.uploading_mission_waypoints = mission_items
        self.master.waypoint_count_send(len(mission_items))

    def arm(self, arm_state: bool):
        if not self.master:
            raise Exception("Vehicle not connected")
        arm_val = 1 if arm_state else 0
        self.master.mav.command_long_send(
            self.master.target_system,
            self.master.target_component,
            mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM,
            0,
            arm_val, 0, 0, 0, 0, 0, 0
        )

    def set_mode(self, mode_name):
        if not self.master:
            raise Exception("Vehicle not connected")
        
        mode_num = None
        if isinstance(mode_name, int):
            mode_num = mode_name
        elif isinstance(mode_name, str) and mode_name.isdigit():
            mode_num = int(mode_name)
        else:
            mode_num = COPTER_MODE_NAMES.get(str(mode_name).upper())
            
        if mode_num is None or mode_num not in COPTER_MODES:
            raise Exception(f"Unknown mode {mode_name}")
            
        self.master.mav.set_mode_send(
            self.master.target_system,
            mavutil.mavlink.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED,
            mode_num
        )

    def takeoff(self, altitude: float):
        if not self.master:
            raise Exception("Vehicle not connected")
        self.master.mav.command_long_send(
            self.master.target_system,
            self.master.target_component,
            mavutil.mavlink.MAV_CMD_NAV_TAKEOFF,
            0,
            0, 0, 0, 0, 0, 0, altitude
        )

    def land(self):
        if not self.master:
            raise Exception("Vehicle not connected")
        self.master.mav.command_long_send(
            self.master.target_system,
            self.master.target_component,
            mavutil.mavlink.MAV_CMD_NAV_LAND,
            0,
            0, 0, 0, 0, 0, 0, 0
        )

    def return_to_launch(self):
        self.set_mode("RTL")

    def goto(self, lat: float, lon: float, altitude: float):
        if not self.master:
            raise Exception("Vehicle not connected")
        
        self.master.mav.mission_item_int_send(
            self.master.target_system,
            self.master.target_component,
            0, # seq
            mavutil.mavlink.MAV_FRAME_GLOBAL_RELATIVE_ALT,
            mavutil.mavlink.MAV_CMD_NAV_WAYPOINT,
            2, # current (2 = guided mode goto)
            0, # autocontinue
            0, 0, 0, 0, # p1, p2, p3, p4
            int(lat * 1e7),
            int(lon * 1e7),
            altitude
        )
