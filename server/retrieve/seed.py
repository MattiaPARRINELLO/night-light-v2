"""Pré-remplissage du cache audio avec des fichiers locaux.

Un morceau enregistré ici est retrouvé par `resolve_track` quand le lecteur
annonce le même titre et le même artiste : il est alors servi depuis le cache,
sans passer par le fournisseur Deezer. C'est le chemin prévu pour les éditions
rares, les lives et les fichiers personnels que le catalogue ne contient pas.

Le cache indexe sur le titre, l'artiste et la durée, comme le reste du serveur :
un fichier pré-rempli n'est donc retrouvé que si le lecteur annonce des
métadonnées compatibles (voir `AudioCache.find_for_query`).
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .cache import AudioCache, AudioCacheError, CacheEntry
from .models import TrackQuery


class SeedError(Exception):
    """Erreur de pré-remplissage avec message lisible."""


@dataclass(frozen=True)
class TrackMetadata:
    """Métadonnées minimales nécessaires pour indexer un fichier local."""

    title: str
    artist: str
    duration_sec: float
    source: str = "ffprobe"


def _run_ffprobe(path: Path) -> dict[str, Any] | None:
    """Retourne les tags et la durée du fichier, ou None si ffprobe échoue."""
    try:
        output = subprocess.run(
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
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if output.returncode != 0:
        return None
    try:
        payload = json.loads(output.stdout or "{}")
    except json.JSONDecodeError:
        return None
    return payload.get("format") if isinstance(payload, dict) else None


def _duration_from_soundfile(path: Path) -> float:
    try:
        import soundfile as sf

        return float(sf.info(str(path)).duration)
    except Exception:  # noqa: BLE001 - dépendance optionnelle pour ce repli
        return 0.0


def _split_filename(path: Path) -> tuple[str, str]:
    """« Damso - Σ. MOROSE (LIVE).mp3 » -> (« Damso », « Σ. MOROSE (LIVE) »)."""
    stem = path.stem.strip()
    if " - " in stem:
        artist, title = stem.split(" - ", 1)
        return artist.strip(), title.strip()
    return "", stem


def probe_metadata(path: Path) -> TrackMetadata:
    """Lit titre, artiste et durée du fichier.

    ffprobe fait foi quand il est disponible ; sinon la durée vient de
    soundfile et le couple artiste/titre du nom de fichier. Un tag manquant est
    remplacé par ce que le nom de fichier raconte, jamais par une valeur vide.
    """
    if not path.is_file():
        raise SeedError(f"fichier introuvable: {path}")
    file_artist, file_title = _split_filename(path)
    payload = _run_ffprobe(path)
    tags = (payload or {}).get("tags") or {}
    if not isinstance(tags, dict):
        tags = {}
    title = str(tags.get("title") or "").strip() or file_title
    artist = str(tags.get("artist") or "").strip() or file_artist
    duration_sec = 0.0
    raw_duration = (payload or {}).get("duration")
    if isinstance(raw_duration, str):
        try:
            duration_sec = float(raw_duration)
        except ValueError:
            duration_sec = 0.0
    source = "ffprobe"
    if duration_sec <= 0:
        duration_sec = _duration_from_soundfile(path)
        source = "soundfile"
    if not title:
        raise SeedError(f"titre introuvable pour {path.name}: passe --title")
    return TrackMetadata(
        title=title,
        artist=artist,
        duration_sec=duration_sec,
        source=source,
    )


def build_query(
    path: Path,
    *,
    title: str | None = None,
    artist: str | None = None,
    duration_sec: float | None = None,
) -> TrackQuery:
    metadata = probe_metadata(path)
    resolved_duration = duration_sec if duration_sec and duration_sec > 0 else metadata.duration_sec
    if resolved_duration <= 0:
        raise SeedError(f"durée introuvable pour {path.name}: passe --duration (en secondes)")
    return TrackQuery(
        title=(title or metadata.title).strip(),
        artist=(artist if artist is not None else metadata.artist).strip(),
        duration_sec=float(resolved_duration),
    )


def seed_track(
    cache: AudioCache,
    path: Path,
    *,
    title: str | None = None,
    artist: str | None = None,
    duration_sec: float | None = None,
    replace: bool = False,
    dry_run: bool = False,
) -> CacheEntry:
    """Copie le fichier dans le cache sous la clé du morceau qu'il représente.

    Sans `replace`, un morceau déjà présent n'est pas réécrit : un fichier
    pré-rempli ne doit pas écraser silencieusement une version récupérée.
    """
    query = build_query(path, title=title, artist=artist, duration_sec=duration_sec)
    existing = cache.get_entry_for_query(query)
    if existing is not None and not replace:
        raise SeedError(
            f"déjà dans le cache ({existing.size_bytes} octets): {query.title} "
            f"— utilise --replace pour écraser"
        )
    if dry_run:
        return CacheEntry(
            key=query.normalized_title,
            path=path.resolve(),
            size_bytes=path.stat().st_size,
            content_hash="",
            created_at=0.0,
            duration_sec=query.duration_sec,
            provider="local",
            title=query.title,
            artist=query.artist,
        )
    try:
        return cache.put_for_query(
            query,
            path,
            candidate_provider="local",
            metadata={"preloaded": True},
        )
    except AudioCacheError as error:
        raise SeedError(str(error)) from error
