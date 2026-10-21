"""Génère une piste de test synthétique (kick, caisse claire, charley, basse).

Utilisée par les tests et par les vérifications manuelles : le tempo et les
sections sont connus à l'avance, donc on peut contrôler ce que l'analyse doit
trouver.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import soundfile as sf

SR = 22050


def _envelope(
    t: np.ndarray,
    attack: float,
    hold: float,
    release: float,
    period: float,
    duration: float,
) -> np.ndarray:
    env = np.zeros_like(t)
    n_a, n_h, n_r = int(attack * SR), int(hold * SR), int(release * SR)
    for start in np.arange(0, duration - 0.05, period):
        cursor = int(start * SR)
        for length, amp, shape in ((n_a, 1.0, "up"), (n_h, 0.6, "flat"), (n_r, 0.0, "down")):
            end = min(cursor + max(length, 1), len(env))
            if cursor >= end:
                break
            if shape == "up":
                env[cursor:end] += amp * np.linspace(0, 1, end - cursor, endpoint=False)
            elif shape == "flat":
                env[cursor:end] += amp
            else:
                env[cursor:end] += amp * np.linspace(1, 0, end - cursor, endpoint=False)
            cursor = end
    return np.clip(env, 0.0, 1.0)


def write_synthetic_track(
    path: Path, duration: float = 12.0, bpm: float = 128.0, level: float = 0.9
) -> float:
    """Écrit un WAV de test et renvoie le tempo réel utilisé."""
    t = np.arange(int(SR * duration)) / SR
    beat = 60.0 / bpm
    rng = np.random.default_rng(7)

    kick = np.sin(2 * np.pi * 55 * t) * _envelope(t, 0.005, 0.09, 0.13, beat, duration) * 0.85
    snare = rng.standard_normal(len(t)) * _envelope(t, 0.002, 0.05, 0.16, 2 * beat, duration) * 0.3
    hat = rng.standard_normal(len(t)) * _envelope(t, 0.002, 0.02, 0.05, beat / 2, duration) * 0.12
    bass = np.sin(2 * np.pi * 80 * t) * 0.16
    melody = np.zeros_like(t)
    notes = [220.0, 246.94, 293.66, 329.63, 392.0, 440.0]
    for start in np.arange(0, duration - 0.5, beat * 2):
        freq = notes[int(rng.integers(0, len(notes)))]
        decay = np.clip(t - start, 0, None)
        melody += np.sin(2 * np.pi * freq * t) * np.exp(-decay * 4.0) * (t >= start) * 0.07

    gain = np.ones_like(t)
    gain[t < duration * 0.33] = 0.3
    ramp = (t >= duration * 0.33) & (t < duration * 0.66)
    if ramp.any():
        gain[ramp] = 0.3 + 0.7 * (t[ramp] - duration * 0.33) / (duration * 0.33)

    mix = (kick + snare + hat + bass + melody) * gain
    peak = float(np.max(np.abs(mix)))
    if peak > 0:
        mix = mix / peak * level
    sf.write(path, mix.astype(np.float32), SR, subtype="PCM_16")
    return bpm


def _gate_window(t: np.ndarray, start: float, end: float, fade: float) -> np.ndarray:
    gate = np.ones_like(t)
    gate[t < start] = 0
    gate[t >= end] = 0
    gate *= np.clip((t - start) / fade, 0, 1)
    gate *= np.clip((end - t) / fade, 0, 1)
    return gate


def _snare_hits(rng: np.random.Generator, length: int, duration: float) -> np.ndarray:
    hits = np.zeros(length)
    for start in np.arange(30, duration, 0.75):
        index = int(start * 22050)
        width = int(0.06 * 22050)
        if index + width >= length:
            break
        hits[index : index + width] += rng.standard_normal(width) * np.exp(
            -np.linspace(0, 6, width)
        )
    return hits * 0.4


def write_rich_track(path: Path, duration: float = 60.0) -> None:
    """Piste de démonstration : quatre caractères musicaux distincts et successifs.

    calme (0-15 s) -> rythmique (15-30 s) -> intense (30-45 s) -> bruité (45-60 s)
    """
    t = np.arange(int(SR * duration)) / SR
    rng = np.random.default_rng(11)
    beat = 0.46875  # 128 BPM
    quarter = duration / 4

    kicks = np.sin(2 * np.pi * 58 * t) * _envelope(t, 0.005, 0.1, 0.16, beat, duration)
    snares = rng.standard_normal(len(t)) * _envelope(t, 0.002, 0.05, 0.14, 2 * beat, duration) * 0.3
    hats = rng.standard_normal(len(t)) * _envelope(t, 0.002, 0.02, 0.04, beat / 2, duration) * 0.13
    bass = np.sin(2 * np.pi * 82 * t) * 0.2

    pad = np.zeros_like(t)
    for index, start in enumerate(np.arange(0, duration, 6)):
        freq = [196.0, 220.0, 261.63, 293.66, 246.94][index % 5]
        envelope = np.exp(-(((t - start) / 3.0) ** 2))
        pad += np.sin(2 * np.pi * freq * t) * envelope * 0.13

    chords = np.zeros_like(t)
    for index, start in enumerate(np.arange(0, duration, 3)):
        base = 196.0 * (1 + (index % 4) * 0.06)
        envelope = np.exp(-(((t - start) / 0.5) ** 2))
        chords += np.sin(2 * np.pi * base * t) * envelope * 0.1
        chords += np.sin(2 * np.pi * base * 1.5 * t) * envelope * 0.06

    noise_band = np.zeros_like(t)
    for center in (3200.0, 5100.0, 7600.0):
        noise_band += np.sin(2 * np.pi * center * t) * rng.standard_normal(len(t)) * 0.05

    layers = [
        pad,
        kicks + snares + hats + bass,
        (kicks + snares + hats) * 1.25 + bass * 1.3 + chords,
        noise_band + chords * 0.8 + _snare_hits(rng, len(t), duration),
    ]

    mix = np.zeros_like(t)
    for index, layer in enumerate(layers):
        start = index * quarter
        end = (index + 1) * quarter
        mix += layer * _gate_window(t, start, end, 0.5)

    peak = float(np.max(np.abs(mix)))
    if peak > 0:
        mix = mix / peak * 0.92
    sf.write(path, mix.astype(np.float32), SR, subtype="PCM_16")


def write_structured_track(path: Path, duration_per_block: float = 12.0) -> None:
    """Piste A-B-A-B (intro-A-refrain-A-refrain-outro) pour la structure.

    Chaque bloc porte une couleur harmonique (fondamentale) et un gain distincts :
    les deux blocs »A« et les deux »B« sont donc identiques deux à deux, et la
    détection de structure doit les regrouper. Le refrain »B« est le plus fort,
    comme dans un vrai morceau.
    """
    sr = SR
    beat = 0.46875  # 128 BPM
    rng = np.random.default_rng(17)
    # (fondamentale, gain) par bloc ; A=verse, B=refrain, I/O=intro/outro.
    blocks = [
        ("I", 110.0, 0.25),
        ("A", 220.0, 0.5),
        ("B", 165.0, 0.9),
        ("A", 220.0, 0.5),
        ("B", 165.0, 0.9),
        ("O", 110.0, 0.25),
    ]

    parts: list[np.ndarray] = []
    for kind, root, gain in blocks:
        t = np.arange(int(sr * duration_per_block)) / sr
        kick = np.sin(2 * np.pi * 55 * t) * np.exp(-(((t % beat) / 0.12) ** 2)) * 0.8
        hat = 0.15 * rng.standard_normal(len(t)) * np.exp(-(((t % (beat / 2)) / 0.03) ** 2))
        chord = np.zeros_like(t)
        for ratio in (1.0, 1.26, 1.5):
            chord += np.sin(2 * np.pi * root * ratio * t) * 0.12
        rate = 0.5 if kind == "B" else 0.25
        melody = np.sin(2 * np.pi * root * 2 * t) * 0.15 * (1 + np.sin(2 * np.pi * rate * t))
        parts.append((kick + hat + chord + melody) * gain)

    mix = np.concatenate(parts)
    peak = float(np.max(np.abs(mix)))
    if peak > 0:
        mix = mix / peak * 0.9
    sf.write(path, mix.astype(np.float32), sr, subtype="PCM_16")


def write_continuous_track(path: Path, duration: float = 60.0) -> None:
    """Morceau **continu** : cinq régimes spectraux distincts, aucun ne revient.

    Jazz/ambient/métal progressif : chaque bloc a sa fondamentale, sa texture et
    son gain, mais aucun matériau n'est repris. L'énergie culmine dans l'avant-
    dernier bloc puis retombe — la progression qu'un découpage « couplet/refrain »
    ne saurait pas décrire.
    """
    sr = SR
    t = np.arange(int(sr * duration)) / sr
    rng = np.random.default_rng(31)
    # (fondamentale, centre du souffle, gain) par bloc.
    blocks = [
        (110.0, 900.0, 0.25),
        (146.8, 2200.0, 0.4),
        (174.6, 3500.0, 0.65),
        (233.1, 5200.0, 0.95),
        (185.0, 1500.0, 0.3),
    ]
    span = duration / len(blocks)
    mix = np.zeros_like(t)
    for index, (root, center, gain) in enumerate(blocks):
        start, end = index * span, (index + 1) * span
        mask = (t >= start) & (t < end)
        tone = np.zeros_like(t)
        for ratio in (1.0, 2.0, 3.0):
            tone += np.sin(2 * np.pi * root * ratio * t) * (0.1 / ratio)
        breath = np.sin(2 * np.pi * center * t) * rng.standard_normal(len(t)) * 0.05
        # Accents propres au bloc : aucune périodicité d'un bloc à l'autre.
        period = 0.38 + 0.13 * index
        for hit in np.arange(start, end, period):
            cursor = int(hit * sr)
            width = int(0.04 * sr)
            if cursor + width >= len(t):
                break
            tone[cursor : cursor + width] += (
                rng.standard_normal(width) * np.exp(-np.linspace(0, 6, width)) * 0.35
            )
        mix += (tone + breath) * gain * mask

    peak = float(np.max(np.abs(mix)))
    if peak > 0:
        mix = mix / peak * 0.9
    sf.write(path, mix.astype(np.float32), sr, subtype="PCM_16")


if __name__ == "__main__":
    import sys

    destination = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/night-light-test.wav")
    argument = sys.argv[2] if len(sys.argv) > 2 else ""
    if argument == "rich":
        write_rich_track(destination)
        print(f"{destination} — piste de démonstration riche (4 caractères)")
    else:
        duration = float(argument) if argument.strip() else 12.0
        tempo = write_synthetic_track(destination, duration=duration)
        print(f"{destination} — {duration:.0f} s, tempo réel {tempo} BPM")
