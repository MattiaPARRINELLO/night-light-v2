"""Le drop visuel doit tomber sur le drop audible, pas 2 s après.

`detect_builds` plaçait la fin de la montée là où la courbe d'énergie cesse de
monter — or un drop reste fort, donc ça arrivait 1 à 2 s après le son. On
fabrique ici une piste dont l'impact est à un instant connu et on vérifie que la
montée détectée s'y termine.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 22050
ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from server.analysis import analyze_file, detect_builds  # noqa: E402
from server.config import load_settings  # noqa: E402

# Instant de l'impact, connu à la fabrication.
DROP = 14.0


def piste_avec_drop(path: Path, duree: float = 30.0) -> None:
    """Batterie constante : riser doux, puis impact franc à `DROP`."""
    t = np.arange(int(SR * duree)) / SR
    rng = np.random.default_rng(5)
    beat = 60.0 / 124.0
    drums = np.zeros_like(t)
    for start in np.arange(0, duree - 0.1, beat):
        index = int(start * SR)
        width = int(0.15 * SR)
        if index + width >= len(t):
            break
        drums[index : index + width] += (
            rng.standard_normal(width) * np.exp(-np.linspace(0, 5, width)) * 0.9
        )
    basse = np.sin(2 * np.pi * 55 * t) * 0.5

    gain = np.full_like(t, 0.32)  # calme
    riser = (t >= DROP - 4.0) & (t < DROP)
    gain[riser] = 0.32 + 0.13 * (t[riser] - (DROP - 4.0)) / 4.0  # montée douce
    gain[t >= DROP] = 1.0  # impact franc

    mix = (drums + basse) * gain
    peak = float(np.max(np.abs(mix)))
    if peak > 0:
        mix = mix / peak * 0.92
    sf.write(path, mix.astype(np.float32), SR, subtype="PCM_16")


def test_le_drop_visuel_tombe_sur_le_drop_audible(tmp_path) -> None:
    piste = tmp_path / "drop.wav"
    piste_avec_drop(piste)
    resultat = analyze_file(piste, load_settings())

    montées = sorted(resultat.builds, key=lambda build: build["end"])
    assert montées, "aucune montée détectée sur une piste qui en contient une"

    # La montée doit se terminer sur l'impact (petite tolérance : la fenêtre de
    # l'analyse est de quelques dizaines de millisecondes).
    fins = [build["end"] for build in montées]
    plus_proche = min(fins, key=lambda fin: abs(fin - DROP))
    assert abs(plus_proche - DROP) <= 0.6, (
        f"impact visuel à {plus_proche:.2f} s pour un impact audible à {DROP} s "
        f"(fins détectées : {[round(f, 2) for f in fins]})"
    )

    # La montée doit bien précéder l'impact, pas le suivre.
    debut = next(build["start"] for build in montées if build["end"] == plus_proche)
    assert debut < DROP, f"la montée commence après l'impact ({debut:.2f} s)"


def test_le_recalage_sur_onset_est_borne(tmp_path) -> None:
    from server.analysis import _snap_to_onset

    onsets = [1.0, 2.0, 3.0]
    # Dans la fenêtre : on prend l'attaque la plus proche.
    assert _snap_to_onset(2.9, onsets, window=0.3) == 3.0
    assert _snap_to_onset(2.7, onsets, window=0.3) == 3.0
    assert _snap_to_onset(2.2, onsets, window=0.3) == 2.0
    # À égale distance des deux attaques, on ne bouge pas.
    assert _snap_to_onset(2.5, onsets, window=0.3) == 2.5
    # Hors fenêtre : on ne bouge pas.
    assert _snap_to_onset(2.6, onsets, window=0.1) == 2.6
    assert _snap_to_onset(2.5, None, window=0.3) == 2.5


# ------------------------------------------------------------------ drop gaps

# Fin de la montée, puis un cut de 350 ms avant le vrai kick.
CREST = 12.0
GAP = 0.35
IMPACT = CREST + GAP


def test_build_se_termine_apres_un_cut_de_350_ms() -> None:
    """La crête du gradient précède le cut : l'impact doit être après le silence."""
    step = 0.05
    times = np.round(np.arange(0.0, 14.0, step), 3)
    values = np.full_like(times, 0.2)
    rise = (times >= 8.0) & (times < CREST)
    values[rise] = np.linspace(0.2, 0.5, int(rise.sum()))
    # Dernière poussée avant le cut : c'est elle qui porte la crête du gradient.
    values[(times >= CREST - 0.05) & (times < CREST)] = 0.9
    values[(times >= CREST) & (times < IMPACT)] = 0.05  # silence franc
    recovery = (times >= IMPACT) & (times < IMPACT + 0.15)
    values[recovery] = np.linspace(0.05, 0.9, int(recovery.sum()))
    values[times >= IMPACT + 0.15] = 0.9

    points = [[float(time), float(value)] for time, value in zip(times, values, strict=False)]
    builds = detect_builds(points, 14.0, [CREST, IMPACT + 0.02, IMPACT + 0.25])

    assert builds, "une montée suivie d'un impact doit être détectée"
    fins = [build["end"] for build in builds]
    plus_proche = min(fins, key=lambda fin: abs(fin - IMPACT))
    assert abs(plus_proche - IMPACT) <= 0.1, (
        f"impact visuel à {plus_proche:.2f} s pour un impact audible à {IMPACT:.2f} s "
        f"(fins détectées : {[round(f, 2) for f in fins]})"
    )
    assert plus_proche > CREST + 0.15, "l'impact est resté calé sur le dernier bruit du riser"


def test_impact_apres_gap_ignore_le_souffle_residuel() -> None:
    from server.analysis import _impact_after_gap

    times = np.round(np.arange(0.0, 12.0, 0.05), 3)
    values = np.full_like(times, 0.05)
    rise = (times >= 8.0) & (times < 10.0)
    values[rise] = np.linspace(0.2, 0.9, int(rise.sum()))
    values[times >= 10.0] = 0.9
    # Silence franc après la crête, souffle résiduel puis vrai impact.
    values[(times > 10.0) & (times < 10.3)] = 0.03

    assert _impact_after_gap(times, values, 0, len(times), [10.05, 10.35], 0.9) == 10.35
    # Sans baisse significative, aucun gap : l'appelant garde son recalage normal.
    plat = np.full_like(times, 0.8)
    assert _impact_after_gap(times, plat, 0, len(times), [10.05, 10.35], 0.8) is None
    # Un creux mais aucun onset après lui : pas d'impact à recaler.
    assert _impact_after_gap(times, values, 0, len(times), [10.05], 0.9) is None
    # Décroissance après l'impact (pas de retour près du pic) : pas un gap.
    decay = np.concatenate(
        (
            np.full(200, 0.9),
            np.linspace(0.9, 0.2, 20),
            np.full(20, 0.45),
        )
    )
    decay_times = np.arange(len(decay)) * 0.05
    assert _impact_after_gap(decay_times, decay, 0, len(decay), [10.4], 0.9) is None
