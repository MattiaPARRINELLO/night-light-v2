"""Sessions et travaux d'analyse : tout reste en mémoire, hormis le fichier
audio nécessaire à la lecture, supprimé avec la session."""

from __future__ import annotations

import shutil
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class Job:
    id: str
    filename: str
    size_bytes: int
    status: str = "queued"
    progress: float = 0.0
    phase: str = "En file d'attente"
    message: str = ""
    result: dict[str, Any] | None = None
    error: dict[str, str] | None = None
    timings: dict[str, Any] | None = None
    created_at: float = field(default_factory=time.time)
    audio_path: Path | None = None
    owns_audio: bool = True

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "jobId": self.id,
            "status": self.status,
            "progress": round(self.progress, 4),
            "phase": self.phase,
            "message": self.message,
            "filename": self.filename,
            "sizeBytes": self.size_bytes,
        }
        if self.result is not None:
            payload["result"] = self.result
        if self.timings is not None:
            payload["timings"] = self.timings
        if self.error is not None:
            payload["error"] = self.error
        return payload


class SessionStore:
    """Registre de travaux protégé par un verrou, avec expiration glissante.

    Le répertoire des sessions porte toujours un nom dédié
    (`night-light-sessions`) : c'est la garde qui empêche une purge d'effacer
    autre chose qu'un espace de travail jetable.
    """

    EXPECTED_DIR_NAME = "night-light-sessions"

    def __init__(self, root: Path, ttl_sec: float) -> None:
        root = Path(root).expanduser().resolve()
        if root.name != self.EXPECTED_DIR_NAME or root == root.parent:
            raise ValueError(
                f"répertoire de sessions invalide : {root} "
                f"(il doit s'appeler « {self.EXPECTED_DIR_NAME} »)"
            )
        self.root = root
        self.ttl_sec = max(60.0, ttl_sec)
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()
        self.root.mkdir(parents=True, exist_ok=True)

    def create(self, filename: str, size_bytes: int) -> Job:
        job_id = uuid.uuid4().hex
        while job_id in self._jobs:
            job_id = uuid.uuid4().hex
        session_dir = (self.root / job_id).resolve()
        session_dir.mkdir(parents=True, exist_ok=True)
        job = Job(
            id=job_id,
            filename=filename,
            size_bytes=size_bytes,
            audio_path=session_dir / "audio",
        )
        with self._lock:
            self._jobs[job_id] = job
        return job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def update(
        self,
        job_id: str,
        *,
        progress: float | None = None,
        phase: str | None = None,
        message: str | None = None,
    ) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            if progress is not None:
                job.progress = max(0.0, min(1.0, progress))
            if phase is not None:
                job.phase = phase
            if message is not None:
                job.message = message
            job.created_at = time.time()

    def set_running(self, job_id: str) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is not None:
                job.status = "running"
                job.phase = "Analyse"
                job.created_at = time.time()

    def set_timings(self, job_id: str, timings: dict[str, Any]) -> None:
        """Fusionne les mesures de chronologie dans le payload du job."""
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            job.timings = {**(job.timings or {}), **timings}
            job.created_at = time.time()

    def set_result(
        self,
        job_id: str,
        analysis: dict[str, Any],
        *,
        timings: dict[str, Any] | None = None,
    ) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            job.status = "done"
            job.progress = 1.0
            job.phase = "Terminé"
            job.result = {"analysis": analysis}
            if timings is not None:
                job.timings = {**(job.timings or {}), **timings}
            job.created_at = time.time()

    def set_partial_result(
        self,
        job_id: str,
        analysis: dict[str, Any],
        *,
        timings: dict[str, Any] | None = None,
    ) -> None:
        """Publie une analyse partielle sans terminer le job."""
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            job.result = {"analysis": analysis, "partial": True}
            if timings is not None:
                job.timings = {**(job.timings or {}), **timings}
            job.created_at = time.time()

    def set_error(self, job_id: str, code: str, message: str, detail: str = "") -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            job.status = "error"
            job.error = {"code": code, "message": message}
            if detail:
                job.error["detail"] = detail
            job.created_at = time.time()

    def count(self) -> int:
        with self._lock:
            return len(self._jobs)

    def drop(self, job_id: str) -> None:
        """Supprime le travail et le fichier audio associé."""
        with self._lock:
            job = self._jobs.pop(job_id, None)
        if job is None:
            return
        if job.audio_path is not None and job.owns_audio:
            # Seuls les jobs ayant créé leur fichier audio le suppriment.
            # Les morceaux issus du cache persistant sont conservés.
            if job.audio_path.parent.exists():
                shutil.rmtree(job.audio_path.parent, ignore_errors=True)
            else:
                job.audio_path.unlink(missing_ok=True)

    def purge_expired(self) -> int:
        now = time.time()
        with self._lock:
            expired = [
                job_id for job_id, job in self._jobs.items() if now - job.created_at > self.ttl_sec
            ]
        for job_id in expired:
            self.drop(job_id)
        return len(expired)

    def purge_all(self) -> None:
        """Vide les sessions connues puis les sous-répertoires restants.

        Le répertoire racine lui-même n'est jamais supprimé : on n'efface que son
        contenu, et uniquement lui.
        """
        with self._lock:
            job_ids = list(self._jobs)
        for job_id in job_ids:
            self.drop(job_id)
        if not self.root.is_dir():
            return
        for entry in self.root.iterdir():
            if entry.is_dir():
                shutil.rmtree(entry, ignore_errors=True)
            else:
                entry.unlink(missing_ok=True)
