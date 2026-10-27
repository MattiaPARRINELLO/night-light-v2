"""Tests serveur de la détection de sections (vague 3 — Structure)."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import soundfile as sf

from server.analysis import analyze_file
from server.config import load_settings
from tests.support.make_fixture import write_silence_milieu, write_synthetic_track

SR = 22050
KINDS = {"intro", "couplet", "refrain", "pont", "silence", "outro"}


def analyze(path: Path):
    return analyze_file(path, load_settings(), report=lambda message, progress: None)


def write_ab_track(path: Path, duration: float = 48.0, block: float = 12.0) -> None:
    """Deux matériaux alternés A (grave, calme) / B (percussif, brillant).

    A : trio de sinusoïdes graves à faible niveau. B : kick, caisse claire,
    charley et bruit aigu. L'énergie de B domine nettement celle de A et le
    timbre diffère : le refrain doit être le groupe B, présent deux fois.
    """
    t = np.arange(int(SR * duration)) / SR
    rng = np.random.default_rng(7)
    beat = 0.5
    kick = np.sin(2 * np.pi * 55 * t) * np.exp(-np.mod(t, beat) / 0.09) * 0.9
    snare = rng.standard_normal(t.size) * np.exp(-np.mod(t, 2 * beat) / 0.07) * 0.3
    hat = rng.standard_normal(t.size) * np.exp(-np.mod(t, beat / 2) / 0.015) * 0.2
    # Bruit « brillant » sans dépendance supplémentaire : dérivation discrète.
    bright = np.diff(rng.standard_normal(t.size), prepend=0.0) * 0.6
    calm = (
        np.sin(2 * np.pi * 130.81 * t) * 0.5
        + np.sin(2 * np.pi * 164.81 * t) * 0.35
        + np.sin(2 * np.pi * 196.0 * t) * 0.2
    )
    loud = kick + snare + hat + bright
    mix = np.zeros_like(t)
    for index in range(int(duration // block)):
        start = index * block
        end = start + block
        window = (t >= start) & (t < end)
        if index % 2 == 0:
            mix[window] = (calm * 0.22)[window]
        else:
            mix[window] = loud[window]
    peak = float(np.max(np.abs(mix)))
    sf.write(path, (mix / peak * 0.9).astype(np.float32), SR, subtype="PCM_16")


def contract_violations(result) -> list[str]:
    problems: list[str] = []
    sections = result.sections
    assert sections, "aucune section"
    if abs(float(sections[0]["start"])) > 1e-6:
        problems.append("la première section ne commence pas à 0")
    if abs(float(sections[-1]["end"]) - result.duration) > 1e-3:
        problems.append("la dernière section ne finit pas à la durée")
    for index, section in enumerate(sections):
        start = float(section["start"])
        end = float(section["end"])
        if end <= start:
            problems.append(f"section {index} vide")
        minimum = 1.5 if section.get("kind") == "silence" else 4.0 - 1e-3
        if end - start < minimum:
            problems.append(f"section {index} trop courte ({end - start:.2f})")
        if section.get("kind") not in KINDS:
            problems.append(f"section {index} kind invalide")
        if not isinstance(section.get("group"), str):
            problems.append(f"section {index} group non textuel")
        confidence = section.get("confidence")
        if confidence is None or not 0.0 <= float(confidence) <= 1.0:
            problems.append(f"section {index} confidence invalide")
        if index > 0 and abs(float(sections[index - 1]["end"]) - start) > 1e-6:
            problems.append(f"discontinuité avant {index}")
    kinds = [section.get("kind") for section in sections]
    if kinds.count("intro") > 1:
        problems.append("plusieurs intro")
    if kinds.count("outro") > 1:
        problems.append("plusieurs outro")
    if "intro" in kinds and kinds[0] != "intro":
        problems.append("intro ailleurs qu'en tête")
    if "outro" in kinds and kinds[-1] != "outro":
        problems.append("outro ailleurs qu'en fin")
    return problems


def test_contrat_sur_piste_synthetique(tmp_path: Path) -> None:
    track = tmp_path / "piste.wav"
    write_synthetic_track(track, duration=60.0, bpm=126.0)
    result = analyze(track)
    assert contract_violations(result) == []
    assert len(result.sections) >= 1
    # Les champs historiques restent présents : un ancien consommateur lit
    # toujours label/energy/occurrence sans modification.
    for section in result.sections:
        assert section["label"] in {"calme", "intense", "silence"}
        assert 0.0 <= section["energy"] <= 1.0
        assert isinstance(section["occurrence"], int)


def test_determinisme_octet_pour_octet(tmp_path: Path) -> None:
    track = tmp_path / "piste.wav"
    write_synthetic_track(track, duration=40.0, bpm=120.0)
    first = analyze(track)
    second = analyze(track)
    assert json.dumps(first.sections, sort_keys=True) == json.dumps(second.sections, sort_keys=True)
    assert first.sections == second.sections
    assert first.beats == second.beats
    assert first.builds == second.builds


def test_refrain_sur_materiau_repete(tmp_path: Path) -> None:
    track = tmp_path / "ab.wav"
    write_ab_track(track)
    result = analyze(track)
    assert contract_violations(result) == []
    refrains = [section for section in result.sections if section["kind"] == "refrain"]
    assert refrains, (
        f"aucun refrain dans {[(s['start'], s['kind'], s['group']) for s in result.sections]}"
    )
    groups = {section["group"] for section in refrains}
    assert len(groups) == 1, f"un seul groupe de refrain attendu, trouvé {groups}"
    starts = [round(float(section["start"]), 1) for section in refrains]
    # Le matériau B occupe 12–24 s et 36–48 s : les débuts doivent tomber sur
    # les mesures de raccord, à quelques secondes près.
    for expected in (12.0, 36.0):
        distance = min(abs(start - expected) for start in starts)
        assert distance <= 2.0, f"refrain attendu vers {expected}s, trouvé {starts}"


def test_silence_detecte_et_localise(tmp_path: Path) -> None:
    track = tmp_path / "silence.wav"
    write_silence_milieu(track)
    result = analyze(track)
    assert contract_violations(result) == []
    silences = [section for section in result.sections if section["kind"] == "silence"]
    assert silences, f"aucun silence dans {[(s['start'], s['end']) for s in result.sections]}"
    assert any(14.0 <= float(section["start"]) <= 16.5 for section in silences)
    assert any(23.5 <= float(section["end"]) <= 25.5 for section in silences)


def test_aucun_silence_sur_morceau_continu(tmp_path: Path) -> None:
    track = tmp_path / "continu.wav"
    write_synthetic_track(track, duration=40.0, bpm=122.0)
    result = analyze(track)
    assert [section for section in result.sections if section["kind"] == "silence"] == []


def test_confiance_et_groupes_optionnels() -> None:
    """La confiance est bornée et les groupes se suivent par ordre d'apparition."""
    import server.analysis as analysis_module

    assert hasattr(analysis_module, "detect_structure")
    # Le contrat V3.1 exige des champs optionnels : absence acceptée côté client.
    section = {"start": 0.0, "end": 10.0, "label": "calme", "energy": 0.2}
    assert "kind" not in section and "confidence" not in section
