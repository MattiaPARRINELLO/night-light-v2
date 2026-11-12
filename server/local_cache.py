"""Cache persistant des morceaux déposés à la main.

Un MP3 déposé sur le dashboard est analysé une fois puis conservé avec son audio
et son analyse dans un répertoire stable. Quand le même morceau est ensuite joué
sur le PC (MPRIS), la résolution le retrouve par métadonnées et le show se cale
sur l'analyse déjà en cache, au lieu de re-télécharger ou de ré-analyser.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import threading
import time
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .retrieve.models import normalize_text


@dataclass(frozen=True)
class CachedUpload:
    """Entrée locale : audio, analyse et métadonnées d'un dépôt manuel."""

    key: str
    audio_path: Path
    analysis: dict[str, Any]
    title: str
    artist: str
    duration_sec: float
    filename: str
    saved_at: float


def probe_metadata(path: Path, fallback_name: str) -> tuple[str, str, float | None]:
    """Titre, artiste et durée d'un fichier audio.

    `ffprobe` lit les tags ID3/MP4 ; s'il est absent ou muet, on retombe sur le
    nom de fichier « Artiste - Titre » puis sur le nom brut.
    """
    title = ""
    artist = ""
    duration: float | None = None
    try:
        completed = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration:format_tags=title,artist",
                "-of",
                "json",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        if completed.returncode == 0 and completed.stdout.strip():
            payload = json.loads(completed.stdout)
            fmt = payload.get("format") or {}
            tags = {str(k).lower(): v for k, v in (fmt.get("tags") or {}).items()}
            title = str(tags.get("title") or "").strip()
            artist = str(tags.get("artist") or "").strip()
            raw_duration = fmt.get("duration")
            if raw_duration is not None:
                value = float(raw_duration)
                if value > 0:
                    duration = value
    except (OSError, ValueError, TypeError, subprocess.SubprocessError, json.JSONDecodeError):
        pass

    stem = Path(fallback_name).stem.strip()
    if not title:
        parts = [part.strip() for part in stem.split(" - ", 1)]
        if len(parts) == 2 and parts[0] and parts[1]:
            artist = artist or parts[0]
            title = parts[1]
        else:
            title = stem or "morceau"
    if not artist:
        artist = ""
    return title, artist, duration


def content_hash(data: bytes) -> str:
    """Empreinte stable d'un fichier déposé, utilisée comme clé de cache."""
    return hashlib.sha256(data).hexdigest()


def _atomic_write(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix="local-", suffix=".tmp", dir=str(path.parent))
    os.close(fd)
    temp = Path(temp_name)
    try:
        temp.write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


class LocalUploadCache:
    """Dépôts manuels conservés sous `cache_dir/local-uploads` avec un index JSON."""

    def __init__(self, root: Path | str, *, max_bytes: int = 0) -> None:
        self.root = Path(root).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.index_path = self.root / "index.json"
        self.max_bytes = max(0, int(max_bytes))
        self._lock = threading.Lock()

    def _read_index(self) -> list[dict[str, Any]]:
        if not self.index_path.is_file():
            return []
        try:
            payload = json.loads(self.index_path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            return []
        entries = payload.get("entries") if isinstance(payload, dict) else payload
        if not isinstance(entries, list):
            return []
        return [entry for entry in entries if isinstance(entry, dict)]

    def _write_index(self, entries: list[dict[str, Any]]) -> None:
        _atomic_write(self.index_path, {"version": 1, "entries": entries})

    def put(
        self,
        audio_path: Path,
        analysis: dict[str, Any],
        *,
        key: str,
        title: str,
        artist: str,
        filename: str,
        duration_sec: float | None = None,
    ) -> CachedUpload:
        """Copie l'audio et l'analyse dans une entrée stable, puis met l'index à jour."""
        with self._lock:
            entry_dir = self.root / key
            entry_dir.mkdir(parents=True, exist_ok=True)
            suffix = audio_path.suffix.lower() or ".bin"
            cached_audio = entry_dir / f"audio{suffix}"
            if audio_path.resolve() != cached_audio.resolve():
                shutil.copy2(audio_path, cached_audio)
            _atomic_write(
                entry_dir / "analysis.json",
                {"savedAt": time.time(), "analysis": analysis},
            )
            duration = float(
                duration_sec
                if duration_sec is not None and duration_sec > 0
                else analysis.get("duration") or 0.0
            )
            meta = {
                "key": key,
                "title": title.strip(),
                "artist": artist.strip(),
                "durationSec": duration,
                "filename": filename,
                "audio": cached_audio.name,
                "savedAt": time.time(),
            }
            _atomic_write(entry_dir / "meta.json", meta)

            entries = [entry for entry in self._read_index() if entry.get("key") != key]
            entries.append(meta)
            self._write_index(entries)
            self._purge_locked(entries)
            return CachedUpload(
                key=key,
                audio_path=cached_audio,
                analysis=analysis,
                title=meta["title"],
                artist=meta["artist"],
                duration_sec=duration,
                filename=filename,
                saved_at=meta["savedAt"],
            )

    def find(
        self,
        title: str,
        artist: str = "",
        duration_sec: float = 0.0,
        *,
        tolerance_sec: float = 3.0,
    ) -> CachedUpload | None:
        """Retrouve un dépôt manuel par titre/artiste/durée."""
        wanted_title = normalize_text(title)
        if not wanted_title:
            return None
        wanted_artist = normalize_text(artist)
        best: tuple[float, dict[str, Any]] | None = None
        with self._lock:
            entries = self._read_index()
        for entry in entries:
            if normalize_text(str(entry.get("title", ""))) != wanted_title:
                continue
            entry_artist = normalize_text(str(entry.get("artist", "")))
            if wanted_artist and entry_artist and entry_artist != wanted_artist:
                continue
            entry_duration = float(entry.get("durationSec") or 0.0)
            if duration_sec > 0 and entry_duration > 0:
                delta = abs(entry_duration - duration_sec)
                if delta > tolerance_sec:
                    continue
            else:
                delta = 0.0
            if best is None:
                best = (delta, entry)
                continue
            best_delta, best_entry = best
            best_saved = float(best_entry.get("savedAt") or 0.0)
            if delta < best_delta or (
                delta == best_delta and float(entry.get("savedAt") or 0.0) > best_saved
            ):
                best = (delta, entry)
        if best is None:
            return None
        return self._load(best[1])

    def get(self, key: str) -> CachedUpload | None:
        with self._lock:
            entry = next((item for item in self._read_index() if item.get("key") == key), None)
        return self._load(entry) if entry is not None else None

    def _load(self, entry: dict[str, Any]) -> CachedUpload | None:
        try:
            entry_dir = self.root / str(entry["key"])
            audio_path = entry_dir / str(entry.get("audio") or "audio.bin")
            analysis_payload = json.loads((entry_dir / "analysis.json").read_text(encoding="utf-8"))
            analysis = analysis_payload.get("analysis")
            if not audio_path.is_file() or not isinstance(analysis, dict):
                return None
            with suppress(OSError):
                os.utime(entry_dir, None)
            return CachedUpload(
                key=str(entry["key"]),
                audio_path=audio_path,
                analysis=analysis,
                title=str(entry.get("title") or ""),
                artist=str(entry.get("artist") or ""),
                duration_sec=float(entry.get("durationSec") or analysis.get("duration") or 0.0),
                filename=str(entry.get("filename") or audio_path.name),
                saved_at=float(entry.get("savedAt") or 0.0),
            )
        except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError):
            return None

    def _purge_locked(self, entries: list[dict[str, Any]]) -> None:
        if self.max_bytes <= 0:
            return
        sizes: list[tuple[dict[str, Any], int, float]] = []
        total = 0
        for entry in entries:
            entry_dir = self.root / str(entry.get("key"))
            size = 0
            with suppress(OSError):
                for path in entry_dir.rglob("*"):
                    if path.is_file():
                        size += path.stat().st_size
            total += size
            sizes.append((entry, size, float(entry.get("savedAt") or 0.0)))
        if total <= self.max_bytes:
            return
        kept: list[dict[str, Any]] = []
        for entry, size, _ in sorted(sizes, key=lambda item: item[2], reverse=True):
            if total > self.max_bytes:
                shutil.rmtree(self.root / str(entry.get("key")), ignore_errors=True)
                total -= size
                continue
            kept.append(entry)
        self._write_index(sorted(kept, key=lambda item: float(item.get("savedAt") or 0.0)))
