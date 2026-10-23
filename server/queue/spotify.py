"""File Spotify (OAuth PKCE, sans client secret)."""

from __future__ import annotations

import base64
import contextlib
import hashlib
import json
import os
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any

from .models import QueueSnapshot, QueueTrack

AUTH_URL = "https://accounts.spotify.com/authorize"
TOKEN_URL = "https://accounts.spotify.com/api/token"
API_BASE = "https://api.spotify.com/v1"
SCOPE = "user-read-playback-state"


@dataclass(frozen=True)
class SpotifyConfig:
    client_id: str = ""
    refresh_token: str = ""
    redirect_uri: str = ""

    @property
    def configured(self) -> bool:
        return bool(self.client_id.strip() and self.refresh_token.strip())


def load_spotify_config(port: int) -> SpotifyConfig:
    return SpotifyConfig(
        client_id=(os.environ.get("SPOTIFY_CLIENT_ID") or "").strip(),
        refresh_token=(os.environ.get("SPOTIFY_REFRESH_TOKEN") or "").strip(),
        redirect_uri=(os.environ.get("SPOTIFY_REDIRECT_URI") or "").strip()
        or f"http://127.0.0.1:{port}/api/spotify/callback",
    )


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def pkce_pair() -> tuple[str, str]:
    verifier = _b64url(secrets.token_bytes(48))
    challenge = _b64url(hashlib.sha256(verifier.encode("ascii")).digest())
    return verifier, challenge


def _post_form(url: str, fields: dict[str, str]) -> dict[str, Any]:
    data = urllib.parse.urlencode(fields).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        payload = json.loads(response.read().decode("utf-8"))
    return payload if isinstance(payload, dict) else {}


def _get_json(url: str, token: str) -> tuple[int, dict[str, Any], str]:
    request = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            payload = json.loads(response.read().decode("utf-8") or "{}")
            return response.status, payload if isinstance(payload, dict) else {}, ""
    except urllib.error.HTTPError as error:
        retry_after = error.headers.get("Retry-After", "") if error.headers else ""
        text = ""
        with contextlib.suppress(Exception):
            text = error.read().decode("utf-8")[:300]
        return error.code, {}, retry_after or text
    except (OSError, ValueError) as error:
        return 0, {}, str(error)[:300]


class SpotifyQueueProvider:
    name = "spotify"

    def __init__(self, config: SpotifyConfig) -> None:
        self.config = config
        self._lock = threading.Lock()
        self._access_token = ""
        self._expires_at = 0.0
        self._last_error = ""
        self._snapshot = QueueSnapshot(provider="spotify_api", note="aucune lecture")

    @property
    def configured(self) -> bool:
        return self.config.configured

    def authorization_url(self, state: str, verifier: str) -> str:
        challenge = _b64url(hashlib.sha256(verifier.encode("ascii")).digest())
        params = {
            "client_id": self.config.client_id,
            "response_type": "code",
            "redirect_uri": self.config.redirect_uri,
            "scope": SCOPE,
            "state": state,
            "code_challenge_method": "S256",
            "code_challenge": challenge,
        }
        return f"{AUTH_URL}?{urllib.parse.urlencode(params)}"

    def exchange_code(self, code: str, verifier: str) -> dict[str, Any]:
        return _post_form(
            TOKEN_URL,
            {
                "client_id": self.config.client_id,
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": self.config.redirect_uri,
                "code_verifier": verifier,
            },
        )

    def _token(self) -> str:
        with self._lock:
            if self._access_token and time.time() < self._expires_at - 30:
                return self._access_token
            if not self.configured:
                raise RuntimeError("Spotify non configuré")
            payload = _post_form(
                TOKEN_URL,
                {
                    "client_id": self.config.client_id,
                    "grant_type": "refresh_token",
                    "refresh_token": self.config.refresh_token,
                },
            )
            token = str(payload.get("access_token") or "")
            if not token:
                raise RuntimeError(f"refresh Spotify refusé: {payload.get('error', 'inconnu')}")
            self._access_token = token
            self._expires_at = time.time() + float(payload.get("expires_in") or 3600)
            return token

    def _get(self, path: str) -> dict[str, Any] | None:
        token = self._token()
        for attempt in range(2):
            status, payload, extra = _get_json(f"{API_BASE}{path}", token)
            if status == 429:
                try:
                    wait = min(30.0, max(0.0, float(extra or "1")))
                except ValueError:
                    wait = 1.0
                # Respecte Retry-After ; une seule nouvelle tentative.
                if attempt == 0:
                    time.sleep(wait)
                    continue
                self._last_error = "Spotify 429"
                return None
            if status == 204 or status == 0:
                self._last_error = extra or "Spotify indisponible"
                return None
            if status >= 400:
                self._last_error = f"Spotify HTTP {status}: {extra}"
                return None
            self._last_error = ""
            return payload
        return None

    @staticmethod
    def _queue_track(payload: dict[str, Any]) -> QueueTrack | None:
        item = payload.get("track") if isinstance(payload.get("track"), dict) else payload
        if not isinstance(item, dict):
            return None
        title = str(item.get("name") or "").strip()
        if not title:
            return None
        artists = item.get("artists")
        artist = ""
        if isinstance(artists, list) and artists:
            artist = str(artists[0].get("name") or "").strip()
        external = item.get("external_ids") if isinstance(item.get("external_ids"), dict) else {}
        duration = item.get("duration_ms")
        try:
            duration_ms = int(duration) if duration is not None else None
        except (TypeError, ValueError):
            duration_ms = None
        return QueueTrack(
            source="spotify",
            spotify_id=str(item.get("id") or "") or None,
            isrc=str(external.get("isrc") or "") or None,
            title=title,
            artist=artist,
            duration_ms=duration_ms,
        )

    def refresh_snapshot(self) -> QueueSnapshot:
        if not self.configured:
            return QueueSnapshot(provider="spotify_api", note="non configuré")
        queue = self._get("/me/player/queue")
        if queue is None:
            return QueueSnapshot(
                provider="spotify_api",
                checked_at=time.time(),
                note=self._last_error or "file indisponible",
                resolution_method="spotify_api",
            )
        current = self._queue_track(queue.get("currently_playing") or {})
        next_items = [
            track
            for track in (self._queue_track(item) for item in queue.get("queue", [])[:3])
            if track is not None
        ]
        if current is None:
            now = self._get("/me/player/currently-playing")
            if now:
                current = self._queue_track(now)
        self._snapshot = QueueSnapshot(
            provider="spotify_api",
            current=current,
            next=next_items,
            checked_at=time.time(),
            note="Spotify API",
            resolution_method="spotify_api",
        )
        return self._snapshot

    def current(self) -> QueueTrack | None:
        return self._snapshot.current

    def next(self, count: int = 3) -> list[QueueTrack]:
        return self._snapshot.next[:count]
