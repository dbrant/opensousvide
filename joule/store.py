"""Persistent settings: this client's address and paired Joules."""

from __future__ import annotations

import json
import os
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

from .protocol import new_app_address


def default_path() -> Path:
    if env := os.environ.get("JOULE_CONFIG"):
        return Path(env)
    if sys.platform == "win32" and (appdata := os.environ.get("APPDATA")):
        base = Path(appdata)
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    return base / "joule" / "config.json"


@dataclass
class PairedJoule:
    circulator_address: str
    secret_key: str
    name: str = ""
    serial_number: str = ""


class Store:
    def __init__(self, path: Path, app_address: str, devices: dict[str, PairedJoule], default: str | None):
        self.path = path
        self.app_address = app_address
        self.devices = devices
        self.default = default

    @classmethod
    def load(cls, path: Path | None = None) -> Store:
        path = path or default_path()
        data = json.loads(path.read_text()) if path.exists() else {}
        devices = {k: PairedJoule(**v) for k, v in data.get("devices", {}).items()}
        store = cls(path, data.get("app_address") or new_app_address(), devices, data.get("default"))
        if "app_address" not in data:
            store.save()
        return store

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "app_address": self.app_address,
            "default": self.default,
            "devices": {k: asdict(v) for k, v in self.devices.items()},
        }
        self.path.write_text(json.dumps(data, indent=2))

    def add(self, joule: PairedJoule) -> None:
        self.devices[joule.circulator_address] = joule
        self.default = joule.circulator_address
        self.save()

    def get(self, selector: str | None = None) -> PairedJoule | None:
        """Look up by circulator address or name; defaults to the last paired."""
        if selector is None:
            return self.devices.get(self.default) if self.default else None
        sel = selector.lower()
        for joule in self.devices.values():
            if sel in (joule.circulator_address, joule.name.lower()):
                return joule
        return None
