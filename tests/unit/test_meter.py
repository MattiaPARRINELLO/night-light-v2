"""Métrique : 4/4 binaire, 3/4 valse, et 4/4 à accentuation ambiguë.

Le corpus réel n'est pas en CI (audio absent) : voir ``tools/corpus_metrics.py``.
Ces signaux minimaux vérifient que la préférence binaire ne se retourne que
devant une périodicité ternaire franche, à plusieurs tempos.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import numpy as np

from server.analysis import estimate_meter

SR = 22050
HOP = 512


def _pulse_envelope(
    accent_every: int,
    *,
    tempo: float = 120.0,
    beats: int = 160,
    offbeat_level: float = 0.2,
) -> np.ndarray:
    """Train de pulsations dont une sur ``accent_every`` est accentuée."""
    period = 60.0 / tempo
    duration = beats * period + 1.0
    onset_env = np.zeros(int(duration * SR / HOP))
    for index in range(beats):
        frame = int(round(index * period * SR / HOP))
        if frame < onset_env.size:
            onset_env[frame] = 1.0 if index % accent_every == 0 else offbeat_level
    return onset_env


def test_4_4_binaire() -> None:
    for tempo in (90.0, 120.0, 160.0):
        assert estimate_meter(_pulse_envelope(4, tempo=tempo), [], tempo, SR) == 4


def test_3_4_valse() -> None:
    for tempo in (90.0, 120.0, 160.0):
        assert estimate_meter(_pulse_envelope(3, tempo=tempo), [], tempo, SR) == 3


def test_3_4_valse_lente() -> None:
    assert estimate_meter(_pulse_envelope(3, tempo=60.0), [], 60.0, SR) == 3


def test_4_4_a_accentuation_ambiguë_reste_binaire() -> None:
    """Pulsations égales ou quasi égales : aucune preuve ternaire, on garde 4."""
    assert estimate_meter(_pulse_envelope(1000), [], 120.0, SR) == 4
    assert estimate_meter(_pulse_envelope(2, offbeat_level=0.9), [], 120.0, SR) == 4


def test_3_4_sans_accent_franc_reste_binaire() -> None:
    """Preuve forte exigée : une périodicité ternaire à peine marquée ne suffit pas."""
    assert estimate_meter(_pulse_envelope(3, offbeat_level=0.9), [], 120.0, SR) == 4


def test_metrique_sans_information_reste_binaire() -> None:
    assert estimate_meter(np.zeros(1000), [], 0.0, SR) == 4
    assert estimate_meter(np.zeros(1000), [], 120.0, SR) == 4
