from dataclasses import dataclass, field
from typing import Optional, Dict, Any

@dataclass
class VehicleState:
    connected: bool = False
    armed: bool = False
    mode: str = "UNKNOWN"
    modeNumber: int = 0
    systemId: Optional[int] = None
    componentId: Optional[int] = None
    autopilot: Optional[int] = None
    lastHeartbeat: float = 0.0

@dataclass
class Attitude:
    roll: float
    pitch: float
    yaw: float

@dataclass
class Position:
    lat: float
    lon: float
    alt: float
    relativeAlt: float

@dataclass
class Velocity:
    vx: float
    vy: float
    vz: float

@dataclass
class Battery:
    voltage: float
    current: float
    remaining: float

@dataclass
class GPS:
    fix: int
    satellites: int

@dataclass
class TelemetryState:
    attitude: Optional[Attitude] = None
    position: Optional[Position] = None
    velocity: Optional[Velocity] = None
    battery: Optional[Battery] = None
    gps: Optional[GPS] = None
    heading: float = 0.0
    groundspeed: float = 0.0
    airspeed: float = 0.0
    climbRate: float = 0.0
    throttle: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        """Convert state to dictionary for Socket.IO JSON serialization."""
        def safe_dict(obj):
            if hasattr(obj, '__dict__'):
                return obj.__dict__
            return obj
            
        return {
            "attitude": safe_dict(self.attitude) if self.attitude else None,
            "position": safe_dict(self.position) if self.position else None,
            "velocity": safe_dict(self.velocity) if self.velocity else None,
            "battery": safe_dict(self.battery) if self.battery else None,
            "gps": safe_dict(self.gps) if self.gps else None,
            "heading": self.heading,
            "groundspeed": self.groundspeed,
            "airspeed": self.airspeed,
            "climbRate": self.climbRate,
            "throttle": self.throttle
        }
