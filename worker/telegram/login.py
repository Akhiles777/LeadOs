"""
Одноразовый вход в Telegram и получение TG_SESSION.

    TG_API_ID=… TG_API_HASH=… python login.py

Спросит телефон, код из Telegram и облачный пароль (если включён) — вводишь сам, в этом терминале.
Печатает строку сессии: положи её в TG_SESSION. Эта строка = полный доступ к аккаунту, храни как пароль.
"""

import asyncio
import os
import sys

from telethon import TelegramClient
from telethon.sessions import StringSession


async def main() -> int:
    api_id = os.environ.get("TG_API_ID")
    api_hash = os.environ.get("TG_API_HASH")
    if not api_id or not api_hash:
        print("Задай TG_API_ID и TG_API_HASH (https://my.telegram.org → API development tools)", file=sys.stderr)
        return 2

    client = TelegramClient(StringSession(), int(api_id), api_hash)
    await client.start()  # интерактивно: телефон → код → пароль 2FA
    me = await client.get_me()
    session = client.session.save()
    await client.disconnect()

    print(f"\nВошли как {'@' + me.username if me.username else me.id}.")
    print("TG_SESSION (не показывай никому, не коммить):\n")
    print(session)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
