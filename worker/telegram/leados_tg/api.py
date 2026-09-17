"""Клиент LeadOS API. Только стандартная библиотека: urllib в отдельном потоке."""

import asyncio
import json
import logging
import time
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional

log = logging.getLogger(__name__)


class ApiError(Exception):
    def __init__(self, status: int, body: str):
        super().__init__(f"LeadOS ответил {status}: {body[:300]}")
        self.status = status
        self.body = body


class LeadOSApi:
    def __init__(self, base_url: str, token: str, timeout: float = 30, retries: int = 3):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout
        self.retries = retries

    def _request(self, method: str, path: str, payload: Optional[Dict[str, Any]] = None) -> Any:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
        headers = {"Authorization": f"Bearer {self.token}", "Accept": "application/json"}
        if data is not None:
            headers["Content-Type"] = "application/json"

        for attempt in range(1, self.retries + 1):
            request = urllib.request.Request(self.base_url + path, data=data, method=method, headers=headers)
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    return json.loads(response.read().decode("utf-8") or "null")
            except urllib.error.HTTPError as e:
                body = e.read().decode("utf-8", "replace")
                # 4xx — ошибка запроса, повтор не поможет; 5xx — пробуем ещё.
                if e.code < 500 or attempt == self.retries:
                    raise ApiError(e.code, body)
                log.warning("LeadOS %s %s → %s, повтор %d/%d", method, path, e.code, attempt, self.retries)
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                if attempt == self.retries:
                    raise
                log.warning("LeadOS недоступен (%s), повтор %d/%d", e, attempt, self.retries)
            time.sleep(2 ** attempt)

    async def call(self, method: str, path: str, payload: Optional[Dict[str, Any]] = None) -> Any:
        return await asyncio.to_thread(self._request, method, path, payload)

    async def channels(self, version: str) -> List[Dict[str, Any]]:
        result = await self.call("GET", f"/api/telegram/channels?version={version}")
        return result["channels"]

    async def ingest(self, channel_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        return await self.call("POST", f"/api/telegram/channels/{channel_id}/ingest", payload)

    async def dialogs(self, dialogs: List[Dict[str, Any]]) -> Dict[str, Any]:
        return await self.call("POST", "/api/telegram/dialogs", {"dialogs": dialogs})
