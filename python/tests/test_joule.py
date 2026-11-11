import asyncio
import contextlib
import random
import unittest
from unittest import mock

from joule import base_pb2 as pb
from joule import client as client_mod
from joule.client import JouleClient, JouleError, JouleResultError, JouleTimeout
from joule.protocol import (
    MANUFACTURER_ID,
    HandlePool,
    content_type,
    make_stream_message,
    parse_manufacturer_data,
    parse_temperature,
)

JOULE_ADDR = "0a1b2c3d4e5f"
APP_ADDR = "aabbaabbaabbaabb"
SECRET = bytes(range(16))


class FakeJoule:
    """Simulates the circulator side of the stream protocol."""

    def __init__(self, button_delay: float | None = 0.0):
        self.address = bytes.fromhex(JOULE_ADDR)
        self.button_delay = button_delay
        self.authorized = False
        self.program: pb.CirculatorProgram | None = None
        self.feed_id = 7
        self.received: list[pb.StreamMessage] = []
        self._on_message = None
        self._on_close = None

    async def open(self, on_message, on_close):
        self._on_message = on_message
        self._on_close = on_close

    async def close(self):
        pass

    def drop_connection(self):
        self._on_close()

    def _reply(self, req, field, payload=None, end=False, delay=0.0):
        msg = make_stream_message(req.handle, self.address, req.senderAddress, field, payload, end)
        asyncio.get_running_loop().call_later(delay, self._on_message, msg.SerializeToString())

    async def write(self, data: bytes):
        msg = pb.StreamMessage.FromString(data)
        self.received.append(msg)
        kind = content_type(msg)
        handler = getattr(self, f"_on_{kind}", None) if kind else None
        if handler:
            handler(msg)

    def _on_startKeyExchangeRequest(self, req):
        if self.button_delay is not None:
            reply = pb.StartKeyExchangeReply(secretKey=SECRET)
            self._reply(req, "startKeyExchangeReply", reply, delay=self.button_delay)

    def _on_submitKeyRequest(self, req):
        ok = req.submitKeyRequest.secretKey == SECRET
        self.authorized = ok
        result = pb.CS_SUCCESS if ok else pb.CS_ERROR_FORBIDDEN
        self._reply(req, "submitKeyReply", pb.SubmitKeyReply(result=result))

    def _authorized_reply(self, req, field, factory, action):
        if not self.authorized:
            self._reply(req, field, factory(result=pb.CS_ERROR_FORBIDDEN))
            return
        self._reply(req, field, factory(result=action()))

    def _on_startProgramRequest(self, req):
        def start():
            if self.program is not None:
                return pb.CS_ERROR_INVALID_STATE
            self.program = req.startProgramRequest.circulatorProgram
            self.feed_id += 1
            return pb.CS_SUCCESS

        self._authorized_reply(req, "startProgramReply", pb.StartProgramReply, start)

    def _on_stopCirculatorRequest(self, req):
        def stop():
            if self.program is None:
                return pb.CS_ERROR_INVALID_STATE
            self.program = None
            return pb.CS_SUCCESS

        self._authorized_reply(req, "stopCirculatorReply", pb.StopCirculatorReply, stop)

    def _on_beginLiveFeed(self, req):
        self._reply(req, "beginLiveFeedReply", pb.BeginLiveFeedReply(result=pb.CS_SUCCESS))
        step = pb.PRE_HEAT if self.program else pb.UNKNOWN
        for seq in range(2):
            point = pb.CirculatorDataPoint(
                feedId=self.feed_id, sequenceNumber=seq, timestamp=seq * 1000, bathTemp=41.5, programStep=step
            )
            self._reply(req, "circulatorDataPoint", point, delay=0.01 * (seq + 1))

    def _on_describeFeedRequest(self, req):
        reply = pb.DescribeFeedReply(feedId=req.describeFeedRequest.feedId, result=pb.CS_SUCCESS)
        if self.program:
            reply.circulatorProgram.CopyFrom(self.program)
        self._reply(req, "describeFeedReply", reply)

    def messages(self, kind):
        return [m for m in self.received if content_type(m) == kind]


class ProtocolTests(unittest.TestCase):
    def test_handle_parity_depends_on_address_order(self):
        low, high = bytes.fromhex("0001"), bytes.fromhex("ff00")
        a = HandlePool(low, high, random.Random(1))
        b = HandlePool(high, low, random.Random(1))
        self.assertTrue(all(a.next() % 2 == 0 for _ in range(200)))
        self.assertTrue(all(b.next() % 2 == 1 for _ in range(200)))

    def test_handles_are_not_reused_recently(self):
        pool = HandlePool(b"\x01", b"\x02", random.Random(0))
        pool._rng = mock.Mock(random=lambda: 0.5)
        handles = [pool.next() for _ in range(50)]
        self.assertEqual(len(set(handles)), 50)

    def test_parse_manufacturer_data(self):
        ad = parse_manufacturer_data({MANUFACTURER_ID: bytes([0x83]) + bytes.fromhex(JOULE_ADDR)})
        self.assertEqual(ad.circulator_address, JOULE_ADDR)
        self.assertEqual(ad.version, 3)
        self.assertTrue(ad.is_connected)
        self.assertIsNone(parse_manufacturer_data({0x004C: b"\x01\x02\x03"}))

    def test_parse_temperature(self):
        self.assertEqual(parse_temperature("60"), 60.0)
        self.assertEqual(parse_temperature("57.5 °C"), 57.5)
        self.assertAlmostEqual(parse_temperature("140F"), 60.0)
        self.assertAlmostEqual(parse_temperature("140", default_unit="F"), 60.0)
        with self.assertRaises(ValueError):
            parse_temperature("hot")

    def test_wire_format_starts_with_fixed32_handle(self):
        msg = make_stream_message(5, b"\xaa", b"\xbb", "ping")
        self.assertEqual(msg.SerializeToString()[:5], bytes.fromhex("0d05000000"))


class ClientTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.joule = FakeJoule()
        self.client = JouleClient(self.joule, JOULE_ADDR, APP_ADDR)
        await self.client.open()

    async def test_pair_then_authenticate(self):
        key = await self.client.pair()
        self.assertEqual(key, SECRET.hex())
        await self.client.authenticate(key)
        self.assertTrue(self.joule.authorized)
        for m in self.joule.received:
            self.assertEqual(m.senderAddress.hex(), APP_ADDR)
            self.assertEqual(m.recipientAddress.hex(), JOULE_ADDR)
        # Every request stream is closed with an end message on the same handle.
        request_handles = {m.handle for m in self.joule.received if content_type(m)}
        end_handles = {m.handle for m in self.joule.received if m.end and not content_type(m)}
        self.assertEqual(request_handles, end_handles)

    async def test_wrong_key_is_rejected(self):
        with self.assertRaises(JouleResultError) as cm:
            await self.client.authenticate("00" * 16)
        self.assertEqual(cm.exception.result, pb.CS_ERROR_FORBIDDEN)

    async def test_set_temperature_from_idle_and_stop(self):
        await self.client.authenticate(SECRET.hex())
        await self.client.set_temperature(57.0)
        self.assertAlmostEqual(self.joule.program.setPoint, 57.0)
        self.assertEqual(self.joule.program.programType, pb.MANUAL)

        status = await self.client.status()
        self.assertTrue(status.cooking)
        self.assertAlmostEqual(status.setpoint_c, 57.0)
        self.assertAlmostEqual(status.bath_temp_c, 41.5)
        self.assertEqual(status.program_step, "PRE_HEAT")

        await self.client.stop()
        self.assertIsNone(self.joule.program)
        self.assertFalse((await self.client.status()).cooking)

    async def test_set_temperature_replaces_running_program(self):
        await self.client.authenticate(SECRET.hex())
        await self.client.set_temperature(57.0)
        await self.client.set_temperature(63.5)
        self.assertAlmostEqual(self.joule.program.setPoint, 63.5)

    async def test_set_temperature_out_of_range(self):
        with self.assertRaises(ValueError):
            await self.client.set_temperature(99.0)
        self.assertEqual(self.joule.received, [])

    async def test_unauthorized_command_fails(self):
        with self.assertRaises(JouleResultError):
            await self.client.start_program(pb.CirculatorProgram(setPoint=60, programType=pb.MANUAL))

    async def test_live_feed_ends_stream_on_close(self):
        async with contextlib.aclosing(self.client.live_feed()) as feed:
            points = [await anext(feed), await anext(feed)]
        self.assertEqual([p.sequenceNumber for p in points], [0, 1])
        handle = self.joule.messages("beginLiveFeed")[0].handle
        self.assertTrue(any(m.handle == handle and m.end for m in self.joule.received))
        self.assertEqual(self.client._streams, {})

    async def test_timeout_when_button_not_pressed(self):
        self.joule.button_delay = None
        with self.assertRaises(JouleTimeout):
            await self.client.pair(timeout=0.1)

    async def test_keep_alives_sent_while_waiting(self):
        self.joule.button_delay = 0.35
        with mock.patch.object(client_mod, "KEEP_ALIVE_SECONDS", 0.1):
            await self.client.pair()
        handle = self.joule.messages("startKeyExchangeRequest")[0].handle
        keep_alives = [m for m in self.joule.messages("keepAlive") if m.handle == handle]
        self.assertGreaterEqual(len(keep_alives), 2)

    async def test_disconnect_fails_pending_request(self):
        self.joule.button_delay = None
        task = asyncio.create_task(self.client.pair())
        await asyncio.sleep(0.05)
        self.joule.drop_connection()
        with self.assertRaises(JouleError):
            await task


if __name__ == "__main__":
    unittest.main()
