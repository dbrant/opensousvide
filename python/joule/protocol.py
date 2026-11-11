"""Joule BLE protocol constants and message helpers (no I/O)."""

from __future__ import annotations

import random
import re
from collections import deque
from dataclasses import dataclass

from . import base_pb2 as pb

# GATT layout of the Joule "stream" service.
STREAM_SERVICE_UUID = "700b4321-9836-4383-a2b2-31a9098d1473"
WRITE_CHAR_UUID = "700b4322-9836-4383-a2b2-31a9098d1473"
READ_CHAR_UUID = "700b4323-9836-4383-a2b2-31a9098d1473"
NOTIFY_CHAR_UUID = "700b4325-9836-4383-a2b2-31a9098d1473"
FILE_CHAR_UUID = "700b4326-9836-4383-a2b2-31a9098d1473"

MANUFACTURER_ID = 0x0159

# Limits enforced by the official app.
MIN_SETPOINT_C = 20.0
MAX_SETPOINT_C = 90.0

ACTIVE_STEPS = frozenset(
    {pb.PRE_HEAT, pb.WAIT_FOR_FOOD, pb.COOK, pb.WAIT_FOR_REMOVE_FOOD}
)


@dataclass(frozen=True)
class Advertisement:
    circulator_address: str
    """Hex address used in StreamMessage sender/recipient fields."""
    version: int
    is_connected: bool
    """True when another client already holds the BLE connection."""


def parse_manufacturer_data(manufacturer_data: dict[int, bytes]) -> Advertisement | None:
    """Parse a Joule advertisement.

    `manufacturer_data` maps company ID to payload, with the 2-byte company ID
    already stripped (as bleak reports it). The payload is one flags byte
    (bit 7 = connected, bits 0-6 = version) followed by the circulator address.
    """
    payload = manufacturer_data.get(MANUFACTURER_ID)
    if not payload or len(payload) < 2:
        return None
    flags = payload[0]
    return Advertisement(
        circulator_address=payload[1:].hex(),
        version=flags & 0x7F,
        is_connected=bool(flags & 0x80),
    )


def address_to_bytes(hex_address: str) -> bytes:
    if len(hex_address) % 2 or len(hex_address) > 18:
        raise ValueError(f"Invalid address: {hex_address!r}")
    return bytes.fromhex(hex_address)


def new_app_address() -> str:
    """Random 8-byte address identifying this client to the circulator."""
    return random.randbytes(8).hex()


class HandlePool:
    """Allocates stream handles toward one remote address.

    Each side of a connection uses only odd or only even handles so that
    streams opened by either party never collide. The side whose address
    compares lower (as a hex string) uses odd handles.
    """

    LRU_SIZE = 128
    MAX_HANDLE = 999_999 - LRU_SIZE * 2

    def __init__(self, my_address: bytes, remote_address: bytes, rng: random.Random | None = None):
        self.even = remote_address.hex() > my_address.hex()
        self._rng = rng or random.Random()
        self._recent: deque[int] = deque(maxlen=self.LRU_SIZE)

    def owns(self, handle: int) -> bool:
        return (handle % 2 == 0) == self.even

    def next(self) -> int:
        handle = round(self._rng.random() * self.MAX_HANDLE)
        if not self.owns(handle):
            handle += 1
        while handle in self._recent:
            handle += 2
        self._recent.append(handle)
        return handle


def make_stream_message(
    handle: int,
    sender: bytes,
    recipient: bytes,
    field: str | None = None,
    payload=None,
    end: bool = False,
) -> pb.StreamMessage:
    msg = pb.StreamMessage(handle=handle, senderAddress=sender, recipientAddress=recipient)
    if end:
        msg.end = True
    if field is not None:
        sub = getattr(msg, field)
        sub.SetInParent()
        if payload is not None:
            sub.MergeFrom(payload)
    return msg


def content_type(msg: pb.StreamMessage) -> str | None:
    return msg.WhichOneof("contents")


def manual_program(setpoint_c: float) -> pb.CirculatorProgram:
    """A program that heats to `setpoint_c` and holds it until stopped."""
    validate_setpoint(setpoint_c)
    return pb.CirculatorProgram(setPoint=setpoint_c, programType=pb.MANUAL)


def validate_setpoint(setpoint_c: float) -> None:
    if not MIN_SETPOINT_C <= setpoint_c <= MAX_SETPOINT_C:
        raise ValueError(
            f"Temperature {setpoint_c:.1f}°C is outside the supported range "
            f"{MIN_SETPOINT_C:.0f}-{MAX_SETPOINT_C:.0f}°C"
        )


_TEMP_RE = re.compile(r"^\s*(-?\d+(?:\.\d+)?)\s*°?\s*([cCfF]?)\s*$")


def parse_temperature(text: str, default_unit: str = "C") -> float:
    """Parse '60', '60C', '140F' or '140 °F' into Celsius."""
    m = _TEMP_RE.match(text)
    if not m:
        raise ValueError(f"Can't parse temperature: {text!r}")
    value = float(m.group(1))
    unit = (m.group(2) or default_unit).upper()
    return f_to_c(value) if unit == "F" else value


def f_to_c(f: float) -> float:
    return (f - 32.0) * 5.0 / 9.0


def c_to_f(c: float) -> float:
    return c * 9.0 / 5.0 + 32.0


def result_name(result: int) -> str:
    return pb.Result.Name(result) if result in pb.Result.values() else str(result)


def step_name(step: int) -> str:
    return pb.ProgramStep.Name(step) if step in pb.ProgramStep.values() else str(step)
