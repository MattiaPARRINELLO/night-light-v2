"""API d'analyse et de lecture des morceaux pour Night Light.

Usage strictement personnel : aucune authentification, aucune base de données,
et le serveur écoute par défaut sur 127.0.0.1 uniquement.
"""

from __future__ import annotations
import json

import asyncio
import logging
import atexit
import shutil
from contextlib import asynccontextmanager
from concurrent.futures import ThreadPoolExecutor
from importlib import metadata
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import sniff
from pydantic import BaseModel
from .retrieve.models import TrackQuery
from .retrieve.cache import AudioCache
from .retrieve.deezer import DeezerProvider
from .retrieve.resolver import resolve_track, RetrievalError
from .analysis import AnalysisError, AnalysisResult, analyze_file, warmup
from .config import Settings, load_settings
from .mpris import get_now_playing, start_mpris_monitor, stop_mpris_monitor
from .playback_position import get_playback_state, match_playback, PlaybackState
from .audio_capture import get_audio_capture
from .store import SessionStore

MAX_ACTIVE_JOBS = 24
_LOGGER = logging.getLogger("night-light.resolve")
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
)
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


class AppState:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.store = SessionStore(Path(settings.session_dir), settings.session_ttl_sec)
        self.executor = ThreadPoolExecutor(
            max_workers=settings.workers, thread_name_prefix="analysis"
        )
        self.purge_task: asyncio.Task[None] | None = None
        self.current_track_key = ""
        self.resolve_pending = False

    def drop_audio(self, job_id: str) -> None:
        job = self.store.get(job_id)
        if job is not None and job.audio_path is not None and job.owns_audio:
            job.audio_path.unlink(missing_ok=True)

    def run_analysis(self, job_id: str) -> None:
        job = self.store.get(job_id)
        if job is None or job.audio_path is None:
            return
        self.store.set_running(job_id)

        def report(message: str, progress: float) -> None:
            phase = message.split("—")[0].strip() if "—" in message else "Analyse"
            self.store.update(job_id, progress=progress, phase=phase, message=message)

        try:
            result = analyze_file(job.audio_path, self.settings, report=report)
            self.store.set_result(job_id, to_schema(result))
        except AnalysisError as error:
            self.drop_audio(job_id)
            self.store.set_error(job_id, error.code, error.message, error.detail)
        except Exception as error:  # noqa: BLE001 - on renvoie une erreur lisible
            self.drop_audio(job_id)
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
    ) -> None:
        job = self.store.get(job_id)
        if job is None:
            return
        self.resolve_pending = True
        used_key = (track_key or f"{title.strip()}|{artist.strip()}").strip()

        query = TrackQuery(title=title, artist=artist, duration_sec=duration_sec)
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
            _LOGGER.info(
                "Résolution %s : %s (%.0f%%) %s", job_id, phase, progress * 100, message
            )

        try:
            result = resolve_track(
                query,
                provider,
                cache,
                thresholds=provider.thresholds,
                progress=report,
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
        _LOGGER.info("Résolution réussie id=%s, lancement de l'analyse", job_id)
        self.resolve_pending = False
        self.run_analysis(job_id)

    async def shutdown(self) -> None:
        if self.purge_task is not None:
            self.purge_task.cancel()
            try:
                await self.purge_task
            except asyncio.CancelledError:
                pass
        self.executor.shutdown(wait=False, cancel_futures=True)
        self.store.purge_all()


def to_schema(result: AnalysisResult) -> dict[str, Any]:
    """Convertit le résultat en charge utile conforme au schéma du front."""
    beat_period = round(60.0 / result.tempo, 6) if result.tempo > 0 else 0.5
    return {
        "schema": 1,
        "duration": result.duration,
        "tempo": result.tempo,
        "beatCount": len(result.beats),
        "beatPeriod": beat_period,
        "beats": result.beats,
        "onsets": result.onsets,
        "energy": result.energy,
        "bass": result.bass,
        "mid": result.mid,
        "high": result.high,
        "sections": result.sections,
        "builds": result.builds,
    }


settings = load_settings()
state = AppState(settings)


async def purge_loop() -> None:
    while True:
        await asyncio.sleep(PURGE_INTERVAL_SEC)
        state.store.purge_expired()


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    state.store.purge_all()
    state.executor.submit(warmup)
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
        raise HTTPException(
            status_code=500, detail="Impossible de créer l'espace de travail."
        )
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
    duration = (
        request.duration_sec if request.duration_sec is not None else request.duration
    )
    duration = float(duration or 0.0)
    artist = request.artist or ""

    filename = " - ".join(
        part for part in (request.title.strip(), artist.strip()) if part
    )
    job = state.store.create(filename, 0)
    if job.audio_path is None:
        raise HTTPException(
            status_code=500, detail="Impossible de créer l'espace de travail."
        )

    track_key = (
        request.track_key or f"{request.title.strip()}|{artist.strip()}"
    ).strip()
    state.current_track_key = track_key
    state.executor.submit(
        state.run_resolve,
        job.id,
        request.title.strip(),
        artist.strip(),
        duration,
        track_key,
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
        raise HTTPException(
            status_code=404, detail="Morceau indisponible (session expirée ?)."
        )
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
    if dist.is_dir():
        app.mount("/", StaticFiles(directory=str(dist), html=True), name="frontend")


mount_frontend()
