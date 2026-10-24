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


# ------------------------------------------------------------------ corpus
#
# Corpus de référence pour les tests de propriété et le harnais de métriques
# (voir docs/testing.md). Chaque piste est DÉTERMINISTE : graine fixe, aucun
# appel à l'horloge, aucun réseau. Deux générations successives doivent donner
# exactement les mêmes octets.
#
# Ce que chaque piste doit provoquer :
#   a. aigus-denses   — hi-hats en 16es continus, presque pas de basses :
#                       la brillance doit être haute, sans saturation du plan.
#   b. basses-seules  — sub + kick, aucun aigu : brillance basse, énergie
#                       portée par les basses, les familles « calmes » doivent
#                       rester visibles.
#   c. voix-mediane   — sinusoïdes modulées, aucune percussion : peu d'onsets,
#                       humeur calme/aérienne, pas de drop.
#   d. trois-drops    — trois montées nettes followed de trois impacts espacés :
#                       le plan doit contenir au moins trois scènes `build`
#                       (ou tomber sur ces impacts).
#   e. sans-montee    — groove régulier sans dynamique : aucun drop, le rendu
#                       doit utiliser le pulsage de secours sans blanchir.
#   f. silence-milieu — 10 s de silence total au milieu puis reprise : le
#                       rendu ne doit jamais devenir un écran mort.
#   g. court          — 4 s : sous la durée minimale de scène (5 s).
#   h. tempo-douteux  — nappes sans transitoire : le tempo ne doit pas être
#                       « inventé » avec assurance ; le plan se construit quand
#                       même avec la grille de repli.
#   i1. tres-faible   — crête à -40 dBFS : aucun crash, courbes non vides.
#   i2. sature        — crête à 0 dBFS avec écrêtage : aucun NaN, pas d'emballement.

CORPUS: list[dict[str, object]] = [
    {
        "name": "a_aigus_denses",
        "duration": 30.0,
        "bpm": 128.0,
        "seed": 101,
        "expect": "brillance haute, hi-hats en 16es, peu de basses",
    },
    {
        "name": "b_basses_seules",
        "duration": 30.0,
        "bpm": 124.0,
        "seed": 102,
        "expect": "sub + kick sans aigus, brillance basse",
    },
    {
        "name": "c_voix_mediane",
        "duration": 30.0,
        "bpm": 0.0,
        "seed": 103,
        "expect": "sinusoïdes modulées sans percussion, peu d'onsets",
    },
    {
        "name": "d_trois_drops",
        "duration": 45.0,
        "bpm": 128.0,
        "seed": 104,
        "expect": "trois montées nettes et trois drops espacés",
    },
    {
        "name": "e_sans_montee",
        "duration": 30.0,
        "bpm": 120.0,
        "seed": 105,
        "expect": "aucune montée détectable, dynamique plate",
    },
    {
        "name": "f_silence_milieu",
        "duration": 40.0,
        "bpm": 122.0,
        "seed": 106,
        "expect": "10 s de silence au milieu puis reprise",
    },
    {
        "name": "g_court",
        "duration": 4.0,
        "bpm": 120.0,
        "seed": 107,
        "expect": "durée inférieure à MIN_SCENE_SPAN (5 s)",
    },
    {
        "name": "h_tempo_douteux",
        "duration": 20.0,
        "bpm": 0.0,
        "seed": 108,
        "expect": "aucun transitoire périodique, tempo non fiable",
    },
    {
        "name": "i1_tres_faible",
        "duration": 20.0,
        "bpm": 120.0,
        "seed": 109,
        "expect": "crête à -40 dBFS",
    },
    {
        "name": "i2_sature",
        "duration": 20.0,
        "bpm": 120.0,
        "seed": 110,
        "expect": "crête à 0 dBFS, écrêtage",
    },
]


def _decay(t: np.ndarray, period: float, decay: float) -> np.ndarray:
    """Enveloppe percussive : une décroissance exponentielle à chaque période."""
    local = np.mod(t, max(period, 1e-3))
    return np.exp(-local / max(decay, 1e-4))


def _groove(
    duration: float,
    bpm: float,
    seed: int,
    *,
    kick: float = 0.8,
    hats: float = 0.16,
    snare: float = 0.22,
    bass: float = 0.3,
    hat_division: float = 2.0,
) -> np.ndarray:
    """Boucle rythmique déterministe (kick, caisse claire, charley, basse)."""
    t = np.arange(int(SR * duration)) / SR
    rng = np.random.default_rng(seed)
    beat = 60.0 / bpm
    mix = np.sin(2 * np.pi * 55 * t) * _decay(t, beat, 0.11) * kick
    mix += np.sin(2 * np.pi * 82 * t) * 0.5 * bass * (0.6 + 0.4 * np.sin(2 * np.pi * 0.1 * t))
    if snare > 0:
        mix += rng.standard_normal(t.size) * _decay(t, 2 * beat, 0.09) * snare
    if hats > 0:
        mix += rng.standard_normal(t.size) * _decay(t, beat / hat_division, 0.018) * hats
    return mix


def _normalize(mix: np.ndarray, level: float) -> np.ndarray:
    peak = float(np.max(np.abs(mix))) if mix.size else 0.0
    return mix / peak * level if peak > 0 else mix


def _write(path: Path, mix: np.ndarray, level: float = 0.9) -> None:
    sf.write(path, _normalize(mix, level).astype(np.float32), SR, subtype="PCM_16")


def write_aigus_denses(path: Path) -> None:
    """a. Hi-hats en 16es continus, sub discret : la brillance doit dominer."""
    t = np.arange(int(SR * 30.0)) / SR
    rng = np.random.default_rng(101)
    beat = 60.0 / 128.0
    hats = rng.standard_normal(t.size) * _decay(t, beat / 4, 0.012) * 0.9
    shimmer = np.sin(2 * np.pi * 6200 * t) * 0.12
    sub = np.sin(2 * np.pi * 48 * t) * 0.1
    kick = np.sin(2 * np.pi * 58 * t) * _decay(t, beat, 0.1) * 0.25
    _write(path, hats + shimmer + sub + kick)


def write_basses_seules(path: Path) -> None:
    """b. Sub continu + kick, aucun contenu au-dessus de 200 Hz."""
    t = np.arange(int(SR * 30.0)) / SR
    beat = 60.0 / 124.0
    sub = np.sin(2 * np.pi * 42 * t) * (0.55 + 0.15 * np.sin(2 * np.pi * 0.07 * t))
    kick = np.sin(2 * np.pi * 55 * t) * _decay(t, beat, 0.13) * 0.9
    body = np.sin(2 * np.pi * 110 * t) * _decay(t, beat, 0.08) * 0.35
    _write(path, sub + kick + body)


def write_voix_mediane(path: Path) -> None:
    """c. Voix synthétique : sinusoïdes modulées, aucune percussion."""
    duration = 30.0
    t = np.arange(int(SR * duration)) / SR
    f0 = 220.0 * (1.0 + 0.015 * np.sin(2 * np.pi * 5.2 * t))
    phase = 2 * np.pi * np.cumsum(f0) / SR
    voice = (
        np.sin(phase)
        + 0.45 * np.sin(2 * phase)
        + 0.22 * np.sin(3 * phase)
        + 0.1 * np.sin(5 * phase)
    )
    # Souffle lent, sans attaque : le contraire d'une percussion.
    swell = 0.45 + 0.25 * np.sin(2 * np.pi * 0.11 * t) + 0.15 * np.sin(2 * np.pi * 0.037 * t)
    _write(path, voice * swell)


def write_trois_drops(path: Path) -> None:
    """d. Trois montées de 6 s (bruit filtré montant) suivies d'un impact."""
    duration = 45.0
    t = np.arange(int(SR * duration)) / SR
    rng = np.random.default_rng(104)
    groove = _groove(duration, 128.0, 104, kick=0.75, hats=0.14, snare=0.2, bass=0.28)

    gain = np.full_like(t, 0.32)
    riser = np.zeros_like(t)
    drops = [12.0, 24.0, 38.0]
    for start in drops:
        build_start = start - 6.0
        window = (t >= build_start) & (t < start)
        gain[window] = 0.18 + 0.72 * (t[window] - build_start) / 6.0
        # Bruit qui monte : la montée doit être audible et détectable.
        riser[window] = (
            rng.standard_normal(int(window.sum()))
            * 0.28
            * (0.1 + 0.9 * (t[window] - build_start) / 6.0)
        )
        after = (t >= start) & (t < start + 5.0)
        gain[after] = 0.95
    impact = np.zeros_like(t)
    for start in drops:
        impact += np.sin(2 * np.pi * 52 * t) * _decay(t - start, 4.0, 0.25) * (t >= start) * 0.9
        impact += np.sin(2 * np.pi * 75 * t) * _decay(t - start, 4.0, 0.15) * (t >= start) * 0.4
    _write(path, groove * gain + riser + impact)


def write_sans_montee(path: Path) -> None:
    """e. Groove régulier, énergie constante : aucune dynamique de montée."""
    _write(path, _groove(30.0, 120.0, 105, kick=0.7, hats=0.18, snare=0.24, bass=0.26))


def write_silence_milieu(path: Path) -> None:
    """f. 15 s de musique, 10 s de silence total, puis 15 s de reprise."""
    duration = 40.0
    mix = _groove(duration, 122.0, 106, kick=0.75, hats=0.15, snare=0.22, bass=0.3)
    t = np.arange(mix.size) / SR
    gate = np.ones_like(t)
    gate[(t >= 15.0) & (t < 25.0)] = 0.0
    # Léger fondu aux bords du trou : une coupure sèche reste un vrai silence.
    for edge in (15.0, 25.0):
        ramp = (t >= edge - 0.05) & (t < edge + 0.05)
        gate[ramp] *= np.clip(np.abs(t[ramp] - edge) / 0.05, 0, 1)
    _write(path, mix * gate)


def write_court(path: Path) -> None:
    """g. 4 s seulement : plus court que la durée minimale d'une scène."""
    _write(path, _groove(4.0, 120.0, 107, kick=0.8, hats=0.18, snare=0.25, bass=0.3))


def write_tempo_douteux(path: Path) -> None:
    """h. Nappes et bruit filtré très lent, sans aucune attaque périodique."""
    duration = 20.0
    t = np.arange(int(SR * duration)) / SR
    rng = np.random.default_rng(108)
    noise = rng.standard_normal(t.size)
    # Lissage très large : plus aucune pulsation audible.
    kernel = np.hanning(4001)
    noise = np.convolve(noise, kernel / kernel.sum(), mode="same")
    drone = (
        np.sin(2 * np.pi * 63 * t) * 0.4
        + np.sin(2 * np.pi * 94.5 * t) * 0.25
        + np.sin(2 * np.pi * 141 * t) * 0.18
    )
    swell = 0.4 + 0.3 * np.sin(2 * np.pi * 0.05 * t + 1.1)
    _write(path, (drone * swell + noise * 0.9))


def write_tres_faible(path: Path) -> None:
    """i1. Même groove que la piste e, ramené à une crête de -40 dBFS."""
    _write(path, _groove(20.0, 120.0, 109, kick=0.8, hats=0.16, snare=0.22, bass=0.3), level=0.01)


def write_sature(path: Path) -> None:
    """i2. Groove poussé à 0 dBFS avec écrêtage (contenu harmonique large)."""
    mix = _normalize(
        _groove(20.0, 120.0, 110, kick=0.9, hats=0.2, snare=0.3, bass=0.4),
        1.0,
    )
    _write(path, np.clip(mix * 1.35, -1.0, 1.0), level=1.0)


GENERATORS = {
    "a_aigus_denses": write_aigus_denses,
    "b_basses_seules": write_basses_seules,
    "c_voix_mediane": write_voix_mediane,
    "d_trois_drops": write_trois_drops,
    "e_sans_montee": write_sans_montee,
    "f_silence_milieu": write_silence_milieu,
    "g_court": write_court,
    "h_tempo_douteux": write_tempo_douteux,
    "i1_tres_faible": write_tres_faible,
    "i2_sature": write_sature,
}


def write_corpus(destination: Path) -> list[Path]:
    """Écrit tout le corpus et son manifeste dans `destination`."""
    destination.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for entry in CORPUS:
        name = str(entry["name"])
        path = destination / f"{name}.wav"
        GENERATORS[name](path)
        written.append(path)
    manifest = destination / "manifest.json"
    import json

    manifest.write_text(
        json.dumps(CORPUS, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    written.append(manifest)
    return written


if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "corpus":
        target = Path(sys.argv[2] if len(sys.argv) > 2 else "tests/fixtures/corpus")
        files = write_corpus(target)
        print(f"{target} — {len(files) - 1} pistes + manifest.json")
    else:
        destination = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/night-light-test.wav")
        argument = sys.argv[2] if len(sys.argv) > 2 else ""
        if argument.startswith("rich"):
            # `rich` = 60 s ; `rich:180` = durée explicite (piste longue).
            length = float(argument.split(":", 1)[1]) if ":" in argument else 60.0
            write_rich_track(destination, duration=length)
            print(f"{destination} — piste de démonstration riche ({length:.0f} s)")
        else:
            duration = float(argument) if argument.strip() else 12.0
            tempo = write_synthetic_track(destination, duration=duration)
            print(f"{destination} — {duration:.0f} s, tempo réel {tempo} BPM")
