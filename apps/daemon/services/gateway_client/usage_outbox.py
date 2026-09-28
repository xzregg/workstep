"""Project-independent SQLite outbox for durable managed usage delivery."""

import json
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4


class UsageOutbox:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.RLock()

    @contextmanager
    def _connection(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.path, timeout=5)
        try:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("""CREATE TABLE IF NOT EXISTS usage_outbox (
                usage_event_id TEXT PRIMARY KEY,
                device_id TEXT,
                payload_json TEXT NOT NULL,
                batch_id TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )""")
            columns = {row[1] for row in connection.execute("PRAGMA table_info(usage_outbox)")}
            if "device_id" not in columns:
                connection.execute("ALTER TABLE usage_outbox ADD COLUMN device_id TEXT")
                rows = connection.execute(
                    "SELECT usage_event_id, payload_json FROM usage_outbox",
                ).fetchall()
                for event_id, payload in rows:
                    device_id = json.loads(payload).get("device_id")
                    connection.execute(
                        "UPDATE usage_outbox SET device_id = ? WHERE usage_event_id = ?",
                        (device_id, event_id),
                    )
            connection.execute("""CREATE TABLE IF NOT EXISTS usage_rejected (
                usage_event_id TEXT PRIMARY KEY,
                payload_json TEXT NOT NULL,
                rejected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )""")
            connection.commit()
            yield connection
        finally:
            connection.close()

    def append(self, event: dict) -> bool:
        if not isinstance(event, dict):
            raise ValueError("Invalid usage event")
        event_id = event.get("usage_event_id")
        if not isinstance(event_id, str) or not 1 <= len(event_id) <= 64:
            raise ValueError("Invalid usage event ID")
        payload = json.dumps(event, sort_keys=True, separators=(",", ":"))
        if len(payload.encode()) > 32 * 1024:
            raise ValueError("Usage event too large")
        with self._lock, self._connection() as connection:
            with connection:
                existing = connection.execute(
                    "SELECT payload_json FROM usage_outbox WHERE usage_event_id = ?",
                    (event_id,),
                ).fetchone()
                if existing:
                    if existing[0] != payload:
                        raise ValueError("Usage event ID conflict")
                    return False
                connection.execute(
                    "INSERT INTO usage_outbox (usage_event_id, device_id, payload_json) "
                    "VALUES (?, ?, ?)",
                    (event_id, event.get("device_id"), payload),
                )
                return True

    def pending(self, *, limit: int = 100, device_id: str | None = None) -> dict | None:
        if not 1 <= limit <= 100:
            raise ValueError("Invalid usage batch limit")
        with self._lock, self._connection() as connection:
            with connection:
                assigned = connection.execute(
                    "SELECT batch_id FROM usage_outbox WHERE batch_id IS NOT NULL "
                    "AND (? IS NULL OR device_id = ?) "
                    "ORDER BY created_at, rowid LIMIT 1", (device_id, device_id),
                ).fetchone()
                if assigned:
                    batch_id = assigned[0]
                    rows = connection.execute(
                        "SELECT payload_json FROM usage_outbox WHERE batch_id = ? "
                        "AND (? IS NULL OR device_id = ?) ORDER BY created_at, rowid",
                        (batch_id, device_id, device_id),
                    ).fetchall()
                else:
                    rows = connection.execute(
                        "SELECT usage_event_id, payload_json FROM usage_outbox "
                        "WHERE batch_id IS NULL AND (? IS NULL OR device_id = ?) "
                        "ORDER BY created_at, rowid LIMIT ?",
                        (device_id, device_id, limit),
                    ).fetchall()
                    if not rows:
                        return None
                    selected = []
                    size = 0
                    for event_id, payload in rows:
                        if selected and size + len(payload.encode()) > 256 * 1024:
                            break
                        selected.append((event_id, payload))
                        size += len(payload.encode())
                    batch_id = uuid4().hex
                    connection.executemany(
                        "UPDATE usage_outbox SET batch_id = ? WHERE usage_event_id = ?",
                        [(batch_id, event_id) for event_id, _ in selected],
                    )
                    rows = [(payload,) for _, payload in selected]
                return {"batch_id": batch_id,
                        "events": [json.loads(row[0]) for row in rows]}

    def ack(self, batch_id: str, *, accepted: list[str], duplicates: list[str],
            rejected: list[str]) -> None:
        if not isinstance(batch_id, str) or not batch_id:
            raise ValueError("Invalid usage acknowledgment")
        ids = accepted + duplicates + rejected
        if len(ids) > 100 or len(set(ids)) != len(ids):
            raise ValueError("Invalid usage acknowledgment IDs")
        with self._lock, self._connection() as connection:
            with connection:
                for event_id in rejected:
                    row = connection.execute(
                        "SELECT payload_json FROM usage_outbox WHERE batch_id = ? "
                        "AND usage_event_id = ?", (batch_id, event_id),
                    ).fetchone()
                    if row:
                        connection.execute(
                            "INSERT OR IGNORE INTO usage_rejected "
                            "(usage_event_id, payload_json) VALUES (?, ?)",
                            (event_id, row[0]),
                        )
                for event_id in ids:
                    connection.execute(
                        "DELETE FROM usage_outbox WHERE batch_id = ? AND usage_event_id = ?",
                        (batch_id, event_id),
                    )
