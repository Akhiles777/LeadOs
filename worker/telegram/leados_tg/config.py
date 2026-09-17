import os
from dataclasses import dataclass


class ConfigError(Exception):
    pass


def _required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ConfigError(f"Не задана переменная окружения {name}")
    return value


def _int(name: str, default: int, minimum: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        raise ConfigError(f"{name} должна быть числом, сейчас: {raw!r}")
    return max(value, minimum)


def _api_id() -> int:
    raw = _required("TG_API_ID")
    if not raw.isdigit():
        raise ConfigError("TG_API_ID должен быть числом из my.telegram.org")
    return int(raw)


@dataclass(frozen=True)
class Config:
    api_id: int
    api_hash: str
    session: str
    leados_url: str
    leados_token: str
    poll_interval: int  # секунд между циклами
    backfill_limit: int  # сколько последних постов читать у нового канала
    max_posts_per_cycle: int  # защита от гигантских догонялок после долгого простоя
    dialogs_interval: int  # как часто обновлять список «Мои каналы»

    @classmethod
    def from_env(cls) -> "Config":
        return cls(
            api_id=_api_id(),
            api_hash=_required("TG_API_HASH"),
            session=_required("TG_SESSION"),
            leados_url=_required("LEADOS_URL").rstrip("/"),
            leados_token=_required("LEADOS_API_TOKEN"),
            poll_interval=_int("POLL_INTERVAL", 300, 60),
            backfill_limit=_int("BACKFILL_LIMIT", 50, 0),
            max_posts_per_cycle=_int("MAX_POSTS_PER_CYCLE", 1000, 50),
            dialogs_interval=_int("DIALOGS_INTERVAL", 1800, 300),
        )
