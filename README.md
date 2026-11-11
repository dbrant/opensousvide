# joule-ble

A small Python app for controlling a ChefSteps Joule sous vide directly over
Bluetooth. It works without the official app, a ChefSteps account, or the cloud.

It builds on the reverse-engineering notes in
[mitchcapper/JouleUWP](https://github.com/mitchcapper/JouleUWP). For the
protocol details, see [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Setup

You need Python 3.10+ and a Bluetooth LE adapter. It runs on Windows, macOS and
Linux through [bleak](https://github.com/hbldh/bleak).

```sh
python -m venv .venv
.venv/Scripts/pip install -e .     # Windows (use .venv/bin/pip on macOS/Linux)
```

## Usage

```sh
joule scan            # list nearby Joules
joule pair            # one-time: press the button on top of the Joule when asked
joule set 57          # heat to 57 °C and hold
joule set 135F        # or in Fahrenheit (or: joule set -F 135)
joule status          # current water temperature, target, and state
joule watch           # live temperature readout (Ctrl+C to quit)
joule stop            # turn heating off
```

The Joule runs the program on its own, so after `joule set` you can close the
terminal or move out of Bluetooth range. It keeps holding the temperature until
you run `joule stop` or press its button.

Add `-v` to any command to log the raw protocol traffic. If you have more than
one Joule, pick one with `-d <name or address>`.

Settings, including this client's address and each Joule's pairing key, are
stored in `%APPDATA%\joule\config.json` on Windows and
`~/.config/joule/config.json` elsewhere. Set `JOULE_CONFIG` to use a different
path.

## Development

```sh
python -m unittest discover -s tests       # runs against a simulated Joule
```

`joule/base_pb2.py` is generated from `proto/base.proto`. To regenerate it:

```sh
pip install grpcio-tools
python -m grpc_tools.protoc -Iproto --python_out=joule proto/base.proto
```

The files in `proto/` come from the official Joule Android app.

## Layout

- `joule/protocol.py`: UUIDs, advertisement parsing, stream handles, and message builders. No I/O.
- `joule/client.py`: `JouleClient`, an async API (`pair`, `authenticate`, `set_temperature`, `stop`, `status`, `live_feed`), and the BLE transport.
- `joule/discovery.py`: BLE scanning.
- `joule/store.py`: saved pairing keys.
- `joule/cli.py`: the `joule` command.
