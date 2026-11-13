"""Journal console du serveur, lisible en direct.

Une ligne par événement : l'heure, un niveau court, un domaine en français, puis
le message. Les journaux d'accès HTTP sont volontairement réduits au silence :
le front interroge l'API en continu (SSE, polling), leurs lignes noieraient les
événements utiles (téléchargement, analyse, paroles) sans rien apprendre.
"""

from __future__ import annotations

import logging
import sys
import time

# Noms de domaines courts : `night-light.resolve` devient `résolution`.
_DOMAINS = {
    "night-light.resolve": "résolution",
    "server.analysis": "analyse",
    "server.lyrics": "paroles",
    "server.lyrics.service": "paroles",
    "server.lyrics.keywords": "paroles",
    "server.lyrics.lrclib": "paroles",
    "server.queue": "file",
    "uvicorn": "serveur",
    "uvicorn.error": "serveur",
    "uvicorn.access": "http",
}

_LEVELS = {
    logging.DEBUG: ("DEBUG", "\033[2m"),
    logging.INFO: ("INFO", "\033[36m"),
    logging.WARNING: ("ATTENTION", "\033[33m"),
    logging.ERROR: ("ERREUR", "\033[31m"),
    logging.CRITICAL: ("CRITIQUE", "\033[41m"),
}
_RESET = "\033[0m"


class LiveFormatter(logging.Formatter):
    """Heure + niveau coloré + domaine + message, sur une seule ligne."""

    def __init__(self) -> None:
        super().__init__()
        self._color = sys.stderr.isatty()

    def format(self, record: logging.LogRecord) -> str:
        at = time.strftime("%H:%M:%S", time.localtime(record.created))
        at = f"{at}.{int(record.msecs):03d}"
        label, color = _LEVELS.get(record.levelno, (record.levelname, ""))
        level = f"{color}{label:<9}{_RESET}" if self._color and color else f"{label:<9}"
        domain = _DOMAINS.get(record.name, record.name.rsplit(".", 1)[-1])
        message = record.getMessage()
        if record.exc_info:
            message = f"{message}\n{self.formatException(record.exc_info)}"
        return f"{at}  {level} {domain:<11} {message}"


def configure_logging(level: int = logging.INFO) -> None:
    """Installe le formateur, y compris par-dessus les handlers d'uvicorn."""
    handler = logging.StreamHandler()
    handler.setFormatter(LiveFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level)
    # uvicorn pose ses propres handlers avant d'importer l'application : on les
    # retire pour que tout passe par le formateur ci-dessus.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        logger = logging.getLogger(name)
        logger.handlers[:] = []
        logger.propagate = True
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)


def duration(seconds: float | None) -> str:
    """Durée lisible : « 320 ms », « 2,4 s », « 1 min 12 s »."""
    if seconds is None or not seconds >= 0:
        return "—"
    if seconds < 1:
        return f"{round(seconds * 1000)} ms"
    if seconds < 60:
        return f"{seconds:.1f}".replace(".", ",") + " s"
    minutes = int(seconds // 60)
    rest = round(seconds % 60)
    return f"{minutes} min {rest} s"


def size_text(num_bytes: int | None) -> str:
    """Taille lisible : « 820 Ko », « 3,2 Mo »."""
    if num_bytes is None or num_bytes < 0:
        return "—"
    if num_bytes < 1024 * 1024:
        return f"{num_bytes / 1024:.0f} Ko"
    return f"{num_bytes / (1024 * 1024):.1f}".replace(".", ",") + " Mo"


def short_id(job_id: str) -> str:
    """Les six derniers caractères suffisent à relier deux lignes d'un job."""
    return job_id[-6:] if len(job_id) > 6 else job_id
