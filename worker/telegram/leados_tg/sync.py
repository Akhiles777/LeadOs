"""Логика чтения каналов. Клиент Telegram передаётся снаружи — в тестах его заменяет фейк."""

import logging
from typing import Any, Dict, List, Optional

from telethon.errors import (
    ChannelInvalidError,
    ChannelPrivateError,
    FloodWaitError,
    UsernameInvalidError,
    UsernameNotOccupiedError,
)
from telethon.tl.types import Channel, User
from telethon.utils import get_peer_id

from .api import ApiError, LeadOSApi

log = logging.getLogger(__name__)

BATCH_SIZE = 200
MAX_DIALOGS = 1000


def channel_label(channel: Dict[str, Any]) -> str:
    return "@" + channel["username"] if channel.get("username") else str(channel.get("peerId") or channel["id"])


def post_payload(message: Any) -> Dict[str, Any]:
    """Сообщение Telethon → пост для LeadOS. Пустой текст тоже отправляем: он сдвигает lastMessageId."""
    post: Dict[str, Any] = {"id": message.id, "text": getattr(message, "message", None) or ""}
    if getattr(message, "date", None):
        post["date"] = message.date.isoformat()

    sender = getattr(message, "sender", None)
    if isinstance(sender, User) and not sender.bot:
        name = " ".join(p for p in (sender.first_name, sender.last_name) if p) or None
        post["author"] = {"username": sender.username, "name": name}
    return post


async def resolve(client: Any, channel: Dict[str, Any]) -> Any:
    if channel.get("peerId"):
        return await client.get_entity(int(channel["peerId"]))
    return await client.get_entity(channel["username"])


async def sync_channel(client: Any, api: LeadOSApi, channel: Dict[str, Any], backfill_limit: int, max_posts: int) -> Dict[str, int]:
    """Читает новые посты одного канала и отправляет пачками. Возвращает сводку для лога."""
    label = channel_label(channel)
    try:
        entity = await resolve(client, channel)
    except FloodWaitError:
        raise
    except (ValueError, UsernameNotOccupiedError, UsernameInvalidError, ChannelPrivateError, ChannelInvalidError) as e:
        message = f"Не удалось открыть канал {label}: {type(e).__name__}. Проверь имя и что аккаунт в нём состоит."
        log.warning(message)
        await api.ingest(channel["id"], {"error": message})
        return {"created": 0, "posts": 0}

    resolved: Optional[Dict[str, Any]] = {
        "peerId": str(get_peer_id(entity)),
        "title": getattr(entity, "title", None) or label,
        "username": getattr(entity, "username", None),
    }

    last_id = int(channel.get("lastMessageId") or 0)
    if last_id == 0:
        # Новый канал: последние N постов, а не вся история. При BACKFILL_LIMIT=0 только запоминаем позицию.
        messages = [m async for m in client.iter_messages(entity, limit=max(backfill_limit, 1))]
        messages.reverse()
        if backfill_limit == 0:
            messages = [_Marker(m.id) for m in messages]
    else:
        messages = [m async for m in client.iter_messages(entity, min_id=last_id, reverse=True, limit=max_posts)]

    posts = [post_payload(m) for m in messages]
    summary = {"created": 0, "posts": len(posts)}

    batches = [posts[i : i + BATCH_SIZE] for i in range(0, len(posts), BATCH_SIZE)] or [[]]
    for batch in batches:
        payload: Dict[str, Any] = {"posts": batch}
        if resolved:
            payload["resolved"] = resolved
            resolved = None  # достаточно один раз за цикл
        try:
            result = await api.ingest(channel["id"], payload)
        except ApiError as e:
            if e.status == 409:
                log.warning("Канал %s уже добавлен другой записью — LeadOS её отключил", label)
                return summary
            raise
        summary["created"] += int(result.get("created", 0))

    if summary["posts"] or summary["created"]:
        log.info("%s: постов %d, новых лидов %d", label, summary["posts"], summary["created"])
    return summary


class _Marker:
    """Пустой пост-метка: только id, без текста (backfill_limit=0)."""

    def __init__(self, message_id: int):
        self.id = message_id
        self.message = ""
        self.date = None


async def report_dialogs(client: Any, api: LeadOSApi) -> int:
    """Отправляет в LeadOS каналы и супергруппы, где состоит аккаунт, — для выбора на странице /telegram."""
    dialogs = []
    async for dialog in client.iter_dialogs(limit=MAX_DIALOGS):
        entity = dialog.entity
        if isinstance(entity, Channel):
            dialogs.append(
                {
                    "peerId": str(get_peer_id(entity)),
                    "title": (dialog.name or entity.title or "")[:300],
                    "username": entity.username,
                }
            )
    await api.dialogs(dialogs)
    log.info("Список каналов аккаунта обновлён: %d", len(dialogs))
    return len(dialogs)
