"""Modèle commun de file d'attente, indépendant de la source."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable


@dataclass(frozen=True)
class QueueTrack:
    source: str
    title: str
    artist: str = ""
    duration_ms: int | None = None
    deezer_id: str | None = None
    spotify_id: str | None = None
    isrc: str | None = None

    @property
    def key(self) -> str:
        if self.deezer_id:
            return f"deezer:{self.deezer_id}"
        if self.isrc:
            return f"isrc:{self.isrc}"
        return f"text:{self.title.strip().lower()}|{self.artist.strip().lower()}"

    @property
    def duration_sec(self) -> float:
        return max(0.0, (self.duration_ms or 0) / 1000.0)

    def to_dict(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "deezerId": self.deezer_id,
            "spotifyId": self.spotify_id,
            "isrc": self.isrc,
            "title": self.title,
            "artist": self.artist,
            "durationMs": self.duration_ms,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any], *, default_source: str = "deezer") -> QueueTrack:
        def text(*names: str) -> str:
            for name in names:
                value = payload.get(name)
                if isinstance(value, str) and value.strip():
                    return value.strip()
            return ""

        raw_duration = payload.get("durationMs", payload.get("duration_ms"))
        try:
            duration_ms = int(raw_duration) if raw_duration is not None else None
        except (TypeError, ValueError):
            duration_ms = None
        return cls(
            source=text("source") or default_source,
            deezer_id=text("deezerId", "deezer_id") or None,
            spotify_id=text("spotifyId", "spotify_id") or None,
            isrc=text("isrc") or None,
            title=text("title"),
            artist=text("artist"),
            duration_ms=duration_ms,
        )


@dataclass
class QueueSnapshot:
    provider: str = "mpris"
    current: QueueTrack | None = None
    next: list[QueueTrack] = field(default_factory=list)
    checked_at: float = 0.0
    note: str = ""
    resolution_method: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "current": self.current.to_dict() if self.current else None,
            "next": [track.to_dict() for track in self.next[:3]],
            "checkedAt": self.checked_at,
            "note": self.note,
            "resolutionMethod": self.resolution_method,
        }


@runtime_checkable
class QueueProvider(Protocol):
    name: str

    def current(self) -> QueueTrack | None: ...

    def next(self, count: int = 3) -> list[QueueTrack]: ...
