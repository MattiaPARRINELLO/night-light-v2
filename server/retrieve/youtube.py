"""Fournisseur audio concret pour YouTube via yt-dlp."""

from __future__ import annotations

import json
import re
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from server.sniff import sniff

from .match import MatchThresholds, validate_match
from .models import Candidate, TrackQuery, normalize_text
from .providers import AudioProvider


YOUTUBE_TIMEOUT_SEC = 30
YOUTUBE_DOWNLOAD_TIMEOUT_SEC = 120
MAX_DOWNLOAD_BYTES = 40 * 1024 * 1024
_UNWANTED_MARKERS = {
    "remix", "live", "nightcore", "slowed", "speed up", "8d",
    "bass boosted", "cover", "mashup", "edit", "react", "commentary",
}
_OFFICIAL_MARKERS = {"official audio", "provided to youtube", "official video", "topic", "original"}


class YouTubeProviderError(Exception):
    """Erreur spécifique au fournisseur YouTube."""


class YouTubeProvider:
    """Recherche et récupère l'audio via yt-dlp, sans téléchargement vidéo."""

    name = "youtube"

    def __init__(
        self,
        *,
        search_limit: int = 10,
        timeout_sec: int = YOUTUBE_TIMEOUT_SEC,
        download_timeout_sec: int = YOUTUBE_DOWNLOAD_TIMEOUT_SEC,
        max_download_bytes: int = MAX_DOWNLOAD_BYTES,
        thresholds: MatchThresholds | None = None,
    ) -> None:
        if search_limit < 1 or search_limit > 25:
            raise ValueError("search_limit must be between 1 and 25")
        self.search_limit = search_limit
        self.timeout_sec = timeout_sec
        self.download_timeout_sec = download_timeout_sec
        self.max_download_bytes = max_download_bytes
        self.thresholds = thresholds or MatchThresholds()

    def search(self, query: TrackQuery) -> list[Candidate]:
        command = [
            "yt-dlp",
            "--dump-json",
            "--no-download",
            "--flat-playlist",
            "--no-playlist",
            "--no-warnings",
            "--quiet",
            f"ytsearch{self.search_limit}:{_build_query(query)}",
        ]
        search_variants = [_build_query(query)]
        primary_artist = re.sub(r"[,;&].*", "", query.artist).strip()
        primary_artist = re.sub(r"\b(feat\.?|ft\.?|featuring).*$", "", primary_artist, flags=re.IGNORECASE).strip()
        if primary_artist and primary_artist.lower() != query.artist.strip().lower():
            search_variants.append(" ".join(part for part in (query.title.strip(), primary_artist) if part))
        # Déduplique les variantes sans multiplier inutilement les requêtes.
        unique_variants: list[str] = []
        for variant in search_variants:
            if variant and variant not in unique_variants:
                unique_variants.append(variant)

        metadata_items: list[dict[str, Any]] = []
        for variant in unique_variants:
            command[-1] = f"ytsearch{self.search_limit}:{variant}"
            try:
                completed = _run_command(command, timeout=self.timeout_sec, operation="recherche YouTube")
            except YouTubeProviderError:
                if variant == unique_variants[-1]:
                    raise
                continue
            parsed = _parse_search_output(completed.stdout)
            if parsed:
                metadata_items = parsed
                break

        candidates: list[Candidate] = []
        seen: set[str] = set()
        for item in metadata_items:
            candidate = _metadata_to_candidate(item)
            if candidate is None:
                continue
            if candidate.source_id in seen:
                continue
            if _is_unwanted_version(candidate.title, f"{query.title} {query.artist}"):
                continue
            seen.add(candidate.source_id)
            candidates.append(candidate)

        if not candidates and metadata_items:
            command[-1] = f"ytsearch{self.search_limit}:{unique_variants[0]} official audio"
            completed = _run_command(command, timeout=self.timeout_sec, operation="recherche YouTube")
            for item in _parse_search_output(completed.stdout):
                candidate = _metadata_to_candidate(item)
                if candidate is None or candidate.source_id in seen or _is_unwanted_version(candidate.title, f"{query.title} {query.artist}"):
                    continue
                seen.add(candidate.source_id)
                candidates.append(candidate)

        candidates.sort(key=lambda candidate: _sort_key(query, candidate, self.thresholds), reverse=True)
        return candidates

    def download(self, candidate: Candidate, destination: Path) -> Path:
        destination = Path(destination)
        destination.mkdir(parents=True, exist_ok=True)
        url = candidate.url or candidate.metadata.get("webpage_url")
        if not url:
            raise YouTubeProviderError("candidat sans URL de téléchargement")

        # "bestaudio" évite la récupération de la piste vidéo.
        command = [
            "yt-dlp",
            "--no-playlist",
            "--quiet",
            "--no-warnings",
            "--no-progress",
            "--socket-timeout", "30",
            "--retries", "3",
            "--max-filesize", f"{self.max_download_bytes}",
            "--format", "bestaudio[abr<=64]/bestaudio[abr<=96]/bestaudio",
            "--print", "after_move:filepath",
            "--output", str(destination / "%(id)s.%(ext)s"),
            str(url),
        ]
        completed = None
        detail = ""
        for attempt in range(2):
            try:
                completed = _run_command(command, timeout=self.download_timeout_sec, operation="téléchargement YouTube")
                break
            except YouTubeProviderError as error:
                detail = str(error)
                if attempt == 0 and ("403" in detail or "Forbidden" in detail or "429" in detail):
                    time.sleep(1.0)
                    continue
                raise
        if completed is None:
            raise YouTubeProviderError(detail or "échec du téléchargement YouTube")
        path = _parse_downloaded_path(completed.stdout, destination)
        try:
            resolved = path.resolve()
            root = destination.resolve()
        except OSError as error:
            raise YouTubeProviderError(f"chemin de fichier invalide: {error}") from error
        if resolved != root and root not in resolved.parents:
            raise YouTubeProviderError("le fichier téléchargé est hors du répertoire attendu")
        _validate_downloaded_audio(path, candidate)
        return path


def _run_command(command: list[str], *, timeout: int, operation: str) -> subprocess.CompletedProcess[str]:
    # Wrapper effectif conservant la compatibilité avec les tests.
    try:
        completed = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError as error:
        raise YouTubeProviderError("yt-dlp introuvable : dépendance externe requise") from error
    except subprocess.TimeoutExpired as error:
        raise YouTubeProviderError(f"{operation} : délai d'attente dépassé") from error
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "erreur inconnue").strip()[:500]
        raise YouTubeProviderError(f"{operation} a échoué (code {completed.returncode}): {detail}")
    return completed


def _build_query(query: TrackQuery) -> str:
    title = query.title.strip()
    artist = query.artist.strip()
    artist = re.sub(r"[,;&/]+", " ", artist)
    artist = " ".join(artist.split())
    parts = [title, artist]
    return " ".join(part for part in parts if part)


def _parse_search_output(stdout: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            data = json.loads(line)
        except json.JSONDecodeError as error:
            raise YouTubeProviderError("réponse yt-dlp invalide") from error
        if isinstance(data, dict):
            items.append(data)
    return items



def _split_artist_title(value: str) -> tuple[str, str]:
    for separator in (" - ", " – ", " — ", " : "):
        if separator in value:
            left, right = value.split(separator, 1)
            left, right = left.strip(), right.strip()
            if left and right:
                return left, right
    # Forme "Artist: Title" sans espace avant le deux-points.
    if ":" in value:
        left, right = value.split(":", 1)
        left, right = left.strip(), right.strip()
        if left and right and " " not in left:
            return left, right
    return "", value.strip()


def _metadata_to_candidate(item: dict[str, Any]) -> Candidate | None:
    video_id = item.get("id") or item.get("display_id")
    url = item.get("webpage_url") or item.get("original_url") or item.get("url")
    raw_title = str(item.get("track") or item.get("title") or item.get("fulltitle") or "")
    if not video_id or not url or not raw_title:
        return None

    parsed_artist, parsed_title = _split_artist_title(raw_title)
    title = parsed_title or raw_title
    feat_match = re.search(r"(?:feat\.?|ft\.?|featuring)\s+[^)]+", title, re.IGNORECASE)
    if parsed_artist and feat_match:
        parsed_artist = f"{parsed_artist} {feat_match.group(0).strip()}"

    duration = item.get("duration")
    try:
        duration_sec = float(duration) if duration is not None else None
    except (TypeError, ValueError):
        duration_sec = None
    if duration_sec is not None and duration_sec <= 0:
        duration_sec = None

    artist = ""
    raw_artist = item.get("artist") or item.get("creator")
    if isinstance(raw_artist, str):
        artist = raw_artist
    elif isinstance(item.get("artists"), list) and item["artists"]:
        artist = str(item["artists"][0])
    if parsed_artist and (not artist or "," in artist or "feat" in artist.lower()):
        artist = parsed_artist
    if not artist:
        artist = str(item.get("channel") or item.get("uploader") or "")
    if not artist and parsed_artist:
        artist = parsed_artist

    metadata = {
        "webpage_url": item.get("webpage_url"),
        "channel": item.get("channel"),
        "uploader": item.get("uploader"),
        "album": item.get("album"),
        "availability": item.get("availability"),
        "live_status": item.get("live_status"),
        "duration_string": item.get("duration_string"),
        "view_count": item.get("view_count"),
        "upload_date": item.get("upload_date"),
        "ext": item.get("ext"),
        "acodec": item.get("acodec"),
        "vcodec": item.get("vcodec"),
        "title_raw": item.get("title"),
    }
    return Candidate(
        provider="youtube",
        source_id=str(video_id),
        title=title,
        artist=artist,
        duration_sec=duration_sec,
        url=str(url),
        container=str(item.get("ext") or _container_from_acodec(item.get("acodec")) or "unknown"),
        codec=str(item.get("acodec") or ""),
        bitrate=_int_or_none(item.get("abr")),
        metadata=metadata,
        is_preview=False,
    )


def _sort_key(query: TrackQuery, candidate: Candidate, thresholds: MatchThresholds) -> tuple[float, float, float]:
    from .match import validate_match

    result = validate_match(query, candidate, thresholds)
    bonus = 0.0
    haystack = normalize_text(f"{candidate.title} {candidate.metadata.get('title_raw', '')}")
    if any(marker in haystack for marker in _OFFICIAL_MARKERS):
        bonus += 15.0
    if "audio" in haystack:
        bonus += 5.0
    # Pénalise les très faibles nombres de vues pour éviter les résultats parasites.
    views = candidate.metadata.get("view_count")
    view_bonus = 0.0
    if isinstance(views, (int, float)) and views > 0:
        view_bonus = min(5.0, views / 1_000_000.0)
    return (result.score + bonus, view_bonus, result.score)


def _is_unwanted_version(title: str, query_text: str = "") -> bool:
    normalized = normalize_text(title)
    query_normalized = normalize_text(query_text)
    return any(marker in normalized and marker not in query_normalized for marker in _UNWANTED_MARKERS)


def _int_or_none(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _container_from_acodec(acodec: Any) -> str:
    text = str(acodec or "").lower()
    if "opus" in text:
        return "webm"
    if "aac" in text or "mp4a" in text:
        return "m4a"
    if "mp3" in text:
        return "mp3"
    if "vorbis" in text:
        return "ogg"
    return ""


def _parse_downloaded_path(stdout: str, destination: Path) -> Path:
    lines = [line.strip() for line in stdout.splitlines() if line.strip()]
    if lines:
        candidate_path = Path(lines[-1])
        if candidate_path.is_file():
            return candidate_path
        # yt-dlp peut renvoyer un chemin relatif.
        candidate_path = destination / candidate_path.name
        if candidate_path.is_file():
            return candidate_path
    # Repli : fichier le plus récent du répertoire.
    files = [path for path in destination.iterdir() if path.is_file()]
    if not files:
        raise YouTubeProviderError("aucun fichier audio téléchargé")
    return max(files, key=lambda path: path.stat().st_mtime)


def _validate_downloaded_audio(path: Path, candidate: Candidate) -> None:
    if not path.is_file() or path.stat().st_size <= 0:
        raise YouTubeProviderError("fichier audio vide ou absent")
    if path.stat().st_size > 40 * 1024 * 1024:
        raise YouTubeProviderError("fichier audio trop volumineux")
    head = path.read_bytes()[:64]
    sniff_result = sniff(head)
    if not sniff_result.supported:
        raise YouTubeProviderError(f"format non audio détecté: {sniff_result.format_name}")

    try:
        output = subprocess.run(
            [
                "ffprobe",
                "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except FileNotFoundError as error:
        raise YouTubeProviderError("ffprobe introuvable : impossible de valider le fichier") from error
    except subprocess.TimeoutExpired as error:
        raise YouTubeProviderError("ffprobe a dépassé le délai") from error
    if output.returncode != 0:
        raise YouTubeProviderError(f"ffprobe a refusé le fichier: {output.stderr.strip()[:200]}")
    try:
        duration = float(output.stdout.strip())
    except ValueError as error:
        raise YouTubeProviderError("durée illisible dans le fichier téléchargé") from error
    if duration <= 0:
        raise YouTubeProviderError("durée non positive dans le fichier téléchargé")
    if candidate.duration_sec and candidate.duration_sec > 0:
        tolerance = max(10.0, candidate.duration_sec * 0.05)
        if abs(duration - candidate.duration_sec) > tolerance:
            raise YouTubeProviderError(
                f"durée incompatible: attendu {candidate.duration_sec:.3f}s, obtenu {duration:.3f}s"
            )
