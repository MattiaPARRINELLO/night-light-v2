"""API d'analyse et de lecture des morceaux pour Night Light.

Usage strictement personnel : aucune authentification, aucune base de données,
et le serveur écoute par défaut sur 127.0.0.1 uniquement.
"""

from __future__ import annotations

import asyncio
import atexit
import shutil
from contextlib import asynccontextmanager
from concurrent.futures import ThreadPoolExecutor
from importlib import metadata
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import sniff
from .analysis import AnalysisError, AnalysisResult, analyze_file, warmup
from .config import Settings, load_settings
from .store import SessionStore

MAX_ACTIVE_JOBS = 24
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


class AppState:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.store = SessionStore(Path(settings.session_dir), settings.session_ttl_sec)
        self.executor = ThreadPoolExecutor(max_workers=settings.workers, thread_name_prefix="analysis")
        self.purge_task: asyncio.Task[None] | None = None

    def drop_audio(self, job_id: str) -> None:
        job = self.store.get(job_id)
        if job is not None and job.audio_path is not None:
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
            self.store.set_error(job_id, "analysis_failed", "L'analyse du morceau a échoué.", str(error)[:300])

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
    atexit.register(state.store.purge_all)
    try:
        yield
    finally:
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
            raise HTTPException(status_code=503, detail="Trop d'analyses en cours. Réessaie dans un instant.")

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


def mount_frontend() -> None:
    """Sert le build statique si l'API est utilisée sans proxy (mode léger)."""
    dist = Path(__file__).resolve().parent.parent / "dist"
    if dist.is_dir():
        app.mount("/", StaticFiles(directory=str(dist), html=True), name="frontend")


mount_frontend()
