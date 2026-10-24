"""Robustesse de l'analyse sur des entrées dégénérées.

Propriétés vérifiées, toutes issues du contrat du serveur (`analyze_file`) :
- une durée < 1 s échoue proprement (`too_short`), jamais par exception nue ;
- les durées autour de la durée minimale de scène (5 s) s'analysent ;
- silence total, mono/stéréo, 8 kHz/96 kHz : aucune valeur non finie ;
- des courbes injectées avec NaN/±inf sont assainies, pas propagées ;
- un tempo non fini retombe sur la grille de repli (120 BPM) ;
- les points de courbe sont toujours finis et dans [0, 1].
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from server.analysis import (
    AnalysisError,
    analyze_file,
    curve_to_points,
    detect_builds,
    estimate_meter,
    normalize_curve,
    normalize_log_curve,
)
from server.config import load_settings


def _write_tone(
    path: Path,
    seconds: float,
    *,
    sample_rate: int = 22050,
    channels: int = 1,
    amplitude: float = 0.4,
) -> None:
    frames = int(round(sample_rate * seconds))
    t = np.arange(frames) / sample_rate
    wave = np.sin(2 * np.pi * 220 * t) * amplitude
    if channels > 1:
        wave = np.repeat(wave[:, None], channels, axis=1)
    if frames == 0:
        wave = np.zeros((0, channels))
    sf.write(path, wave.astype(np.float32), sample_rate, subtype="PCM_16")


def _assert_finite_result(result) -> None:
    assert math.isfinite(result.duration) and result.duration >= 0
    assert math.isfinite(result.tempo) and result.tempo > 0
    for name in ("energy", "bass", "mid", "mid_low", "mid_high", "high"):
        points = getattr(result, name)
        for time_value, energy in points:
            assert math.isfinite(time_value), f"{name}: temps non fini"
            assert math.isfinite(energy), f"{name}: valeur non finie"
            assert 0.0 <= energy <= 1.0, f"{name}: valeur hors [0,1]"
    for beat in result.beats:
        assert math.isfinite(beat)
    for onset in result.onsets:
        assert math.isfinite(onset)
    for build in result.builds:
        assert all(math.isfinite(build[key]) for key in ("start", "end", "strength"))
        assert 0.0 <= build["strength"] <= 1.0
    for section in result.sections:
        assert math.isfinite(section["start"]) and math.isfinite(section["end"])


@pytest.mark.parametrize("seconds", [0.0, 0.5, 0.99])
def test_une_duree_sous_une_seconde_echoue_proprement(tmp_path: Path, seconds: float) -> None:
    track = tmp_path / f"court-{seconds}.wav"
    _write_tone(track, seconds)
    with pytest.raises(AnalysisError) as raised:
        analyze_file(track, load_settings())
    assert raised.value.code == "too_short"
    assert raised.value.message


@pytest.mark.parametrize("seconds", [4.9, 5.0, 5.1])
def test_les_durees_autour_de_la_scene_minimale_s_analysent(tmp_path: Path, seconds: float) -> None:
    track = tmp_path / f"seuil-{seconds}.wav"
    _write_tone(track, seconds)
    result = analyze_file(track, load_settings())
    _assert_finite_result(result)
    assert result.duration >= seconds - 0.05


def test_le_silence_total_ne_produit_aucune_valeur_non_finie(tmp_path: Path) -> None:
    track = tmp_path / "silence.wav"
    sf.write(track, np.zeros(22050 * 10, dtype=np.float32), 22050, subtype="PCM_16")
    result = analyze_file(track, load_settings())
    _assert_finite_result(result)


@pytest.mark.parametrize(
    ("sample_rate", "channels"),
    [(22050, 1), (22050, 2), (8000, 1), (96000, 1)],
    ids=["mono-22k", "stereo-22k", "mono-8k", "mono-96k"],
)
def test_les_formats_mono_stereo_et_rates_extremes_s_analysent(
    tmp_path: Path, sample_rate: int, channels: int
) -> None:
    track = tmp_path / f"format-{sample_rate}-{channels}.wav"
    _write_tone(track, 3.0, sample_rate=sample_rate, channels=channels)
    result = analyze_file(track, load_settings())
    _assert_finite_result(result)


def test_un_tempo_non_fini_retombe_sur_la_grille_de_repli() -> None:
    # `NaN <= 0` est faux : sans garde de finitude, un tempo NaN traversait
    # l'analyse. La grille de repli documentée est de 4/4 (donc 120 BPM).
    onset_env = np.ones(200)
    beats = [index * 0.5 for index in range(40)]
    for tempo in (0.0, float("nan"), float("inf"), -1.0):
        assert estimate_meter(onset_env, beats, tempo, 22050) == 4


def test_une_courbe_avec_nan_et_infinis_est_assainie() -> None:
    values = np.array([0.1, np.nan, np.inf, -np.inf, 0.9, 0.5])
    for normalized in (normalize_curve(values), normalize_log_curve(values)):
        assert np.all(np.isfinite(normalized))
        assert np.all(normalized >= 0.0)
        assert np.all(normalized <= 1.0)


def test_les_points_serialises_ne_contiennent_jamais_de_nan() -> None:
    times = np.arange(6) * 0.1
    values = np.array([0.0, 1.0, np.nan, np.inf, 0.4, -np.inf])
    points = curve_to_points(times, values, 20.0, 0.5)
    assert points
    for time_value, energy in points:
        assert math.isfinite(time_value)
        assert math.isfinite(energy)
        assert 0.0 <= energy <= 1.0


def test_des_montees_avec_des_points_non_finis_sont_ignorees() -> None:
    points = [
        [0.0, 0.1],
        [0.1, np.nan],
        [0.2, 0.2],
        [0.3, np.inf],
        [0.4, 0.3],
        [0.5, 0.4],
        [0.6, 0.5],
        [0.7, 0.6],
        [0.8, 0.7],
        [0.9, 0.8],
    ]
    builds = detect_builds(points, 1.0, [])
    for build in builds:
        assert all(math.isfinite(build[key]) for key in ("start", "end", "strength"))
