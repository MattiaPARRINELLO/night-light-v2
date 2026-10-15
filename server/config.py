"""Configuration serveur, lue depuis l'environnement (voir `.env.example`)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

DEFAULT_SESSION_DIR = "/tmp/night-light-sessions"
SESSION_DIR_NAME = "night-light-sessions"


def _clean_session_dir(raw: str | None) -> Path:
    """Résout le répertoire des sessions en empêchant toute valeur dangereuse.

    Une chaîne vide ou un chemin relatif se résoudrait en « répertoire courant » ;
    une purge y effacerait alors le projet lui-même.
    """
    candidate = (raw or "").strip()
    if candidate == "":
        return Path(DEFAULT_SESSION_DIR).resolve()
    resolved = Path(candidate).expanduser().resolve()
    if resolved == resolved.parent:  # racine du système de fichiers
        return Path(DEFAULT_SESSION_DIR).resolve()
    if resolved == Path.home().resolve():  # le répertoire personnel lui-même
        return Path(DEFAULT_SESSION_DIR).resolve()
    return resolved


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(float(raw))
    except ValueError:
        return default


def _float_env(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _bool_env(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "vrai", "yes", "oui", "on"}


def is_loopback_host(host: str) -> bool:
    """Vrai si l'hôte est une adresse locale (par défaut du serveur)."""
    return host.strip().lower() in {"127.0.0.1", "localhost", "::1", "[::1]"}


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    max_file_bytes: int
    max_duration_sec: float
    analyze_timeout_sec: float
    session_ttl_sec: float
    session_dir: str
    cache_dir: str
    deezer_arl: str
    workers: int
    sample_rate: int
    curve_rate_hz: float
    allow_network: bool

    @property
    def max_file_mb(self) -> float:
        return self.max_file_bytes / (1024 * 1024)


def load_settings() -> Settings:
    session_dir = _clean_session_dir(os.environ.get("SESSION_DIR"))
    return Settings(
        host=os.environ.get("HOST", "127.0.0.1"),
        port=_int_env("PORT", 8787),
        max_file_bytes=_int_env("MAX_FILE_MB", 40) * 1024 * 1024,
        max_duration_sec=_float_env("MAX_DURATION_SEC", 900),
        analyze_timeout_sec=_float_env("ANALYZE_TIMEOUT_SEC", 240),
        session_ttl_sec=_float_env("SESSION_TTL_SEC", 1800),
        session_dir=str(session_dir),
        cache_dir=str(
            os.environ.get("CACHE_DIR")
            or (Path(session_dir).resolve().parent / "night-light-cache")
        ),
        deezer_arl=(os.environ.get("DEEZER_ARL") or "").strip(),
        workers=max(1, _int_env("ANALYZE_WORKERS", 1)),
        sample_rate=_int_env("ANALYSIS_SAMPLE_RATE", 22050),
        curve_rate_hz=_float_env("CURVE_RATE_HZ", 20),
        allow_network=_bool_env("ALLOW_NETWORK"),
    )
