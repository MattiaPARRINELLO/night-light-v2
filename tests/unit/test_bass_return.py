"""Retour de basse : absence de deux mesures, attaque, espacement, garde de montée."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from server.meter import BASS_RETURN_MIN_SPACING_SEC, detect_bass_returns

SR = 22050
HOP = 512
NFFT = 2048
FRAME_RATE = SR / HOP
FREQUENCIES = np.linspace(0.0, SR / 2.0, NFFT // 2 + 1)


def _spectrum(
    levels: list[float], *, beats: float = 0.5
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Spectre dont la seule énergie est le sous-grave, avec les niveaux donnés.

    ``levels`` est fourni par temps : une valeur positive remplit l'intervalle,
    une valeur nulle simule une absence de basse.
    """
    frame_times = np.arange(int(len(levels) * beats * FRAME_RATE) + 1) / FRAME_RATE
    spectrum = np.zeros((FREQUENCIES.size, frame_times.size))
    sub = (FREQUENCIES >= 20.0) & (FREQUENCIES < 60.0)
    for index, level in enumerate(levels):
        start = int(index * beats * FRAME_RATE)
        end = int((index + 1) * beats * FRAME_RATE)
        spectrum[sub, start:end] = level
    beat_times = np.asarray([round(index * beats, 3) for index in range(len(levels))])
    return spectrum, frame_times, beat_times


def _pattern(sections: list[tuple[int, float]], meter: int = 4) -> list[float]:
    """Construit des niveaux par temps à partir de (nombre de temps, niveau)."""
    levels: list[float] = []
    for count, level in sections:
        levels.extend([level] * count)
    return levels


def test_retour_apres_deux_mesures() -> None:
    levels = _pattern([(16, 1.0), (10, 0.0), (16, 2.0)])  # > 2 mesures de 4
    spectrum, frame_times, beats = _spectrum(levels)
    events = detect_bass_returns(
        spectrum, FREQUENCIES, frame_times, list(beats), 4, [], len(beats) * 0.5
    )
    assert len(events) == 1
    event = events[0]
    assert event["kind"] == "bass-return"
    assert abs(event["t"] - 13.0) <= 0.6
    assert 0.0 < event["strength"] <= 1.0


def test_absence_d_un_seul_temps_ignoree() -> None:
    levels = _pattern([(16, 1.0), (4, 0.0), (16, 2.0)])
    spectrum, frame_times, beats = _spectrum(levels)
    assert (
        detect_bass_returns(
            spectrum, FREQUENCIES, frame_times, list(beats), 4, [], len(beats) * 0.5
        )
        == []
    )


def test_espacement_minimal_de_huit_secondes() -> None:
    # Deux retours à 11 s et 18 s : le plus fort reste, l'autre est écarté.
    levels = _pattern([(12, 1.0), (10, 0.0), (4, 1.5), (10, 0.0), (20, 3.0)])
    spectrum, frame_times, beats = _spectrum(levels)
    events = detect_bass_returns(
        spectrum, FREQUENCIES, frame_times, list(beats), 4, [], len(beats) * 0.5
    )
    assert len(events) == 1
    assert all(
        abs(left["t"] - right["t"]) >= BASS_RETURN_MIN_SPACING_SEC
        for index, left in enumerate(events)
        for right in events[index + 1 :]
    )


def test_aucun_evenement_pres_d_une_fin_de_montee() -> None:
    levels = _pattern([(16, 1.0), (10, 0.0), (16, 2.0)])
    spectrum, frame_times, beats = _spectrum(levels)
    builds = [{"start": 11.0, "end": 13.5, "strength": 0.5}]
    events = detect_bass_returns(
        spectrum, FREQUENCIES, frame_times, list(beats), 4, builds, len(beats) * 0.5
    )
    assert events == []


def test_basse_continue_aucun_evenement() -> None:
    levels = _pattern([(60, 1.0)])
    spectrum, frame_times, beats = _spectrum(levels)
    assert (
        detect_bass_returns(
            spectrum, FREQUENCIES, frame_times, list(beats), 4, [], len(beats) * 0.5
        )
        == []
    )


def test_morceau_sans_sous_grave_aucun_evenement() -> None:
    levels = _pattern([(16, 1.0), (10, 0.0), (16, 2.0)])
    spectrum, frame_times, beats = _spectrum(levels)
    # Énergie dominante hors sous-grave : ratio sous-grave / total < 3 %.
    spectrum[(FREQUENCIES >= 150.0) & (FREQUENCIES < 2000.0), :] = 100.0
    assert (
        detect_bass_returns(
            spectrum, FREQUENCIES, frame_times, list(beats), 4, [], len(beats) * 0.5
        )
        == []
    )


def test_evenements_tries_par_temps() -> None:
    levels = _pattern([(12, 1.0), (8, 0.0), (12, 2.0), (8, 0.0), (12, 1.5)])
    spectrum, frame_times, beats = _spectrum(levels)
    events = detect_bass_returns(
        spectrum, FREQUENCIES, frame_times, list(beats), 4, [], len(beats) * 0.5
    )
    assert [event["t"] for event in events] == sorted(event["t"] for event in events)
