"""Assemblage des paroles et des mots marquants pour un morceau.

Le service est appelé au moment de servir une analyse, jamais pendant le rendu :
le navigateur reçoit un payload prêt à afficher. Les cues issus du modèle sont
mis en cache disque, les replis locaux ne le sont pas (ils seront retentés).
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Any

from server.retrieve.models import TrackQuery

from .cache import CueCache, cue_cache_key
from .groq import GroqClient
from .keywords import DEFAULT_MAX_KEYWORDS, LyricCues, extract_cues
from .lrclib import LrclibClient
from .models import Lyrics

_LOGGER = logging.getLogger(__name__)
_MEMO_LIMIT = 64


class LyricsService:
    """Renvoie un payload JSON de paroles pour un morceau, ou None."""

    def __init__(
        self,
        cache_dir: Path,
        *,
        client: LrclibClient | None = None,
        groq: GroqClient | None = None,
        max_keywords: int = DEFAULT_MAX_KEYWORDS,
    ) -> None:
        self.client = client or LrclibClient()
        self.groq = groq or GroqClient()
        self.max_keywords = max_keywords
        self.cache = CueCache(Path(cache_dir))
        self._memo: dict[str, dict[str, Any] | None] = {}
        self._lock = threading.Lock()

    def for_track(self, track: TrackQuery, *, allow_network: bool = True) -> dict[str, Any] | None:
        """Payload prêt à servir. `allow_network=False` ne lit que le mémo."""
        key = self._memo_key(track)
        with self._lock:
            if key in self._memo:
                return self._memo[key]
        if not allow_network:
            return None
        payload = self._build(track)
        with self._lock:
            if len(self._memo) >= _MEMO_LIMIT:
                self._memo.clear()
            self._memo[key] = payload
        return payload

    def _memo_key(self, track: TrackQuery) -> str:
        return (
            f"{track.normalized_title}|{track.normalized_artist}|"
            f"{round(float(track.duration_sec), 1)}"
        )

    def _build(self, track: TrackQuery) -> dict[str, Any] | None:
        try:
            lyrics = self.client.fetch(track.title, track.artist, track.duration_sec or None)
        except Exception as error:  # noqa: BLE001 - un service externe ne casse pas l'analyse
            _LOGGER.warning("Recherche de paroles impossible pour %r: %s", track.title, error)
            return None
        if lyrics is None:
            return None
        cues = self._cues_for(lyrics)
        return {
            "recordId": lyrics.record_id,
            "wordSynced": lyrics.word_synced,
            "keywords": [cue.as_dict() for cue in cues.keywords],
            "chorusLines": list(cues.chorus_lines),
            "lines": [line.as_dict() for line in lyrics.lines],
            "source": cues.source,
            "model": cues.model,
        }

    def _cues_for(self, lyrics: Lyrics) -> LyricCues:
        key = cue_cache_key(
            lyrics.record_id,
            model=self.groq.model,
            max_keywords=self.max_keywords,
        )
        cached = self.cache.get(key)
        if cached is not None:
            return cached
        cues = extract_cues(lyrics, client=self.groq, max_keywords=self.max_keywords)
        if cues.source == "llm":
            try:
                self.cache.put(key, cues)
            except OSError as error:
                _LOGGER.warning("Écriture du cache de cues impossible: %s", error)
        return cues
