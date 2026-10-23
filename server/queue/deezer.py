"""File Deezer : ID direct, ISRC, ou repli playlist/album public."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any

from ..retrieve.models import Candidate, TrackQuery
from .models import QueueSnapshot, QueueTrack

DEEZER_API = "https://api.deezer.com"


@dataclass
class DeezerLookup:
    candidate: Candidate | None
    method: str


def _get_json(url: str, timeout: float = 8.0) -> dict[str, Any]:
    request = urllib.request.Request(url, headers={"User-Agent": "night-light/2"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))
    return payload if isinstance(payload, dict) else {}


def _track_from_payload(payload: dict[str, Any], *, source: str = "deezer") -> QueueTrack | None:
    track_id = payload.get("id")
    title = str(payload.get("title") or payload.get("title_short") or "").strip()
    if not track_id or not title:
        return None
    artist = str((payload.get("artist") or {}).get("name") or "").strip()
    duration = payload.get("duration")
    try:
        duration_ms = int(float(duration) * 1000) if duration is not None else None
    except (TypeError, ValueError):
        duration_ms = None
    return QueueTrack(
        source=source,
        deezer_id=str(track_id),
        title=title,
        artist=artist,
        duration_ms=duration_ms,
    )


def candidate_for_queue_track(track: QueueTrack) -> Candidate:
    """Candidat direct à partir d'un ID Deezer, sans étape de recherche."""
    return Candidate(
        provider="deezer",
        source_id=str(track.deezer_id or ""),
        title=track.title,
        artist=track.artist,
        duration_sec=track.duration_sec or None,
    )


def lookup_isrc(isrc: str, *, expected_duration_sec: float = 0.0) -> DeezerLookup:
    """Résout un ISRC via l'API publique, avec contrôle de durée ±3 s."""
    if not isrc.strip():
        return DeezerLookup(None, "isrc_absent")
    try:
        payload = _get_json(f"{DEEZER_API}/track/isrc:{urllib.parse.quote(isrc.strip())}")
    except (OSError, urllib.error.URLError, ValueError):
        return DeezerLookup(None, "isrc_error")
    if payload.get("error") or not payload.get("id"):
        return DeezerLookup(None, "isrc_not_found")
    try:
        duration = float(payload.get("duration") or 0.0)
    except (TypeError, ValueError):
        duration = 0.0
    if expected_duration_sec > 0 and duration > 0 and abs(duration - expected_duration_sec) > 3.0:
        return DeezerLookup(None, "isrc_duration_mismatch")
    title = str(payload.get("title") or "").strip()
    artist = str((payload.get("artist") or {}).get("name") or "").strip()
    candidate = Candidate(
        provider="deezer",
        source_id=str(payload["id"]),
        title=title,
        artist=artist,
        duration_sec=duration or None,
    )
    return DeezerLookup(candidate, "isrc")


def lookup_for_queue_track(track: QueueTrack) -> DeezerLookup:
    """Ordre de résolution : ID Deezer, puis ISRC, sinon recherche."""
    if track.deezer_id:
        return DeezerLookup(candidate_for_queue_track(track), "deezer_id")
    if track.isrc:
        lookup = lookup_isrc(track.isrc, expected_duration_sec=track.duration_sec)
        if lookup.candidate is not None:
            return lookup
    return DeezerLookup(None, "search")


def track_query(track: QueueTrack, candidate: Candidate | None = None) -> TrackQuery:
    if candidate is not None:
        return TrackQuery(
            title=candidate.title or track.title,
            artist=candidate.artist or track.artist,
            duration_sec=candidate.duration_sec or track.duration_sec,
        )
    return TrackQuery(title=track.title, artist=track.artist, duration_sec=track.duration_sec)


def snapshot_from_userscript(payload: dict[str, Any]) -> QueueSnapshot:
    current_raw = payload.get("current")
    next_raw = payload.get("next")
    next_items = next_raw if isinstance(next_raw, list) else []
    return QueueSnapshot(
        provider="deezer_userscript",
        current=QueueTrack.from_dict(current_raw, default_source="deezer")
        if isinstance(current_raw, dict)
        else None,
        next=[
            QueueTrack.from_dict(item, default_source="deezer")
            for item in next_items[:3]
            if isinstance(item, dict)
        ],
        checked_at=float(payload.get("checkedAt") or 0.0) or time.time(),
        note=str(payload.get("note") or ""),
        resolution_method=str(payload.get("resolutionMethod") or ""),
    )


def snapshot_from_public_collection(kind: str, collection_id: str) -> QueueSnapshot:
    """Repli playlist/album détecté dans l'URL Deezer."""
    kind_path = "playlist" if kind == "playlist" else "album"
    try:
        payload = _get_json(f"{DEEZER_API}/{kind_path}/{urllib.parse.quote(collection_id)}")
    except (OSError, urllib.error.URLError, ValueError):
        return QueueSnapshot(provider="deezer_playlist", note="API Deezer indisponible")
    tracks = payload.get("tracks", {}).get("data", [])
    queue = [
        track
        for track in (_track_from_payload(item) for item in tracks if isinstance(item, dict))
        if track is not None
    ]
    return QueueSnapshot(
        provider=f"deezer_{kind_path}",
        current=queue[0] if queue else None,
        next=queue[1:4],
        checked_at=time.time(),
        note=f"{kind_path} {collection_id}",
        resolution_method="playlist",
    )
