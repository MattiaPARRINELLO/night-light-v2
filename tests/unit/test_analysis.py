"""Analyse réelle d'une piste de test dont le tempo est connu."""

from __future__ import annotations

import sys
from dataclasses import asdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import numpy as np
import pytest

from server.analysis import (
    AnalysisError,
    analyze_file,
    analyze_with_timeout,
    assign_roles,
    detect_builds,
    estimate_meter,
)
from server.config import load_settings
from tests.support.make_fixture import (
    write_continuous_track,
    write_synthetic_track,
)


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
    for name in ("energy", "bass", "mid", "mid_low", "mid_high", "high"):
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
    kinds = {"intro", "couplet", "refrain", "pont", "outro", "section"}
    for section in result.sections:
        assert section["end"] > section["start"]
        assert section["label"] in {"calme", "montee", "intense", "descente", "silence"}
        assert 0.0 <= section["energy"] <= 1.0
        assert isinstance(section["group"], str)
        assert section["kind"] in kinds
        assert isinstance(section["occurrence"], int)


def test_assign_roles_deduit_refrain_et_couplet() -> None:
    # Intro basse, couplet (A), refrain (B, plus fort et répété), couplet, refrain,
    # pont unique, puis outro : la structure canonique d'un morceau de soirée.
    sections = [
        {"start": 0, "end": 10, "energy": 0.15, "group": "X"},
        {"start": 10, "end": 25, "energy": 0.45, "group": "A"},
        {"start": 25, "end": 40, "energy": 0.9, "group": "B"},
        {"start": 40, "end": 55, "energy": 0.5, "group": "A"},
        {"start": 55, "end": 70, "energy": 0.92, "group": "B"},
        {"start": 70, "end": 85, "energy": 0.6, "group": "C"},
        {"start": 85, "end": 95, "energy": 0.15, "group": "Y"},
    ]
    assign_roles(sections, duration=95.0)
    kinds = [section["kind"] for section in sections]
    assert kinds == ["intro", "couplet", "refrain", "couplet", "refrain", "pont", "outro"]
    # Le refrain revient : la seconde occurrence est numérotée.
    assert [section["occurrence"] for section in sections] == [1, 1, 1, 2, 2, 1, 1]


def test_assign_roles_ne_demarre_pas_le_refrain_sur_l_ouverture() -> None:
    """Régression « LIFE LIFE » : couplet et refrain sur la même boucle.

    Le matériau du refrain (D) apparaît dès 6 s, chanté comme un couplet, puis
    revient en refrain. Comme le premier passage tombe dans le tout premier
    cinquième du morceau, il reste un couplet : le refrain ne démarre qu'à son
    retour (40 s). Sans cette règle, l'analyse annonçait un refrain dès 6 s.
    """
    sections = [
        {"start": 0, "end": 6, "energy": 0.08, "group": "I"},
        {"start": 6, "end": 22, "energy": 0.9, "group": "D"},
        {"start": 22, "end": 40, "energy": 0.35, "group": "Q"},
        {"start": 40, "end": 58, "energy": 0.92, "group": "D"},
        {"start": 58, "end": 76, "energy": 0.5, "group": "Q"},
        {"start": 76, "end": 94, "energy": 0.88, "group": "D"},
        {"start": 94, "end": 100, "energy": 0.1, "group": "O"},
    ]
    assign_roles(sections, duration=100.0)
    kinds = [section["kind"] for section in sections]
    assert kinds == ["intro", "couplet", "couplet", "refrain", "couplet", "refrain", "outro"]
    # Le matériau D ouvre en couplet puis se numérote par rôle : refrain n°1, n°2.
    assert [section["occurrence"] for section in sections] == [1, 1, 1, 1, 2, 2, 1]


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


# ------------------------------------------------------------------- métrique


def _pulse_envelope(accent_every: int, beats: int = 120) -> tuple[np.ndarray, list[float]]:
    sr, hop = 22050, 512
    period = 0.5  # 120 BPM
    beat_times = [round(index * period, 3) for index in range(beats)]
    onset_env = np.zeros(int((beats * period + 1.0) * sr / hop))
    for index, time in enumerate(beat_times):
        frame = int(round(time * sr / hop))
        onset_env[frame] = 1.0 if index % accent_every == 0 else 0.2
    return onset_env, beat_times


def test_metrique_ternaire_detectee() -> None:
    onset_env, beats = _pulse_envelope(3)
    assert estimate_meter(onset_env, beats, 120.0, 22050) == 3


def test_metrique_binaire_detectee() -> None:
    onset_env, beats = _pulse_envelope(4)
    assert estimate_meter(onset_env, beats, 120.0, 22050) == 4


def test_metrique_ambigue_reste_en_4_4() -> None:
    onset_env, beats = _pulse_envelope(1000)  # accents tous identiques
    assert estimate_meter(onset_env, beats, 120.0, 22050) == 4
    assert estimate_meter(np.zeros(10), [], 120.0, 22050) == 4


def test_meter_expose_et_dans_le_domaine(tmp_path: Path) -> None:
    result = make_analysis(tmp_path, duration=20.0, bpm=128.0)
    assert result.meter in (3, 4)


# ------------------------------------------------- morceaux continus (novelty)


def test_morceau_continu_recoit_des_roles_de_progression(tmp_path: Path) -> None:
    """Aucun passage ne revient : pas de faux couplet/refrain, mais des rôles."""
    track = tmp_path / "continu.wav"
    write_continuous_track(track, duration=60.0)
    result = analyze_file(track, load_settings(), report=lambda message, progress: None)

    kinds = {section["kind"] for section in result.sections}
    assert kinds <= {"exposition", "developpement", "climax", "resolution"}
    assert "climax" in kinds
    assert result.sections[0]["start"] == 0.0
    assert result.sections[-1]["end"] >= result.duration - 0.5
    # Aucun groupe n'est affirmé quand aucune répétition n'est démontrée.
    assert all(section["group"] == "" for section in result.sections)


# --------------------------------------------------------- déterminisme/schéma


def test_analyse_deterministe(tmp_path: Path) -> None:
    track = tmp_path / "deterministe.wav"
    write_synthetic_track(track, duration=12.0, bpm=120.0)
    settings = load_settings()
    first = analyze_file(track, settings, report=lambda message, progress: None)
    second = analyze_file(track, settings, report=lambda message, progress: None)
    assert asdict(first) == asdict(second)


# ------------------------------------------------------------------ timeout


def test_timeout_leve_une_erreur_explicite(tmp_path: Path) -> None:
    track = tmp_path / "timeout.wav"
    write_synthetic_track(track, duration=3.0)
    with pytest.raises(AnalysisError) as captured:
        analyze_with_timeout(track, load_settings(), timeout_sec=0.05)
    assert captured.value.code == "timeout"


def test_timeout_laisse_passer_une_analyse_raisonnable(tmp_path: Path) -> None:
    track = tmp_path / "ok.wav"
    write_synthetic_track(track, duration=3.0)
    result = analyze_with_timeout(track, load_settings(), timeout_sec=120.0)
    assert result.duration == 3.0
    assert result.meter in (3, 4)
    assert len(result.mid_low) == len(result.mid)
    assert len(result.mid_high) == len(result.mid)
