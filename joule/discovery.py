"""Finding Joules via BLE advertisements."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass

from .protocol import Advertisement, parse_manufacturer_data


@dataclass
class FoundJoule:
    device: object
    """bleak BLEDevice, passed to BleakTransport."""
    name: str | None
    rssi: int | None
    ad: Advertisement

    @property
    def ble_address(self) -> str:
        return self.device.address


async def scan(timeout: float = 6.0) -> list[FoundJoule]:
    found: dict[str, FoundJoule] = {}
    await _scan(found, timeout, stop_when=None)
    return sorted(found.values(), key=lambda j: -(j.rssi or -999))


async def find(circulator_address: str | None = None, timeout: float = 10.0) -> FoundJoule | None:
    """Return the first Joule seen, or the one with `circulator_address`."""
    found: dict[str, FoundJoule] = {}

    def matches(j: FoundJoule) -> bool:
        return circulator_address is None or j.ad.circulator_address == circulator_address.lower()

    await _scan(found, timeout, stop_when=matches)
    return next((j for j in found.values() if matches(j)), None)


async def _scan(found: dict[str, FoundJoule], timeout: float, stop_when) -> None:
    from bleak import BleakScanner

    done = asyncio.Event()

    def on_detect(device, adv) -> None:
        ad = parse_manufacturer_data(adv.manufacturer_data)
        if ad is None:
            return
        joule = FoundJoule(device=device, name=adv.local_name or device.name, rssi=adv.rssi, ad=ad)
        found[device.address] = joule
        if stop_when and stop_when(joule):
            done.set()

    async with BleakScanner(detection_callback=on_detect):
        try:
            await asyncio.wait_for(done.wait(), timeout)
        except asyncio.TimeoutError:
            pass
