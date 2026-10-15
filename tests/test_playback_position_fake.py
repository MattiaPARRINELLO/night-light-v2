"""Tests de la position de lecture via un faux `playerctl` (aucun lecteur réel)."""

from __future__ import annotations

import time

import pytest

from server.playback_position import get_playback_state, match_playback
from tests.fake_player import FakePlayer


@pytest.fixture
def fake(tmp_path, monkeypatch):
    """Un faux lecteur placé devant le vrai `playerctl` du système."""
    player = FakePlayer(tmp_path / "bin")
    for name, value in player.env().items():
        monkeypatch.setenv(name, value)
    return player


def test_position_avance_avec_le_temps(fake: FakePlayer) -> None:
    fake.write(
        status="Playing",
        title="Neon Skyline",
        artist="Artiste de test",
        length_us=12_000_000,
        position=4.0,
    )
    state = get_playback_state(title="Neon Skyline", duration_sec=12.0)
    assert state.source in {"mpris", "spotify"}
    assert state.available is True
    assert state.status == "playing"
    assert state.title == "Neon Skyline"
    assert state.duration_ms == 12_000

    # On mesure le temps réellement écoulé : sous charge, une machine lente
    # allonge l'appel à `playerctl` et la position avance d'autant.
    debut = time.monotonic()
    time.sleep(0.5)
    later = get_playback_state(title="Neon Skyline", duration_sec=12.0)
    ecoule_ms = (time.monotonic() - debut) * 1000
    avance = later.position_ms - state.position_ms
    assert ecoule_ms - 250 <= avance <= ecoule_ms + 400, (
        f"avance {avance} ms pour {ecoule_ms:.0f} ms écoulés"
    )


def test_pause_fige_la_position(fake: FakePlayer) -> None:
    fake.write(
        status="Paused",
        title="Neon Skyline",
        artist="Artiste de test",
        length_us=12_000_000,
        position=7.0,
    )
    state = get_playback_state(title="Neon Skyline", duration_sec=12.0)
    assert state.status == "paused"
    time.sleep(0.3)
    again = get_playback_state(title="Neon Skyline", duration_sec=12.0)
    assert again.position_ms == state.position_ms == 7000


def test_match_refuse_un_autre_morceau(fake: FakePlayer) -> None:
    fake.write(
        status="Playing",
        title="Tout autre chose",
        artist="Artiste de test",
        length_us=12_000_000,
        position=1.0,
    )
    state = get_playback_state(title="Neon Skyline", duration_sec=12.0)
    verdict = match_playback(state, title="Neon Skyline", duration_sec=12.0)
    assert verdict["accepted"] is False
    assert "weak_title" in verdict["reasons"]


def test_saut_de_position_change_la_position_lue(fake: FakePlayer) -> None:
    fake.write(
        status="Playing",
        title="Neon Skyline",
        artist="Artiste de test",
        length_us=12_000_000,
        position=4.0,
    )
    state = get_playback_state(title="Neon Skyline", duration_sec=12.0)
    assert 4_000 <= state.position_ms < 6_000

    fake.set_position(30.5)
    jumped = get_playback_state(title="Neon Skyline", duration_sec=12.0)
    assert 30_000 <= jumped.position_ms < 31_500
    # Un saut de lecture doit rester le même morceau : la synchro doit suivre,
    # pas renoncer.
    verdict = match_playback(jumped, title="Neon Skyline", duration_sec=12.0)
    assert verdict["accepted"] is True
