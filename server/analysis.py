"""Analyse audio réelle d'un morceau, avec librosa.

Aucune valeur n'est inventée : chaque courbe, tempo, temps fort ou section
provient d'un calcul effectué sur les échantillons décodés.
"""

from __future__ import annotations

import contextlib
import multiprocessing
import queue as queue_module
import subprocess
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

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
    meter: int
    beats: list[float]
    onsets: list[float]
    energy: list[list[float]]
    bass: list[list[float]]
    mid: list[list[float]]
    mid_low: list[list[float]]
    mid_high: list[list[float]]
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
    return [[round(float(t), 3), round(float(v), 2)] for t, v in zip(grid, resampled, strict=False)]


def band_energy(
    spectrum: np.ndarray, frequencies: np.ndarray, low: float, high: float
) -> np.ndarray:
    mask = (frequencies >= low) & (frequencies < high)
    if not mask.any():
        return np.zeros(spectrum.shape[1])
    return spectrum[mask].sum(axis=0)


# ----------------------------------------------------------------- rythme


def estimate_meter(
    onset_env: np.ndarray,
    beats: list[float],
    tempo: float,
    sr: int,
    hop_length: int = HOP,
) -> int:
    """Estime la métrique dominante : 3 (ternaire) ou 4 (binaire).

    On mesure la périodicité de l'accentuation des temps forts, par
    autocorrélation : en 3/4, l'accent revient toutes les 3 pulsations (et 6) ;
    en 4/4, toutes les 4 (et 8). Sans répétition nette, on garde 4 : c'est
    l'hypothèse la plus courante, et se tromper vers le ternaire casserait la
    grille visuelle d'une écrasante majorité de morceaux.
    """
    if tempo <= 0 or onset_env.size == 0 or len(beats) < 8:
        return 4
    frames = librosa.time_to_frames(np.asarray(beats, dtype=float), sr=sr, hop_length=hop_length)
    frames = frames[(frames >= 0) & (frames < onset_env.size)]
    if frames.size < 8:
        return 4

    # Accent d'un temps = maximum local de l'enveloppe : la densité d'attaques
    # (charleys, ghost notes) ne doit pas décider de la métrique.
    accents = np.asarray(
        [
            float(np.max(onset_env[max(0, frame - 1) : min(onset_env.size, frame + 2)]))
            for frame in frames
        ]
    )
    accents = accents - float(np.mean(accents))
    total = float(np.sum(accents**2))
    if total <= 1e-9:
        return 4

    def lag_score(lag: int) -> float:
        if accents.size <= lag:
            return 0.0
        return float(np.dot(accents[:-lag], accents[lag:])) / total

    ternary = max(lag_score(3), lag_score(6))
    binary = max(lag_score(4), lag_score(8))
    # Marge volontaire : sans écart net ni accent ternaire franc, l'écart est du
    # bruit de mesure et on reste sur 4/4. Se tromper vers le ternaire casserait
    # la grille d'une écrasante majorité de morceaux.
    if ternary >= 0.45 and ternary > binary * 1.25:
        return 3
    return 4


def detect_rhythm(
    y: np.ndarray,
    sr: int,
    report: ProgressFn,
    phase: Phase,
) -> tuple[float, list[float], list[float], int]:
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
    onsets = (
        librosa.onset.onset_detect(
            onset_envelope=onset_env,
            sr=sr,
            hop_length=HOP,
            units="time",
            backtrack=False,
        )
        + GROUP_DELAY_SEC
    )
    unique_beats = sorted({round(float(b), 3) for b in beats})
    unique_onsets = sorted({round(float(o), 3) for o in onsets})
    meter = estimate_meter(onset_env, unique_beats, tempo_value, sr)
    return tempo_value, unique_beats, unique_onsets, meter


# ---------------------------------------------------------------- sections


def _energy_label(mean_energy: float) -> str:
    """Qualifie l'énergie globale du morceau.

    Pas de pente ici : sur une section qui couvre tout le morceau, une pente
    globale dirait « montée » du début à la fin. Le suivi fin de l'énergie est
    déjà porté par les courbes et les montées.
    """
    if mean_energy < 0.08:
        return "silence"
    if mean_energy > 0.5:
        return "intense"
    return "calme"


def detect_sections(
    energy_curve: np.ndarray,
    energy_times: np.ndarray,
    duration: float,
) -> list[dict]:
    """Décrit le morceau comme une **section unique**, de 0 à la fin.

    Le découpage automatique (répétition, ruptures spectrales, regroupement
    agglomératif) est volontairement absent : il produisait plus de frontières
    fausses que de repères utiles. Le spectacle est piloté par l'énergie, les
    montées et les temps forts, pas par une grille couplet/refrain inventée.

    On conserve une section pour garder le contrat d'analyse et l'affichage
    (tableau, bande de structure, étiquette HUD).
    """
    window = (energy_times >= 0.0) & (energy_times < duration)
    segment = energy_curve[window]
    mean_energy = float(np.mean(segment)) if segment.size else 0.0
    return [
        {
            "start": 0.0,
            "end": round(float(duration), 3),
            "label": _energy_label(mean_energy),
            "energy": round(float(np.clip(mean_energy, 0.0, 1.0)), 3),
            "group": "",
            "kind": "section",
            "occurrence": 0,
        }
    ]


# ------------------------------------------------------------------ montées


def _snap_to_onset(target: float, onsets: list[float] | None, window: float = 0.3) -> float:
    """Recale `target` sur l'attaque (onset) la plus proche, si elle existe.

    L'oreille entend l'attaque, pas le milieu de l'enveloppe : sans ce recadrage,
    le spectacle fête le drop là où la courbe d'énergie s'aplatit, ce qui est
    toujours un peu après le son.
    """
    if not onsets:
        return target
    best = target
    best_delta = window
    for onset in onsets:
        delta = abs(float(onset) - target)
        if delta <= best_delta:
            best_delta = delta
            best = float(onset)
    return best


# Un cut de 150 à 450 ms précède souvent le vrai impact (EDM, trap). La crête du
# gradient de montée tombe alors **avant** le silence : il faut chercher plus
# loin que la fenêtre habituelle de 300 ms, et surtout après le creux.
GAP_SEARCH_SEC = 0.6
# Baisse minimale pour parler de gap : absolue (courbe normalisée) ou relative à
# la crête. En dessous, il s'agit du bruit de fond de la montée, pas d'un cut.
_GAP_MIN_DROP = 0.12
_GAP_RELATIVE_DROP = 0.35
# Un vrai silence franc tombe sous 30 % du niveau de crête. Sans ce garde-fou,
# l'oscillation d'un kick régulier ressemble à un cut et déplace l'impact.
_GAP_MAX_TROUGH_RATIO = 0.3


def _onset_level(onset: float, times: np.ndarray, values: np.ndarray, span: float = 0.12) -> float:
    """Niveau atteint juste après une attaque.

    Un onset marque le *début* de l'impact : la courbe lissée est encore basse à
    cet instant précis. On mesure donc le maximum sur une courte fenêtre qui suit,
    sinon un kick parfaitement calé serait jugé « pas énergique ».
    """
    window = (times >= onset) & (times <= onset + span)
    if window.any():
        return float(np.max(values[window]))
    return float(np.interp(onset, times, values))


def _impact_after_gap(
    times: np.ndarray,
    values: np.ndarray,
    start_index: int,
    end_index: int,
    onsets: list[float] | None,
    peak_level: float,
) -> float | None:
    """Cherche un cut (silence franc) dans la montée et l'onset qui le suit.

    On parcourt la montée par la fin : le dernier creux franc est celui qui
    précède l'impact. Comparer chaque creux à sa crête locale — et non au maximum
    global du gradient — couvre les risers dont le pic de gradient tombe avant le
    silence. Le retour doit ensuite atteindre le niveau du pic de la montée :
    c'est ce qui distingue un drop d'une simple respiration entre deux kicks.
    """
    if onsets is None or times.size < 2 or values.size != times.size:
        return None
    if end_index <= start_index + 1:
        return None
    step = float(np.median(np.diff(times)))
    lookback = max(2, int(round(GAP_SEARCH_SEC / max(step, 1e-3))))
    recovery = max(0.08, 0.9 * peak_level)

    for trough_index in range(end_index - 1, start_index + 1, -1):
        trough = float(values[trough_index])
        crest_slice = range(max(start_index, trough_index - lookback), trough_index)
        crest_index = max(crest_slice, key=lambda index: float(values[index]))
        crest_level = float(values[crest_index])
        drop = crest_level - trough
        if drop < max(_GAP_MIN_DROP, _GAP_RELATIVE_DROP * max(crest_level, 1e-6)):
            continue
        if trough > _GAP_MAX_TROUGH_RATIO * crest_level:
            continue

        trough_time = float(times[trough_index])
        candidates = sorted(
            float(onset)
            for onset in onsets
            if trough_time < float(onset) <= trough_time + GAP_SEARCH_SEC
        )
        # Le premier onset qui remonte au niveau du pic : le souffle résiduel du
        # cut ne doit pas voler l'impact au kick qui suit.
        for onset in candidates:
            if _onset_level(onset, times, values) >= recovery:
                return onset
    return None


def detect_builds(
    energy_points: list[list[float]],
    duration: float,
    onsets: list[float] | None = None,
) -> list[dict]:
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
        # L'impact audible est le saut d'énergie le plus raide de la montée. Le
        # `derivative` est lissé sur plusieurs secondes, donc sa fin de montée
        # tombe après l'impact : sans ce recalcul, le spectacle fête le drop 1 à
        # 2 s après le son.
        pic = slice(start_index, min(end_index + 1, len(gradient)))
        if pic.stop > pic.start:
            after_gap = _impact_after_gap(
                times,
                values,
                start_index,
                pic.stop,
                onsets,
                float(np.max(values[start_index : pic.stop])),
            )
            if after_gap is not None:
                # Le drop est après le silence : c'est lui qu'il faut fêter.
                end = after_gap
            else:
                crest_index = min(
                    int(np.argmax(gradient[pic])) + pic.start,
                    len(times) - 1,
                )
                end = float(times[crest_index])
                # Et on recale sur l'attaque réelle : c'est elle que l'oreille entend.
                end = _snap_to_onset(end, onsets)
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
        librosa.beat.beat_track(
            onset_envelope=onset_env, sr=sample_rate, hop_length=HOP, trim=False
        )
        mel = librosa.feature.melspectrogram(
            y=noise, sr=sample_rate, n_fft=NFFT, hop_length=HOP, n_mels=64
        )
        librosa.feature.mfcc(S=librosa.power_to_db(mel + 1e-10), n_mfcc=13)
        librosa.feature.chroma_stft(
            S=librosa.stft(noise, n_fft=NFFT, hop_length=HOP),
            sr=sample_rate,
            hop_length=HOP,
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
        Phase("Décodage audio", 0.12),
        Phase("Enveloppes spectrales", 0.30),
        Phase("Analyse du rythme", 0.26),
        Phase("Montées et impacts", 0.16),
        Phase("Assemblage des données", 0.16),
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
        raise AnalysisError(
            "too_short",
            "Le morceau est trop court (moins d'une seconde) pour être analysé.",
        )
    if duration > settings.max_duration_sec:
        raise AnalysisError(
            "too_long",
            f"Morceau trop long ({duration / 60:.1f} min). Limite : "
            f"{settings.max_duration_sec / 60:.0f} min.",
        )

    spectrum = np.abs(librosa.stft(y, n_fft=NFFT, hop_length=HOP))
    frequencies = librosa.fft_frequencies(sr=sample_rate, n_fft=NFFT)
    frame_times = librosa.frames_to_time(
        np.arange(spectrum.shape[1]), sr=sample_rate, hop_length=HOP
    )
    frame_rate = sample_rate / float(HOP)

    # Lissage large : sans lui les courbes servent le battement du morceau et
    # feraient clignoter les effets au lieu de suivre son énergie.
    bass = normalize_curve(_smooth(band_energy(spectrum, frequencies, 30, 150), 0.35, frame_rate))
    mid = normalize_curve(_smooth(band_energy(spectrum, frequencies, 150, 2000), 0.35, frame_rate))
    # Subdivision du médium : 150–600 Hz (corps, bas-médium lourd) et 600–2500 Hz
    # (présence, caisses claires). `mid` reste exposé tel quel pour ne pas casser
    # le contrat du frontend ; ces deux courbes sont un raffinement optionnel.
    mid_low = normalize_curve(
        _smooth(band_energy(spectrum, frequencies, 150, 600), 0.35, frame_rate)
    )
    mid_high = normalize_curve(
        _smooth(band_energy(spectrum, frequencies, 600, 2500), 0.35, frame_rate)
    )
    high = normalize_curve(
        _smooth(band_energy(spectrum, frequencies, 2000, 10000), 0.35, frame_rate)
    )
    rms = normalize_curve(_smooth(librosa.feature.rms(y=y, hop_length=HOP)[0], 0.35, frame_rate))
    progress(phases[1], 1.0, "bandes basses / médiums / aigus")

    energy_raw = 0.62 * rms + 0.38 * ((bass + mid + high) / 3.0)
    energy = normalize_log_curve(energy_raw)

    tempo, beats, onsets, meter = detect_rhythm(y, sample_rate, progress, phases[2])

    # Pas de découpage couplet/refrain : la détection coûtait plus cher (temps
    # d'analyse limité) qu'elle n'apportait de repères fiables. Le morceau reste
    # une seule section ; le spectacle suit l'énergie, les montées et les temps
    # forts.
    energy_points = curve_to_points(frame_times, energy, settings.curve_rate_hz, duration)
    sections = detect_sections(energy, frame_times, duration)
    progress(phases[3], 0.5, "détection des montées")
    builds = detect_builds(energy_points, duration, onsets)
    progress(phases[3], 1.0, f"{len(builds)} montées repérées")
    progress(phases[4], 1.0, "données du spectacle prêtes")

    return AnalysisResult(
        duration=round(duration, 3),
        tempo=round(tempo, 3),
        meter=meter,
        beats=beats,
        onsets=onsets,
        energy=energy_points,
        bass=curve_to_points(frame_times, bass, settings.curve_rate_hz, duration),
        mid=curve_to_points(frame_times, mid, settings.curve_rate_hz, duration),
        mid_low=curve_to_points(frame_times, mid_low, settings.curve_rate_hz, duration),
        mid_high=curve_to_points(frame_times, mid_high, settings.curve_rate_hz, duration),
        high=curve_to_points(frame_times, high, settings.curve_rate_hz, duration),
        sections=sections,
        builds=builds,
    )


# ------------------------------------------------------------------ timeout
#
# `ANALYZE_TIMEOUT_SEC` doit être une garantie dure : un fichier pathologique
# (STFT énorme, décodage ffmpeg bloqué) ne doit pas immobiliser un worker pour
# toujours. Un thread ne peut pas être interrompu au milieu de code C (librosa,
# numpy), et signal.alarm n'agit que sur le thread principal — or `run_analysis`
# tourne dans un pool de threads. On exécute donc l'analyse dans un process
# dédié, que l'on peut tuer. Le contexte « spawn » évite d'hériter des verrous
# d'un serveur multi-thread ; le coût de démarrage est le prix de la garantie.


def _analysis_worker(
    messages: Any,
    path: str,
    settings: Settings,
) -> None:
    """Point d'entrée du process d'analyse : renvoie le résultat par la queue."""

    def report(message: str, progress: float) -> None:
        # Un client parti ne doit pas tuer l'analyse.
        with contextlib.suppress(Exception):
            messages.put(("progress", message, float(progress)))

    try:
        result = analyze_file(Path(path), settings, report=report)
        messages.put(("done", result))
    except AnalysisError as error:
        messages.put(("analysis_error", error.code, error.message, error.detail))
    except BaseException as error:  # noqa: BLE001 - on remonte une erreur lisible
        messages.put(("crash", type(error).__name__, str(error)[:300]))


def analyze_with_timeout(
    path: Path,
    settings: Settings,
    report: Callable[[str, float], None] | None = None,
    timeout_sec: float | None = None,
) -> AnalysisResult:
    """`analyze_file` avec une limite de temps dure.

    Lève `AnalysisError("timeout")` si l'analyse dépasse la limite (par défaut
    `settings.analyze_timeout_sec`) ; le process est alors tué, sans laisser de
    worker bloqué. Une limite nulle ou négative désactive le garde-fou et exécute
    l'analyse en direct.
    """
    limit = settings.analyze_timeout_sec if timeout_sec is None else timeout_sec
    if limit is None or limit <= 0:
        return analyze_file(path, settings, report=report)

    context = multiprocessing.get_context("spawn")
    messages = context.Queue()
    process = context.Process(
        target=_analysis_worker,
        args=(messages, str(Path(path).resolve()), settings),
        name="night-light-analysis",
        daemon=True,
    )
    process.start()
    deadline = time.monotonic() + limit
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AnalysisError(
                    "timeout",
                    f"L'analyse a dépassé la limite de {limit:.0f} s.",
                    "Morceau trop complexe ou fichier illisible : réessaie avec un "
                    "fichier plus court, ou augmente ANALYZE_TIMEOUT_SEC.",
                )
            try:
                event = messages.get(timeout=min(remaining, 0.25))
            except queue_module.Empty:
                if not process.is_alive() and messages.empty():
                    raise AnalysisError(
                        "analysis_failed",
                        "L'analyse du morceau a échoué.",
                        "Le process d'analyse s'est arrêté sans résultat "
                        f"(code {process.exitcode}).",
                    ) from None
                continue

            kind = event[0]
            if kind == "progress":
                if report is not None:
                    report(event[1], event[2])
            elif kind == "done":
                return event[1]
            elif kind == "analysis_error":
                raise AnalysisError(event[1], event[2], event[3])
            else:
                raise AnalysisError(
                    "analysis_failed",
                    "L'analyse du morceau a échoué.",
                    f"{event[1]}: {event[2]}",
                )
    finally:
        if process.is_alive():
            process.terminate()
        process.join(timeout=5.0)
        if process.is_alive():
            process.kill()
            process.join(timeout=1.0)
        messages.close()
        messages.join_thread()
