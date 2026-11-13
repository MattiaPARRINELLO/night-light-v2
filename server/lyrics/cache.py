"""Cache disque des mots marquants, indexé par morceau et version de prompt.

Un morceau déjà traité ne rappelle jamais le modèle : les cues sont relus ici.
L'écriture est atomique (fichier temporaire puis `os.replace`).
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path

from .keywords import PROMPT_VERSION, LyricCues, cues_from_json, cues_to_json


def cue_cache_key(
    record_id: int,
    *,
    model: str,
    prompt_version: str = PROMPT_VERSION,
    max_keywords: int,
) -> str:
    """Clé stable : changer de modèle ou de prompt invalide les anciennes cues."""
    raw = f"{int(record_id)}|{model}|{prompt_version}|{int(max_keywords)}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


class CueCache:
    """Stocke les cues en JSON, une entrée par (morceau, modèle, prompt)."""

    def __init__(self, directory: Path) -> None:
        self.root = Path(directory)

    def path_for(self, key: str) -> Path:
        return self.root / f"{key}.json"

    def get(self, key: str) -> LyricCues | None:
        path = self.path_for(key)
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        return cues_from_json(payload) if isinstance(payload, dict) else None

    def put(self, key: str, cues: LyricCues) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        payload = json.loads(cues_to_json(cues))
        fd, temp_name = tempfile.mkstemp(prefix="cues-", suffix=".tmp", dir=str(self.root))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False)
            os.replace(temp_name, self.path_for(key))
        except Exception:
            Path(temp_name).unlink(missing_ok=True)
            raise
