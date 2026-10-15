"""Fournisseur audio concret pour Deezer, via la CLI streamrip.

La recherche se fait dans le catalogue Deezer (titre/artiste), et non dans des
clips vidéo, puis le morceau est téléchargé au **plus bas niveau de qualité**
proposé par streamrip pour Deezer : 128 kbps MP3.
"""

from __future__ import annotations

import functools
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from server.sniff import sniff

from .match import MatchThresholds, validate_match
from .models import Candidate, TrackQuery

STREAMRIP_BINARY = "streamrip"
# Niveau de qualité le plus bas de streamrip pour Deezer (voir [deezer] quality
# de sa configuration) : 0 = 128 kbps MP3, 1 = 320 kbps MP3, 2 = FLAC.
# Exigence du projet : la qualité la plus basse, jamais la plus haute.
DEEZER_QUALITY = 0
DEEZER_BITRATE_KBPS = 128
SEARCH_TIMEOUT_SEC = 45
DOWNLOAD_TIMEOUT_SEC = 180
MAX_DOWNLOAD_BYTES = 40 * 1024 * 1024
_AUDIO_SUFFIXES = (
    ".mp3",
    ".m4a",
    ".aac",
    ".flac",
    ".ogg",
    ".opus",
    ".aiff",
    ".aif",
    ".wav",
)
# Clés modifiées dans la copie de configuration utilisée par le provider : le
# reste du fichier de streamrip est repris tel quel.
_CONFIG_OPTIONS = (
    # streamrip interroge GitHub avant chaque commande : appel inutile ici.
    ("cli", "no_update_check", "true"),
    # Pas de paroles : un appel à lrclib.net en moins, et rien à en faire ici.
    ("downloads", "lyrics", "false"),
    # Le provider décide lui-même quand télécharger ; la base de streamrip
    # ferait sauter un morceau déjà vu au lieu de le livrer à nouveau.
    ("database", "downloads_enabled", "false"),
    ("database", "failed_downloads_enabled", "false"),
    # Pochette inutile pour la lecture, et son fichier .jpg dans le dossier de
    # destination brouillerait la recherche du morceau téléchargé.
    ("artwork", "embed", "false"),
    ("artwork", "save_artwork", "false"),
)
# Message de streamrip quand le cookie ARL est absent ou expiré.
_AUTH_HINTS = ("AuthenticationError", "MissingCredentialsError", "needs authorising")
# Un résultat de recherche streamrip ne porte pas de durée : elle est vérifiée
# sur le fichier téléchargé, dans `download`.
MATCH_THRESHOLDS = MatchThresholds(allow_missing_duration=True)


class DeezerProviderError(Exception):
    """Erreur spécifique au fournisseur Deezer."""


class DeezerProvider:
    """Cherche sur Deezer et télécharge en 128 kbps via la CLI streamrip."""

    name = "deezer"

    def __init__(
        self,
        *,
        arl: str,
        work_dir: Path | None = None,
        search_limit: int = 10,
        search_timeout_sec: int = SEARCH_TIMEOUT_SEC,
        download_timeout_sec: int = DOWNLOAD_TIMEOUT_SEC,
        max_download_bytes: int = MAX_DOWNLOAD_BYTES,
        thresholds: MatchThresholds | None = None,
        binary: str = STREAMRIP_BINARY,
    ) -> None:
        if not arl or not arl.strip():
            raise ValueError("arl is required")
        if search_limit < 1 or search_limit > 100:
            raise ValueError("search_limit must be between 1 and 100")
        self.arl = arl.strip()
        self.work_dir = Path(work_dir or (Path(tempfile.gettempdir()) / "night-light-streamrip"))
        self.search_limit = search_limit
        self.search_timeout_sec = search_timeout_sec
        self.download_timeout_sec = download_timeout_sec
        self.max_download_bytes = max_download_bytes
        self.thresholds = thresholds or MATCH_THRESHOLDS
        self.binary = binary
        self._config_path: Path | None = None

    def search(self, query: TrackQuery) -> list[Candidate]:
        """Cherche le morceau dans le catalogue Deezer."""
        with tempfile.TemporaryDirectory(prefix="deezer-search-") as temp_dir:
            output_file = Path(temp_dir) / "results.json"
            command = [
                self._binary(),
                "--config-path",
                str(self._config()),
                "--no-progress",
                "--quality",
                str(DEEZER_QUALITY),
                "search",
                "deezer",
                "track",
                _build_query(query),
                "--num-results",
                str(self.search_limit),
                "--output-file",
                str(output_file),
            ]
            _run_command(command, timeout=self.search_timeout_sec, operation="recherche Deezer")
            # streamrip n'écrit rien quand la recherche ne rend rien.
            if not output_file.is_file():
                return []
            try:
                results = json.loads(output_file.read_text(encoding="utf-8"))
            except json.JSONDecodeError as error:
                raise DeezerProviderError("réponse streamrip illisible") from error

        candidates: list[Candidate] = []
        seen: set[str] = set()
        for item in results if isinstance(results, list) else []:
            candidate = _candidate_from_result(item, query)
            if candidate is None or candidate.source_id in seen:
                continue
            seen.add(candidate.source_id)
            candidates.append(candidate)
        candidates.sort(
            key=lambda candidate: validate_match(query, candidate, self.thresholds).score,
            reverse=True,
        )
        return candidates

    def download(self, candidate: Candidate, destination: Path) -> Path:
        """Télécharge le morceau au niveau de qualité le plus bas."""
        destination = Path(destination)
        destination.mkdir(parents=True, exist_ok=True)
        track_id = (candidate.source_id or "").strip()
        if not track_id:
            raise DeezerProviderError("candidat sans identifiant Deezer")
        before = _files_in(destination)
        command = [
            self._binary(),
            "--config-path",
            str(self._config()),
            "--no-progress",
            "--quality",
            str(DEEZER_QUALITY),
            "-f",
            str(destination),
            "id",
            "deezer",
            "track",
            track_id,
        ]
        _run_command(
            command,
            timeout=self.download_timeout_sec,
            operation="téléchargement Deezer",
        )
        path = _downloaded_file(destination, before)
        try:
            resolved = path.resolve()
            root = destination.resolve()
        except OSError as error:
            raise DeezerProviderError(f"chemin de fichier invalide: {error}") from error
        if resolved != root and root not in resolved.parents:
            raise DeezerProviderError("le fichier téléchargé est hors du répertoire attendu")
        _validate_downloaded_audio(
            path,
            max_bytes=self.max_download_bytes,
            expected_duration_sec=_expected_duration(candidate),
        )
        return path

    def _binary(self) -> str:
        # `bun run dev` n'hérite pas toujours de ~/.local/bin.
        found = shutil.which(self.binary)
        if found:
            return found
        local = Path.home() / ".local" / "bin" / self.binary
        return str(local) if local.is_file() else self.binary

    def _config(self) -> Path:
        """La configuration streamrip du provider, écrite une fois par instance.

        streamrip n'accepte pas d'ARL par variable d'environnement : le cookie
        est posé dans une copie privée de sa configuration, elle-même dérivée
        de la configuration par défaut de la version installée.
        """
        if self._config_path is not None and self._config_path.is_file():
            return self._config_path
        self.work_dir.mkdir(parents=True, exist_ok=True)
        os.chmod(self.work_dir, 0o700)
        template = self.work_dir / f"streamrip-base-{_streamrip_version(self._binary())}.toml"
        if not template.is_file():
            _run_command(
                [
                    self._binary(),
                    "--config-path",
                    str(template),
                    "config",
                    "reset",
                    "-y",
                ],
                timeout=self.search_timeout_sec,
                operation="initialisation de streamrip",
            )
        text = template.read_text(encoding="utf-8")
        text = _set_option(text, "deezer", "arl", _toml_string(self.arl))
        for section, key, value in _CONFIG_OPTIONS:
            text = _set_option(text, section, key, value)
        config = self.work_dir / "streamrip.toml"
        _write_private(config, text)
        self._config_path = config
        return config


def _run_command(
    command: list[str], *, timeout: int, operation: str
) -> subprocess.CompletedProcess[str]:
    environment = dict(os.environ, NO_COLOR="1", TERM="dumb")
    try:
        completed = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            env=environment,
        )
    except FileNotFoundError as error:
        raise DeezerProviderError(
            "streamrip introuvable : installe le fork "
            "(uv tool install <chemin-vers-le-dépôt-cloné-de-streamrip>)"
        ) from error
    except subprocess.TimeoutExpired as error:
        raise DeezerProviderError(f"{operation} : délai d'attente dépassé") from error
    if completed.returncode != 0:
        detail = _error_detail(completed.stderr, completed.stdout)
        if any(hint in detail for hint in _AUTH_HINTS):
            raise DeezerProviderError(
                "Deezer a refusé l'authentification : vérifie DEEZER_ARL "
                "(cookie « arl » d'une session web Deezer), ou essaie "
                "`streamrip config open` depuis un terminal."
            )
        raise DeezerProviderError(f"{operation} a échoué (code {completed.returncode}): {detail}")
    return completed


def _error_detail(stderr: str, stdout: str) -> str:
    """Le message utile d'une erreur streamrip, qu'elle encadre de décor."""
    lines = [line.strip().strip("│╰╯╭╮─╌╎ \t") for line in (stderr or stdout or "").splitlines()]
    lines = [line for line in lines if line]
    errors = [line for line in lines if "Error" in line]
    return (errors or lines or ["erreur inconnue"])[-1][:300]


def _build_query(query: TrackQuery) -> str:
    artist = " ".join(re.sub(r"[,;&/]+", " ", query.artist).split())
    return " ".join(part for part in (query.title.strip(), artist) if part)


def _parse_desc(desc: str) -> tuple[str, str]:
    """Sépare le « Name by Artist (2024) » que streamrip résume d'un résultat."""
    text = re.sub(r"\s*\([^()]*\)\s*$", "", desc.strip())
    title, separator, artist = text.rpartition(" by ")
    if separator and title.strip() and artist.strip():
        return title.strip(), artist.strip()
    return text.strip(), ""


def _candidate_from_result(item: Any, query: TrackQuery) -> Candidate | None:
    if not isinstance(item, dict):
        return None
    track_id = str(item.get("id") or "").strip()
    desc = str(item.get("desc") or "").strip()
    if not track_id or not desc:
        return None
    title, artist = _parse_desc(desc)
    if not title:
        return None
    return Candidate(
        provider="deezer",
        source_id=track_id,
        title=title,
        artist=artist,
        # streamrip ne renvoie pas la durée d'un résultat de recherche : elle
        # est reportée sur le candidat puis vérifiée sur le fichier téléchargé.
        duration_sec=None,
        url=f"https://www.deezer.com/track/{track_id}",
        container="mp3",
        codec="mp3",
        bitrate=DEEZER_BITRATE_KBPS,
        metadata={
            "desc": desc,
            "quality": DEEZER_QUALITY,
            "expected_duration_sec": query.duration_sec,
        },
        is_preview=False,
    )


def _expected_duration(candidate: Candidate) -> float | None:
    value = candidate.metadata.get("expected_duration_sec")
    return float(value) if isinstance(value, (int, float)) and value > 0 else None


def _set_option(text: str, section: str, key: str, literal: str) -> str:
    """Fixe une clé d'une section du TOML, sans reconstruire le fichier.

    Le schéma de streamrip change d'une version à l'autre : on ne réécrit que
    la ligne visée et on laisse le reste intact.
    """
    lines = text.splitlines()
    header = f"[{section}]"
    start = next((i for i, line in enumerate(lines) if line.strip() == header), None)
    if start is None:
        raise DeezerProviderError(f"section [{section}] absente de la configuration streamrip")
    end = next(
        (i for i in range(start + 1, len(lines)) if lines[i].lstrip().startswith("[")),
        len(lines),
    )
    option = re.compile(rf"^\s*#?\s*{re.escape(key)}\s*=")
    for index in range(start + 1, end):
        if option.match(lines[index]):
            lines[index] = f"{key} = {literal}"
            return "\n".join(lines) + "\n"
    lines.insert(start + 1, f"{key} = {literal}")
    return "\n".join(lines) + "\n"


def _toml_string(value: str) -> str:
    if any(character in value for character in ('"', "\\", "\n", "\r")):
        raise DeezerProviderError("DEEZER_ARL contient des caractères invalides")
    return f'"{value}"'


def _write_private(path: Path, text: str) -> None:
    temporary = path.with_suffix(".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(text)
    os.replace(temporary, path)


def _files_in(directory: Path) -> set[Path]:
    return {path for path in directory.rglob("*") if path.is_file()}


def _downloaded_file(destination: Path, before: set[Path]) -> Path:
    files = [path for path in _files_in(destination) if path.suffix.lower() in _AUDIO_SUFFIXES]
    if not files:
        raise DeezerProviderError("aucun fichier audio téléchargé")
    fresh = [path for path in files if path not in before]
    return max(fresh or files, key=lambda path: path.stat().st_mtime)


def _validate_downloaded_audio(
    path: Path, *, max_bytes: int, expected_duration_sec: float | None
) -> None:
    if not path.is_file() or path.stat().st_size <= 0:
        raise DeezerProviderError("fichier audio vide ou absent")
    if path.stat().st_size > max_bytes:
        raise DeezerProviderError("fichier audio trop volumineux")
    head = path.read_bytes()[:64]
    sniff_result = sniff(head)
    if not sniff_result.supported:
        raise DeezerProviderError(f"format non audio détecté: {sniff_result.format_name}")
    duration = _probe_duration(path)
    if duration <= 0:
        raise DeezerProviderError("durée non positive dans le fichier téléchargé")
    if expected_duration_sec and expected_duration_sec > 0:
        # Tolérance stricte: petits écarts d'encodage/lecture seulement. Un
        # écart franc signale une autre version (live, remix, edit).
        tolerance = max(2.0, expected_duration_sec * 0.005)
        if abs(duration - expected_duration_sec) > tolerance:
            raise DeezerProviderError(
                f"durée incompatible: attendu {expected_duration_sec:.3f}s, obtenu {duration:.3f}s"
            )


def _probe_duration(path: Path) -> float:
    try:
        output = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except FileNotFoundError as error:
        raise DeezerProviderError(
            "ffprobe introuvable : impossible de valider le fichier"
        ) from error
    except subprocess.TimeoutExpired as error:
        raise DeezerProviderError("ffprobe a dépassé le délai") from error
    if output.returncode != 0:
        raise DeezerProviderError(f"ffprobe a refusé le fichier: {output.stderr.strip()[:200]}")
    try:
        return float(output.stdout.strip())
    except ValueError as error:
        raise DeezerProviderError("durée illisible dans le fichier téléchargé") from error


@functools.lru_cache(maxsize=4)
def _streamrip_version(binary: str) -> str:
    """La version installée : le modèle de config ne doit pas venir d'une autre."""
    try:
        completed = subprocess.run(
            [binary, "--version"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return "unknown"
    if completed.returncode != 0:
        return "unknown"
    match = re.search(r"(\d+\.\d+(?:\.\d+)?)", completed.stdout or "")
    return match.group(1) if match else "unknown"
