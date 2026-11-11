# OpenSousVide: Python command-line app

A small Python app for controlling a ChefSteps Joule sous vide directly over
Bluetooth. It works without the official app, a ChefSteps account, or the cloud.
For the protocol details, see [docs/PROTOCOL.md](../docs/PROTOCOL.md).

## Setup

You need Python 3.10+ and a Bluetooth LE adapter. It runs on Windows, macOS and
Linux through [bleak](https://github.com/hbldh/bleak). Run these from this
`python/` folder:

```sh
python -m venv .venv
.venv/Scripts/pip install -e .     # Windows (use .venv/bin/pip on macOS/Linux)
```

The install creates a `joule` command inside the virtual environment, as
`.venv/Scripts/joule.exe` on Windows or `.venv/bin/joule` elsewhere. The command
comes from the `[project.scripts]` entry in `pyproject.toml`; there is no
`joule.py` file. Run it in one of these ways from the `python/` folder:

1. Activate the virtual environment so `joule` is on your PATH for that
   terminal session:

   ```sh
   .venv\Scripts\Activate.ps1     # Windows PowerShell
   source .venv/Scripts/activate  # Windows Git Bash
   source .venv/bin/activate      # macOS/Linux
   joule scan
   ```

   If PowerShell refuses to run `Activate.ps1`, run
   `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once.

2. Call the command by its full path, without activating:

   ```sh
   .venv/Scripts/joule scan       # Windows (.venv/bin/joule on macOS/Linux)
   ```

3. Run the package as a Python module:

   ```sh
   .venv/Scripts/python -m joule scan
   ```

The examples below assume the virtual environment is activated.

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

`joule/base_pb2.py` is generated from the shared `../proto/base.proto`. To
regenerate it, run this from the `python/` folder:

```sh
pip install grpcio-tools
python -m grpc_tools.protoc -I../proto --python_out=joule ../proto/base.proto
```

## Layout

- `joule/protocol.py`: UUIDs, advertisement parsing, stream handles, and message builders. No I/O.
- `joule/client.py`: `JouleClient`, an async API (`pair`, `authenticate`, `set_temperature`, `stop`, `status`, `live_feed`), and the BLE transport.
- `joule/discovery.py`: BLE scanning.
- `joule/store.py`: saved pairing keys.
- `joule/cli.py`: the `joule` command.
