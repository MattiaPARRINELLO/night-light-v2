"""Détection de la structure répétitive (groupes couplet/refrain)."""

from __future__ import annotations

import sys
from pathlib import Path

import librosa
import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from server import structure
from server.structure import StructureSegment, _coalesce, _letters, estimate_structure
from tests.support.make_fixture import write_structured_track


def _describe(track: Path) -> tuple[np.ndarray, list[float], int, float]:
    """Spectre, temps forts et durée d'un fichier, comme `analysis.py` les fournit."""
    y, sr = librosa.load(track, sr=22050, mono=True)
    spectrum = np.abs(librosa.stft(y, n_fft=structure.N_FFT, hop_length=structure.HOP_LENGTH))
    _, beat_frames = librosa.beat.beat_track(y=y, sr=sr, hop_length=structure.HOP_LENGTH)
    beats = [
        float(t)
        for t in librosa.frames_to_time(beat_frames, sr=sr, hop_length=structure.HOP_LENGTH)
    ]
    return spectrum, beats, sr, float(len(y) / sr)


def test_letters_ordonnees_par_premiere_apparition() -> None:
    assert _letters(["2.0", "1.0", "2.0", "0.0"]) == ["A", "B", "A", "C"]


def test_coalesce_absorbe_les_blocs_trop_courts() -> None:
    segments = [
        StructureSegment(0.0, 0.8, "A"),  # artefact : absorbé par la suite
        StructureSegment(0.8, 20.0, "B"),
        StructureSegment(20.0, 20.6, "C"),  # artefact : absorbé par l'arrière
        StructureSegment(20.6, 60.0, "D"),
    ]
    out = _coalesce(segments)
    assert [(segment.start, segment.end, segment.group) for segment in out] == [
        (0.0, 20.6, "B"),
        (20.6, 60.0, "D"),
    ]


def test_structure_repetitive_detectee(tmp_path: Path) -> None:
    track = tmp_path / "structure.wav"
    write_structured_track(track, duration_per_block=12.0)
    spectrum, beats, sr, duration = _describe(track)

    segments = estimate_structure(spectrum, beats, sr, duration)
    assert segments is not None, "un morceau A-B-A-B doit être segmenté"
    assert len(segments) >= 3

    groups = [segment.group for segment in segments]
    # Le tout est qu'au moins un passage revienne : c'est ce qui distingue la
    # structure de la simple énergie par section.
    assert len(set(groups)) < len(groups)

    # Les blocs se suivent, couvrent le morceau et ne se recouvrent pas.
    assert segments[0].start == 0.0
    assert segments[-1].end == duration
    for previous, current in zip(segments, segments[1:], strict=False):
        assert current.start == pytest.approx(previous.end, abs=0.01)
        assert current.end > current.start


def test_morceau_trop_court_sans_structure() -> None:
    spectrum = np.ones((structure.N_FFT // 2 + 1, 50), dtype=np.float32)
    assert estimate_structure(spectrum, [], 22050, 10.0) is None
