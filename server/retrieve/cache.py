"""Cache persistant des morceaux déjà récupérés."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
import threading
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from .models import Candidate, TrackQuery, audio_cache_key, normalize_text


class AudioCacheError(Exception):
    """Erreur liée au cache audio."""


@dataclass(frozen=True)
class CacheEntry:
    key: str
    path: Path
    size_bytes: int
    content_hash: str
    created_at: float
    duration_sec: float | None = None
    provider: str = ""
    title: str = ""
    artist: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["path"] = str(self.path)
        return payload

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "CacheEntry":
        data = dict(payload)
        data["path"] = Path(data["path"])
        known = {f.name for f in cls.__dataclass_fields__.values()}
        return cls(**{k: v for k, v in data.items() if k in known})


def _safe_suffix(path: Path | str) -> str:
    suffix = Path(path).suffix.lower().strip()
    if not suffix or len(suffix) > 12:
        return ".bin"
    if any(ch not in ".abcdefghijklmnopqrstuvwxyz0123456789" for ch in suffix):
        return ".bin"
    return suffix


class AudioCache:
    """Cache disque à clé, avec verrou par entrée et sidecar JSON."""

    def __init__(self, root: Path | str, *, version: int = 1) -> None:
        self.root = Path(root).expanduser().resolve()
        self.version = version
        self.root.mkdir(parents=True, exist_ok=True)
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()

    def lock_for(self, key: str) -> threading.Lock:
        with self._locks_guard:
            lock = self._locks.get(key)
            if lock is None:
                lock = threading.RLock()
                self._locks[key] = lock
            return lock

    def _entry_dir(self, key: str) -> Path:
        if not key or "/" in key or "\\" in key or ".." in key:
            raise AudioCacheError(f"invalid cache key: {key!r}")
        return self.root / key

    def _metadata_path(self, key: str) -> Path:
        return self._entry_dir(key) / "metadata.json"

    def _find_audio_path(self, entry_dir: Path) -> Path | None:
        candidates = sorted(p for p in entry_dir.glob("audio.*") if p.is_file())
        if not candidates:
            return None
        # Préfère un fichier explicitement nommé audio.<ext>.
        return candidates[0]

    def _hash_file(self, path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    def get(self, key: str, *, validate_hash: bool = False) -> CacheEntry | None:
        entry_dir = self._entry_dir(key)
        metadata_path = entry_dir / "metadata.json"
        if not metadata_path.is_file():
            return None
        try:
            payload = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            self.remove(key)
            return None
        if payload.get("version", 1) != self.version:
            self.remove(key)
            return None
        audio_path = self._find_audio_path(entry_dir)
        if audio_path is None or not audio_path.is_file():
            self.remove(key)
            return None
        entry = CacheEntry.from_dict({**payload, "key": key, "path": str(audio_path)})
        expected_size = entry.size_bytes
        actual_size = audio_path.stat().st_size
        if expected_size and actual_size != expected_size:
            self.remove(key)
            return None
        if validate_hash:
            try:
                if self._hash_file(audio_path) != entry.content_hash:
                    self.remove(key)
                    return None
            except OSError:
                self.remove(key)
                return None
        return entry

    def put(
        self,
        key: str,
        source_path: Path | str,
        *,
        duration_sec: float | None = None,
        provider: str = "",
        title: str = "",
        artist: str = "",
        metadata: dict[str, Any] | None = None,
    ) -> CacheEntry:
        source_path = Path(source_path)
        if not source_path.is_file():
            raise AudioCacheError(f"source audio introuvable: {source_path}")
        lock = self.lock_for(key)
        with lock:
            entry_dir = self._entry_dir(key)
            entry_dir.mkdir(parents=True, exist_ok=True)
            suffix = _safe_suffix(source_path)
            audio_name = f"audio{suffix}"
            target_path = entry_dir / audio_name

            # Nettoie les anciens fichiers audio du même répertoire.
            for old in entry_dir.glob("audio.*"):
                if old.name != audio_name and old.is_file():
                    old.unlink(missing_ok=True)

            content_hash = self._hash_file(source_path)
            size_bytes = source_path.stat().st_size

            temp_dir = None
            try:
                fd, temp_name = tempfile.mkstemp(prefix="audio-", suffix=suffix, dir=str(entry_dir))
                os.close(fd)
                temp_path = Path(temp_name)
                temp_dir = None
                shutil.copyfile(source_path, temp_path)
                os.replace(temp_path, target_path)

                entry = CacheEntry(
                    key=key,
                    path=target_path,
                    size_bytes=size_bytes,
                    content_hash=content_hash,
                    created_at=time.time(),
                    duration_sec=duration_sec,
                    provider=provider,
                    title=title or source_path.stem,
                    artist=artist,
                    metadata=dict(metadata or {}),
                )
                metadata_payload = {**entry.to_dict(), "version": self.version}
                metadata_payload.pop("path", None)
                metadata_payload["path"] = str(target_path)

                metadata_tmp_fd, metadata_tmp_name = tempfile.mkstemp(prefix="metadata-", dir=str(entry_dir))
                os.close(metadata_tmp_fd)
                metadata_tmp_path = Path(metadata_tmp_name)
                metadata_tmp_path.write_text(
                    json.dumps(metadata_payload, ensure_ascii=False, indent=2, sort_keys=True),
                    encoding="utf-8",
                )
                os.replace(metadata_tmp_path, self._metadata_path(key))
                return entry
            except Exception as error:  # noqa: BLE001 - convertit pour l'appelant
                # Nettoyage défensif en cas d'échec partiel.
                for tmp in entry_dir.glob("audio-*"):
                    if tmp.is_file():
                        tmp.unlink(missing_ok=True)
                for tmp in entry_dir.glob("metadata-*"):
                    if tmp.is_file():
                        tmp.unlink(missing_ok=True)
                raise AudioCacheError(f"échec d'écriture cache: {error}") from error
            finally:
                if temp_dir is not None:
                    shutil.rmtree(temp_dir, ignore_errors=True)

    def remove(self, key: str) -> None:
        lock = self.lock_for(key)
        with lock:
            entry_dir = self._entry_dir(key)
            if entry_dir.exists():
                shutil.rmtree(entry_dir, ignore_errors=True)

    def clear(self) -> int:
        count = 0
        if not self.root.is_dir():
            return count
        for entry in self.root.iterdir():
            if entry.is_dir():
                shutil.rmtree(entry, ignore_errors=True)
                count += 1
            elif entry.is_file():
                entry.unlink(missing_ok=True)
                count += 1
        return count

    def get_entry_for_query(self, query: TrackQuery) -> CacheEntry | None:
        return self.get(audio_cache_key(query))

    def put_for_query(
        self,
        query: TrackQuery,
        source_path: Path | str,
        *,
        candidate_provider: str = "",
        metadata: dict[str, Any] | None = None,
    ) -> CacheEntry:
        return self.put(
            audio_cache_key(query),
            source_path,
            duration_sec=query.duration_sec,
            provider=candidate_provider,
            title=query.title,
            artist=query.artist,
            metadata=metadata,
        )

    @staticmethod
    def normalize_title(value: str | None) -> str:
        return normalize_text(value)
