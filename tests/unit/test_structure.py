"""Structure locale et reprises de production sur des courbes synthétiques."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from server.structure import _late_return, detect_structure  # noqa: E402


def make_curves(duration: float = 120.0) -> dict[str, np.ndarray]:
    rate = 20.0
    times = np.arange(0.0, duration, 1.0 / rate)
    beats = np.arange(0.0, duration, 0.5)
    energy = np.full_like(times, 0.15)
    bass = np.full_like(times, 0.05)
    for start, end, value, low in [
        (20.0, 50.0, 0.80, 0.65),
        (60.0, 100.0, 0.85, 0.70),
    ]:
        window = (times >= start) & (times < end)
        energy[window] = value
        bass[window] = low
    onsets = np.arange(0.0, duration, 2.0)
    chroma = np.ones((12, times.size))
    mfcc = np.ones((13, times.size))
    # Le timbre du bloc final diffère du premier : nouvelle production.
    chroma[:, times >= 60.0] = 2.0
    mfcc[:, times >= 60.0] = 3.0
    return {
        "times": times,
        "beats": beats,
        "energy": energy,
        "bass": bass,
        "onsets": onsets,
        "chroma": chroma,
        "mfcc": mfcc,
        "duration": duration,
    }


def test_reprise_apres_creux_et_pas_la_premiere_exposition() -> None:
    data = make_curves()
    structure = detect_structure(
        [],
        [],
        data["times"],
        data["energy"],
        data["bass"],
        data["beats"],
        data["onsets"],
        data["chroma"],
        data["mfcc"],
        data["duration"],
    )
    starts = [drop["time"] for drop in structure.drops]
    assert starts, "la reprise de 60 s doit être détectée"
    assert min(starts, key=lambda time: abs(time - 60.0)) < 62.0
    # Le premier bloc plein est l'exposition : ce n'est pas une reprise.
    assert all(abs(time - 20.0) > 2.0 for time in starts)


def test_sections_couvrent_le_morceau_sans_trou() -> None:
    data = make_curves()
    structure = detect_structure(
        [],
        [],
        data["times"],
        data["energy"],
        data["bass"],
        data["beats"],
        data["onsets"],
        data["chroma"],
        data["mfcc"],
        data["duration"],
    )
    assert structure.sections
    assert structure.sections[0]["start"] == 0.0
    assert structure.sections[-1]["end"] == data["duration"]
    for previous, following in zip(structure.sections, structure.sections[1:], strict=False):
        assert previous["end"] == following["start"]


def test_reprise_decalee_recalée_sur_le_temps_fort_suivant() -> None:
    """Une frontière molle suivie d'un creux court : l'impact est le temps fort plein."""
    duration = 20.0
    times = np.arange(0.0, duration, 1.0 / 20.0)
    beats = np.arange(0.0, duration, 0.5)
    energy = np.full_like(times, 0.10)
    bass = np.zeros_like(times)
    # La production revient à 10,5 s, après un creux d'une demi-seconde.
    energy[(times >= 10.5) & (times < 19.0)] = 0.90
    bass[(times >= 10.5) & (times < 19.0)] = 0.70
    late = _late_return(energy, bass, times, beats, 10.4, 2.0)
    assert late is not None
    # Le premier temps fort dont la mesure précédente est déjà pleine : 11,0 s.
    assert 10.9 <= late <= 11.1


def test_energie_constante_ne_produit_aucun_drop() -> None:
    duration = 90.0
    rate = 20.0
    times = np.arange(0.0, duration, 1.0 / rate)
    energy = np.full_like(times, 0.6)
    bass = np.full_like(times, 0.5)
    structure = detect_structure(
        [],
        [],
        times,
        energy,
        bass,
        np.arange(0.0, duration, 0.5),
        np.arange(0.0, duration, 2.0),
        np.ones((12, times.size)),
        np.ones((13, times.size)),
        duration,
    )
    assert structure.drops == []


def _structure(
    energy: np.ndarray, bass: np.ndarray, duration: float, switch_at: float | None = None
):
    times = np.arange(0.0, duration, 1.0 / 20.0)
    chroma = np.ones((12, times.size))
    mfcc = np.ones((13, times.size))
    if switch_at is not None:
        chroma[:, times >= switch_at] = 2.0
        mfcc[:, times >= switch_at] = 3.0
    return detect_structure(
        [],
        [],
        times,
        energy,
        bass,
        np.arange(0.0, duration, 0.5),
        np.arange(0.0, duration, 2.0),
        chroma,
        mfcc,
        duration,
    )


def test_reprise_sans_retour_de_basse_et_sans_drop() -> None:
    """Une basse continue n'empêche pas la reprise, mais ne fait pas un drop."""
    duration = 120.0
    times = np.arange(0.0, duration, 1.0 / 20.0)
    energy = np.full_like(times, 0.15)
    bass = np.full_like(times, 0.05)
    energy[(times >= 20.0) & (times < 50.0)] = 0.85
    energy[(times >= 60.0) & (times < 100.0)] = 0.85
    # La basse ne bouge pas : aucun gain de basse, donc aucun drop.
    bass[(times >= 20.0) & (times < 100.0)] = 0.50
    structure = _structure(energy, bass, duration, switch_at=60.0)

    reprises = [reprise["time"] for reprise in structure.reprises]
    assert any(abs(time - 60.0) <= 2.0 for time in reprises)
    assert structure.drops == []
    # Tout drop reste une reprise, par construction.
    assert set(drop["time"] for drop in structure.drops) <= set(reprises)


def test_premiere_entree_apres_un_bloc_faible_mais_audible_est_une_reprise() -> None:
    """Cause B : l'entrée de prod après un bloc réel (0,17) compte comme reprise."""
    duration = 90.0
    times = np.arange(0.0, duration, 1.0 / 20.0)
    energy = np.full_like(times, 0.05)
    bass = np.full_like(times, 0.02)
    energy[(times >= 10.0) & (times < 40.0)] = 0.80
    bass[(times >= 10.0) & (times < 40.0)] = 0.30
    # Le bloc d'intro porte de la matière (au-dessus du silence) sans être plein.
    energy[times < 10.0] = 0.17
    structure = _structure(energy, bass, duration, switch_at=10.0)

    reprises = [reprise["time"] for reprise in structure.reprises]
    assert any(abs(time - 10.0) <= 2.0 for time in reprises)
    # La prod n'avait pas encore démarré : ce n'est pas un drop.
    assert structure.drops == []


def test_premiere_entree_apres_une_intro_silencieuse_reste_l_exposition() -> None:
    """Une intro quasi silencieuse ne fait pas de l'entrée une reprise."""
    duration = 90.0
    times = np.arange(0.0, duration, 1.0 / 20.0)
    energy = np.full_like(times, 0.05)
    bass = np.full_like(times, 0.05)
    energy[(times >= 10.0) & (times < 40.0)] = 0.85
    structure = _structure(energy, bass, duration, switch_at=10.0)

    reprises = [reprise["time"] for reprise in structure.reprises]
    assert all(abs(time - 10.0) > 2.0 for time in reprises)
    assert structure.drops == []
