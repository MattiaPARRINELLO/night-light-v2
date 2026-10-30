"""Non-régression R7 : refrains sans reprise de production.

``fixtures/r7_refrains.npz`` contient les courbes et les matrices chroma/MFCC
beat-sync de *Lune de fiel* (MZ). Le morceau enchaîne ses refrains sans creux
de production : la règle R4/R5 (refrain = matériau répété **et** reprise) n'en
détectait aucun. La règle R7 ajoute la répétition franche et contrastée.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from server.structure import detect_structure  # noqa: E402

FIXTURE = Path(__file__).parent / "fixtures" / "r7_refrains.npz"

# Refrains attendus (secondes) : le même matériau revient à 53,3, 123,5 et
# 208,2 s, sans reprise de production à ces frontières.
REFRAINS = (53.336, 123.507, 208.19)


def _detect() -> list[dict]:
    data = np.load(FIXTURE)
    key = "lune"
    times = data[f"{key}_times"].astype(float)
    beats = data[f"{key}_beats"].astype(float)
    chroma_sync = data[f"{key}_chroma_sync"].astype(float)
    mfcc_sync = data[f"{key}_mfcc_sync"].astype(float)
    frames = np.clip(
        np.searchsorted(beats, times, side="right") - 1,
        0,
        chroma_sync.shape[1] - 1,
    )
    structure = detect_structure(
        [],
        [],
        times,
        data[f"{key}_energy"].astype(float),
        data[f"{key}_bass"].astype(float),
        beats,
        data[f"{key}_onsets"].astype(float),
        chroma_sync[:, frames],
        mfcc_sync[:, frames],
        float(data[f"{key}_duration"]),
    )
    return structure.sections


def test_lune_de_fiel_retrouve_ses_trois_refrains() -> None:
    refrains = [section["start"] for section in _detect() if section["kind"] == "refrain"]
    assert len(refrains) == len(REFRAINS), f"refrains détectés : {refrains}"
    for target in REFRAINS:
        assert any(abs(time - target) <= 0.05 for time in refrains), (
            f"refrain {target} s absent ({refrains})"
        )
