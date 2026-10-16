"""Chronomètre et inspection d'une analyse, hors API.

uv run python bench/bench_analysis.py /tmp/piste.wav
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import librosa
import numpy as np

from server.analysis import HOP, NFFT, _section_count, analyze_file
from server.config import load_settings

settings = load_settings()


def lap(label, fn):
    start = time.perf_counter()
    result = fn()
    print(f"{label:28s} {time.perf_counter() - start:7.2f}s")
    return result


def main(path: str) -> None:
    audio, sr = lap(
        "load 22050 mono",
        lambda: librosa.load(path, sr=settings.sample_rate, mono=True),
    )
    duration = len(audio) / sr
    print(f"{path} — {duration:.1f} s @ {sr} Hz")

    lap("onset_strength", lambda: librosa.onset.onset_strength(y=audio, sr=sr, hop_length=HOP))
    lap(
        "beat_track",
        lambda: librosa.beat.beat_track(
            onset_envelope=None, y=audio, sr=sr, hop_length=HOP, trim=False
        ),
    )
    lap("stft 2048/512", lambda: np.abs(librosa.stft(audio, n_fft=NFFT, hop_length=HOP)))

    librosa.feature.melspectrogram(y=audio, sr=sr, n_fft=NFFT, hop_length=HOP, n_mels=64)
    lap(
        "mfcc + chroma",
        lambda: librosa.feature.chroma_stft(
            S=librosa.feature.melspectrogram(y=audio, sr=sr, n_fft=NFFT, hop_length=HOP, n_mels=12),
            sr=sr,
            hop_length=HOP,
        ),
    )

    start = time.perf_counter()
    result = analyze_file(Path(path), settings, report=lambda message, progress: None)
    print(f"\nanalyse complète         {time.perf_counter() - start:6.2f}s")
    print(f"tempo {result.tempo} | temps forts {len(result.beats)} | attaques {len(result.onsets)}")
    print(
        f"sections ({_section_count(duration)} visées) :",
        [(s["start"], s["end"], s["label"], s["energy"]) for s in result.sections],
    )
    print("montées :", result.builds)
    print(
        "courbes :",
        {name: len(getattr(result, name)) for name in ("energy", "bass", "mid", "high")},
    )


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "/tmp/piste.wav")
