"""Détection des lecteurs multimédias via MPRIS / playerctl."""

from __future__ import annotations

import queue
import subprocess
import threading
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass
from typing import Any

PLAYERCTL = "playerctl"
FOLLOW_FORMAT = "{{status}}|{{title}}|{{artist}}|{{album}}|{{mpris:length}}"


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
_FOLLOW_PROC: subprocess.Popen[str] | None = None
_SUBSCRIBERS: set[queue.Queue[dict[str, Any]]] = set()
_SUBSCRIBERS_LOCK = threading.Lock()
_LISTENERS: list[Callable[[NowPlaying], None]] = []
_LISTENERS_LOCK = threading.Lock()


def _run(args: list[str], timeout: float = 3.0) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired, FileNotFoundError) as error:
        return subprocess.CompletedProcess(args, returncode=124, stdout="", stderr=str(error))


def _playerctl_available() -> bool:
    try:
        cp = _run([PLAYERCTL, "--version"], timeout=2.0)
        return cp.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def _parse_info(line: str) -> dict[str, Any]:
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
    return {
        "status": status,
        "title": title.strip(),
        "artist": artist.strip(),
        "album": album.strip(),
        "duration_sec": duration,
    }


def _metadata_for(player: str) -> dict[str, Any]:
    cp = _run(
        [
            PLAYERCTL,
            "-p",
            player,
            "metadata",
            "--format",
            FOLLOW_FORMAT,
        ],
        timeout=2.0,
    )
    info = _parse_info((cp.stdout or "").strip())
    position = None
    cp_pos = _run([PLAYERCTL, "-p", player, "position"], timeout=2.0)
    try:
        position = float((cp_pos.stdout or "").strip())
    except (ValueError, TypeError):
        position = None
    info["position_sec"] = position
    return info


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


def _publish(state: NowPlaying) -> None:
    """Met à jour l'état partagé, notifie les abonnés SSE et les écouteurs."""
    global _STATE
    with _LOCK:
        _STATE = state
    with _SUBSCRIBERS_LOCK:
        subscribers = list(_SUBSCRIBERS)
    if subscribers:
        payload = state.to_dict()
        for subscriber in subscribers:
            try:
                if subscriber.full():
                    subscriber.get_nowait()
                subscriber.put_nowait(payload)
            except (queue.Full, queue.Empty):
                continue
    with _LISTENERS_LOCK:
        listeners = list(_LISTENERS)
    for listener in listeners:
        try:
            listener(state)
        except Exception:  # noqa: BLE001 - un abonné ne doit pas casser le moniteur
            continue


def subscribe_now_playing() -> queue.Queue[dict[str, Any]]:
    """File d'attente recevant chaque changement de morceau (SSE)."""
    subscriber: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=32)
    with _SUBSCRIBERS_LOCK:
        _SUBSCRIBERS.add(subscriber)
    return subscriber


def unsubscribe_now_playing(subscriber: queue.Queue[dict[str, Any]]) -> None:
    with _SUBSCRIBERS_LOCK:
        _SUBSCRIBERS.discard(subscriber)


def add_now_playing_listener(listener: Callable[[NowPlaying], None]) -> None:
    with _LISTENERS_LOCK:
        if listener not in _LISTENERS:
            _LISTENERS.append(listener)


def remove_now_playing_listener(listener: Callable[[NowPlaying], None]) -> None:
    with _LISTENERS_LOCK:
        if listener in _LISTENERS:
            _LISTENERS.remove(listener)


def _snapshot(previous: NowPlaying) -> NowPlaying:
    """Lit l'état complet du lecteur choisi (métadonnées + position)."""
    players = _list_players()
    if not players:
        return NowPlaying(available=True, updated_at=time.time())
    chosen, ambiguous = _choose_player(players, previous)
    info = _metadata_for(chosen) if chosen else {}
    return NowPlaying(
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


def _follow_once(previous: NowPlaying) -> tuple[bool, NowPlaying]:
    """Lit `playerctl --follow metadata` jusqu'à ce que le process meure.

    Renvoie `(sain, dernier_état)`. « sain » distingue un process qui a vécu
    assez longtemps pour être utile d'un échec immédiat (playerctl absent ou
    option non supportée), auquel cas le polling reprend la main.
    """
    global _FOLLOW_PROC
    started_at = time.monotonic()
    try:
        process = subprocess.Popen(
            [PLAYERCTL, "--follow", "metadata", "--format", FOLLOW_FORMAT],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
        )
    except (OSError, ValueError):
        return False, previous
    with _LOCK:
        _FOLLOW_PROC = process
    state = _snapshot(previous)
    _publish(state)
    previous = state
    try:
        assert process.stdout is not None
        # Lecture bloquante : chaque ligne est un changement de métadonnées.
        for line in process.stdout:
            if _STOP.is_set():
                break
            info = _parse_info(line.strip())
            cp_pos = _run([PLAYERCTL, "position"], timeout=2.0)
            try:
                position = float((cp_pos.stdout or "").strip())
            except (ValueError, TypeError):
                position = None
            state = NowPlaying(
                available=True,
                player=previous.player,
                status=info["status"],
                title=info["title"],
                artist=info["artist"],
                album=info["album"],
                duration_sec=info["duration_sec"],
                position_sec=position,
                updated_at=time.time(),
            )
            _publish(state)
            previous = state
    finally:
        with _LOCK:
            if _FOLLOW_PROC is process:
                _FOLLOW_PROC = None
        if process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=1.0)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=1.0)
    return time.monotonic() - started_at >= 5.0, previous


def _poll_fallback(previous: NowPlaying, seconds: float = 5.0) -> NowPlaying:
    """Polling de secours, utilisé quand le suivi temps réel est indisponible."""
    deadline = time.monotonic() + seconds
    while not _STOP.is_set() and time.monotonic() < deadline:
        state = _snapshot(previous)
        _publish(state)
        previous = state
        _STOP.wait(1.0)
    return previous


def _monitor_loop() -> None:
    previous = NowPlaying(available=False)
    if not _playerctl_available():
        _publish(NowPlaying(available=False, error="playerctl introuvable"))
        return
    while not _STOP.is_set():
        healthy, previous = _follow_once(previous)
        if _STOP.is_set():
            return
        if not healthy:
            # `--follow` a échoué trop vite (option absente, lecteur fermé…) :
            # on garde le polling historique pour ne jamais perdre la détection.
            previous = _poll_fallback(previous)
        else:
            _STOP.wait(0.2)


def start_mpris_monitor() -> bool:
    global _THREAD
    if _THREAD is not None and _THREAD.is_alive():
        return True
    if not _playerctl_available():
        _publish(NowPlaying(available=False, error="playerctl introuvable"))
        return False
    _STOP.clear()
    _THREAD = threading.Thread(target=_monitor_loop, name="mpris-monitor", daemon=True)
    _THREAD.start()
    return True


def stop_mpris_monitor() -> None:
    global _FOLLOW_PROC
    _STOP.set()
    with _LOCK:
        process = _FOLLOW_PROC
    if process is not None and process.poll() is None:
        process.terminate()
    if _THREAD is not None and _THREAD.is_alive():
        _THREAD.join(timeout=3.0)


def get_now_playing() -> NowPlaying:
    with _LOCK:
        return NowPlaying(**_STATE.__dict__)
