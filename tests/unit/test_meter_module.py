"""Métrique V3.1 : 3/4, 4/4, ambiguïté, fixture de vérité et audio synthétique."""

from __future__ import annotations

import json
import sys
from dataclasses import asdict
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from server.analysis import analyze_file
from server.config import load_settings
from server.meter import METER_MIN_CONFIDENCE, estimate_meter
from tests.support.make_fixture import write_meter_track

ROOT = Path(__file__).resolve().parents[2]
SR = 22050
HOP = 512
NFFT = 2048
FRAME_RATE = SR / HOP
FREQUENCIES = np.linspace(0.0, SR / 2.0, NFFT // 2 + 1)


def _spectrum_for_pulse(
    accent_every: int, *, beats: int = 80
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Spectre où la bande basse est accentuée un temps sur ``accent_every``."""
    beat_period = 0.5
    duration = beats * beat_period
    frame_times = np.arange(int(duration * FRAME_RATE) + 1) / FRAME_RATE
    spectrum = np.full((FREQUENCIES.size, frame_times.size), 0.01)
    low = (FREQUENCIES >= 20.0) & (FREQUENCIES < 150.0)
    for index in range(beats):
        start = int(index * beat_period * FRAME_RATE)
        end = int((index + 1) * beat_period * FRAME_RATE)
        level = 1.0 if index % accent_every == 0 else 0.2
        spectrum[low, start:end] = level
    beat_times = [round(index * beat_period, 3) for index in range(beats)]
    return spectrum, frame_times, np.asarray(beat_times)


def test_metrique_3_4_sur_accentuation_basse() -> None:
    spectrum, frame_times, beats = _spectrum_for_pulse(3)
    decision = estimate_meter(spectrum, FREQUENCIES, frame_times, list(beats))
    assert decision.beats_per_bar == 3
    assert decision.confidence >= METER_MIN_CONFIDENCE


def test_metrique_4_4_sur_accentuation_basse() -> None:
    spectrum, frame_times, beats = _spectrum_for_pulse(4)
    decision = estimate_meter(spectrum, FREQUENCIES, frame_times, list(beats))
    assert decision.beats_per_bar == 4
    assert decision.confidence >= METER_MIN_CONFIDENCE


def test_metrique_ambigue_replie_4_4() -> None:
    spectrum, frame_times, beats = _spectrum_for_pulse(1)  # aucun accent, aucun motif
    decision = estimate_meter(spectrum, FREQUENCIES, frame_times, list(beats))
    assert decision.beats_per_bar == 4
    assert decision.confidence >= METER_MIN_CONFIDENCE


def test_metrique_sans_temps_assez_nombreux_replie_4_4() -> None:
    spectrum, frame_times, _beats = _spectrum_for_pulse(3)
    decision = estimate_meter(spectrum, FREQUENCIES, frame_times, [0.0, 0.5, 1.0])
    assert decision.beats_per_bar == 4
    assert decision.confidence == METER_MIN_CONFIDENCE


def test_la_fixture_de_verite_couvre_le_manifeste() -> None:
    manifest = json.loads((ROOT / "tests/support/real_corpus.json").read_text(encoding="utf-8"))
    truth = json.loads((ROOT / "tests/fixtures/meter_truth.json").read_text(encoding="utf-8"))
    real = {int(entry["id"]): entry for entry in truth["real"]}
    assert set(real) == {int(entry["id"]) for entry in manifest}
    for entry in manifest:
        assert real[int(entry["id"])]["meter"] == int(entry["meter_attendu"])
    assert sum(1 for entry in real.values() if entry["meter"] == 3) >= 3
    six = [entry for entry in truth["synthetiques"] if entry["beats_per_bar"] == 6]
    assert len(six) == 1
    assert six[0]["meter_attendu"] in (3, 4)


@pytest.mark.parametrize(
    ("name", "bpm", "beats_per_bar"),
    [("valse_90", 90.0, 3), ("valse_120", 120.0, 3), ("valse_150", 150.0, 3)],
)
def test_valses_synthetiques_detectees_3_4(
    tmp_path: Path, name: str, bpm: float, beats_per_bar: int
) -> None:
    track = tmp_path / f"{name}.wav"
    write_meter_track(track, bpm=bpm, beats_per_bar=beats_per_bar)
    result = analyze_file(track, load_settings(), report=lambda message, progress: None)
    assert result.meter == 3, f"{name} : métrique {result.meter}"
    assert result.meter_confidence >= METER_MIN_CONFIDENCE
    assert isinstance(result.events, list)


def test_six_huit_repli_documente(tmp_path: Path) -> None:
    """Le contrat autorise 3 ou le repli 4/4 pour un 6/8 ; on documente le repli."""
    track = tmp_path / "six_huit.wav"
    write_meter_track(track, bpm=120.0, beats_per_bar=6)
    result = analyze_file(track, load_settings(), report=lambda message, progress: None)
    assert result.meter in (3, 4)
    assert result.meter_confidence >= METER_MIN_CONFIDENCE


def test_champs_nouveaux_serialises_et_optionnels(tmp_path: Path) -> None:
    track = tmp_path / "schema.wav"
    write_meter_track(track, bpm=120.0, beats_per_bar=3, duration=12.0)
    result = analyze_file(track, load_settings(), report=lambda message, progress: None)
    payload = asdict(result)
    assert payload["meter"] in (3, 4)
    assert 0.0 <= payload["meter_confidence"] <= 1.0
    assert isinstance(payload["events"], list)
    for event in payload["events"]:
        assert set(event) == {"t", "kind", "strength"}
        assert event["kind"] == "bass-return"
        assert 0.0 <= event["strength"] <= 1.0
