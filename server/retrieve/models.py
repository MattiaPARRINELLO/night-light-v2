"""Modèles et types partagés pour le retrieval audio."""

from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


def normalize_text(value: str | None) -> str:
    """Normalise un titre/artiste pour comparaison et mise en cache."""
    if not value:
        return ""
    value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    value = value.lower()
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return " ".join(value.split())


@dataclass(frozen=True)
class TrackQuery:
    """Métadonnées minimales reçues pour identifier un morceau."""

    title: str
    artist: str = ""
    duration_sec: float = 0.0

    def __post_init__(self) -> None:
        if not self.title or not self.title.strip():
            raise ValueError("title is required")
        if self.duration_sec < 0:
            raise ValueError("duration_sec must be non-negative")

    @property
    def normalized_title(self) -> str:
        return normalize_text(self.title)

    @property
    def normalized_artist(self) -> str:
        return normalize_text(self.artist)


@dataclass
class Candidate:
    """Source candidate trouvée par un fournisseur."""

    provider: str
    source_id: str
    title: str = ""
    artist: str = ""
    duration_sec: float | None = None
    url: str | None = None
    local_path: Path | None = None
    container: str = ""
    codec: str = ""
    bitrate: int | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    is_preview: bool = False

    @property
    def normalized_title(self) -> str:
        raw = self.title or str(self.metadata.get("title", ""))
        return normalize_text(raw)

    @property
    def normalized_artist(self) -> str:
        raw = self.artist or str(self.metadata.get("artist", ""))
        return normalize_text(raw)


@dataclass(frozen=True)
class MatchScore:
    title: float
    artist: float
    duration: float

    @property
    def total(self) -> float:
        return self.title + self.artist + self.duration


@dataclass(frozen=True)
class MatchResult:
    accepted: bool
    score: float
    max_score: float
    duration_delta_sec: float | None
    reasons: tuple[str, ...] = ()


def audio_cache_key(query: TrackQuery) -> str:
    """Clé stable pour le cache persistant, fondée sur les métadonnées."""
    raw = (
        f"{query.normalized_title}|{query.normalized_artist}|"
        f"{round(float(query.duration_sec), 3)}"
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()
