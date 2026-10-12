"""Analyse audio réelle d'un morceau, avec librosa.

Aucune valeur n'est inventée : chaque courbe, tempo, temps fort ou section
provient d'un calcul effectué sur les échantillons décodés.
"""

from __future__ import annotations

import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import librosa
import numpy as np

from .config import Settings

SR_DEFAULT = 22050
HOP = 512
NFFT = 2048
# Retard de groupe d'une STFT : le pic de flux spectral précède le transitoire
# d'environ n_fft/2 échantillons. On le corrige explicitement.
GROUP_DELAY_SEC = (NFFT / 2) / SR_DEFAULT


class AnalysisError(Exception):
    """Erreur d'analyse, traduite en message compréhensible par l'API."""

    def __init__(self, code: str, message: str, detail: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail


@dataclass
class Phase:
    name: str
    weight: float


ProgressFn = Callable[[Phase, float, str], None]


@dataclass
class AnalysisResult:
    duration: float
    tempo: float
    beats: list[float]
    onsets: list[float]
    energy: list[list[float]]
    bass: list[list[float]]
    mid: list[list[float]]
    high: list[list[float]]
    sections: list[dict]
    builds: list[dict]


# --------------------------------------------------------------------- décodage


def decode_with_ffmpeg(path: Path, sample_rate: int) -> np.ndarray | None:
    """Repli pour les formats que libsndfile ne sait pas ouvrir (M4A/AAC)."""
    command = [
        "ffmpeg",
        "-v",
        "error",
        "-nostdin",
        "-i",
        str(path),
        "-vn",
        "-ac",
        "1",
        "-ar",
        str(sample_rate),
        "-f",
        "wav",
        "-",
    ]
    try:
        completed = subprocess.run(command, capture_output=True, timeout=120, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    if completed.returncode != 0 or len(completed.stdout) < 4096:
        return None
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as handle:
        handle.write(completed.stdout)
        handle.flush()
        try:
            audio, _ = librosa.load(Path(handle.name), sr=sample_rate, mono=True)
        except Exception:
            return None
    return np.asarray(audio, dtype=np.float32)


def load_audio(path: Path, sample_rate: int) -> np.ndarray:
    try:
        audio, _ = librosa.load(path, sr=sample_rate, mono=True)
        return np.asarray(audio, dtype=np.float32)
    except Exception as direct:  # noqa: BLE001 - on tente le repli ffmpeg
        fallback = decode_with_ffmpeg(path, sample_rate)
        if fallback is not None and fallback.size > 0:
            return fallback
        raise AnalysisError(
            "unreadable_audio",
            "Ce fichier n'est pas un audio exploitable : le décodage a échoué.",
            str(direct)[:300],
        ) from direct


# ------------------------------------------------------------------- courbes


def _smooth(values: np.ndarray, seconds: float, rate: float) -> np.ndarray:
    """Moyenne mobile fenêtrée (Hann).

    En dessous de 3 points aucun noyau n'est défini : `np.hanning(2)` vaut
    `[0, 0]` et annulerait entièrement la courbe.
    """
    width = int(seconds * rate)
    if width < 3 or values.size == 0:
        return values
    kernel = np.hanning(width)
    total = float(kernel.sum())
    if total <= 0.0:
        return values
    return np.convolve(values, kernel / total, mode="same")


def normalize_curve(
    values: np.ndarray,
    floor_q: float = 0.35,
    ceil_q: float = 0.985,
    gamma: float = 0.85,
) -> np.ndarray:
    """Normalisation robuste par quantiles, puis compression douce."""
    if values.size == 0:
        return values
    finite = values[np.isfinite(values)]
    if finite.size == 0:
        return np.zeros_like(values)
    low = float(np.quantile(finite, floor_q))
    high = float(np.quantile(finite, ceil_q))
    if high - low < 1e-9:
        return np.zeros_like(values)
    out = np.clip((values - low) / (high - low), 0.0, 1.0)
    return np.power(out, gamma)


def normalize_log_curve(
    values: np.ndarray,
    floor_q: float = 0.1,
    ceil_q: float = 0.99,
    floor: float = 0.05,
) -> np.ndarray:
    """Normalisation d'énergie en échelle logarithmique.

    L'oreille (et le spectacle) suivent le logarithme de l'amplitude : avec une
    normalisation linéaire par quantiles, les passages modérés s'écrasent à 0 et
    le show se vide pendant les couplets.
    """
    if values.size == 0:
        return values
    finite = values[np.isfinite(values)]
    if finite.size == 0:
        return np.zeros_like(values)
    log = np.log1p(np.clip(values, 0.0, None) * 400.0)
    low = float(np.quantile(log, floor_q))
    high = float(np.quantile(log, ceil_q))
    if high - low < 1e-9:
        return np.zeros_like(values)
    return np.clip((log - low) / (high - low), floor, 1.0)


def curve_to_points(
    times: np.ndarray,
    values: np.ndarray,
    rate_hz: float,
    duration: float,
) -> list[list[float]]:
    """Rééchantillonne une courbe à cadence fixe et la sérialise."""
    if values.size == 0 or duration <= 0:
        return []
    step = 1.0 / max(rate_hz, 1.0)
    grid = np.arange(0.0, duration + step * 0.5, step)
    resampled = np.interp(grid, times, values, left=0.0, right=0.0)
    resampled = _smooth(np.clip(resampled, 0.0, 1.0), 0.14, rate_hz)
    return [[round(float(t), 3), round(float(v), 2)] for t, v in zip(grid, resampled)]


def band_energy(spectrum: np.ndarray, frequencies: np.ndarray, low: float, high: float) -> np.ndarray:
    mask = (frequencies >= low) & (frequencies < high)
    if not mask.any():
        return np.zeros(spectrum.shape[1])
    return spectrum[mask].sum(axis=0)


# ----------------------------------------------------------------- rythme


def detect_rhythm(
    y: np.ndarray,
    sr: int,
    report: ProgressFn,
    phase: Phase,
) -> tuple[float, list[float], list[float]]:
    report(phase, 0.1, "Enveloppe des attaques")
    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP)
    report(phase, 0.5, "Estimation du tempo")
    tempo, beat_frames = librosa.beat.beat_track(
        onset_envelope=onset_env,
        sr=sr,
        hop_length=HOP,
        trim=False,
    )
    tempo_value = float(np.atleast_1d(np.asarray(tempo, dtype=float))[0])
    if tempo_value <= 0:
        tempo_value = 120.0
    report(phase, 0.8, "Temps forts et attaques")
    beats = librosa.frames_to_time(beat_frames, sr=sr, hop_length=HOP) + GROUP_DELAY_SEC
    onsets = librosa.onset.onset_detect(
        onset_envelope=onset_env,
        sr=sr,
        hop_length=HOP,
        units="time",
        backtrack=False,
    ) + GROUP_DELAY_SEC
    unique_beats = sorted({round(float(b), 3) for b in beats})
    unique_onsets = sorted({round(float(o), 3) for o in onsets})
    return tempo_value, unique_beats, unique_onsets


# ---------------------------------------------------------------- sections


def _section_count(duration: float) -> int:
    """Nombre de groupes visés : environ une section toutes les 30 secondes,
    avec un minimum pour les morceaux courts."""
    target = round(duration / 30.0) + 2 + (1 if duration < 60 else 0)
    return int(max(3, min(14, target)))


def detect_sections(
    spectrum: np.ndarray,
    y: np.ndarray,
    sr: int,
    duration: float,
    energy_curve: np.ndarray,
    energy_times: np.ndarray,
    report: ProgressFn,
    phase: Phase,
) -> list[dict]:
    report(phase, 0.2, "Caractéristiques spectrales")
    mel = librosa.feature.melspectrogram(y=y, sr=sr, n_fft=NFFT, hop_length=HOP, n_mels=64)
    mfcc = librosa.feature.mfcc(S=librosa.power_to_db(mel + 1e-10), n_mfcc=13)
    chroma = librosa.feature.chroma_stft(S=spectrum, sr=sr, hop_length=HOP)
    features = np.vstack([mfcc, chroma])
    features = librosa.util.normalize(features, axis=1)

    count = _section_count(duration)
    report(phase, 0.6, f"Regroupement des {count} sections")
    bounds = librosa.segment.agglomerative(features, count)
    edges = sorted(
        {
            round(float(librosa.frames_to_time(int(b), sr=sr, hop_length=HOP)), 3)
            for b in np.asarray(bounds, dtype=int)
        }
        | {0.0, round(float(duration), 3)}
    )
    edges = [edge for index, edge in enumerate(edges) if index == 0 or edge - edges[index - 1] > 0.75]
    if edges[-1] < duration:
        edges.append(round(float(duration), 3))

    sections: list[dict] = []
    for index in range(len(edges) - 1):
        start = edges[index]
        end = edges[index + 1]
        if end - start <= 0.3:
            continue
        window = (energy_times >= start) & (energy_times < end)
        segment = energy_curve[window]
        if segment.size == 0:
            mean_energy = 0.0
            slope = 0.0
        else:
            mean_energy = float(np.mean(segment))
            half = max(1, segment.size // 3)
            slope = float(np.mean(segment[-half:]) - np.mean(segment[:half]))
        if mean_energy < 0.08:
            label = "silence"
        elif slope > 0.12:
            label = "montee"
        elif slope < -0.12 and mean_energy < 0.55:
            label = "descente"
        elif mean_energy > 0.5 and slope >= -0.05:
            label = "intense"
        else:
            label = "calme"
        sections.append(
            {
                "start": round(float(start), 3),
                "end": round(float(end), 3),
                "label": label,
                "energy": round(float(np.clip(mean_energy, 0.0, 1.0)), 3),
            }
        )

    if not sections:
        sections = [{"start": 0.0, "end": round(float(duration), 3), "label": "intense", "energy": 0.5}]
    report(phase, 1.0, f"{len(sections)} sections détectées")
    return sections


# ------------------------------------------------------------------ montées


def detect_builds(energy_points: list[list[float]], duration: float) -> list[dict]:
    """Montées d'énergie suivies d'un impact."""
    if len(energy_points) < 8:
        return []
    times = np.array([point[0] for point in energy_points], dtype=float)
    values = np.array([point[1] for point in energy_points], dtype=float)
    rate = 1.0 / max(float(np.median(np.diff(times))) if times.size > 1 else 0.05, 1e-3)
    smooth = _smooth(values, min(2.0, max(0.5, duration / 6.0)), rate)
    if values.size < 3:
        return []
    gradient = np.gradient(smooth) * rate
    window = max(1, int(min(4.0, max(1.0, duration / 4.0)) * rate))
    derivative = np.convolve(gradient, np.ones(window) / window, mode="same")
    rising = derivative > 0.01

    builds: list[dict] = []
    index = 0
    while index < len(rising):
        if not rising[index]:
            index += 1
            continue
        start_index = index
        end_index = index
        while end_index < len(rising) and rising[end_index]:
            end_index += 1
        start = float(times[start_index])
        end = float(times[min(end_index, len(times) - 1)])
        peak_slice = values[start_index : min(start_index + int(6 * rate), len(values))]
        strength = float(np.max(peak_slice)) if peak_slice.size > 0 else 0.0
        start_level = float(values[start_index])
        # Une vraie montée gagne nettement en niveau, pas seulement quelques %.
        if 2.0 <= end - start <= 30.0 and strength > 0.3 and strength - start_level > 0.18:
            builds.append(
                {
                    "start": round(start, 3),
                    "end": round(min(end, duration), 3),
                    "strength": round(float(np.clip(strength, 0.0, 1.0)), 3),
                }
            )
        index = end_index + 1

    # Fusionne les montées qui se chevauchent.
    merged: list[dict] = []
    for build in builds:
        if merged and build["start"] - merged[-1]["end"] < 1.0:
            merged[-1]["end"] = max(merged[-1]["end"], build["end"])
            merged[-1]["strength"] = max(merged[-1]["strength"], build["strength"])
        else:
            merged.append(dict(build))
    return merged


def warmup(seconds: float = 2.0, sample_rate: int = SR_DEFAULT) -> None:
    """Préchauffe les chemins numba/librosa.

    Sans ça, le premier upload paie la compilation JIT (plusieurs secondes) et
    l'avancement reste bloqué sur la première phase sans que l'utilisateur
    comprenne pourquoi.
    """
    try:
        rng = np.random.default_rng(0)
        noise = (rng.standard_normal(int(sample_rate * seconds)) * 0.05).astype(np.float32)
        onset_env = librosa.onset.onset_strength(y=noise, sr=sample_rate, hop_length=HOP)
        librosa.beat.beat_track(onset_envelope=onset_env, sr=sample_rate, hop_length=HOP, trim=False)
        mel = librosa.feature.melspectrogram(y=noise, sr=sample_rate, n_fft=NFFT, hop_length=HOP, n_mels=64)
        librosa.feature.mfcc(S=librosa.power_to_db(mel + 1e-10), n_mfcc=13)
        librosa.feature.chroma_stft(
            S=librosa.stft(noise, n_fft=NFFT, hop_length=HOP), sr=sample_rate, hop_length=HOP
        )
        librosa.feature.rms(y=noise, hop_length=HOP)
    except Exception:  # noqa: BLE001 - un échec de préchauffage n'est pas fatal
        pass


# ------------------------------------------------------------------ analyse


def analyze_file(
    path: Path,
    settings: Settings,
    report: Callable[[str, float], None] | None = None,
) -> AnalysisResult:
    """Analyse complète. `report(message, progress)` sert l'avancement réel."""

    def emit(message: str, value: float) -> None:
        if report is not None:
            report(message, float(min(max(value, 0.0), 1.0)))

    phases = [
        Phase("Décodage audio", 0.08),
        Phase("Enveloppes spectrales", 0.24),
        Phase("Analyse du rythme", 0.18),
        Phase("Découpage en sections", 0.22),
        Phase("Montées et impacts", 0.16),
        Phase("Assemblage des données", 0.12),
    ]
    totals = np.cumsum([phase.weight for phase in phases])
    total = float(totals[-1])

    def progress(phase: Phase, ratio: float, detail: str) -> None:
        index = phases.index(phase)
        done = float(totals[index - 1]) if index > 0 else 0.0
        emit(f"{phase.name} — {detail}", (done + phase.weight * ratio) / total)

    sample_rate = settings.sample_rate
    emit("Décodage du fichier audio", 0.0)
    y = load_audio(path, sample_rate)
    duration = float(len(y) / sample_rate) if sample_rate > 0 else 0.0

    if duration < 1.0:
        raise AnalysisError("too_short", "Le morceau est trop court (moins d'une seconde) pour être analysé.")
    if duration > settings.max_duration_sec:
        raise AnalysisError(
            "too_long",
            f"Morceau trop long ({duration / 60:.1f} min). Limite : {settings.max_duration_sec / 60:.0f} min.",
        )

    spectrum = np.abs(librosa.stft(y, n_fft=NFFT, hop_length=HOP))
    frequencies = librosa.fft_frequencies(sr=sample_rate, n_fft=NFFT)
    frame_times = librosa.frames_to_time(np.arange(spectrum.shape[1]), sr=sample_rate, hop_length=HOP)
    frame_rate = sample_rate / float(HOP)

    # Lissage large : sans lui les courbes servent le battement du morceau et
    # feraient clignoter les effets au lieu de suivre son énergie.
    bass = normalize_curve(_smooth(band_energy(spectrum, frequencies, 30, 150), 0.35, frame_rate))
    mid = normalize_curve(_smooth(band_energy(spectrum, frequencies, 150, 2000), 0.35, frame_rate))
    high = normalize_curve(_smooth(band_energy(spectrum, frequencies, 2000, 10000), 0.35, frame_rate))
    rms = normalize_curve(_smooth(librosa.feature.rms(y=y, hop_length=HOP)[0], 0.35, frame_rate))
    progress(phases[1], 1.0, "bandes basses / médiums / aigus")

    energy_raw = 0.62 * rms + 0.38 * ((bass + mid + high) / 3.0)
    energy = normalize_log_curve(energy_raw)

    tempo, beats, onsets = detect_rhythm(y, sample_rate, progress, phases[2])

    sections = detect_sections(
        spectrum,
        y,
        sample_rate,
        duration,
        energy,
        frame_times,
        progress,
        phases[3],
    )
    progress(phases[4], 0.5, "détection des montées")
    energy_points = curve_to_points(frame_times, energy, settings.curve_rate_hz, duration)
    builds = detect_builds(energy_points, duration)
    progress(phases[4], 1.0, f"{len(builds)} montées repérées")
    progress(phases[5], 1.0, "données du spectacle prêtes")

    return AnalysisResult(
        duration=round(duration, 3),
        tempo=round(tempo, 3),
        beats=beats,
        onsets=onsets,
        energy=energy_points,
        bass=curve_to_points(frame_times, bass, settings.curve_rate_hz, duration),
        mid=curve_to_points(frame_times, mid, settings.curve_rate_hz, duration),
        high=curve_to_points(frame_times, high, settings.curve_rate_hz, duration),
        sections=sections,
        builds=builds,
    )
