"""Async client for controlling a Joule over Bluetooth LE."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from dataclasses import dataclass
from typing import AsyncIterator, Callable, Protocol

from google.protobuf.message import DecodeError

from . import base_pb2 as pb
from .protocol import (
    ACTIVE_STEPS,
    NOTIFY_CHAR_UUID,
    READ_CHAR_UUID,
    WRITE_CHAR_UUID,
    HandlePool,
    address_to_bytes,
    content_type,
    make_stream_message,
    manual_program,
    result_name,
    step_name,
)

log = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 5.0
# Key exchange waits for the user to press the button on the Joule.
KEY_EXCHANGE_TIMEOUT = 35.0
KEEP_ALIVE_SECONDS = 5.0
LIVE_FEED_TIMEOUT = 30.0


class JouleError(Exception):
    pass


class JouleTimeout(JouleError):
    pass


class JouleResultError(JouleError):
    def __init__(self, request: str, result: int):
        self.request = request
        self.result = result
        super().__init__(f"{request} failed: {result_name(result)}")


class Transport(Protocol):
    async def open(self, on_message: Callable[[bytes], None], on_close: Callable[[], None]) -> None: ...

    async def write(self, data: bytes) -> None: ...

    async def close(self) -> None: ...


class BleakTransport:
    """GATT transport: write requests to one characteristic; the Joule signals
    pending data with a notification, which is then fetched by reading another."""

    def __init__(self, device, connect_timeout: float = 20.0):
        self._device = device
        self._connect_timeout = connect_timeout
        self._client = None
        self._wakeups: asyncio.Queue[None] = asyncio.Queue()
        self._reader: asyncio.Task | None = None
        self._write_lock = asyncio.Lock()
        self._on_close: Callable[[], None] = lambda: None

    async def open(self, on_message, on_close) -> None:
        from bleak import BleakClient

        self._on_close = on_close
        self._client = BleakClient(
            self._device,
            timeout=self._connect_timeout,
            disconnected_callback=lambda _c: self._handle_disconnect(),
        )
        await self._client.connect()
        self._reader = asyncio.create_task(self._read_loop(on_message))
        await self._client.start_notify(NOTIFY_CHAR_UUID, lambda _c, _d: self._wakeups.put_nowait(None))
        # The official app reads once right after subscribing.
        self._wakeups.put_nowait(None)

    async def _read_loop(self, on_message) -> None:
        while True:
            await self._wakeups.get()
            try:
                data = await self._client.read_gatt_char(READ_CHAR_UUID)
            except Exception as e:
                if not self._client.is_connected:
                    return
                log.warning("Read failed: %s", e)
                continue
            # A leading zero byte means "nothing to read".
            if data and data[0] != 0:
                on_message(bytes(data))

    async def write(self, data: bytes) -> None:
        async with self._write_lock:
            await self._client.write_gatt_char(WRITE_CHAR_UUID, data, response=True)

    def _handle_disconnect(self) -> None:
        log.debug("BLE disconnected")
        self._on_close()

    async def close(self) -> None:
        if self._reader:
            self._reader.cancel()
        if self._client and self._client.is_connected:
            with contextlib.suppress(Exception):
                await self._client.stop_notify(NOTIFY_CHAR_UUID)
            await self._client.disconnect()


class _Stream:
    def __init__(self, handle: int):
        self.handle = handle
        self.queue: asyncio.Queue[pb.StreamMessage | None] = asyncio.Queue()
        self.remote_ended = False

    async def receive(self, timeout: float | None) -> pb.StreamMessage:
        """Return the next message with content, skipping keep-alives."""
        loop = asyncio.get_running_loop()
        deadline = None if timeout is None else loop.time() + timeout
        while True:
            remaining = None if deadline is None else max(0.0, deadline - loop.time())
            try:
                msg = await asyncio.wait_for(self.queue.get(), remaining)
            except asyncio.TimeoutError:
                raise JouleTimeout("Timed out waiting for the Joule to respond") from None
            if msg is None:
                raise JouleError("Connection to the Joule was lost")
            if msg.end:
                self.remote_ended = True
            kind = content_type(msg)
            if kind and kind != "keepAlive":
                return msg
            if msg.end:
                raise JouleError("The Joule ended the request without replying")


@dataclass
class Status:
    cooking: bool
    bath_temp_c: float | None = None
    setpoint_c: float | None = None
    program_step: str | None = None
    time_remaining_s: int | None = None
    error_state: str | None = None
    note: str | None = None


class JouleClient:
    """Speaks the Joule stream protocol over a Transport.

    Every exchange is a "stream": the opener picks a handle, and both sides tag
    their messages with it until one sends a message with `end` set.
    """

    def __init__(self, transport: Transport, circulator_address: str, app_address: str):
        self._transport = transport
        self._remote = address_to_bytes(circulator_address)
        self._me = address_to_bytes(app_address)
        self._handles = HandlePool(self._me, self._remote)
        self._streams: dict[int, _Stream] = {}
        self._connected = False

    async def __aenter__(self) -> JouleClient:
        await self.open()
        return self

    async def __aexit__(self, *exc) -> None:
        await self.close()

    async def open(self) -> None:
        await self._transport.open(self._on_bytes, self._on_close)
        self._connected = True

    async def close(self) -> None:
        self._connected = False
        await self._transport.close()

    # --- Commands ---

    async def pair(self, timeout: float = KEY_EXCHANGE_TIMEOUT) -> str:
        """Start a key exchange; returns the secret key (hex) once the user
        presses the button on the Joule."""
        reply = await self._request("startKeyExchangeRequest", None, "startKeyExchangeReply", timeout)
        return reply.secretKey.hex()

    async def authenticate(self, secret_key: str) -> None:
        req = pb.SubmitKeyRequest(secretKey=bytes.fromhex(secret_key))
        await self._request("submitKeyRequest", req, "submitKeyReply")

    async def identify(self) -> pb.IdentifyCirculatorReply:
        return await self._request("identifyCirculatorRequest", None, "identifyCirculatorReply")

    async def start_program(self, program: pb.CirculatorProgram) -> None:
        req = pb.StartProgramRequest(circulatorProgram=program)
        await self._request("startProgramRequest", req, "startProgramReply")

    async def stop(self) -> None:
        await self._request("stopCirculatorRequest", None, "stopCirculatorReply")

    async def set_temperature(self, setpoint_c: float) -> None:
        """Heat to `setpoint_c` and hold until stopped.

        Programs can't be modified once running, so any current program is
        stopped first, as the official app does.
        """
        program = manual_program(setpoint_c)
        try:
            await self.stop()
        except JouleResultError as e:
            log.debug("Stop before start: %s", e)
        await self.start_program(program)

    async def describe_feed(self, feed_id: int) -> pb.DescribeFeedReply:
        req = pb.DescribeFeedRequest(feedId=feed_id)
        return await self._request("describeFeedRequest", req, "describeFeedReply", timeout=10.0)

    async def live_feed(self, timeout: float = LIVE_FEED_TIMEOUT) -> AsyncIterator[pb.CirculatorDataPoint]:
        """Yield data points until the caller stops iterating.

        Wrap in `contextlib.aclosing` so the stream is ended promptly on exit.
        """
        req = pb.BeginLiveFeed(feedType=pb.COOK_DATA)
        async with self._stream("beginLiveFeed", req) as stream:
            while True:
                msg = await stream.receive(timeout)
                kind = content_type(msg)
                if kind == "beginLiveFeedReply":
                    reply = msg.beginLiveFeedReply
                    if reply.HasField("result") and reply.result != pb.CS_SUCCESS:
                        raise JouleResultError("beginLiveFeed", reply.result)
                elif kind == "circulatorDataPoint":
                    yield msg.circulatorDataPoint
                if stream.remote_ended:
                    return

    async def status(self, timeout: float = 10.0) -> Status:
        try:
            async with contextlib.aclosing(self.live_feed(timeout)) as feed:
                point = await anext(feed, None)
        except JouleTimeout:
            point = None
        except JouleResultError as e:
            return Status(cooking=False, note=f"No active feed ({result_name(e.result)})")
        if point is None:
            return Status(cooking=False, note="No live data received; the Joule is probably idle")

        status = Status(
            cooking=point.HasField("programStep") and point.programStep in ACTIVE_STEPS,
            bath_temp_c=point.bathTemp,
            program_step=step_name(point.programStep) if point.HasField("programStep") else None,
            time_remaining_s=point.timeRemaining if point.HasField("timeRemaining") else None,
            error_state=pb.ErrorState.Name(point.errorState) if point.HasField("errorState") else None,
        )
        if status.cooking:
            with contextlib.suppress(JouleError):
                feed_info = await self.describe_feed(point.feedId)
                if feed_info.HasField("circulatorProgram"):
                    status.setpoint_c = feed_info.circulatorProgram.setPoint
        return status

    # --- Stream plumbing ---

    def _on_bytes(self, data: bytes) -> None:
        try:
            msg = pb.StreamMessage.FromString(data)
        except DecodeError:
            log.warning("Undecodable message: %s", data.hex())
            return
        log.debug("<- %s handle=%d end=%s", content_type(msg), msg.handle, msg.end)
        stream = self._streams.get(msg.handle)
        if stream:
            stream.queue.put_nowait(msg)
        else:
            log.debug("Ignoring message for unknown handle %d", msg.handle)

    def _on_close(self) -> None:
        self._connected = False
        for stream in self._streams.values():
            stream.queue.put_nowait(None)

    async def _send(self, handle: int, field: str | None = None, payload=None, end: bool = False) -> None:
        msg = make_stream_message(handle, self._me, self._remote, field, payload, end)
        data = msg.SerializeToString()
        log.debug("-> %s handle=%d end=%s [%s]", field, handle, end, data.hex())
        await self._transport.write(data)

    async def _keep_alive(self, handle: int) -> None:
        while True:
            await asyncio.sleep(KEEP_ALIVE_SECONDS)
            await self._send(handle, "keepAlive")

    @contextlib.asynccontextmanager
    async def _stream(self, field: str, payload=None):
        if not self._connected:
            raise JouleError("Not connected")
        stream = _Stream(self._handles.next())
        self._streams[stream.handle] = stream
        keep_alive = None
        try:
            await self._send(stream.handle, field, payload)
            keep_alive = asyncio.create_task(self._keep_alive(stream.handle))
            yield stream
        finally:
            if keep_alive:
                keep_alive.cancel()
            del self._streams[stream.handle]
            if self._connected and not stream.remote_ended:
                try:
                    await self._send(stream.handle, end=True)
                except Exception as e:
                    log.debug("Failed to end stream %d: %s", stream.handle, e)

    async def _request(self, field: str, payload, expect: str, timeout: float = DEFAULT_TIMEOUT):
        async with self._stream(field, payload) as stream:
            msg = await stream.receive(timeout)
        kind = content_type(msg)
        if kind != expect:
            raise JouleError(f"Expected {expect} but the Joule sent {kind}")
        reply = getattr(msg, expect)
        if "result" in reply.DESCRIPTOR.fields_by_name and reply.HasField("result"):
            if reply.result != pb.CS_SUCCESS:
                raise JouleResultError(field, reply.result)
        return reply
