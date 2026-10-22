"""Cache persistant des analyses, indexé par morceau et version d'analyseur.

Le cache audio évite de re-télécharger ; celui-ci évite de ré-analyser. La clé
reprend la clé du cache audio (`audio_cache_key`, donc titre/artiste/durée) et la
version de l'analyseur : une évolution de l'algorithme invalide donc proprement
les anciennes entrées au lieu de servir un résultat périmé.

Les écritures sont atomiques (fichier temporaire puis `os.replace`) et les
entrées sont purgées en LRU au-delà d'une taille maximale configurable.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
import time
from contextlib import suppress
from pathlib import Path
from typing import Any

_SAFE = re.compile(r"[^a-zA-Z0-9._-]+")


def _safe_part(value: str) -> str:
    cleaned = _SAFE.sub("_", value).strip("._")
    return cleaned or "default"


class AnalysisCache:
    """Analyses JSON sur disque, avec écriture atomique et purge LRU."""

    def __init__(
        self,
        root: Path | str,
        *,
        version: str,
        max_bytes: int = 0,
    ) -> None:
        self.root = Path(root).expanduser().resolve()
        self.version = str(version)
        self.max_bytes = max(0, int(max_bytes))
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def path_for(self, key: str) -> Path:
        """Chemin de l'entrée : clé du morceau + version de l'analyseur."""
        return self.root / f"{_safe_part(key)}-{_safe_part(self.version)}.json"

    def get(self, key: str) -> dict[str, Any] | None:
        """Analyse en cache, ou `None` si absente, illisible ou d'une autre version."""
        path = self.path_for(key)
        if not path.is_file():
            return None
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            # JSON corrompu : on l'écarte, l'appelant réanalysera.
            path.unlink(missing_ok=True)
            return None
        if not isinstance(payload, dict):
            path.unlink(missing_ok=True)
            return None
        if payload.get("version") != self.version or payload.get("key") != key:
            return None
        analysis = payload.get("analysis")
        if not isinstance(analysis, dict) or "duration" not in analysis:
            path.unlink(missing_ok=True)
            return None
        # Marque l'entrée comme récemment utilisée pour la purge LRU.
        with suppress(OSError):
            os.utime(path, None)
        return analysis

    def put(self, key: str, analysis: dict[str, Any]) -> None:
        """Écrit l'analyse de façon atomique, puis applique la purge LRU."""
        payload = {
            "version": self.version,
            "key": key,
            "savedAt": time.time(),
            "analysis": analysis,
        }
        with self._lock:
            self.root.mkdir(parents=True, exist_ok=True)
            fd, temp_name = tempfile.mkstemp(prefix="analysis-", suffix=".tmp", dir=str(self.root))
            os.close(fd)
            temp_path = Path(temp_name)
            try:
                temp_path.write_text(
                    json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                    encoding="utf-8",
                )
                os.replace(temp_path, self.path_for(key))
            finally:
                temp_path.unlink(missing_ok=True)
            self._purge_locked()

    def purge(self) -> int:
        """Applique la purge LRU et renvoie le nombre de fichiers supprimés."""
        with self._lock:
            return self._purge_locked()

    def _purge_locked(self) -> int:
        if self.max_bytes <= 0:
            return 0
        entries: list[tuple[Path, int, float]] = []
        total = 0
        for path in self.root.glob("*.json"):
            try:
                stat = path.stat()
            except OSError:
                continue
            entries.append((path, stat.st_size, stat.st_mtime))
            total += stat.st_size
        if total <= self.max_bytes:
            return 0
        removed = 0
        for path, size, _ in sorted(entries, key=lambda item: item[2]):
            if total <= self.max_bytes:
                break
            try:
                path.unlink()
            except OSError:
                continue
            total -= size
            removed += 1
        return removed
