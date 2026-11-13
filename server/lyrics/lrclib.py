"""Client LRCLIB : paroles synchronisées, mot à mot quand la base le permet.

LRCLIB est gratuit et ne demande aucune clé. Le serveur exige seulement un
`User-Agent` qui identifie l'application (voir
https://lrclib.net/docs#implementation-requirements).
"""

from __future__ import annotations

import json
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from typing import Any

from server.retrieve.models import normalize_text

from .models import Lyrics
from .parsers import parse_lrc, parse_lyricsfile

BASE_URL = "https://lrclib.net"
USER_AGENT = "night-light/2.0 (+https://github.com/MattiaPARRINELLO/night-light-v2)"
REQUEST_TIMEOUT_SEC = 8.0
# Écart de durée accepté entre la demande et un enregistrement de la base.
DURATION_TOLERANCE_SEC = 6.0
# Écart au-delà duquel l'enregistrement est considéré comme un autre morceau.
DURATION_REJECT_SEC = 15.0
# Score minimal pour accepter un résultat de recherche.
MIN_MATCH_SCORE = 2.0
# Plafond d'attente quand LRCLIB répond 429.
MAX_RETRY_AFTER_SEC = 30.0

Fetcher = Callable[[str], Any]


class LrclibError(Exception):
    """Erreur de communication avec LRCLIB."""


class LrclibRateLimited(LrclibError):
    """LRCLIB demande d'attendre avant de réessayer."""

    def __init__(self, message: str, retry_after_sec: float) -> None:
        super().__init__(message)
        self.retry_after_sec = retry_after_sec


def _http_get_json(url: str, *, user_agent: str, timeout_sec: float) -> Any:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": user_agent, "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_sec) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        if error.code == 429:
            retry_after = _retry_after_seconds(error)
            raise LrclibRateLimited("LRCLIB rate limit", retry_after) from error
        raise LrclibError(f"LRCLIB HTTP {error.code}") from error
    except (OSError, ValueError) as error:
        raise LrclibError(f"LRCLIB inaccessible: {error}") from error


def _retry_after_seconds(error: urllib.error.HTTPError) -> float:
    raw = error.headers.get("Retry-After") if error.headers else None
    try:
        value = float(raw) if raw is not None else 1.0
    except (TypeError, ValueError):
        value = 1.0
    return min(max(value, 0.0), MAX_RETRY_AFTER_SEC)


class LrclibClient:
    """Recherche et récupère des paroles sur LRCLIB."""

    provider = "lrclib"

    def __init__(
        self,
        *,
        base_url: str = BASE_URL,
        user_agent: str = USER_AGENT,
        timeout_sec: float = REQUEST_TIMEOUT_SEC,
        fetcher: Fetcher | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.user_agent = user_agent
        self.timeout_sec = timeout_sec
        self._fetcher = fetcher

    def search(
        self,
        track_name: str,
        artist_name: str = "",
        *,
        limit: int | None = None,
    ) -> tuple[Lyrics, ...]:
        """Renvoie les enregistrements correspondants, sans filtrage de score."""
        if not track_name.strip():
            raise ValueError("track_name is required")
        params: dict[str, Any] = {"track_name": track_name.strip()}
        if artist_name.strip():
            params["artist_name"] = artist_name.strip()
        records = self._request("/api/search", params)
        if not isinstance(records, list):
            return ()
        results = [self._to_lyrics(record) for record in records if isinstance(record, dict)]
        results = [lyrics for lyrics in results if lyrics is not None]
        return tuple(results[:limit] if limit else results)

    def get(self, record_id: int) -> Lyrics | None:
        """Récupère un enregistrement par son identifiant stable."""
        payload = self._request(f"/api/get/{int(record_id)}", {})
        if not isinstance(payload, dict):
            return None
        return self._to_lyrics(payload)

    def fetch(
        self,
        track_name: str,
        artist_name: str = "",
        duration_sec: float | None = None,
    ) -> Lyrics | None:
        """Cherche le meilleur enregistrement pour un morceau, ou None.

        Le score combine le titre, l'artiste et la durée ; un enregistrement
        synchronisé mot à mot est légèrement préféré à qualité égale.
        """
        best: Lyrics | None = None
        best_score = 0.0
        for lyrics in self.search(track_name, artist_name):
            score = _match_score(lyrics, track_name, artist_name, duration_sec)
            if score > best_score:
                best, best_score = lyrics, score
        if best is None or best_score < MIN_MATCH_SCORE:
            return None
        return best

    def _request(self, path: str, params: dict[str, Any]) -> Any:
        url = self.base_url + path
        if params:
            url = f"{url}?{urllib.parse.urlencode(params)}"
        fetch = self._fetcher or (
            lambda target: _http_get_json(
                target, user_agent=self.user_agent, timeout_sec=self.timeout_sec
            )
        )
        try:
            return fetch(url)
        except LrclibRateLimited as error:
            # Une seule reprise, avec jitter, pour ne pas marteler le service.
            delay = error.retry_after_sec * (1.0 + random.uniform(0.0, 0.3))
            time.sleep(delay)
            return fetch(url)

    def _to_lyrics(self, record: dict[str, Any]) -> Lyrics | None:
        record_id = record.get("id")
        if not isinstance(record_id, int):
            return None
        duration = record.get("duration")
        duration_ms = (
            int(round(float(duration) * 1000)) if isinstance(duration, (int, float)) else 0
        )
        instrumental = bool(record.get("instrumental"))
        plain = str(record.get("plainLyrics") or "")

        if instrumental:
            return Lyrics(
                record_id=record_id,
                track_name=str(record.get("trackName") or ""),
                artist_name=str(record.get("artistName") or ""),
                album_name=str(record.get("albumName") or ""),
                duration_ms=duration_ms,
                instrumental=True,
                provider=self.provider,
            )

        metadata: dict[str, Any] = {}
        lines = ()
        lyricsfile = record.get("lyricsfile")
        if record.get("hasWordSync") and isinstance(lyricsfile, str) and lyricsfile.strip():
            metadata, lines = parse_lyricsfile(lyricsfile)
        if not lines:
            synced = record.get("syncedLyrics")
            if isinstance(synced, str) and synced.strip():
                lines = parse_lrc(synced)

        return Lyrics(
            record_id=record_id,
            track_name=str(record.get("trackName") or ""),
            artist_name=str(record.get("artistName") or ""),
            album_name=str(record.get("albumName") or ""),
            duration_ms=duration_ms,
            language=str(metadata.get("language") or ""),
            lines=lines,
            plain_text=plain,
            provider=self.provider,
        )


def _match_score(
    lyrics: Lyrics,
    track_name: str,
    artist_name: str,
    duration_sec: float | None,
) -> float:
    wanted_title = normalize_text(track_name)
    found_title = normalize_text(lyrics.track_name)
    if wanted_title == found_title:
        score = 3.0
    elif wanted_title and (wanted_title in found_title or found_title in wanted_title):
        score = 1.5
    else:
        return 0.0

    wanted_artist = normalize_text(artist_name)
    if wanted_artist:
        found_artist = normalize_text(lyrics.artist_name)
        if not found_artist:
            pass
        elif wanted_artist == found_artist:
            score += 2.0
        elif wanted_artist in found_artist or found_artist in wanted_artist:
            score += 1.0
        else:
            # Même titre mais autre artiste : reprise ou homonyme, on écarte.
            return 0.0

    if duration_sec and lyrics.duration_ms:
        delta = abs(lyrics.duration_ms / 1000.0 - duration_sec)
        if delta <= DURATION_TOLERANCE_SEC:
            score += 1.0
        elif delta > DURATION_REJECT_SEC:
            score -= 1.0

    if lyrics.word_synced:
        score += 0.25
    return score


def fetch_lyrics(
    track_name: str,
    artist_name: str = "",
    duration_sec: float | None = None,
    *,
    client: LrclibClient | None = None,
) -> Lyrics | None:
    """Raccourci pour un appel ponctuel."""
    return (client or LrclibClient()).fetch(track_name, artist_name, duration_sec)
