"""Запуск: python -m leados_tg"""

import asyncio
import logging
import signal
import sys
import time

from telethon import TelegramClient
from telethon.errors import FloodWaitError
from telethon.sessions import StringSession

from . import __version__
from .api import ApiError, LeadOSApi
from .config import Config, ConfigError
from .sync import channel_label, report_dialogs, sync_channel

log = logging.getLogger("leados_tg")


async def run(config: Config, stop: asyncio.Event) -> None:
    api = LeadOSApi(config.leados_url, config.leados_token)
    client = TelegramClient(StringSession(config.session), config.api_id, config.api_hash)
    await client.connect()
    if not await client.is_user_authorized():
        raise ConfigError("Сессия Telegram недействительна — заново запусти login.py и обнови TG_SESSION")

    me = await client.get_me()
    log.info("Воркер %s запущен от аккаунта %s", __version__, "@" + me.username if me.username else me.id)

    # get_dialogs заполняет кэш сущностей — без него каналы по peerId из StringSession не найти.
    await client.get_dialogs(limit=None)
    last_dialogs_report = 0.0

    try:
        while not stop.is_set():
            try:
                if time.monotonic() - last_dialogs_report > config.dialogs_interval:
                    await report_dialogs(client, api)
                    last_dialogs_report = time.monotonic()

                channels = await api.channels(__version__)
                for channel in channels:
                    if stop.is_set():
                        break
                    try:
                        await sync_channel(client, api, channel, config.backfill_limit, config.max_posts_per_cycle)
                    except FloodWaitError:
                        raise
                    except ApiError as e:
                        log.error("%s: LeadOS отклонил данные: %s", channel_label(channel), e)
                    except Exception:
                        log.exception("%s: ошибка чтения", channel_label(channel))
            except FloodWaitError as e:
                log.warning("Telegram попросил подождать %d с", e.seconds)
                await _sleep(stop, e.seconds + 5)
                continue
            except Exception:
                log.exception("Цикл не удался, повторю через %d с", config.poll_interval)

            await _sleep(stop, config.poll_interval)
    finally:
        await client.disconnect()
        log.info("Воркер остановлен")


async def _sleep(stop: asyncio.Event, seconds: float) -> None:
    try:
        await asyncio.wait_for(stop.wait(), timeout=seconds)
    except asyncio.TimeoutError:
        pass


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("telethon").setLevel(logging.WARNING)
    try:
        config = Config.from_env()
    except ConfigError as e:
        log.error("%s", e)
        return 2

    loop = asyncio.new_event_loop()
    stop = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    try:
        loop.run_until_complete(run(config, stop))
    except ConfigError as e:
        log.error("%s", e)
        return 2
    finally:
        loop.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
