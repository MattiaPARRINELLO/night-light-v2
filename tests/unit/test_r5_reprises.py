"""Non-régression R5 sur des features figées, sans audio.

Le fixture ``fixtures/r5_reprises.npz`` contient les courbes et les matrices
chroma/MFCC beat-sync des cinq titres qui portent les cas R5. Il permet de
vérifier les seuils sans relancer l'analyse audio (lent et dépendant du cache).
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from server.structure import detect_structure  # noqa: E402

FIXTURE = Path(__file__).parent / "fixtures" / "r5_reprises.npz"

# Reprises cibles de la consigne R5 (secondes).
TARGETS = {
    "omen": (30.441, 61.672),
    "latch": (95.620, 127.106),
    "mj": (10.542,),
}
ZERO_REFRAIN = ("bolero", "gym")


def _detect(data, key: str):
    times = data[f"{key}_times"].astype(float)
    beats = data[f"{key}_beats"].astype(float)
    chroma_sync = data[f"{key}_chroma_sync"].astype(float)
    mfcc_sync = data[f"{key}_mfcc_sync"].astype(float)
    # Le fixture stocke les matrices au pas de la mesure ; on les ré-expand
    # sur les frames pour retrouver les entrées attendues par le détecteur.
    frames = np.clip(
        np.searchsorted(beats, times, side="right") - 1,
        0,
        chroma_sync.shape[1] - 1,
    )
    return detect_structure(
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


def test_les_cinq_reprises_cibles_restent_detectees() -> None:
    data = np.load(FIXTURE)
    for key, targets in TARGETS.items():
        structure = _detect(data, key)
        reprises = [reprise["time"] for reprise in structure.reprises]
        refrains = [
            section["start"] for section in structure.sections if section["kind"] == "refrain"
        ]
        for target in targets:
            assert any(abs(time - target) <= 0.05 for time in reprises), (
                f"{key} : reprise cible {target} s absente ({reprises})"
            )
            # Les cibles R5 doivent aussi ancrer un refrain, pas seulement
            # exister comme reprise.
            assert any(abs(time - target) <= 0.05 for time in refrains), (
                f"{key} : refrain cible {target} s absent ({refrains})"
            )


def test_bolero_et_gymnopedie_restent_sans_refrain() -> None:
    data = np.load(FIXTURE)
    for key in ZERO_REFRAIN:
        structure = _detect(data, key)
        refrains = [section for section in structure.sections if section["kind"] == "refrain"]
        assert refrains == [], f"{key} : refrain inattendu {refrains}"
