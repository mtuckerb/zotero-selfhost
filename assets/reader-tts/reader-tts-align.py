#!/usr/bin/env python3
"""
Small server-side forced-alignment proxy for the Zotero reader TTS overlay.

The browser sends one already-synthesized audio part and its source text. This
proxy uploads the audio to Parlyx, waits for the timestamped transcript, aligns
that transcript back onto the source words, and returns a compact word timeline.
Keeping this server-side means the Parlyx bearer token never reaches the page.
"""

from __future__ import annotations

import base64
import json
import os
import re
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


TIME_LINE = re.compile(
    r"^\[(\d+):(\d+):(\d+(?:\.\d+)?)\s+-->\s+(\d+):(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$"
)
NUMBER_WORDS = {
    "zero": "0",
    "one": "1",
    "two": "2",
    "three": "3",
    "four": "4",
    "five": "5",
    "six": "6",
    "seven": "7",
    "eight": "8",
    "nine": "9",
    "ten": "10",
    "eleven": "11",
    "twelve": "12",
    "thirteen": "13",
    "fourteen": "14",
    "fifteen": "15",
    "sixteen": "16",
    "seventeen": "17",
    "eighteen": "18",
    "nineteen": "19",
    "twenty": "20",
}
SOURCE_WORD = re.compile(r"\S+")
SPEAKER_PREFIX = re.compile(r"^(?:Speaker\s+[A-Z0-9_-]+|[A-Z]):\s*", re.I)
FAILED_STATUSES = {"failed", "cancelled", "canceled"}
COMPLETE_STATUSES = {"completed"}


def env_int(name: str, default: int) -> int:
    try:
        value = int(os.environ.get(name, ""))
        return value if value > 0 else default
    except ValueError:
        return default


PARLYX_BASE_URL = os.environ.get("PARLYX_BASE_URL", "").rstrip("/")
PARLYX_API_KEY_FILE = os.environ.get("PARLYX_API_KEY_FILE", "")
PARLYX_API_KEY = os.environ.get("PARLYX_API_KEY", "")
HOST = os.environ.get("ZOTERO_READER_TTS_ALIGN_HOST", "127.0.0.1")
PORT = env_int("ZOTERO_READER_TTS_ALIGN_PORT", 8891)
TIMEOUT_SEC = env_int("ZOTERO_READER_TTS_ALIGN_TIMEOUT_SEC", 180)
POLL_MS = env_int("ZOTERO_READER_TTS_ALIGN_POLL_MS", 1000)
MAX_AUDIO_BYTES = env_int("ZOTERO_READER_TTS_ALIGN_MAX_AUDIO_BYTES", 25 * 1024 * 1024)
MAX_JSON_BYTES = MAX_AUDIO_BYTES * 2 + 512 * 1024


def parlyx_api_key() -> str:
    if PARLYX_API_KEY:
        return PARLYX_API_KEY.strip()
    if not PARLYX_API_KEY_FILE:
        return ""
    with open(PARLYX_API_KEY_FILE, "r", encoding="utf-8") as handle:
        value = handle.read().strip()
    if "=" in value:
        for line in value.splitlines():
            key, sep, raw = line.partition("=")
            if sep and "PARLYX_API_KEY" in key:
                return raw.strip().strip("\"'")
    return value


def http_json(status: int, body: dict) -> bytes:
    return json.dumps(body, separators=(",", ":")).encode("utf-8")


def seconds(hours: str, minutes: str, value: str) -> float:
    return int(hours) * 3600 + int(minutes) * 60 + float(value)


def source_words(text: str) -> list[str]:
    return [match.group(0) for match in SOURCE_WORD.finditer(text or "")]


def is_letter(ch: str) -> bool:
    return unicodedata.category(ch).startswith("L")


def is_mark(ch: str) -> bool:
    return unicodedata.category(ch).startswith("M")


def is_digit(ch: str) -> bool:
    return unicodedata.category(ch).startswith("N")


def transcript_tokens(text: str) -> list[str]:
    tokens: list[str] = []
    index = 0
    while index < len(text):
        ch = text[index]
        if is_letter(ch):
            start = index
            index += 1
            while index < len(text):
                nxt = text[index]
                if is_letter(nxt) or is_mark(nxt) or nxt in "’'-":
                    index += 1
                else:
                    break
            tokens.append(text[start:index])
            continue
        if is_digit(ch):
            start = index
            index += 1
            while index < len(text):
                nxt = text[index]
                if is_digit(nxt):
                    index += 1
                elif nxt in ".," and index + 1 < len(text) and is_digit(text[index + 1]):
                    index += 2
                    while index < len(text) and is_digit(text[index]):
                        index += 1
                else:
                    break
            tokens.append(text[start:index])
            continue
        index += 1
    return tokens


def normalize_token(value: str) -> str:
    decomposed = unicodedata.normalize("NFKD", value or "")
    stripped = "".join(ch for ch in decomposed if not is_mark(ch))
    lowered = stripped.lower().replace("'", "").replace("’", "")
    normalized = "".join(ch for ch in lowered if is_letter(ch) or is_digit(ch))
    return NUMBER_WORDS.get(normalized, normalized)


def parse_parlyx_transcript(transcript: str) -> list[dict]:
    words: list[dict] = []
    for raw_line in (transcript or "").splitlines():
        match = TIME_LINE.match(raw_line.strip())
        if not match:
            continue
        start_ms = round(seconds(match.group(1), match.group(2), match.group(3)) * 1000)
        end_ms = max(
            start_ms + 1,
            round(seconds(match.group(4), match.group(5), match.group(6)) * 1000),
        )
        text = SPEAKER_PREFIX.sub("", match.group(7).strip())
        tokens = transcript_tokens(text)
        weights = [max(1, len(normalize_token(token))) for token in tokens]
        total = sum(weights) or 1
        elapsed = 0
        for token, weight in zip(tokens, weights):
            word_start = start_ms + round((end_ms - start_ms) * elapsed / total)
            elapsed += weight
            word_end = start_ms + round((end_ms - start_ms) * elapsed / total)
            words.append(
                {
                    "text": token,
                    "startMs": word_start,
                    "endMs": max(word_start + 1, word_end),
                }
            )
    return words


def similarity(left: str, right: str) -> float:
    if left == right:
        return 1.0 if left else 0.0
    if not left or not right:
        return 0.0
    previous = list(range(len(right) + 1))
    for left_index in range(1, len(left) + 1):
        current = [left_index]
        for right_index in range(1, len(right) + 1):
            current.append(
                min(
                    current[right_index - 1] + 1,
                    previous[right_index] + 1,
                    previous[right_index - 1]
                    + (0 if left[left_index - 1] == right[right_index - 1] else 1),
                )
            )
        previous = current
    return max(0.0, 1.0 - previous[len(right)] / max(len(left), len(right)))


def align_gap(
    source: list[str],
    transcript: list[str],
    source_start: int,
    source_end: int,
    transcript_start: int,
    transcript_end: int,
) -> list[tuple[int, int, float]]:
    source_length = source_end - source_start
    transcript_length = transcript_end - transcript_start
    if (
        not source_length
        or not transcript_length
        or source_length > 12000
        or transcript_length > 12000
        or source_length * transcript_length > 10_000_000
    ):
        return []

    rows = source_length + 1
    columns = transcript_length + 1
    costs = [[0.0] * columns for _ in range(rows)]
    moves = [[0] * columns for _ in range(rows)]
    for idx in range(1, rows):
        costs[idx][0] = float(idx)
        moves[idx][0] = 2
    for idx in range(1, columns):
        costs[0][idx] = float(idx)
        moves[0][idx] = 3

    for source_idx in range(1, rows):
        for transcript_idx in range(1, columns):
            score = similarity(
                source[source_start + source_idx - 1],
                transcript[transcript_start + transcript_idx - 1],
            )
            diagonal = costs[source_idx - 1][transcript_idx - 1] + (
                0 if score == 1 else 1 - score if score >= 0.6 else 1.25
            )
            deletion = costs[source_idx - 1][transcript_idx] + 1
            insertion = costs[source_idx][transcript_idx - 1] + 1
            if diagonal <= deletion and diagonal <= insertion:
                costs[source_idx][transcript_idx] = diagonal
                moves[source_idx][transcript_idx] = 1
            elif deletion <= insertion:
                costs[source_idx][transcript_idx] = deletion
                moves[source_idx][transcript_idx] = 2
            else:
                costs[source_idx][transcript_idx] = insertion
                moves[source_idx][transcript_idx] = 3

    pairs: list[tuple[int, int, float]] = []
    source_idx = source_length
    transcript_idx = transcript_length
    while source_idx > 0 or transcript_idx > 0:
        move = moves[source_idx][transcript_idx]
        if move == 1:
            score = similarity(
                source[source_start + source_idx - 1],
                transcript[transcript_start + transcript_idx - 1],
            )
            if score >= 0.6:
                pairs.append(
                    (
                        source_start + source_idx - 1,
                        transcript_start + transcript_idx - 1,
                        score,
                    )
                )
            source_idx -= 1
            transcript_idx -= 1
        elif move == 2:
            source_idx -= 1
        elif move == 3:
            transcript_idx -= 1
        else:
            break
    pairs.reverse()
    return pairs


def exact_anchors(source: list[str], transcript: list[str]) -> list[dict]:
    width = 4
    index: dict[str, list[int]] = {}
    for position in range(0, max(0, len(source) - width + 1)):
        window = source[position : position + width]
        if any(not word for word in window):
            continue
        index.setdefault("\0".join(window), []).append(position)

    candidates = []
    for t_position in range(0, max(0, len(transcript) - width + 1)):
        window = transcript[t_position : t_position + width]
        if any(not word for word in window):
            continue
        entries = index.get("\0".join(window), [])
        if not entries or len(entries) > 4:
            continue
        for s_position in reversed(entries):
            candidates.append({"source": s_position, "transcript": t_position})
    if not candidates:
        return []

    tails: list[int] = []
    tail_indices: list[int] = []
    previous = [-1] * len(candidates)
    for idx, candidate in enumerate(candidates):
        value = candidate["source"]
        low = 0
        high = len(tails)
        while low < high:
            middle = (low + high) >> 1
            if tails[middle] < value:
                low = middle + 1
            else:
                high = middle
        if low > 0:
            previous[idx] = tail_indices[low - 1]
        if low == len(tails):
            tails.append(value)
            tail_indices.append(idx)
        else:
            tails[low] = value
            tail_indices[low] = idx

    chain = []
    cursor = tail_indices[-1] if tail_indices else -1
    while cursor >= 0:
        chain.append(candidates[cursor])
        cursor = previous[cursor]
    chain.reverse()
    return chain


def align_source_to_transcript(text: str, transcript_text: str) -> dict:
    raw_source_words = source_words(text)
    timed_words = parse_parlyx_transcript(transcript_text)
    source = [normalize_token(word) for word in raw_source_words]
    transcript = [normalize_token(word["text"]) for word in timed_words]
    anchors = exact_anchors(source, transcript)

    exact_pairs: list[tuple[int, int, float]] = []
    for anchor in anchors:
        for offset in range(4):
            exact_pairs.append((anchor["source"] + offset, anchor["transcript"] + offset, 1.0))
    exact_pairs.sort(key=lambda pair: (pair[0], pair[1]))

    monotonic = []
    last_source = -1
    last_transcript = -1
    for pair in exact_pairs:
        if pair[0] > last_source and pair[1] > last_transcript:
            monotonic.append(pair)
            last_source = pair[0]
            last_transcript = pair[1]

    pairs: list[tuple[int, int, float]] = []
    source_cursor = 0
    transcript_cursor = 0
    for anchor in monotonic:
        pairs.extend(
            align_gap(source, transcript, source_cursor, anchor[0], transcript_cursor, anchor[1])
        )
        pairs.append(anchor)
        source_cursor = anchor[0] + 1
        transcript_cursor = anchor[1] + 1
    pairs.extend(
        align_gap(source, transcript, source_cursor, len(source), transcript_cursor, len(transcript))
    )

    timeline = []
    last_source = -1
    last_transcript = -1
    for source_index, transcript_index, confidence in pairs:
        if source_index <= last_source or transcript_index <= last_transcript:
            continue
        if transcript_index >= len(timed_words):
            continue
        timed = timed_words[transcript_index]
        timeline.append(
            [
                source_index,
                int(timed["startMs"]),
                int(timed["endMs"]),
                round(float(confidence), 3),
            ]
        )
        last_source = source_index
        last_transcript = transcript_index

    coverage = len(timeline) / len(raw_source_words) if raw_source_words else 0
    confidence = sum(item[3] for item in timeline) / len(timeline) if timeline else 0
    return {
        "version": 1,
        "method": "parlyx",
        "sourceWordCount": len(raw_source_words),
        "transcriptWordCount": len(timed_words),
        "matchedWordCount": len(timeline),
        "coverage": round(coverage, 4),
        "confidence": round(confidence, 4),
        "timeline": timeline,
    }


def request_parlyx(
    path: str,
    *,
    method: str = "GET",
    data: bytes | None = None,
    headers: dict | None = None,
    expect_json: bool = True,
) -> object:
    if not PARLYX_BASE_URL:
        raise RuntimeError("Parlyx base URL is not configured")
    token = parlyx_api_key()
    if not token:
        raise RuntimeError("Parlyx API key is not configured")
    request = urllib.request.Request(
        PARLYX_BASE_URL + path,
        data=data,
        method=method,
        headers={"Authorization": f"Bearer {token}", **(headers or {})},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            raw = response.read()
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", errors="replace")
        try:
            body = json.loads(raw)
            message = body.get("error") or body.get("message") or raw
        except json.JSONDecodeError:
            message = raw
        raise RuntimeError(f"Parlyx returned HTTP {error.code}: {message}") from error
    text = raw.decode("utf-8", errors="replace")
    if not text:
        return {} if expect_json else ""
    try:
        return json.loads(text)
    except json.JSONDecodeError as error:
        if not expect_json:
            return text
        raise RuntimeError("Parlyx returned non-JSON response") from error


def multipart_body(fields: dict[str, str], file_field: str, filename: str, content_type: str, data: bytes) -> tuple[bytes, str]:
    boundary = "----zotero-reader-tts-align-" + uuid.uuid4().hex
    chunks: list[bytes] = []
    for name, value in fields.items():
        chunks.extend(
            [
                f"--{boundary}\r\n".encode(),
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode(),
                str(value).encode(),
                b"\r\n",
            ]
        )
    chunks.extend(
        [
            f"--{boundary}\r\n".encode(),
            f'Content-Disposition: form-data; name="{file_field}"; filename="{filename}"\r\n'.encode(),
            f"Content-Type: {content_type}\r\n\r\n".encode(),
            data,
            b"\r\n",
            f"--{boundary}--\r\n".encode(),
        ]
    )
    return b"".join(chunks), boundary


def upload_audio(audio: bytes, audio_format: str, mime_type: str) -> str:
    suffix = re.sub(r"[^a-z0-9]+", "", (audio_format or "mp3").lower()) or "mp3"
    body, boundary = multipart_body(
        {
            "summarize": "false",
            "diarize": "false",
            "priority": "30",
            "title": "Zotero reader TTS alignment",
        },
        "file",
        f"zotero-reader-tts-{uuid.uuid4().hex}.{suffix}",
        mime_type or "application/octet-stream",
        audio,
    )
    created = request_parlyx(
        "/api/tasks/upload",
        method="POST",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    if not isinstance(created, dict):
        raise RuntimeError("Parlyx returned an invalid upload response")
    task_id = created.get("task_id")
    if not task_id:
        raise RuntimeError("Parlyx did not return a task id")
    return str(task_id)


def wait_for_transcript(task_id: str) -> str:
    deadline = time.monotonic() + TIMEOUT_SEC
    last_error = ""
    while time.monotonic() < deadline:
        task = request_parlyx(f"/api/tasks/{urllib.parse.quote(task_id)}")
        if not isinstance(task, dict):
            raise RuntimeError("Parlyx returned an invalid task response")
        status = str(task.get("status") or "").lower()
        if status in COMPLETE_STATUSES:
            result = str(task.get("result") or "")
            if result.strip():
                return result
            result_body = request_parlyx(
                f"/api/tasks/{urllib.parse.quote(task_id)}/result",
                expect_json=False,
            )
            if isinstance(result_body, str) and result_body.strip():
                return result_body
            if isinstance(result_body, dict):
                for key in ("result", "transcript", "text", "content"):
                    value = str(result_body.get(key) or "")
                    if value.strip():
                        return value
            raise RuntimeError("Parlyx completed without a transcript")
        if status in FAILED_STATUSES:
            raise RuntimeError(str(task.get("error") or "Parlyx alignment task failed"))
        if task.get("error"):
            last_error = str(task.get("error"))
        time.sleep(POLL_MS / 1000)
    raise TimeoutError(last_error or "Timed out waiting for Parlyx alignment")


def destroy_task(task_id: str) -> None:
    try:
        request_parlyx(f"/api/tasks/{urllib.parse.quote(task_id)}/destroy", method="DELETE")
    except Exception:
        pass


def align_request(payload: dict) -> dict:
    text = str(payload.get("text") or "")
    encoded = str(payload.get("audio") or "")
    if not text.strip():
        raise ValueError("text is required")
    if not encoded:
        raise ValueError("audio is required")
    try:
        audio = base64.b64decode(encoded, validate=True)
    except Exception as error:
        raise ValueError("audio must be base64") from error
    if not audio:
        raise ValueError("audio is empty")
    if len(audio) > MAX_AUDIO_BYTES:
        raise ValueError("audio is too large")

    task_id = upload_audio(
        audio,
        str(payload.get("format") or "mp3"),
        str(payload.get("mimeType") or "application/octet-stream"),
    )
    try:
        transcript = wait_for_transcript(task_id)
        result = align_source_to_transcript(text, transcript)
        result["taskId"] = task_id
        return result
    finally:
        destroy_task(task_id)


class Handler(BaseHTTPRequestHandler):
    server_version = "ZoteroReaderTTSAlign/1.0"

    def log_message(self, fmt: str, *args) -> None:  # noqa: N802
        print(f"{self.address_string()} - {fmt % args}", flush=True)

    def send_json(self, status: int, body: dict) -> None:
        data = http_json(status, body)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.rstrip("/") == "/health":
            self.send_json(200, {"ok": True})
        else:
            self.send_json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.rstrip("/") != "/v1/audio/align":
            self.send_json(404, {"error": "not found"})
            return
        length = int(self.headers.get("content-length") or "0")
        if length <= 0 or length > MAX_JSON_BYTES:
            self.send_json(413, {"error": "request body is too large"})
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            result = align_request(payload)
            self.send_json(200, result)
        except ValueError as error:
            self.send_json(400, {"error": str(error)})
        except TimeoutError as error:
            self.send_json(504, {"error": str(error)})
        except Exception as error:
            self.send_json(502, {"error": str(error)})


def main() -> None:
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"reader TTS alignment proxy listening on {HOST}:{PORT}", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
