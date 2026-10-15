"""Lecture des positions de lecture externes pour Night Light."""

from __future__ import annotations

import re
import subprocess
import time
import unicodedata
from dataclasses import asdict, dataclass
from difflib import SequenceMatcher
from typing import Any

PLAYERCTL = "playerctl"
_MPRIS_PREFIX = "org.mpris.MediaPlayer2."


@dataclass(frozen=True)
class PlaybackState:
    source: str = "none"
    available: bool = False
    title: str = ""
    artist: str = ""
    album: str = ""
    status: str = "stopped"
    position_ms: int = 0
    duration_ms: int | None = None
    captured_at: float = 0.0
    error: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _clean_ensure() -> None:
    return None


def _run(args: list[str], timeout: float = 3.0) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return subprocess.CompletedProcess(
            args=args, returncode=127, stdout="", stderr="lancement indisponible"
        )


def _playerctl_available() -> bool:
    completed = _run([PLAYERCTL, "--version"], timeout=2.0)
    return completed.returncode == 0


def _list_players() -> list[str]:
    if not _playerctl_available():
        return []
    completed = _run([PLAYERCTL, "-l"], timeout=2.0)
    if completed.returncode != 0:
        return []
    return [line.strip() for line in completed.stdout.splitlines() if line.strip()]


def _metadata_for(player: str) -> dict[str, Any]:
    title = ""
    artist = ""
    album = ""
    duration_ms: int | None = None
    status = "unknown"
    position = 0.0
    cp = _run(
        [
            PLAYERCTL,
            "-p",
            player,
            "metadata",
            "--format",
            "{{status}}|{{title}}|{{artist}}|{{album}}|{{mpris:length}}",
        ],
        timeout=2.0,
    )
    line = (cp.stdout or "").strip()
    parts = line.split("|", 4)
    while len(parts) < 5:
        parts.append("")
    status_raw, title, artist, album, length_raw = parts
    status = (status_raw or "").strip().lower() or "unknown"
    if status not in {"playing", "paused", "stopped"}:
        status = "playing" if "playing" in status else status
    try:
        length = int(float((length_raw or "").strip()))
        if length > 0:
            duration_ms = length // 1000
    except (ValueError, TypeError):
        duration_ms = None
    try:
        read_started = time.time()
        cp_pos = _run([PLAYERCTL, "-p", player, "position"], timeout=2.0)
        position = float((cp_pos.stdout or "").strip())
        read_finished = time.time()
        position_read_at = (read_started + read_finished) / 2
    except (ValueError, TypeError):
        position = 0.0
        position_read_at = None
    # Player "player" via Spotify expose son backend aussi par playerctl ; on nomme
    # la source selon le lecteur détecté.
    return {
        "status": status,
        "title": title.strip(),
        "artist": artist.strip(),
        "album": album.strip(),
        "duration_ms": duration_ms,
        "position_sec": position,
        # Instant de la vraie mesure de position : sans lui, le front extrapole
        # avec une origine trop tardive et le show perd la latence de playerctl.
        "position_read_at": position_read_at,
    }


def normalize_text(value: str | None) -> str:
    if not value:
        return ""
    if isinstance(value, list):
        value = " ".join(str(v) for v in value)
    value = str(value)
    value = (
        unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    )
    value = value.lower()
    # Variantes courantes enlevées sans distinguer les versions (least-impact).
    value = re.sub(r"\([^)]*\)", " ", value)
    for marker in (
        "feat",
        "ft",
        "featuring",
        "remaster",
        "remastered",
        "live",
        "remix",
        "edit",
    ):
        value = re.sub(rf"\b{marker}\b", " ", value)
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return " ".join(value.split())


def text_similarity(left: str | None, right: str | None) -> float:
    left_n = normalize_text(left)
    right_n = normalize_text(right)
    if not left_n or not right_n:
        return 0.0 if (left_n or right_n) else 1.0
    if left_n == right_n:
        return 1.0
    return SequenceMatcher(None, left_n, right_n).ratio()


def _source_for(player: str) -> str:
    lower = player.lower()
    if "spotify" in lower:
        return "spotify"
    # Deezer et les navigateurs sont également exposés via MPRIS.
    return "mpris"


def _choose_player(
    players: list[str], title: str, artist: str
) -> tuple[str, dict[str, Any]]:
    if not players:
        return "", {}
    infos = [(player, _metadata_for(player)) for player in players]
    if not title and not artist:
        # Aucun critère : privilégier les lecteurs actifs, puis ceux qui ont un morceau.
        infos.sort(
            key=lambda item: (
                1 if item[1]["status"] == "playing" else 0,
                1 if item[1]["title"] else 0,
            ),
            reverse=True,
        )
        player, info = infos[0]
        return player, info

    best: tuple[float, str, dict[str, Any]] | None = None
    for player, info in infos:
        score = 0.0
        if info["status"] == "playing":
            score += 0.25
        score += 0.5 * text_similarity(title, info["title"])
        if artist:
            score += 0.25 * text_similarity(artist, info["artist"])
        candidate = (score, player, info)
        if best is None or score > best[0]:
            best = candidate
    if best is None:
        player, info = infos[0]
        return player, info
    return best[1], best[2]


def match_playback(
    state: PlaybackState,
    *,
    title: str = "",
    artist: str = "",
    duration_sec: float = 0.0,
    title_threshold: float = 0.8,
    duration_tolerance_sec: float = 3.0,
) -> dict[str, Any]:
    reasons: list[str] = []
    if state.source == "none":
        return {
            "accepted": False,
            "title_similarity": 0.0,
            "artist_similarity": 0.0,
            "duration_delta_sec": None,
            "reasons": ("no_player",),
        }

    title_similarity = text_similarity(title, state.title) if title else 1.0
    artist_similarity = text_similarity(artist, state.artist) if artist else 1.0
    duration_delta: float | None = None
    if duration_sec > 0 and state.duration_ms is not None:
        duration_delta = abs((state.duration_ms / 1000.0) - duration_sec)

    if title.strip() and title_similarity < title_threshold:
        reasons.append("weak_title")
    if artist.strip() and state.artist and artist_similarity < 0.75:
        reasons.append("weak_artist")
    if duration_delta is not None and duration_delta > duration_tolerance_sec:
        reasons.append("duration_mismatch")
    if state.status != "playing":
        reasons.append("not_playing")

    accepted = not reasons
    return {
        "accepted": accepted,
        "title_similarity": round(title_similarity, 4),
        "artist_similarity": round(artist_similarity, 4),
        "duration_delta_sec": None
        if duration_delta is None
        else round(duration_delta, 3),
        "reasons": tuple(reasons),
    }


def get_playback_state(
    *,
    title: str = "",
    artist: str = "",
    duration_sec: float = 0.0,
    **_ignored: Any,
) -> PlaybackState:
    captured_at = time.time()
    if not _playerctl_available():
        return PlaybackState(
            source="none",
            status="stopped",
            captured_at=captured_at,
            error="playerctl indisponible",
        )

    players = _list_players()
    if not players:
        return PlaybackState(source="none", status="stopped", captured_at=captured_at)

    player, info = _choose_player(players, title, artist)
    status = (info.get("status") or "unknown").lower()
    if status not in {"playing", "paused", "stopped"}:
        status = "playing" if status.startswith("play") else "unknown"
    if status == "unknown":
        status = "stopped"

    position_sec = float(info.get("position_sec", 0.0) or 0.0)
    # L'horodatage doit correspondre à l'instant où playerctl a réellement mesuré
    # la position, et non à la fin de tous les sous-processus : sans quoi le front
    # extrapole avec une origine trop tardive et le show garde un retard
    # systématique égal à la latence de lecture de playerctl.
    read_at = info.get("position_read_at")
    captured_at = read_at if isinstance(read_at, float) and read_at > 0 else time.time()
    return PlaybackState(
        source=_source_for(player),
        available=True,
        title=info.get("title", ""),
        artist=info.get("artist", ""),
        album=info.get("album", ""),
        status=status,
        position_ms=max(0, int(position_sec * 1000)),
        duration_ms=info.get("duration_ms"),
        captured_at=captured_at,
    )
