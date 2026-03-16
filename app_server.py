from __future__ import annotations

import json
import os
import queue
import threading
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, Response, abort, jsonify, request, send_from_directory, stream_with_context

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
BOARD_FILE = DATA_DIR / "board-state.json"

app = Flask(__name__, static_folder=None)
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0

store_lock = threading.Lock()
subscriber_lock = threading.Lock()
subscribers: set[queue.Queue[str]] = set()


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def default_record() -> dict:
    return {
        "revision": 0,
        "updatedAt": "",
        "sharedState": None,
    }


def read_record() -> dict:
    with store_lock:
        return read_record_unlocked()


def read_record_unlocked() -> dict:
    if not BOARD_FILE.exists():
        return default_record()

    try:
        payload = json.loads(BOARD_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return default_record()

    return {
        "revision": int(payload.get("revision", 0) or 0),
        "updatedAt": str(payload.get("updatedAt", "") or ""),
        "sharedState": payload.get("sharedState"),
    }


def write_record(shared_state: dict) -> dict:
    with store_lock:
        current = read_record_unlocked()
        next_record = {
            "revision": current["revision"] + 1,
            "updatedAt": iso_now(),
            "sharedState": shared_state,
        }
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        BOARD_FILE.write_text(
            json.dumps(next_record, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return next_record


def no_store(response):
    response.headers["Cache-Control"] = "no-store"
    return response


def publish_state_event(payload: dict) -> None:
    message = json.dumps(payload, ensure_ascii=False)
    stale: list[queue.Queue[str]] = []

    with subscriber_lock:
        current_subscribers = list(subscribers)

    for subscriber in current_subscribers:
        try:
            subscriber.put_nowait(message)
        except queue.Full:
            stale.append(subscriber)

    if stale:
        with subscriber_lock:
            for subscriber in stale:
                subscribers.discard(subscriber)


def format_sse(event_name: str, payload: dict) -> str:
    return f"event: {event_name}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


@app.get("/api/health")
def api_health():
    return no_store(
        jsonify(
            {
                "ok": True,
                "mode": "shared-file-store",
            }
        )
    )


@app.get("/api/state")
def api_get_state():
    record = read_record()
    return no_store(
        jsonify(
            {
                **record,
                "exists": isinstance(record.get("sharedState"), dict),
            }
        )
    )


@app.put("/api/state")
def api_put_state():
    payload = request.get_json(silent=True) or {}
    shared_state = payload.get("sharedState")
    client_id = str(payload.get("clientId", "") or "")

    if not isinstance(shared_state, dict):
        return no_store(jsonify({"ok": False, "error": "sharedState must be an object"})), 400

    record = write_record(shared_state)
    publish_state_event(
        {
            "type": "state-updated",
            "revision": record["revision"],
            "updatedAt": record["updatedAt"],
            "clientId": client_id,
        }
    )
    return no_store(jsonify(record))


@app.get("/api/events")
def api_events():
    subscriber: queue.Queue[str] = queue.Queue(maxsize=32)
    current = read_record()

    with subscriber_lock:
        subscribers.add(subscriber)

    @stream_with_context
    def event_stream():
        yield "retry: 2000\n\n"
        yield format_sse(
            "ready",
            {
                "revision": current["revision"],
                "updatedAt": current["updatedAt"],
            },
        )
        try:
            while True:
                try:
                    payload = subscriber.get(timeout=20)
                except queue.Empty:
                    yield ": keepalive\n\n"
                    continue
                yield f"event: state\ndata: {payload}\n\n"
        finally:
            with subscriber_lock:
                subscribers.discard(subscriber)

    response = Response(event_stream(), mimetype="text/event-stream")
    response.headers["Cache-Control"] = "no-store"
    response.headers["Connection"] = "keep-alive"
    response.headers["X-Accel-Buffering"] = "no"
    return response


def serve_asset(path: str):
    if path.startswith("api/") or path.startswith("data/"):
        abort(404)

    file_path = BASE_DIR / path
    if not file_path.exists() or not file_path.is_file():
        abort(404)

    response = send_from_directory(BASE_DIR, path, max_age=0)
    if path in {"index.html", "service-worker.js", "manifest.webmanifest"}:
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/")
def serve_index():
    return serve_asset("index.html")


@app.get("/<path:path>")
def serve_static(path: str):
    return serve_asset(path)


if __name__ == "__main__":
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "4174"))
    app.run(host=host, port=port, debug=False, threaded=True)
