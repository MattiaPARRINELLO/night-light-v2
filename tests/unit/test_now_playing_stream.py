"""Flux SSE now-playing : battement régulier et transmission des changements."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from server import main, mpris


class _FakeRequest:
    """Requête minimale : le flux ne doit jamais se croire déconnecté."""

    async def is_disconnected(self) -> bool:
        return False


def test_le_flux_bat_quand_aucun_morceau_ne_change(monkeypatch) -> None:
    """Sans changement MPRIS, le client doit quand même recevoir un signe de vie."""
    monkeypatch.setattr(main, "NOW_PLAYING_HEARTBEAT_SEC", 0.05)

    async def scenario() -> list[str]:
        response = await main.now_playing_stream(_FakeRequest())
        iterator = response.body_iterator
        frames: list[str] = []
        try:

            async def collect() -> None:
                async for chunk in iterator:
                    frames.append(str(chunk))
                    if len(frames) >= 3:
                        return

            await asyncio.wait_for(collect(), timeout=5.0)
        finally:
            await iterator.aclose()
        return frames

    frames = asyncio.run(scenario())
    assert frames[0].startswith("data: ")
    assert any("event: ping" in frame for frame in frames[1:])


def test_le_flux_transmet_les_changements_de_morceau(monkeypatch) -> None:
    monkeypatch.setattr(main, "NOW_PLAYING_HEARTBEAT_SEC", 0.05)
    # Titre unique : l'état MPRIS est global et d'autres tests ont pu y laisser
    # un morceau identique, que le flux ne renverrait alors pas (même payload).
    titre = "Morceau SSE de test"

    async def scenario() -> str:
        response = await main.now_playing_stream(_FakeRequest())
        iterator = response.body_iterator
        try:
            await asyncio.wait_for(iterator.__anext__(), timeout=5.0)

            async def next_track() -> str:
                while True:
                    frame = str(await iterator.__anext__())
                    if frame.startswith("data: ") and titre in frame:
                        return frame

            mpris._publish(mpris.NowPlaying(available=True, title=titre, artist="Test"))
            return await asyncio.wait_for(next_track(), timeout=5.0)
        finally:
            await iterator.aclose()

    frame = asyncio.run(scenario())
    assert titre in frame
