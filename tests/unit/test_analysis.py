"""Analyse réelle d'une piste de test dont le tempo est connu."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import numpy as np

from server.analysis import AnalysisError, analyze_file, detect_builds
from server.config import load_settings
from tests.support.make_fixture import write_synthetic_track


def make_analysis(tmp_path: Path, duration: float = 20.0, bpm: float = 128.0):
    track = tmp_path / "piste.wav"
    write_synthetic_track(track, duration=duration, bpm=bpm)
    return analyze_file(track, load_settings(), report=lambda message, progress: None)


def test_duree_et_tempo(tmp_path: Path) -> None:
    result = make_analysis(tmp_path, duration=20.0, bpm=128.0)
    assert result.duration == 20.0
    assert abs(result.tempo - 128.0) < 4.0, f"tempo mesuré {result.tempo}"


def test_temps_forts_reguliers(tmp_path: Path) -> None:
    result = make_analysis(tmp_path, duration=20.0, bpm=120.0)
    assert len(result.beats) > 20
    spacing = np.diff(np.array(result.beats))
    assert spacing.min() > 0.2
    assert abs(float(np.median(spacing)) - 0.5) < 0.15


def test_courbes_non_vides(tmp_path: Path) -> None:
    """Régression : np.hanning(2) vaut [0, 0] et annulait toutes les courbes."""
    result = make_analysis(tmp_path, duration=20.0)
    for name in ("energy", "bass", "mid", "high"):
        curve = getattr(result, name)
        assert len(curve) > 50, f"{name} trop courte"
        values = np.array([point[1] for point in curve])
        assert values.max() > 0.15, f"{name} ne monte jamais : {values[:5]}"
        assert values.min() >= 0.0
        assert values.max() <= 1.0
        times = np.array([point[0] for point in curve])
        assert times[0] == 0.0
        assert times[-1] <= result.duration + 0.5
        assert np.all(np.diff(times) > 0), f"{name} non monotone"


def test_les_bandes_different_des_moments(tmp_path: Path) -> None:
    result = make_analysis(tmp_path, duration=20.0, bpm=128.0)
    energy = np.array([point[1] for point in result.energy])
    # Le morceau de test monte nettement dans son deuxième tiers.
    assert energy[int(len(energy) * 0.75)] > energy[int(len(energy) * 0.2)]


def test_sections_couvrent_le_morceau(tmp_path: Path) -> None:
    result = make_analysis(tmp_path, duration=40.0, bpm=126.0)
    assert len(result.sections) >= 2
    assert result.sections[0]["start"] == 0.0
    assert result.sections[-1]["end"] >= result.duration - 0.5
    for section in result.sections:
        assert section["end"] > section["start"]
        assert section["label"] in {"calme", "montee", "intense", "descente", "silence"}
        assert 0.0 <= section["energy"] <= 1.0


def test_montee_detectee(tmp_path: Path) -> None:
    track = tmp_path / "montee.wav"
    write_synthetic_track(track, duration=60.0, bpm=126.0)
    result = analyze_file(track, load_settings(), report=lambda message, progress: None)
    assert len(result.builds) >= 1, "la montée du morceau de test devrait être détectée"
    build = result.builds[0]
    assert 2.0 <= build["end"] - build["start"] <= 30.0
    assert 0.3 <= build["strength"] <= 1.0


def test_fichier_inexploitable(tmp_path: Path) -> None:
    path = tmp_path / "faux.wav"
    path.write_bytes(b"ceci n'est pas de l'audio" * 10)
    try:
        analyze_file(path, load_settings(), report=lambda message, progress: None)
    except AnalysisError as error:
        assert error.code == "unreadable_audio"
    else:  # pragma: no cover - si ffmpeg réussissait là où libsndfile échoue
        raise AssertionError("une analyse d'un fichier non audio devrait échouer")


def test_progression_reportee(tmp_path: Path) -> None:
    track = tmp_path / "progression.wav"
    write_synthetic_track(track, duration=12.0)
    seen: list[float] = []
    analyze_file(track, load_settings(), report=lambda message, progress: seen.append(progress))
    assert len(seen) >= 5
    assert seen[-1] >= 0.99
    assert all(0.0 <= value <= 1.0 for value in seen)


def test_detect_builds_sur_courbe_synthetique() -> None:
    points = (
        [[0.0, 0.2]]
        + [[float(i), min(1.0, 0.2 + 0.06 * i)] for i in range(1, 25)]
        + [[30.0, 1.0]] * 5
    )
    builds = detect_builds(points, 30.0)
    assert builds, "une montée continue doit être détectée"
