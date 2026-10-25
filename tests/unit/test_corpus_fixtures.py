"""Le corpus de test est déterministe et couvre les cas dégénérés attendus.

Propriété vérifiée : régénérer le corpus deux fois produit exactement les mêmes
octets (même hash SHA-256), et le manifeste décrit les 10 pistes attendues.
Aucun WAV n'est committé : la génération est rapide et reproductible.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import soundfile as sf

from tests.support.make_fixture import CORPUS, write_corpus


def _digests(directory: Path) -> dict[str, str]:
    return {
        path.name: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(directory.iterdir())
        if path.is_file()
    }


def test_le_corpus_est_reproductible_a_l_octet_pres(tmp_path: Path) -> None:
    first = tmp_path / "first"
    second = tmp_path / "second"
    write_corpus(first)
    write_corpus(second)
    assert _digests(first) == _digests(second)


def test_le_manifeste_decrit_les_dix_pistes_et_leurs_proprietes(tmp_path: Path) -> None:
    write_corpus(tmp_path)
    manifest = json.loads((tmp_path / "manifest.json").read_text(encoding="utf-8"))
    names = [entry["name"] for entry in manifest]

    assert len(names) == 10
    assert len(set(names)) == 10
    for entry in manifest:
        assert entry["expect"], "chaque piste doit documenter ce qu'elle provoque"
        assert isinstance(entry["seed"], int)
        path = tmp_path / f"{entry['name']}.wav"
        assert path.exists()
        info = sf.info(path)
        assert int(info.frames) == int(round(float(entry["duration"]) * info.samplerate))


def test_les_cas_degeneres_sont_presents(tmp_path: Path) -> None:
    write_corpus(tmp_path)
    by_name = {entry["name"]: entry for entry in CORPUS}

    # Les cas exigés par le cahier de tests : durée courte, silence, tempo
    # douteux, niveaux extrêmes.
    assert float(by_name["g_court"]["duration"]) < 5.0
    assert float(by_name["f_silence_milieu"]["duration"]) >= 30.0
    assert float(by_name["b_basses_seules"]["bpm"]) > 0
    assert float(by_name["h_tempo_douteux"]["bpm"]) == 0
    assert float(by_name["i1_tres_faible"]["duration"]) > 0
    assert float(by_name["i2_sature"]["duration"]) > 0


def test_les_niveaux_extremes_sont_reellement_atteints(tmp_path: Path) -> None:
    write_corpus(tmp_path)
    import numpy as np

    faible, _ = sf.read(tmp_path / "i1_tres_faible.wav")
    sature, _ = sf.read(tmp_path / "i2_sature.wav")
    peak_quiet = float(np.max(np.abs(faible)))
    peak_saturated = float(np.max(np.abs(sature)))
    assert peak_quiet < 0.02, f"crête attendue ≈ -40 dBFS, obtenue {peak_quiet:.4f}"
    assert peak_saturated > 0.98, f"crête attendue 0 dBFS, obtenue {peak_saturated:.4f}"
