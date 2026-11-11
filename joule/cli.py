"""Command-line interface: `joule scan | pair | status | set | stop | watch`."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import logging
import sys
import time

from . import discovery
from .client import BleakTransport, JouleClient, JouleError, JouleResultError
from .protocol import c_to_f, parse_temperature, step_name, validate_setpoint
from .store import PairedJoule, Store


class CliError(Exception):
    pass


def fmt_temp(c: float | None) -> str:
    return "?" if c is None else f"{c:.1f}°C ({c_to_f(c):.1f}°F)"


@contextlib.asynccontextmanager
async def session(store: Store, selector: str | None):
    """Find, connect to, and authenticate with a paired Joule."""
    paired = store.get(selector)
    if paired is None:
        raise CliError("No paired Joule found. Run `joule pair` first.")
    label = paired.name or paired.circulator_address
    print(f"Looking for {label}...")
    found = await discovery.find(paired.circulator_address)
    if found is None:
        raise CliError(f"Couldn't find {label}. Make sure it's plugged in and within Bluetooth range.")
    if found.ad.is_connected:
        print("Note: the Joule reports another device is connected to it; that may block this connection.")
    async with JouleClient(BleakTransport(found.device), paired.circulator_address, store.app_address) as client:
        try:
            await client.authenticate(paired.secret_key)
        except JouleResultError as e:
            raise CliError(f"The Joule rejected the saved key ({e}). Run `joule pair` again.") from e
        yield client


async def cmd_scan(args, store: Store) -> None:
    print(f"Scanning for {args.timeout:.0f}s...")
    joules = await discovery.scan(args.timeout)
    if not joules:
        print("No Joules found.")
        return
    for j in joules:
        paired = " (paired)" if j.ad.circulator_address in store.devices else ""
        busy = " [busy: another device connected]" if j.ad.is_connected else ""
        print(f"{j.name or 'Joule'}  address={j.ad.circulator_address}  ble={j.ble_address}  rssi={j.rssi}{paired}{busy}")


async def cmd_pair(args, store: Store) -> None:
    print("Scanning...")
    if args.address:
        found = await discovery.find(args.address)
        if found is None:
            raise CliError(f"No Joule with address {args.address} found.")
    else:
        joules = await discovery.scan()
        if not joules:
            raise CliError("No Joules found. Make sure it's plugged in and nearby.")
        if len(joules) > 1:
            listing = "\n".join(f"  {j.name or 'Joule'}  {j.ad.circulator_address}" for j in joules)
            raise CliError(f"Found several Joules; pick one with --address:\n{listing}")
        found = joules[0]

    address = found.ad.circulator_address
    print(f"Connecting to {found.name or 'Joule'} ({address})...")
    async with JouleClient(BleakTransport(found.device), address, store.app_address) as client:
        print("Press the button on top of the Joule to approve pairing (waiting up to 35s)...")
        key = await client.pair()
        await client.authenticate(key)
        info = None
        with contextlib.suppress(JouleError):
            info = await client.identify()

    name = (info.name if info else "") or found.name or ""
    store.add(PairedJoule(address, key, name=name, serial_number=info.serialNumber if info else ""))
    print(f"Paired with {name or address}.")
    if info:
        print(f"  Firmware {info.firmwareVersion}, hardware {info.hardwareVersion}")


async def cmd_status(args, store: Store) -> None:
    async with session(store, args.device) as client:
        s = await client.status()
    if s.cooking:
        print(f"Cooking: target {fmt_temp(s.setpoint_c)}, water {fmt_temp(s.bath_temp_c)}")
    else:
        print("Idle" + (f": water {fmt_temp(s.bath_temp_c)}" if s.bath_temp_c is not None else ""))
    if s.program_step:
        print(f"  Step: {s.program_step}")
    if s.error_state and s.error_state != "NO_ERROR":
        print(f"  Error state: {s.error_state}")
    if s.note:
        print(f"  {s.note}")


async def cmd_set(args, store: Store) -> None:
    setpoint = parse_temperature(args.temperature, "F" if args.fahrenheit else "C")
    validate_setpoint(setpoint)
    async with session(store, args.device) as client:
        await client.set_temperature(setpoint)
    print(f"Joule is heating to {fmt_temp(setpoint)} and will hold it until you run `joule stop`.")


async def cmd_stop(args, store: Store) -> None:
    async with session(store, args.device) as client:
        await client.stop()
    print("Joule stopped.")


async def cmd_watch(args, store: Store) -> None:
    async with session(store, args.device) as client:
        print("Watching (Ctrl+C to quit; the Joule keeps running)...")
        setpoints: dict[int, float | None] = {}
        async with contextlib.aclosing(client.live_feed()) as feed:
            async for point in feed:
                if point.feedId not in setpoints:
                    setpoints[point.feedId] = None
                    with contextlib.suppress(JouleError):
                        info = await client.describe_feed(point.feedId)
                        if info.HasField("circulatorProgram"):
                            setpoints[point.feedId] = info.circulatorProgram.setPoint
                step = point.programStep if point.HasField("programStep") else None
                print(
                    f"{time.strftime('%H:%M:%S')}  water {fmt_temp(point.bathTemp)}"
                    f"  target {fmt_temp(setpoints[point.feedId])}"
                    f"  {step_name(step) if step is not None else ''}"
                )


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="joule", description="Control a ChefSteps Joule over Bluetooth.")
    p.add_argument("-v", "--verbose", action="store_true", help="log protocol traffic")
    sub = p.add_subparsers(dest="command", required=True)

    s = sub.add_parser("scan", help="list nearby Joules")
    s.add_argument("--timeout", type=float, default=6.0)
    s.set_defaults(func=cmd_scan)

    s = sub.add_parser("pair", help="pair with a Joule (press its button when asked)")
    s.add_argument("--address", help="circulator address from `joule scan`")
    s.set_defaults(func=cmd_pair)

    def with_device(sp):
        sp.add_argument("-d", "--device", help="paired Joule name or address (default: last paired)")
        return sp

    with_device(sub.add_parser("status", help="show temperature and state")).set_defaults(func=cmd_status)

    s = with_device(sub.add_parser("set", help="heat to a temperature and hold it"))
    s.add_argument("temperature", help="e.g. 57, 57C or 135F")
    s.add_argument("-F", "--fahrenheit", action="store_true", help="treat a bare number as °F")
    s.set_defaults(func=cmd_set)

    with_device(sub.add_parser("stop", help="stop heating")).set_defaults(func=cmd_stop)
    with_device(sub.add_parser("watch", help="stream live temperatures")).set_defaults(func=cmd_watch)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.WARNING,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    if not args.verbose:
        logging.getLogger("bleak").setLevel(logging.WARNING)
    try:
        store = Store.load()
        asyncio.run(args.func(args, store))
    except KeyboardInterrupt:
        return 130
    except (CliError, JouleError, ValueError) as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
    except OSError as e:
        # bleak raises BleakError (an Exception) or OSError when Bluetooth is off/unavailable.
        print(f"Bluetooth error: {e}", file=sys.stderr)
        return 1
    except Exception as e:
        if type(e).__module__.startswith("bleak"):
            print(f"Bluetooth error: {e}", file=sys.stderr)
            return 1
        raise
    return 0


if __name__ == "__main__":
    sys.exit(main())
