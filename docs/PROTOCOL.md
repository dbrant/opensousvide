# Joule Bluetooth LE protocol

Notes on how the official ChefSteps app (Android build archived in
[JouleUWP releases](https://github.com/mitchcapper/JouleUWP/releases/download/0.0/jouleapp.zip))
talks to a Joule over BLE. Sources: `assets/www/js/chefsteps.js` (app layer),
`assets/www/js/bundle.js` (the `circulator-sdk` and `cs-message-handler` modules),
`classes_source/com/evothings/BLE.java` (native BLE plugin), and
`assets/www/protobuf-files/*.proto` (copied into [`proto/`](../proto)).

No cloud account or Wi-Fi is needed. Everything below works over BLE alone.

## Discovery

The Joule advertises the stream service UUID `700B4321-9836-4383-A2B2-31A9098D1473`
and manufacturer-specific data with company ID `0x0159`:

| Offset (after 2-byte company ID) | Meaning |
|---|---|
| 0 | bit 7: another client is connected; bits 0-6: protocol version |
| 1.. | **circulator address** (8 bytes on the units seen so far) |

The circulator address is what goes into protobuf message addresses. It is not
the BLE MAC address.

## GATT

All characteristics are in the stream service `700B4321-...`:

| UUID | Use |
|---|---|
| `700B4322-9836-4383-A2B2-31A9098D1473` | **write**: one encoded `StreamMessage` per write (write with response; long writes are fine) |
| `700B4325-9836-4383-A2B2-31A9098D1473` | **notify**: "data ready" signal; payload ignored |
| `700B4323-9836-4383-A2B2-31A9098D1473` | **read**: one encoded `StreamMessage` per read; read once per notification. A value starting with `0x00` means nothing to read |
| `700B4326-9836-4383-A2B2-31A9098D1473` | raw file-transfer blocks (firmware updates; not needed for cooking) |

The app subscribes to `4325`, does one read of `4323` immediately, then one read
per notification. Messages are plain protobuf (no length prefix or framing).
No BLE bonding or PIN is used.

## Messages and streams

Every message is a `StreamMessage` (see `proto/base.proto`):

- `handle` (fixed32): stream ID.
- `senderAddress`, `recipientAddress` (bytes): the app's address and the circulator address.
- `end` (bool): closes the stream.
- One `contents` oneof field holding the actual request or reply.

**App address.** The official app takes the `a` claim from the user's ChefSteps
JWT, falling back to `aabbaabbaabbaabb` when logged out. Any 8 bytes work over
BLE; this client generates a random one and saves it.

**Streams.** To make a request, open a stream with a new handle, send the
request, and wait for the reply on the same handle. Then send a message with
only `end = true` on that handle, unless the reply already had `end` set. While
a stream you opened is open, send a `keepAlive` on it every 5 s. This matters for
key exchange, which can wait up to 35 s, and for live feeds.

**Handles.** Each side uses only odd or only even handles so streams never
collide. If the remote address hex string is greater than your own, use even
handles; otherwise, odd ones. The app picks random values below ~1,000,000.

**Results.** Most replies carry an optional `Result result`; anything other than
`CS_SUCCESS` (0) is an error.

## Pairing and authentication

1. Connect, then send `startKeyExchangeRequest`. The Joule waits for its top
   button to be pressed, then replies with `startKeyExchangeReply.secretKey`
   (raw bytes). The app allows 35 s.
2. On every new connection, send `submitKeyRequest { secretKey }` before any
   other command. Store the key; you only pair once.

## Cooking

- **Start:** `startProgramRequest { circulatorProgram { setPoint: <°C float>, programType: MANUAL } }`
  heats to the set point and holds it. `cookTime`, `delayedStart`,
  `holdingTemperature` and `programMetadata` are optional. The app's allowed
  range is 20-90 °C.
- **Change temperature:** programs can't be changed once started. The app sends
  `stopCirculatorRequest` and then a new `startProgramRequest`.
- **Stop:** `stopCirculatorRequest {}`. Its optional `feedId`/`sequenceNumber`
  are only for optimistic concurrency.
- The program runs on the Joule itself and keeps running after BLE disconnects.

## Status

`beginLiveFeed { feedType: COOK_DATA }` opens a long-lived stream. The Joule
replies with `beginLiveFeedReply` and then sends `circulatorDataPoint` messages
(`bathTemp`, `programStep`, `timeRemaining`, `errorState`, `feedId`, plus
heater/motor diagnostics). To get the running program's set point, send
`describeFeedRequest { feedId }`.

`programStep` values `PRE_HEAT`, `WAIT_FOR_FOOD`, `COOK` and `WAIT_FOR_REMOVE_FOOD`
mean a program is active.

## Verified on hardware

On a Joule with hardware version `JC`, firmware `175`, ESP firmware `v3.1.3`:

- The advertisement layout and an 8-byte circulator address.
- The GATT layout: `4322` write, `4323` read, `4325` read+notify. `4326` is not
  exposed.
- The full request flow (write, notify, read, reply on the same handle, end)
  with `identifyCirculatorRequest`. It also works before `submitKeyRequest`.

## Not yet verified on hardware

- Pairing, starting, stopping and the live feed. These follow the official app's
  code and pass against the simulated Joule in `python/tests/`.
- What the live feed does when the Joule is idle (no reply, an error result, or
  data points with `programStep` `UNKNOWN`). The client handles all three.
- Whether `stopCirculatorRequest` when idle returns success or an error. The
  client ignores errors there.
