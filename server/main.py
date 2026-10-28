"""API d'analyse et de lecture des morceaux pour Night Light.

Usage strictement personnel : aucune authentification, aucune base de données,
et le serveur écoute par défaut sur 127.0.0.1 uniquement.
"""

from __future__ import annotations

import asyncio
import atexit
import json
import logging
import os
import queue
import shutil
import threading
import time
from collections.abc import AsyncIterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass, replace
from importlib import metadata
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import sniff
from .analysis import (
    ANALYZER_VERSION,
    AnalysisError,
    AnalysisResult,
    analyze_file,
    analyze_with_timeout,
    start_analysis_worker,
    stop_analysis_worker,
    warmup,
)
from .analysis_cache import AnalysisCache
from .audio_capture import get_audio_capture
from .config import Settings, is_loopback_host, load_settings
from .mpris import (
    add_now_playing_listener,
    get_now_playing,
    remove_now_playing_listener,
    start_mpris_monitor,
    stop_mpris_monitor,
    subscribe_now_playing,
    unsubscribe_now_playing,
)
from .playback_position import get_playback_state, match_playback
from .queue.deezer import lookup_for_queue_track, track_query
from .queue.manager import QueueManager
from .queue.models import QueueTrack
from .retrieve.cache import AudioCache
from .retrieve.deezer import DeezerProvider
from .retrieve.models import TrackQuery, audio_cache_key, normalize_text
from .retrieve.resolver import RetrievalError, resolve_track
from .store import SessionStore

MAX_ACTIVE_JOBS = 24
_LOGGER = logging.getLogger("night-light.resolve")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
PURGE_INTERVAL_SEC = 20

AUDIO_MEDIA_TYPES = {
    "mp3": "audio/mpeg",
    "wav": "audio/wav",
    "flac": "audio/flac",
    "ogg": "audio/ogg",
    "m4a": "audio/mp4",
    "webm": "audio/webm",
    "aiff": "audio/aiff",
}


def package_version(name: str) -> str:
    try:
        return metadata.version(name)
    except metadata.PackageNotFoundError:
        return "inconnue"


class ResolveRequest(BaseModel):
    title: str
    artist: str = ""
    duration_sec: float | None = None
    duration: float | None = None
    track_key: str | None = None
    deezer_id: str | None = None
    isrc: str | None = None


@dataclass(frozen=True)
class PendingResolve:
    """Une résolution en attente, prête à être exécutée plus tard."""

    job_id: str
    title: str
    artist: str
    duration_sec: float
    track_key: str
    deezer_id: str | None = None
    isrc: str | None = None


class AppState:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.store = SessionStore(Path(settings.session_dir), settings.session_ttl_sec)
        self.analysis_cache = AnalysisCache(
            Path(settings.cache_dir) / "analysis",
            version=ANALYZER_VERSION,
            max_bytes=settings.analysis_cache_max_bytes,
        )
        self.executor = ThreadPoolExecutor(
            max_workers=settings.workers, thread_name_prefix="analysis"
        )
        self.purge_task: asyncio.Task[None] | None = None
        self.current_track_key = ""
        self.resolve_pending = False
        # Les résolutions attendent dans une **pile**, pas une file : le morceau
        # le plus récent est dépilé en premier, donc celui qu'on écoute est
        # téléchargé et analysé avant les morceaux qu'on a sautés. Ces derniers
        # restent dans la pile : ils sont téléchargés ensuite (mis en cache, donc
        # « en stock »), mais jamais analysés ni affichés — `current_track_key`
        # les marque comme périmés.
        self._resolve_cond = threading.Condition()
        self._resolve_stack: list[PendingResolve] = []
        self._resolve_stop = False
        self._resolve_thread: threading.Thread | None = None
        self.now_playing_key = ""
        self.active_analyses = 0
        self.queue = QueueManager(settings, self)
        add_now_playing_listener(self._on_now_playing)

    @staticmethod
    def _same_track(left: str, right: str) -> bool:
        return normalize_text(left.replace("|", " ")) == normalize_text(right.replace("|", " "))

    def _on_now_playing(self, state: Any) -> None:
        """Suit la piste réellement jouée, pour interrompre une analyse périmée."""
        title = getattr(state, "title", "").strip()
        artist = getattr(state, "artist", "").strip()
        self.now_playing_key = f"{title}|{artist}" if title else ""
        player = getattr(state, "player", "")
        if title:
            self.queue.on_mpris_change(player, title, artist)

    def _cancellation_check(self, track_key: str) -> Any:
        """Annule l'analyse si MPRIS est passé à une autre piste (sauf ≥ 80 %)."""
        started_key = self.now_playing_key
        active = bool(started_key) and self._same_track(track_key, started_key)

        def should_cancel(progress: float) -> bool:
            if not active or progress >= 0.8:
                return False
            return not self._same_track(track_key, self.now_playing_key)

        return should_cancel

    def submit_resolve(self, request: PendingResolve) -> None:
        """Empile une résolution ; le dernier morceau demandé passe devant."""
        with self._resolve_cond:
            self.current_track_key = request.track_key
            self.resolve_pending = True
            self._resolve_stack.append(request)
            self._resolve_cond.notify()
        if self._resolve_thread is None:
            self._resolve_thread = threading.Thread(
                target=self._resolve_worker, name="resolve", daemon=True
            )
            self._resolve_thread.start()

    def _resolve_worker(self) -> None:
        while True:
            with self._resolve_cond:
                while not self._resolve_stack and not self._resolve_stop:
                    self._resolve_cond.wait()
                if self._resolve_stop:
                    return
                # Pile : on dépile par le haut, donc le morceau le plus récent.
                request = self._resolve_stack.pop()
            try:
                self.run_resolve(
                    request.job_id,
                    request.title,
                    request.artist,
                    request.duration_sec,
                    request.track_key,
                    request.deezer_id,
                    request.isrc,
                )
            except Exception:  # noqa: BLE001 - un job ne doit pas tuer le worker
                _LOGGER.exception("Résolution interrompue id=%s", request.job_id)

    def drop_audio(self, job_id: str) -> None:
        job = self.store.get(job_id)
        if job is not None and job.audio_path is not None and job.owns_audio:
            job.audio_path.unlink(missing_ok=True)

    def run_analysis(self, job_id: str, **kwargs: Any) -> None:
        self.active_analyses += 1
        try:
            self._run_analysis(job_id, **kwargs)
        finally:
            self.active_analyses = max(0, self.active_analyses - 1)

    def _run_analysis(
        self,
        job_id: str,
        *,
        analysis_key: str | None = None,
        timings: dict[str, Any] | None = None,
        track_key: str | None = None,
        window: tuple[float, float] | None = None,
    ) -> None:
        job = self.store.get(job_id)
        if job is None or job.audio_path is None:
            return
        self.store.set_running(job_id)
        started_at = time.time()
        detected = (timings or {}).get("detectedAt")
        if not isinstance(detected, (int, float)) or detected <= 0:
            detected = round(job.created_at * 1000)
        quick_started = time.time()
        should_cancel = self._cancellation_check(track_key) if track_key else None

        def report(message: str, progress: float) -> None:
            phase = message.split("—")[0].strip() if "—" in message else "Analyse"
            mapped = 0.2 + progress * 0.8 if window is not None else progress
            self.store.update(job_id, progress=mapped, phase=phase, message=message)

        def quick_report(message: str, progress: float) -> None:
            self.store.update(
                job_id,
                progress=min(0.2, 0.02 + progress * 0.18),
                phase="Analyse rapide",
                message=message,
            )

        # Passe rapide : uniquement la fenêtre autour de la position du lecteur.
        # Elle rend le show utilisable tout de suite ; seule la passe complète
        # alimente le cache.
        if window is not None:
            try:
                quick = analyze_file(
                    job.audio_path,
                    replace(self.settings, sample_rate=min(self.settings.sample_rate, 11025)),
                    report=quick_report,
                    window=window,
                    should_cancel=should_cancel,
                )
                quick_ms = round((time.time() - quick_started) * 1000)
                partial_ms = round(time.time() * 1000 - detected)
                serialize_started = time.monotonic()
                quick_schema = to_schema(quick)
                quick_serialize_ms = round((time.monotonic() - serialize_started) * 1000)
                _LOGGER.info(
                    "Analyse rapide prête id=%s fenêtre=[%.1f, %.1f] durée=%.2fs tempo=%.1f",
                    job_id,
                    window[0],
                    window[1],
                    quick_ms / 1000,
                    quick.tempo,
                )
                self.store.set_partial_result(
                    job_id,
                    quick_schema,
                    timings={
                        "partialMs": partial_ms,
                        "quickAnalysisMs": quick_ms,
                        "analysisCache": False,
                        "analysisPhases": {
                            **quick.phase_timings,
                            "serializationMs": quick_serialize_ms,
                        },
                    },
                )
            except AnalysisError as error:
                if error.code == "cancelled":
                    self.drop_audio(job_id)
                    self.store.set_timings(job_id, {"analysisError": "cancelled"})
                    self.store.set_error(job_id, error.code, error.message, error.detail)
                    return
                _LOGGER.warning(
                    "Analyse rapide impossible id=%s (%s), passage à l'analyse complète",
                    job_id,
                    error.code,
                )
            except Exception as error:  # noqa: BLE001 - la passe complète reste possible
                _LOGGER.warning("Analyse rapide en échec id=%s: %s", job_id, error)

        def finished(extra: dict[str, Any] | None = None) -> dict[str, Any]:
            now = time.time()
            payload = dict(timings or {})
            payload["detectedAt"] = detected
            payload["analysisMs"] = round((now - started_at) * 1000)
            payload["analyzedMs"] = round(now * 1000 - detected)
            payload["totalMs"] = payload["analyzedMs"]
            with suppress(OSError):
                payload["loadavg"] = [round(value, 2) for value in os.getloadavg()]
            payload["activeJobs"] = self.store.count()
            if extra:
                payload.update(extra)
            return payload

        try:
            result = analyze_with_timeout(
                job.audio_path,
                self.settings,
                report=report,
                timeout_sec=self.settings.analyze_timeout_sec,
                should_cancel=should_cancel,
            )
            schema = to_schema(result)
            serialize_started = time.monotonic()
            serialize_ms = round((time.monotonic() - serialize_started) * 1000)
            elapsed = time.time() - started_at
            _LOGGER.info(
                "Analyse terminée id=%s durée=%.2fs tempo=%.1f phases=%s",
                job_id,
                elapsed,
                result.tempo,
                result.phase_timings,
            )
            if analysis_key is not None:
                try:
                    self.analysis_cache.put(analysis_key, schema)
                except Exception as error:  # noqa: BLE001 - le cache ne doit pas casser l'analyse
                    _LOGGER.warning("Écriture cache analyse impossible id=%s: %s", job_id, error)
            self.store.set_result(
                job_id,
                schema,
                timings=finished(
                    {
                        "analysisCache": False,
                        "analysisPhases": {
                            **result.phase_timings,
                            "serializationMs": serialize_ms,
                        },
                    }
                ),
            )
        except AnalysisError as error:
            self.drop_audio(job_id)
            self.store.set_timings(
                job_id,
                finished({"analysisCache": False, "analysisError": error.code}),
            )
            self.store.set_error(job_id, error.code, error.message, error.detail)
        except Exception as error:  # noqa: BLE001 - on renvoie une erreur lisible
            self.drop_audio(job_id)
            self.store.set_timings(
                job_id,
                finished({"analysisCache": False, "analysisError": "analysis_failed"}),
            )
            self.store.set_error(
                job_id,
                "analysis_failed",
                "L'analyse du morceau a échoué.",
                str(error)[:300],
            )

    def run_resolve(
        self,
        job_id: str,
        title: str,
        artist: str,
        duration_sec: float,
        track_key: str | None = None,
        deezer_id: str | None = None,
        isrc: str | None = None,
    ) -> None:
        job = self.store.get(job_id)
        if job is None:
            return
        self.resolve_pending = True
        used_key = (track_key or f"{title.strip()}|{artist.strip()}").strip()
        detected_at_ms = round(job.created_at * 1000)
        timings: dict[str, Any] = {
            "detectedAt": detected_at_ms,
            "queueMs": max(0, round((time.time() - job.created_at) * 1000)),
        }

        query = TrackQuery(title=title, artist=artist, duration_sec=duration_sec)
        queue_track = QueueTrack(
            source="deezer",
            deezer_id=deezer_id,
            isrc=isrc,
            title=title,
            artist=artist,
            duration_ms=int(duration_sec * 1000) if duration_sec > 0 else None,
        )
        lookup = lookup_for_queue_track(queue_track)
        preselected = [lookup.candidate] if lookup.candidate is not None else None
        if lookup.candidate is not None:
            query = track_query(queue_track, lookup.candidate)
        timings["resolutionMethod"] = lookup.method
        cache = AudioCache(Path(self.settings.cache_dir))
        _LOGGER.info(
            "Début résolution id=%s titre=%r artiste=%r durée=%.3fs",
            job_id,
            title,
            artist,
            duration_sec,
        )
        if not self.settings.deezer_arl:
            self.resolve_pending = False
            self.store.set_error(
                job_id,
                "deezer_not_configured",
                "La récupération Deezer n'est pas configurée.",
                "Renseigne DEEZER_ARL dans l'environnement du serveur, puis relance-le.",
            )
            _LOGGER.error("Résolution refusée: Deezer non configuré id=%s", job_id)
            return
        provider = DeezerProvider(
            arl=self.settings.deezer_arl,
            work_dir=Path(self.settings.cache_dir) / "streamrip",
        )

        def report(phase: str, progress: float, message: str) -> None:
            self.store.update(job_id, progress=progress, phase=phase, message=message)
            _LOGGER.info("Résolution %s : %s (%.0f%%) %s", job_id, phase, progress * 100, message)

        try:
            result = resolve_track(
                query,
                provider,
                cache,
                thresholds=provider.thresholds,
                progress=report,
                preselected=preselected,
            )
        except RetrievalError as error:
            self.resolve_pending = False
            self.store.set_error(job_id, error.code, error.message)
            return
        except Exception as error:  # noqa: BLE001 - on renvoie une erreur lisible
            self.resolve_pending = False
            self.store.set_error(
                job_id,
                "resolve_failed",
                "La récupération du morceau a échoué.",
                str(error)[:300],
            )
            return

        # Chronologie du retrieval : c'est le premier endroit où ces mesures
        # existent. Elles sont désormais journalisées et publiées dans le job.
        retrieval = {
            "searchMs": round(result.timings.search_sec * 1000),
            "validationMs": round(result.timings.validation_sec * 1000),
            "downloadMs": round(result.timings.download_sec * 1000),
            "cacheMs": round(result.timings.cache_sec * 1000),
            "totalMs": round(result.timings.total_sec * 1000),
        }
        found_ms = timings["queueMs"] + retrieval["searchMs"] + retrieval["validationMs"]
        downloaded_ms = found_ms + retrieval["downloadMs"] + retrieval["cacheMs"]
        timings.update(
            {
                "foundMs": found_ms,
                "downloadedMs": downloaded_ms,
                "resolvedMs": round((time.time() - job.created_at) * 1000),
                "audioCache": result.from_cache,
                "retrieval": retrieval,
            }
        )
        _LOGGER.info(
            "Retrieval terminé id=%s cache_audio=%s timings=%s",
            job_id,
            result.from_cache,
            result.timings,
        )
        self.store.set_timings(job_id, timings)

        resolved_job = self.store.get(job_id)
        if resolved_job is not None:
            resolved_job.audio_path = result.cache_entry_path
            resolved_job.owns_audio = False
            resolved_job.size_bytes = (
                result.cache_entry_path.stat().st_size
                if result.cache_entry_path.is_file()
                else resolved_job.size_bytes
            )
            resolved_job.filename = (
                " - ".join(part for part in (title.strip(), artist.strip()) if part)
                or resolved_job.filename
            )
        if self.current_track_key and used_key != self.current_track_key:
            self.resolve_pending = False
            self.store.set_error(
                job_id, "stale_result", "Le morceau a changé pendant la résolution."
            )
            return

        # Le cache d'analyse évite complètement `run_analysis` à la réécoute.
        analysis_key = audio_cache_key(query)
        cached_analysis = self.analysis_cache.get(analysis_key)
        if cached_analysis is not None:
            now = time.time()
            analyzed_ms = round(now * 1000 - detected_at_ms)
            timings.update(
                {
                    "analysisMs": 0,
                    "analyzedMs": analyzed_ms,
                    "totalMs": analyzed_ms,
                    "analysisCache": True,
                }
            )
            self.resolve_pending = False
            self.store.set_result(job_id, cached_analysis, timings=timings)
            _LOGGER.info(
                "Analyse servie depuis le cache id=%s version=%s total=%.0f ms",
                job_id,
                ANALYZER_VERSION,
                analyzed_ms,
            )
            return

        _LOGGER.info("Résolution réussie id=%s, lancement de l'analyse", job_id)
        self.resolve_pending = False
        partial_window: tuple[float, float] | None = None
        try:
            playback = get_playback_state(title=title, artist=artist, duration_sec=duration_sec)
            if playback.available and playback.status in {"playing", "paused"}:
                position = max(0.0, playback.position_ms / 1000.0)
                partial_window = (max(0.0, position - 5.0), position + 40.0)
        except Exception as error:  # noqa: BLE001 - la passe complète suffit
            _LOGGER.warning("Position MPRIS indisponible pour la passe rapide: %s", error)
        self.run_analysis(
            job_id,
            analysis_key=analysis_key,
            timings={**timings, "analysisCache": False},
            track_key=used_key,
            window=partial_window,
        )

    async def shutdown(self) -> None:
        remove_now_playing_listener(self._on_now_playing)
        self.queue.stop()
        stop_analysis_worker()
        with self._resolve_cond:
            self._resolve_stop = True
            self._resolve_cond.notify_all()
        if self._resolve_thread is not None:
            await asyncio.to_thread(self._resolve_thread.join, 2.0)
        if self.purge_task is not None:
            self.purge_task.cancel()
            with suppress(asyncio.CancelledError):
                await self.purge_task
        self.executor.shutdown(wait=False, cancel_futures=True)
        self.store.purge_all()


def to_schema(result: AnalysisResult) -> dict[str, Any]:
    """Convertit le résultat en charge utile conforme au schéma du front."""
    beat_period = round(60.0 / result.tempo, 6) if result.tempo > 0 else 0.5
    return {
        "schema": 2,
        "duration": result.duration,
        "tempo": result.tempo,
        "meter": result.meter,
        "beatCount": len(result.beats),
        "beatPeriod": beat_period,
        "beats": result.beats,
        "onsets": result.onsets,
        "energy": result.energy,
        "bass": result.bass,
        "mid": result.mid,
        "midLow": result.mid_low,
        "midHigh": result.mid_high,
        "high": result.high,
        "sections": result.sections,
        "builds": result.builds,
        "drops": result.drops,
        **({"coverage": list(result.coverage)} if result.coverage is not None else {}),
    }


settings = load_settings()


def enforce_network_guard(current: Settings) -> None:
    """Refuse un écouteur réseau non local : le serveur n'a aucune authentification.

    Un utilisateur qui expose l'API sur Internet ouvrirait la lecture et
    l'analyse à n'importe qui. Le garde-fou est un refus explicite, levé par
    `ALLOW_NETWORK=1` en connaissance de cause.
    """
    if is_loopback_host(current.host) or current.allow_network:
        return
    raise SystemExit(
        f"HOST={current.host!r} n'est pas une adresse locale. Night Light n'a "
        "aucune authentification : ne l'expose pas sur le réseau. Utilise "
        "HOST=127.0.0.1, ou force avec ALLOW_NETWORK=1 si tu sais ce que tu fais."
    )


enforce_network_guard(settings)

state = AppState(settings)


async def purge_loop() -> None:
    while True:
        await asyncio.sleep(PURGE_INTERVAL_SEC)
        state.store.purge_expired()


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    state.store.purge_all()
    state.executor.submit(warmup)
    start_analysis_worker()
    state.queue.start()
    state.purge_task = asyncio.create_task(purge_loop())
    start_mpris_monitor()
    atexit.register(state.store.purge_all)
    try:
        yield
    finally:
        stop_mpris_monitor()
        await state.shutdown()


app = FastAPI(
    title="Night Light — analyse audio",
    version="2.0.0",
    description="Analyse audio locale pour un light show musical personnel.",
    lifespan=lifespan,
)


@app.exception_handler(Exception)
async def unhandled_error(_: Request, error: Exception) -> JSONResponse:
    return JSONResponse(
        status_code=500,
        content={
            "error": {
                "code": "internal",
                "message": "Erreur interne du serveur.",
                "detail": str(error)[:300],
            }
        },
    )


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "limits": {
            "maxFileBytes": settings.max_file_bytes,
            "maxDurationSec": settings.max_duration_sec,
        },
        "formats": ["mp3", "wav", "ogg", "flac", "m4a", "aac", "aiff", "webm"],
        "tools": {
            "librosa": package_version("librosa"),
            "soundfile": package_version("soundfile"),
            "ffmpeg": shutil.which("ffmpeg") is not None,
        },
        "audioRetention": (
            "le fichier audio reste le temps de la session puis est supprimé "
            f"(session expirée après ≈ {settings.session_ttl_sec / 60:.0f} min d'inactivité)"
        ),
    }


async def read_upload(file: UploadFile) -> tuple[bytes, str]:
    limit = settings.max_file_bytes + 1
    content = await file.read(limit)
    if len(content) > settings.max_file_bytes:
        raise HTTPException(
            status_code=413,
            detail=(
                f"Fichier trop volumineux ({len(content) / 1048576:.1f} Mo). "
                f"Limite : {settings.max_file_mb:.0f} Mo."
            ),
        )
    return content, file.filename or "morceau"


@app.post("/api/analyze")
async def analyze(file: UploadFile = File(...)) -> JSONResponse:
    if state.store.count() >= MAX_ACTIVE_JOBS:
        state.store.purge_expired()
        if state.store.count() >= MAX_ACTIVE_JOBS:
            raise HTTPException(
                status_code=503,
                detail="Trop d'analyses en cours. Réessaie dans un instant.",
            )

    content, filename = await read_upload(file)
    if len(content) == 0:
        raise HTTPException(status_code=400, detail="Le fichier reçu est vide.")

    detected = sniff.sniff(content[:64])
    if not detected.supported:
        raise HTTPException(
            status_code=415,
            detail=(
                f"Format non pris en charge ({detected.format_name}). "
                "Dépose un MP3, WAV, OGG, FLAC ou M4A."
            ),
        )

    job = state.store.create(filename, len(content))
    if job.audio_path is None:
        raise HTTPException(status_code=500, detail="Impossible de créer l'espace de travail.")
    audio_path = job.audio_path.with_name(f"audio.{detected.extension_hint or 'bin'}")
    job.audio_path = audio_path
    audio_path.write_bytes(content)
    del content

    state.executor.submit(state.run_analysis, job.id)
    return JSONResponse(
        status_code=202,
        content={
            "jobId": job.id,
            "status": "queued",
            "progress": 0,
            "phase": "En file d'attente",
            "message": "Fichier reçu, analyse en préparation.",
            "filename": job.filename,
            "sizeBytes": job.size_bytes,
        },
    )


@app.post("/api/resolve")
async def resolve(request: ResolveRequest) -> JSONResponse:
    """Résout un morceau par métadonnées puis le transmet à l'analyseur existant."""
    if state.store.count() >= MAX_ACTIVE_JOBS:
        raise HTTPException(
            status_code=503,
            detail="Trop d'analyses en cours. Réessaie dans un instant.",
        )

    if not request.title or not request.title.strip():
        raise HTTPException(status_code=400, detail="Le titre est requis.")
    duration = request.duration_sec if request.duration_sec is not None else request.duration
    duration = float(duration or 0.0)
    artist = request.artist or ""

    filename = " - ".join(part for part in (request.title.strip(), artist.strip()) if part)
    job = state.store.create(filename, 0)
    if job.audio_path is None:
        raise HTTPException(status_code=500, detail="Impossible de créer l'espace de travail.")

    track_key = (request.track_key or f"{request.title.strip()}|{artist.strip()}").strip()
    state.submit_resolve(
        PendingResolve(
            job_id=job.id,
            title=request.title.strip(),
            artist=artist.strip(),
            duration_sec=duration,
            track_key=track_key,
            deezer_id=(request.deezer_id or "").strip() or None,
            isrc=(request.isrc or "").strip() or None,
        )
    )
    return JSONResponse(
        status_code=202,
        content={
            "jobId": job.id,
            "status": "queued",
            "progress": 0,
            "phase": "En file d'attente",
            "message": "Morceau demandé, recherche en préparation.",
            "filename": job.filename,
            "sizeBytes": 0,
        },
    )


@app.get("/api/jobs/{job_id}")
async def job_status(job_id: str) -> dict[str, Any]:
    job = state.store.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Analyse introuvable ou expirée.")
    return job.to_dict()


@app.delete("/api/session/{job_id}")
async def delete_session(job_id: str) -> dict[str, str]:
    state.store.drop(job_id)
    return {"status": "deleted"}


@app.get("/api/track/{job_id}")
async def track(job_id: str) -> FileResponse:
    job = state.store.get(job_id)
    if job is None or job.audio_path is None or not job.audio_path.exists():
        raise HTTPException(status_code=404, detail="Morceau indisponible (session expirée ?).")
    extension = job.audio_path.suffix.lstrip(".").lower()
    media_type = AUDIO_MEDIA_TYPES.get(extension, "application/octet-stream")
    return FileResponse(
        path=str(job.audio_path),
        media_type=media_type,
        filename=job.filename,
        headers={"Cache-Control": "no-store"},
    )


@app.get("/api/playback-position")
async def playback_position(
    title: str = "", artist: str = "", duration_sec: float = 0.0
) -> dict[str, Any]:
    state = get_playback_state(title=title, artist=artist, duration_sec=duration_sec)
    payload = state.to_dict()
    if title.strip() or artist.strip() or duration_sec > 0:
        payload["match"] = match_playback(
            state,
            title=title,
            artist=artist,
            duration_sec=duration_sec,
            title_threshold=0.8,
        )
    return payload


@app.get("/api/now-playing")
async def now_playing() -> dict[str, Any]:
    return get_now_playing().to_dict()


@app.get("/api/now-playing/stream")
async def now_playing_stream(request: Request) -> StreamingResponse:

    async def stream() -> asyncio.AsyncIterator[str]:
        subscriber = subscribe_now_playing()
        try:
            current = get_now_playing().to_dict()
            yield f"data: {json.dumps(current, ensure_ascii=False)}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    payload = await asyncio.to_thread(subscriber.get, True, 1.0)
                except queue.Empty:
                    continue
                yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
        finally:
            unsubscribe_now_playing(subscriber)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/jobs/{job_id}/stream")
async def job_stream(job_id: str, request: Request) -> StreamingResponse:
    """SSE d'un job ; le front garde le polling en repli."""
    if state.store.get(job_id) is None:
        raise HTTPException(status_code=404, detail="Analyse introuvable ou expirée.")

    async def stream() -> asyncio.AsyncIterator[str]:
        last = ""
        while True:
            if await request.is_disconnected():
                break
            job = state.store.get(job_id)
            if job is None:
                break
            payload = json.dumps(job.to_dict(), ensure_ascii=False)
            if payload != last:
                last = payload
                yield f"data: {payload}\n\n"
            if job.status in {"done", "error"}:
                break
            await asyncio.sleep(0.15)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/queue")
async def queue_status() -> dict[str, Any]:
    return state.queue.status()


@app.post("/api/deezer-queue")
async def deezer_queue(request: Request) -> dict[str, Any]:
    """Reçoit la file du userscript Deezer (ID Deezer) ou une URL playlist/album."""
    try:
        payload = await request.json()
    except Exception as error:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="JSON invalide.") from error
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Objet JSON attendu.")
    snapshot = state.queue.update_deezer(payload)
    return snapshot.to_dict()


@app.get("/api/audio-levels")
async def audio_levels(request: Request) -> StreamingResponse:
    """Flux SSE du niveau audio système capturé via PipeWire/PulseAudio."""

    async def stream() -> asyncio.AsyncIterator[str]:
        capture = get_audio_capture()
        capture.acquire()
        try:
            while True:
                if await request.is_disconnected():
                    break
                payload = json.dumps(capture.level().to_dict(), ensure_ascii=False)
                yield f"data: {payload}\n\n"
                await asyncio.sleep(0.08)
        finally:
            capture.release()

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def mount_frontend() -> None:
    """Sert le build statique si l'API est utilisée sans proxy (mode léger)."""
    dist = Path(__file__).resolve().parent.parent / "dist"
    if not dist.is_dir():
        return

    dashboard = dist / "dashboard.html"
    if dashboard.is_file():
        # StaticFiles(html=True) cherche `/dashboard/index.html` : sans cette
        # route explicite, l'URL propre /dashboard renverrait 404.
        @app.get("/dashboard", include_in_schema=False)
        async def dashboard_page() -> FileResponse:
            return FileResponse(dashboard)

    app.mount("/", StaticFiles(directory=str(dist), html=True), name="frontend")


mount_frontend()
