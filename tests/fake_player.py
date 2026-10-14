"""Pilote le faux lecteur `playerctl` utilisé par les tests de synchronisation."""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

DEFAULT_STATE = {
    "status": "Stopped",
    "title": "",
    "artist": "",
    "album": "",
    "length_us": 0,
    "position": 0.0,
    "updated_at": 0.0,
}


class FakePlayer:
    """Écrit l'état du lecteur factice ; le binaire `playerctl` le relit à chaque appel."""

    def __init__(self, root: str | os.PathLike[str]) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.state_path = self.root / "player-state.json"
        self.bin_path = self.root / "playerctl"
        self._write_binary()

    def _write_binary(self) -> None:
        source = Path(__file__).with_name("fake_playerctl.py")
        self.bin_path.write_text(
            f'#!/bin/sh\nexec {sys.executable} {source} "$@"\n',
            encoding="utf-8",
        )
        self.bin_path.chmod(0o755)

    def write(self, **updates: object) -> dict:
        state = {**DEFAULT_STATE, **updates}
        state["updated_at"] = time.time()
        self.state_path.write_text(json.dumps(state), encoding="utf-8")
        return state

    def set_position(self, position_sec: float) -> dict:
        """Déplace la tête de lecture, comme un saut dans le morceau."""
        state = json.loads(self.state_path.read_text(encoding="utf-8"))
        state["position"] = float(position_sec)
        state["updated_at"] = time.time()
        self.state_path.write_text(json.dumps(state), encoding="utf-8")
        return state

    def read(self) -> dict:
        return json.loads(self.state_path.read_text(encoding="utf-8"))

    def env(self) -> dict[str, str]:
        """Variables à injecter dans le processus serveur : PATH + état du lecteur."""
        return {
            "PATH": f"{self.root}{os.pathsep}{os.environ.get('PATH', '')}",
            "FAKE_PLAYER_STATE": str(self.state_path),
        }


def write_default(root: str | os.PathLike[str]) -> FakePlayer:
    return FakePlayer(root)
