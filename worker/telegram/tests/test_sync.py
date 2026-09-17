"""
Тесты воркера без Telegram: фейковый клиент отдаёт настоящие типы Telethon.

    python -m unittest discover -s tests -v
Интеграционный тест против запущенного LeadOS включается переменными LEADOS_URL и LEADOS_API_TOKEN.
"""

import asyncio
import os
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any, Dict, List

from telethon.errors import UsernameNotOccupiedError
from telethon.tl.types import Channel, ChatPhotoEmpty, User

from leados_tg.api import ApiError, LeadOSApi
from leados_tg.sync import post_payload, report_dialogs, sync_channel

T0 = datetime(2026, 9, 17, 8, 0, tzinfo=timezone.utc)


def make_channel(channel_id: int, username: str, title: str = "Test Jobs", megagroup: bool = False) -> Channel:
    return Channel(id=channel_id, title=title, photo=ChatPhotoEmpty(), date=T0, username=username, access_hash=1, megagroup=megagroup)


def msg(message_id: int, text: str, sender: Any = None) -> SimpleNamespace:
    return SimpleNamespace(id=message_id, message=text, date=T0 + timedelta(minutes=message_id), sender=sender)


class FakeClient:
    def __init__(self, entities: Dict[Any, Channel], history: Dict[int, List[SimpleNamespace]]):
        self.entities = entities
        self.history = history  # channel.id → сообщения по возрастанию id
        self.calls: List[Dict[str, Any]] = []

    async def get_entity(self, ref: Any) -> Channel:
        if ref not in self.entities:
            if isinstance(ref, str):
                raise UsernameNotOccupiedError(request=None)
            raise ValueError("Could not find the input entity")
        return self.entities[ref]

    async def iter_messages(self, entity: Channel, limit: int = None, min_id: int = 0, reverse: bool = False):
        self.calls.append({"limit": limit, "min_id": min_id, "reverse": reverse})
        items = [m for m in self.history.get(entity.id, []) if m.id > min_id]
        items = items if reverse else list(reversed(items))  # Telethon по умолчанию — от новых к старым
        for m in items[:limit] if limit else items:
            yield m

    async def iter_dialogs(self, limit: int = None):
        for entity in self.entities.values():
            yield SimpleNamespace(entity=entity, name=entity.title)


class FakeApi:
    def __init__(self, fail_with: ApiError = None):
        self.ingested: List[Dict[str, Any]] = []
        self.sent_dialogs: List[Dict[str, Any]] = []
        self.fail_with = fail_with

    async def ingest(self, channel_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        if self.fail_with:
            raise self.fail_with
        self.ingested.append({"channel": channel_id, **payload})
        return {"created": len([p for p in payload.get("posts", []) if p["text"]])}

    async def dialogs(self, dialogs: List[Dict[str, Any]]) -> Dict[str, Any]:
        self.sent_dialogs = dialogs
        return {"ok": True}


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


class SyncChannelTest(unittest.TestCase):
    def setUp(self):
        self.entity = make_channel(1111111111, "test_jobs")
        self.history = {self.entity.id: [msg(i, f"пост {i}") for i in range(1, 121)]}
        self.client = FakeClient({"test_jobs": self.entity, -1001111111111: self.entity}, self.history)

    def test_new_channel_backfills_last_n_in_order_and_resolves(self):
        api = FakeApi()
        channel = {"id": "c1", "username": "test_jobs", "peerId": None, "lastMessageId": 0}
        summary = run(sync_channel(self.client, api, channel, backfill_limit=50, max_posts=1000))

        self.assertEqual(summary["posts"], 50)
        ids = [p["id"] for call in api.ingested for p in call["posts"]]
        self.assertEqual(ids, list(range(71, 121)))
        self.assertEqual(api.ingested[0]["resolved"], {"peerId": "-1001111111111", "title": "Test Jobs", "username": "test_jobs"})

    def test_known_channel_reads_only_new_posts_in_batches(self):
        api = FakeApi()
        channel = {"id": "c1", "username": "test_jobs", "peerId": "-1001111111111", "lastMessageId": 10}
        summary = run(sync_channel(self.client, api, channel, backfill_limit=50, max_posts=1000))

        self.assertEqual(summary["posts"], 110)
        self.assertEqual([len(c["posts"]) for c in api.ingested], [110])  # BATCH_SIZE=200
        self.assertEqual(api.ingested[0]["posts"][0]["id"], 11)
        self.assertEqual(self.client.calls[-1], {"limit": 1000, "min_id": 10, "reverse": True})
        self.assertNotIn("resolved", api.ingested[1] if len(api.ingested) > 1 else {})

    def test_max_posts_caps_catch_up(self):
        api = FakeApi()
        channel = {"id": "c1", "username": None, "peerId": "-1001111111111", "lastMessageId": 0 + 1}
        run(sync_channel(self.client, api, channel, backfill_limit=50, max_posts=60))
        ids = [p["id"] for p in api.ingested[0]["posts"]]
        self.assertEqual(ids[0], 2)
        self.assertEqual(len(ids), 60)

    def test_backfill_zero_only_marks_position(self):
        api = FakeApi()
        channel = {"id": "c1", "username": "test_jobs", "peerId": None, "lastMessageId": 0}
        run(sync_channel(self.client, api, channel, backfill_limit=0, max_posts=1000))
        self.assertEqual(api.ingested[0]["posts"], [{"id": 120, "text": ""}])

    def test_no_new_posts_still_reports_check(self):
        api = FakeApi()
        channel = {"id": "c1", "username": "test_jobs", "peerId": None, "lastMessageId": 120}
        summary = run(sync_channel(self.client, api, channel, backfill_limit=50, max_posts=1000))
        self.assertEqual(summary["posts"], 0)
        self.assertEqual(len(api.ingested), 1)
        self.assertEqual(api.ingested[0]["posts"], [])

    def test_unknown_channel_reports_error_instead_of_crashing(self):
        api = FakeApi()
        channel = {"id": "c2", "username": "no_such_channel", "peerId": None, "lastMessageId": 0}
        run(sync_channel(self.client, api, channel, backfill_limit=50, max_posts=1000))
        self.assertIn("error", api.ingested[0])
        self.assertIn("@no_such_channel", api.ingested[0]["error"])

    def test_duplicate_channel_409_is_not_fatal(self):
        api = FakeApi(fail_with=ApiError(409, '{"error":"duplicate_channel"}'))
        channel = {"id": "c1", "username": "test_jobs", "peerId": None, "lastMessageId": 110}
        run(sync_channel(self.client, api, channel, backfill_limit=50, max_posts=1000))  # не бросает

    def test_other_api_errors_propagate(self):
        api = FakeApi(fail_with=ApiError(422, "validation"))
        channel = {"id": "c1", "username": "test_jobs", "peerId": None, "lastMessageId": 110}
        with self.assertRaises(ApiError):
            run(sync_channel(self.client, api, channel, backfill_limit=50, max_posts=1000))


class PayloadTest(unittest.TestCase):
    def test_group_author_is_passed_bots_are_not(self):
        person = User(id=5, first_name="Анна", last_name="Петрова", username="anna_pm")
        bot = User(id=6, first_name="Helper", username="helper_bot", bot=True)
        self.assertEqual(post_payload(msg(1, "текст", person))["author"], {"username": "anna_pm", "name": "Анна Петрова"})
        self.assertNotIn("author", post_payload(msg(2, "текст", bot)))
        self.assertNotIn("author", post_payload(msg(3, "текст", make_channel(1, "chan"))))

    def test_media_without_caption_becomes_empty_text(self):
        payload = post_payload(SimpleNamespace(id=9, message=None, date=T0, sender=None))
        self.assertEqual(payload, {"id": 9, "text": "", "date": "2026-09-17T08:00:00+00:00"})

    def test_dialogs_include_channels_and_supergroups(self):
        client = FakeClient({"a": make_channel(1, "jobs"), "b": make_channel(2, None, "Чат фрилансеров", megagroup=True)}, {})
        api = FakeApi()
        run(report_dialogs(client, api))
        self.assertEqual(
            api.sent_dialogs,
            [
                {"peerId": "-1000000000001", "title": "Test Jobs", "username": "jobs"},
                {"peerId": "-1000000000002", "title": "Чат фрилансеров", "username": None},
            ],
        )


@unittest.skipUnless(os.environ.get("LEADOS_URL") and os.environ.get("LEADOS_API_TOKEN"), "нужен запущенный LeadOS")
class LiveLeadOSTest(unittest.TestCase):
    """Полный путь без Telegram: фейковый канал → настоящий LeadOS API → лиды в БД."""

    def test_end_to_end(self):
        api = LeadOSApi(os.environ["LEADOS_URL"], os.environ["LEADOS_API_TOKEN"])
        marker = uuid.uuid4().hex[:8]
        entity = make_channel(1999999999, "leados_it_channel", "IT-тест LeadOS")
        client = FakeClient(
            {-1001999999999: entity, "leados_it_channel": entity},
            {
                entity.id: [
                    msg(1, f"Нужен сайт для автосервиса {marker}. Бюджет: 60 000 ₽, пишите в личку, обсудим"),
                    msg(2, "Короткий"),
                    msg(3, f"Ищу работу, сделаю сайт недорого {marker}, портфолио по запросу, пишите"),
                    msg(4, f"Нужен Telegram-бот {marker} для записи в салон, оплата 20-30к руб", User(id=7, first_name="Ольга", username="olga_salon")),
                ]
            },
        )
        channel_id = os.environ["LEADOS_IT_CHANNEL_ID"]
        channels = run(api.channels("it-test"))
        channel = next(c for c in channels if c["id"] == channel_id)

        summary = run(sync_channel(client, api, channel, backfill_limit=50, max_posts=1000))
        self.assertEqual(summary, {"created": 2, "posts": 4})

        channel = next(c for c in run(api.channels("it-test")) if c["id"] == channel_id)
        self.assertEqual(channel["lastMessageId"], 4)
        self.assertEqual(channel["peerId"], "-1001999999999")

        again = run(sync_channel(client, api, channel, backfill_limit=50, max_posts=1000))
        self.assertEqual(again, {"created": 0, "posts": 0})


if __name__ == "__main__":
    unittest.main()
