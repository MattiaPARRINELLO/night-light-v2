"""Sélection de la file et préchargement des morceaux suivants."""

from __future__ import annotations

import contextlib
import threading
import time
from dataclasses import replace
from pathlib import Path
from typing import Any

from ..analysis import PersistentAnalysis
from ..retrieve.cache import AudioCache
from ..retrieve.deezer import DeezerProvider
from ..retrieve.models import audio_cache_key
from ..retrieve.resolver import RetrievalError, resolve_track
from .deezer import lookup_for_queue_track, track_query
from .models import QueueSnapshot, QueueTrack
from .spotify import SpotifyQueueProvider, load_spotify_config


class QueueManager:
    def __init__(self, settings: Any, state: Any) -> None:
        self.settings = settings
        self.state = state
        self.spotify = SpotifyQueueProvider(load_spotify_config(settings.port))
        self.deezer_snapshot: QueueSnapshot | None = None
        self.snapshot = QueueSnapshot(provider="mpris", note="MPRIS seul")
        self.preload = PreloadManager(settings, state, self)
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._last_spotify = 0.0
        self._last_mpris_key = ""
        self._last_mpris_refresh = 0.0

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._poll_loop, name="queue-manager", daemon=True)
        self._thread.start()
        self.preload.start()

    def stop(self) -> None:
        self._stop.set()
        self.preload.stop()
        if self._thread is not None:
            self._thread.join(timeout=2.0)

    def _poll_loop(self) -> None:
        while not self._stop.is_set():
            with contextlib.suppress(Exception):
                self.refresh()
            self._stop.wait(10.0)

    def on_mpris_change(self, player: str, title: str, artist: str) -> None:
        key = f"{title}|{artist}"
        if key == self._last_mpris_key:
            return
        self._last_mpris_key = key
        now = time.time()
        if "spotify" in player.lower():
            # Revalide la file à chaque changement de morceau, pas à chaque event.
            if now - self._last_mpris_refresh >= 2.0:
                self._last_mpris_refresh = now
                self.refresh(force_spotify=True)
            return
        # Un lecteur Deezer/navigateur : le userscript pousse la file.
        if self.deezer_snapshot is not None and time.time() - self.deezer_snapshot.checked_at < 30:
            self._apply(self.deezer_snapshot)
            return
        self.refresh()

    def update_deezer(self, payload: dict[str, Any]) -> QueueSnapshot:
        from .deezer import snapshot_from_userscript

        snapshot = snapshot_from_userscript(payload)
        if not snapshot.current and payload.get("url"):
            from .deezer import snapshot_from_public_collection

            url = str(payload.get("url") or "")
            parts = [part for part in url.split("?")[0].split("/") if part]
            for index, part in enumerate(parts):
                if part in {"playlist", "album"} and index + 1 < len(parts):
                    snapshot = snapshot_from_public_collection(part, parts[index + 1])
                    break
        with self._lock:
            self.deezer_snapshot = snapshot
        self._apply(snapshot)
        return snapshot

    def refresh(self, *, force_spotify: bool = False) -> QueueSnapshot:
        now = time.time()
        if self.spotify.configured and (force_spotify or now - self._last_spotify >= 10.0):
            self._last_spotify = now
            snapshot = self.spotify.refresh_snapshot()
            if snapshot.current or snapshot.next:
                self._apply(snapshot)
                return snapshot
        if self.deezer_snapshot is not None and now - self.deezer_snapshot.checked_at < 30:
            self._apply(self.deezer_snapshot)
            return self.deezer_snapshot
        mpris = self.state.now_playing_key
        if self.spotify.configured:
            snapshot = self.spotify.refresh_snapshot()
            self._apply(snapshot)
            return snapshot
        self.snapshot = QueueSnapshot(
            provider="mpris",
            current=QueueTrack(
                source="mpris",
                title=mpris.split("|", 1)[0] if mpris else "",
                artist=mpris.split("|", 1)[1] if "|" in mpris else "",
            )
            if mpris
            else None,
            checked_at=now,
            note="MPRIS seul",
        )
        return self.snapshot

    def _apply(self, snapshot: QueueSnapshot) -> None:
        self.snapshot = snapshot
        self.preload.update(snapshot)

    def status(self) -> dict[str, Any]:
        return {
            **self.snapshot.to_dict(),
            "spotifyConfigured": self.spotify.configured,
            "preload": self.preload.status(),
        }


class PreloadManager:
    """Précharge les 2 morceaux suivants avec un worker d'analyse dédié."""

    def __init__(self, settings: Any, state: Any, queue: QueueManager) -> None:
        self.settings = settings
        self.state = state
        self.queue = queue
        self._lock = threading.Lock()
        self._tasks: list[QueueTrack] = []
        self._status: dict[str, dict[str, Any]] = {}
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._engine: PersistentAnalysis | None = None
        self._active_key = ""

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="preload", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        if self._engine is not None:
            self._engine.stop()
            self._engine = None
        if self._thread is not None:
            self._thread.join(timeout=2.0)

    def update(self, snapshot: QueueSnapshot) -> None:
        wanted = [
            track
            for track in snapshot.next[:2]
            if track.title and (not snapshot.current or track.key != snapshot.current.key)
        ]
        with self._lock:
            self._tasks = wanted
            for track in wanted:
                self._status.setdefault(
                    track.key,
                    {
                        "title": track.title,
                        "artist": track.artist,
                        "source": track.source,
                        "state": "queued",
                        "method": "en attente",
                        "startedAt": 0.0,
                        "finishedAt": 0.0,
                        "error": "",
                    },
                )
        self._wake.set()

    def status(self) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(item, key=key) for key, item in self._status.items()]

    def _set(self, key: str, **patch: Any) -> None:
        with self._lock:
            if key in self._status:
                self._status[key].update(patch)

    def _run(self) -> None:
        while not self._stop.is_set():
            self._wake.wait(1.0)
            self._wake.clear()
            if self._stop.is_set():
                return
            with self._lock:
                tasks = list(self._tasks)
            for track in tasks:
                if self._stop.is_set():
                    return
                with self._lock:
                    status = self._status.get(track.key, {})
                if status.get("state") in {"ready", "analyzing", "resolving"}:
                    continue
                if track.key == self._active_key:
                    continue
                # Le courant passe toujours devant : on attend qu'aucune
                # résolution courante ne soit en cours avant de précharger.
                while (
                    getattr(self.state, "resolve_pending", False)
                    or getattr(self.state, "active_analyses", 0) > 0
                ) and not self._stop.is_set():
                    self._stop.wait(0.2)
                if self._stop.is_set():
                    return
                self._preload(track)

    def _preload(self, track: QueueTrack) -> None:
        key = track.key
        self._active_key = key
        self._set(key, state="resolving", method="résolution", startedAt=time.time())
        cache = AudioCache(Path(self.settings.cache_dir))
        if not self.settings.deezer_arl:
            self._set(
                key,
                state="error",
                method="deezer_non_configuré",
                error="DEEZER_ARL absent",
                finishedAt=time.time(),
            )
            self._active_key = ""
            return
        provider = DeezerProvider(
            arl=self.settings.deezer_arl,
            work_dir=Path(self.settings.cache_dir) / "streamrip",
        )
        lookup = lookup_for_queue_track(track)
        query = track_query(track, lookup.candidate)
        audio_key = audio_cache_key(query)
        analysis_key = audio_key
        analysis_cache = getattr(self.state, "analysis_cache", None)
        cached_analysis = analysis_cache.get(analysis_key) if analysis_cache is not None else None
        if cached_analysis is not None and cache.get(audio_key) is not None:
            self._set(key, state="ready", method=f"{lookup.method}+cache", finishedAt=time.time())
            self._active_key = ""
            return
        try:
            result = resolve_track(
                query,
                provider,
                cache,
                thresholds=provider.thresholds,
                preselected=[lookup.candidate] if lookup.candidate is not None else None,
            )
        except RetrievalError as error:
            self._set(
                key, state="error", method=lookup.method, error=error.code, finishedAt=time.time()
            )
            self._active_key = ""
            return
        self._set(key, state="analyzing", method=lookup.method)
        try:
            if self._engine is None:
                self._engine = PersistentAnalysis()
                self._engine.start()
            result_analysis = self._engine.analyze(
                result.cache_entry_path,
                replace(self.settings),
                timeout_sec=self.settings.analyze_timeout_sec,
            )
            from ..main import to_schema

            schema = to_schema(result_analysis)
            if analysis_cache is not None:
                analysis_cache.put(analysis_key, schema)
            self._set(
                key,
                state="ready",
                method=f"{lookup.method}+analyse",
                finishedAt=time.time(),
            )
        except Exception as error:  # noqa: BLE001 - un préchargement ne casse rien
            self._set(
                key,
                state="error",
                method=lookup.method,
                error=str(error)[:200],
                finishedAt=time.time(),
            )
        finally:
            self._active_key = ""
