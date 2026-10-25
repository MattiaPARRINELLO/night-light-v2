"""Recevabilité d'un impact : un critère de rejet, un cas qui passe, un qui échoue.

Ces tests travaillent sur des courbes synthétiques minimales : ils isolent un
critère à la fois pour qu'une régression future soit imputable sans ambiguïté.
Le corpus réel, lui, n'est pas en CI (audio absent) : voir
``tools/build_diagnostic.py``.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import numpy as np

from server.analysis import detect_builds

STEP = 0.05


def _curve(values: np.ndarray) -> list[list[float]]:
    return [[round(index * STEP, 3), float(value)] for index, value in enumerate(values)]


def _ramp(start: np.ndarray, begin: float, end: float, low: float, high: float) -> None:
    window = (start >= begin) & (start < end)
    start[window] = np.linspace(low, high, int(window.sum()))


def _scene(
    *,
    duration: float = 30.0,
    baseline: float = 0.2,
    rise_at: float = 10.0,
    rise_span: float = 3.0,
    plateau: float = 0.9,
    bass_baseline: float = 0.05,
    bass_plateau: float = 0.5,
) -> tuple[list[list[float]], list[list[float]]]:
    """Fond stable, montée linéaire, plateau tenu jusqu'à la fin."""
    times = np.arange(0.0, duration, STEP)
    energy = np.full_like(times, baseline)
    _ramp(energy, rise_at, rise_at + rise_span, baseline, plateau * 0.55)
    energy[times >= rise_at + rise_span] = plateau
    bass = np.full_like(times, bass_baseline)
    _ramp(bass, rise_at, rise_at + rise_span, bass_baseline, bass_plateau * 0.6)
    bass[times >= rise_at + rise_span] = bass_plateau
    return _curve(energy), _curve(bass)


# --------------------------------------------------- contraste relatif (ratio)


def test_un_vrai_impact_est_retenu() -> None:
    energy, bass = _scene()
    builds = detect_builds(energy, 30.0, [], bass)
    assert len(builds) == 1
    assert builds[0]["start"] < builds[0]["end"]


def test_un_plateau_marginal_sur_un_fond_deja_fort_est_rejete() -> None:
    """Même montée absolue, mais le morceau était déjà au même niveau : pas d'impact."""
    energy, bass = _scene(baseline=0.8, plateau=0.95, bass_baseline=0.4, bass_plateau=0.6)
    assert detect_builds(energy, 30.0, [], bass) == []


# -------------------------------------------------------- arrivée des basses


def test_une_nuance_sans_arrivee_de_basses_est_rejetee() -> None:
    """Crescendo instrumental modéré : l'énergie monte, les basses ne bougent pas."""
    energy, _ = _scene(baseline=0.3, plateau=0.6)
    bass = [[time, 0.4] for time, _ in energy]
    assert detect_builds(energy, 30.0, [], bass) == []


def test_un_contraste_ecrasant_suffit_sans_arrivee_de_basses() -> None:
    """Un orchestre qui éclate reste un impact même sans contenu basse mesurable."""
    energy, _ = _scene(baseline=0.2, plateau=0.95)
    bass = [[time, 0.0] for time, _ in energy]
    assert len(detect_builds(energy, 30.0, [], bass)) == 1


def test_la_meme_montee_avec_arrivee_de_basses_est_retenue() -> None:
    energy, bass = _scene()
    assert len(detect_builds(energy, 30.0, [], bass)) == 1


# --------------------------------------------------- plateau qui ne tient pas


def test_une_montee_qui_retombe_n_est_pas_un_impact() -> None:
    energy, bass = _scene(plateau=0.9)
    times = np.array([point[0] for point in energy])
    # Le plateau s'effondre juste après l'impact.
    energy = _curve(np.where(times >= 13.0, 0.18, [point[1] for point in energy]))
    bass = _curve(np.where(times >= 13.0, 0.5, [point[1] for point in bass]))
    assert detect_builds(energy, 30.0, [], bass) == []


def test_un_plateau_tenu_est_retenu() -> None:
    energy, bass = _scene()
    assert len(detect_builds(energy, 30.0, [], bass)) == 1


# ------------------------------------------------------------ contexte absent


def test_un_impact_isole_sur_une_piste_courte_reste_detecte() -> None:
    """Pas de règle de contexte : un morceau court doit rester exploitable."""
    energy, bass = _scene(rise_at=5.0, rise_span=1.5, duration=12.0)
    assert len(detect_builds(energy, 12.0, [], bass)) == 1


# ------------------------------------------------------- rampe longue (90 BPM)


def test_une_rampe_longue_place_l_impact_sur_le_plateau() -> None:
    """Une montée de 20 s n'a pas de pic de pente : l'impact est son arrivée."""
    times = np.arange(0.0, 60.0, STEP)
    energy = np.full_like(times, 0.2)
    _ramp(energy, 20.0, 40.0, 0.2, 0.9)
    energy[times >= 40.0] = 0.9
    bass = np.full_like(times, 0.05)
    _ramp(bass, 20.0, 40.0, 0.05, 0.5)
    bass[times >= 40.0] = 0.5

    builds = detect_builds(_curve(energy), 60.0, [], _curve(bass))
    assert len(builds) == 1
    assert builds[0]["end"] > 30.0, "l'impact doit tomber sur l'arrivée, pas à 20 s"


def test_une_montee_vers_le_silence_est_rejetee() -> None:
    """Garde-fou : un plateau sous 0,45 n'est pas un impact, même avec des basses."""
    energy, bass = _scene(baseline=0.1, plateau=0.35, bass_baseline=0.02, bass_plateau=0.3)
    assert detect_builds(energy, 30.0, [], bass) == []


# ------------------------------------------------------- climax haché (cuivres)


def test_un_climax_hache_en_deux_monttees_courtes_est_recolle() -> None:
    times = np.arange(0.0, 30.0, STEP)
    energy = np.full_like(times, 0.2)
    _ramp(energy, 10.0, 11.0, 0.2, 0.55)
    energy[(times >= 11.0) & (times < 11.5)] = 0.5
    _ramp(energy, 11.5, 12.5, 0.5, 0.9)
    energy[times >= 12.5] = 0.9
    bass = np.full_like(times, 0.05)
    bass[times >= 12.5] = 0.55

    builds = detect_builds(_curve(energy), 30.0, [], _curve(bass))
    assert len(builds) == 1
    assert builds[0]["end"] - builds[0]["start"] >= 2.0


# ------------------------------------------------------------ forme de sortie


def test_forme_de_sortie_des_impacts() -> None:
    energy, bass = _scene()
    builds = detect_builds(energy, 30.0, [], bass)
    assert builds
    for build in builds:
        assert set(build) == {"start", "end", "strength", "source"}
        assert build["source"] == "rise"
        assert isinstance(build["start"], float)
        assert isinstance(build["end"], float)
        assert 0.0 <= build["strength"] <= 1.0
        assert build["start"] < build["end"]
