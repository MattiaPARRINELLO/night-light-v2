"""Détection des lecteurs multimédias via MPRIS / playerctl."""

from __future__ import annotations

import subprocess
import threading
import time
from dataclasses import asdict, dataclass
from typing import Any

PLAYERCTL = "playerctl"


@dataclass
class NowPlaying:
    available: bool
    player: str = ""
    status: str = "unknown"  # playing, paused, stopped, unknown
    title: str = ""
    artist: str = ""
    album: str = ""
    duration_sec: float | None = None
    position_sec: float | None = None
    updated_at: float = 0.0
    ambiguous: bool = False
    error: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


_STATE = NowPlaying(available=False, error="non démarré")
_LOCK = threading.Lock()
_THREAD: threading.Thread | None = None
_STOP = threading.Event()


def _run(args: list[str], timeout: float = 3.0) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def _playerctl_available() -> bool:
    try:
        cp = _run([PLAYERCTL, "--version"], timeout=2.0)
        return cp.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def _metadata_for(player: str) -> dict[str, Any]:
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
    status = status_raw.strip().lower() or "unknown"
    # mpris:length est en microsecondes.
    duration = None
    try:
        length = int(length_raw.strip())
        if length > 0:
            duration = length / 1_000_000.0
    except ValueError:
        duration = None
    position = None
    cp_pos = _run([PLAYERCTL, "-p", player, "position"], timeout=2.0)
    try:
        position = float((cp_pos.stdout or "").strip())
    except (ValueError, TypeError):
        position = None
    return {
        "status": status,
        "title": title.strip(),
        "artist": artist.strip(),
        "album": album.strip(),
        "duration_sec": duration,
        "position_sec": position,
    }


def _list_players() -> list[str]:
    cp = _run([PLAYERCTL, "-l"], timeout=2.0)
    if cp.returncode != 0:
        return []
    return [line.strip() for line in cp.stdout.splitlines() if line.strip()]


def _choose_player(players: list[str], previous: NowPlaying) -> tuple[str, bool]:
    """Stratégie simple : préférer 'playing', puis la source la plus récemment modifiée."""
    if not players:
        return "", False
    infos = []
    for player in players:
        info = _metadata_for(player)
        score = 0
        if info["status"] == "playing":
            score += 100
        elif info["status"] == "paused":
            score += 10
        # Préférer la source dont les métadonnées sont présentes et récentes.
        if info["title"]:
            score += 5
        if info["artist"]:
            score += 5
        if info["player"] == previous.player if False else False:
            pass
        infos.append((player, info, score))
    # S'il y a plusieurs lecteurs avec le même meilleur score, on lève l'ambiguïté.
    best_score = max(item[2] for item in infos)
    best = [item for item in infos if item[2] == best_score]
    ambiguous = len(best) > 1 and best_score < 100
    # Si plusieurs players jouent vraiment, garder celui dont les métadonnées
    # sont les plus récentes heuristiquement :
    if sum(1 for item in infos if item[1]["status"] == "playing") > 1:
        # Sans horodatage MPRIS fiable, on ne tranche pas arbitrairement.
        playing = [item for item in infos if item[1]["status"] == "playing"]
        if len(playing) > 1:
            ambiguous = True
    chosen = best[0][0]
    return chosen, ambiguous


def _monitor_loop() -> None:
    global _STATE
    previous = NowPlaying(available=False)
    while not _STOP.is_set():
        if not _playerctl_available():
            with _LOCK:
                _STATE = NowPlaying(available=False, error="playerctl introuvable")
            _STOP.wait(5.0)
            continue
        players = _list_players()
        if not players:
            with _LOCK:
                _STATE = NowPlaying(available=True, updated_at=time.time())
            _STOP.wait(1.0)
            continue
        chosen, ambiguous = _choose_player(players, previous)
        info = _metadata_for(chosen) if chosen else {}
        state = NowPlaying(
            available=True,
            player=chosen,
            status=info.get("status", "unknown"),
            title=info.get("title", ""),
            artist=info.get("artist", ""),
            album=info.get("album", ""),
            duration_sec=info.get("duration_sec"),
            position_sec=info.get("position_sec"),
            updated_at=time.time(),
            ambiguous=ambiguous,
        )
        with _LOCK:
            _STATE = state
        previous = state
        _STOP.wait(1.0)


def start_mpris_monitor() -> bool:
    global _THREAD
    if _THREAD is not None and _THREAD.is_alive():
        return True
    if not _playerctl_available():
        with _LOCK:
            global _STATE
            _STATE = NowPlaying(available=False, error="playerctl introuvable")
        return False
    _STOP.clear()
    _THREAD = threading.Thread(target=_monitor_loop, name="mpris-monitor", daemon=True)
    _THREAD.start()
    return True


def stop_mpris_monitor() -> None:
    _STOP.set()
    if _THREAD is not None and _THREAD.is_alive():
        _THREAD.join(timeout=3.0)


def get_now_playing() -> NowPlaying:
    with _LOCK:
        return NowPlaying(**_STATE.__dict__)
