#!/usr/bin/env python3
"""Faux `playerctl` pour les tests : joue un morceau défini dans un fichier d'état.

Le serveur appelle seulement trois formes :

    playerctl --version
    playerctl -l
    playerctl -p <lecteur> metadata --format "{{status}}|{{title}}|…"
    playerctl -p <lecteur> position

L'état attend un JSON :

    {
      "status": "Playing",
      "title": "Neon Skyline",
      "artist": "Artiste de test",
      "album": "",
      "length_us": 12000000,
      "position": 4.0,
      "updated_at": 1791970000.0,
      "rate": 1.0
    }

La position avance toute seule quand `status` vaut `playing`, ce qui permet de
vérifier le suivi dans le temps sans lecteur réel.
"""

from __future__ import annotations

import json
import os
import sys
import time

STATE_PATH = os.environ.get("FAKE_PLAYER_STATE", "")
PLAYER = "fake.player"


def load_state() -> dict:
    if STATE_PATH == "" or not os.path.exists(STATE_PATH):
        return {
            "status": "Stopped",
            "title": "",
            "artist": "",
            "album": "",
            "length_us": 0,
            "position": 0.0,
            "updated_at": time.time(),
        }
    with open(STATE_PATH, encoding="utf-8") as handle:
        return json.load(handle)


def current_position(state: dict) -> float:
    position = float(state.get("position", 0.0) or 0.0)
    if str(state.get("status", "")).lower() == "playing":
        # `rate` permet de faire dériver volontairement l'horloge du lecteur :
        # 1.03 = il avance 3 % plus vite, donc l'écart avec le show grandit.
        rate = float(state.get("rate", 1.0) or 1.0)
        position += max(0.0, time.time() - float(state.get("updated_at", 0.0) or 0.0)) * rate
    return max(0.0, position)


def main(argv: list[str]) -> int:
    if argv[:1] == ["--version"]:
        print("2.4.1-fake")
        return 0

    if argv[:1] == ["-l"]:
        print(PLAYER)
        return 0

    state = load_state()
    player = ""
    if argv[:1] == ["-p"] and len(argv) > 1:
        player = argv[1]
        argv = argv[2:]

    if argv[:1] == ["metadata"]:
        template = argv[argv.index("--format") + 1] if "--format" in argv else ""
        # playerctl remplace les champs entre accolades : "{{status}}" -> "status".
        fields = [
            field.strip().removeprefix("{{").removesuffix("}}")
            for field in template.split("|")
        ]
        values = {
            "status": str(state.get("status", "Stopped")),
            "title": str(state.get("title", "")),
            "artist": str(state.get("artist", "")),
            "album": str(state.get("album", "")),
            "mpris:length": str(int(state.get("length_us", 0) or 0)),
        }
        print("|".join(values.get(field, "") for field in fields))
        return 0

    if argv[:1] == ["position"]:
        print(f"{current_position(state):.6f}")
        return 0

    print("", end="")
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
