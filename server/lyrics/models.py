"""Modèles de paroles synchronisées, indépendants du fournisseur.

Les timings sont exprimés en millisecondes depuis le début du morceau, comme
dans le format Lyricsfile de LRCLIB et dans le LRC.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

# Durée retenue pour la dernière ligne d'un LRC, qui ne porte pas de fin.
DEFAULT_LAST_LINE_MS = 4_000


@dataclass(frozen=True)
class LyricWord:
    """Un mot (ou un fragment) avec ses bornes temporelles."""

    text: str
    start_ms: int
    end_ms: int

    @property
    def duration_ms(self) -> int:
        return max(0, self.end_ms - self.start_ms)

    def as_dict(self) -> dict[str, Any]:
        return {"text": self.text, "startMs": self.start_ms, "endMs": self.end_ms}


@dataclass(frozen=True)
class LyricLine:
    """Une ligne de paroles, avec un découpage optionnel en mots."""

    text: str
    start_ms: int
    end_ms: int
    words: tuple[LyricWord, ...] = ()

    @property
    def word_synced(self) -> bool:
        return len(self.words) > 0

    def as_dict(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "startMs": self.start_ms,
            "endMs": self.end_ms,
            "words": [word.as_dict() for word in self.words],
        }


@dataclass(frozen=True)
class Lyrics:
    """Paroles d'un morceau, éventuellement synchronisées mot à mot."""

    record_id: int
    track_name: str
    artist_name: str
    album_name: str = ""
    duration_ms: int = 0
    instrumental: bool = False
    language: str = ""
    lines: tuple[LyricLine, ...] = ()
    plain_text: str = ""
    provider: str = "lrclib"

    @property
    def timed(self) -> bool:
        """Vrai si les lignes portent des timings exploitables."""
        return len(self.lines) > 0

    @property
    def word_synced(self) -> bool:
        """Vrai si au moins une ligne est découpée en mots."""
        return any(line.word_synced for line in self.lines)

    def line_at(self, position_ms: int) -> LyricLine | None:
        """Ligne affichée à une position donnée, ou None avant la première."""
        found: LyricLine | None = None
        for line in self.lines:
            if line.start_ms > position_ms:
                break
            found = line
        return found

    def word_at(self, position_ms: int) -> LyricWord | None:
        """Mot en cours à une position donnée, ou None si la ligne n'en a pas."""
        line = self.line_at(position_ms)
        if line is None:
            return None
        found: LyricWord | None = None
        for word in line.words:
            if word.start_ms > position_ms:
                break
            found = word
        return found

    def as_dict(self) -> dict[str, Any]:
        return {
            "recordId": self.record_id,
            "trackName": self.track_name,
            "artistName": self.artist_name,
            "albumName": self.album_name,
            "durationMs": self.duration_ms,
            "instrumental": self.instrumental,
            "language": self.language,
            "provider": self.provider,
            "wordSynced": self.word_synced,
            "plainText": self.plain_text,
            "lines": [line.as_dict() for line in self.lines],
        }
