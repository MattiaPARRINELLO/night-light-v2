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
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import librosa
import numpy as np
import soundfile as sf

from .config import Settings
from .structure import align_builds_to_drops, detect_structure

SR_DEFAULT = 22050
HOP = 512
NFFT = 2048
# Version du résultat d'analyse. À incrémenter dès que l'algorithme change :
# le cache d'analyse est indexé dessus, donc les entrées périmées sont ignorées.
ANALYZER_VERSION = "7"
# Retard de groupe d'une STFT : le pic de flux spectral précède le transitoire
# d'environ n_fft/2 échantillons. On le corrige explicitement.
GROUP_DELAY_SEC = (NFFT / 2) / SR_DEFAULT

# Métrique : un pic d'autocorrélation ternaire doit dépasser ce seuil, et
# devancer le pic binaire de cette marge, pour renverser la préférence 4/4.
TERNARY_MIN_PEAK = 0.02
TERNARY_MARGIN = 0.02


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
    drops: list[dict] = field(default_factory=list)
    coverage: tuple[float, float] | None = None
    phase_timings: dict[str, float] = field(default_factory=dict)


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


def load_audio(
    path: Path,
    sample_rate: int,
    *,
    offset: float = 0.0,
    duration: float | None = None,
    timings: dict[str, float] | None = None,
) -> np.ndarray:
    offset = max(0.0, offset)
    started = time.monotonic()
    try:
        # Décodage direct via libsndfile (MP3/FLAC/WAV/OGG), puis
        # rééchantillonnage séparé : on mesure les deux coûts distinctement.
        with sf.SoundFile(path) as stream:
            source_sr = int(stream.samplerate)
            if offset > 0:
                stream.seek(int(offset * source_sr))
            frames = -1 if duration is None else int(duration * source_sr)
            data = stream.read(frames=frames, dtype="float32", always_2d=True)
        decode_sec = time.monotonic() - started
        if data.ndim == 2 and data.shape[1] > 1:
            data = data.mean(axis=1)
        audio = np.asarray(data, dtype=np.float32).reshape(-1)
        resample_started = time.monotonic()
        if source_sr != sample_rate and audio.size > 0:
            audio = librosa.resample(
                audio,
                orig_sr=source_sr,
                target_sr=sample_rate,
                res_type="soxr_hq",
            )
        if timings is not None:
            timings["decodeSec"] = round(decode_sec, 3)
            timings["resampleSec"] = round(time.monotonic() - resample_started, 3)
        return audio
    except Exception as direct:  # noqa: BLE001 - on tente le repli ffmpeg
        fallback_started = time.monotonic()
        fallback = decode_with_ffmpeg(path, sample_rate)
        if fallback is not None and fallback.size > 0:
            start = int(offset * sample_rate)
            end = None if duration is None else start + int(duration * sample_rate)
            if timings is not None:
                timings["decodeSec"] = round(time.monotonic() - fallback_started, 3)
                timings["resampleSec"] = 0.0
            return fallback[start:end]
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


def sanitize_curve(values: np.ndarray) -> np.ndarray:
    """Remplace NaN/inf par des valeurs finies avant toute sérialisation.

    Une courbe ne doit jamais transporter de NaN jusqu'au front : une seule
    valeur non finie contamine les sommes, les comparaisons et le rendu. On
    ramène les NaN à 0 et les infinis dans `[0, 1]` — une énergie infinie n'a
    pas de sens, mais elle ne doit pas casser le spectacle pour autant.
    """
    if values.size == 0:
        return values
    return np.nan_to_num(values, nan=0.0, posinf=1.0, neginf=0.0)


def normalize_curve(
    values: np.ndarray,
    floor_q: float = 0.35,
    ceil_q: float = 0.985,
    gamma: float = 0.85,
) -> np.ndarray:
    """Normalisation robuste par quantiles, puis compression douce."""
    values = sanitize_curve(values)
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
    return sanitize_curve(np.power(out, gamma))


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
    values = sanitize_curve(values)
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
    return sanitize_curve(np.clip((log - low) / (high - low), floor, 1.0))


def curve_to_points(
    times: np.ndarray,
    values: np.ndarray,
    rate_hz: float,
    duration: float,
) -> list[list[float]]:
    """Rééchantillonne une courbe à cadence fixe et la sérialise."""
    if values.size == 0 or duration <= 0 or not np.isfinite(duration):
        return []
    values = sanitize_curve(values)
    times = sanitize_curve(times)
    step = 1.0 / max(rate_hz, 1.0)
    grid = np.arange(0.0, duration + step * 0.5, step)
    resampled = np.interp(grid, times, values, left=0.0, right=0.0)
    resampled = _smooth(np.clip(resampled, 0.0, 1.0), 0.14, rate_hz)
    resampled = sanitize_curve(resampled)
    return [
        [round(float(t), 3), round(float(v), 2)]
        for t, v in zip(grid, np.clip(resampled, 0.0, 1.0), strict=False)
    ]


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

    On mesure la périodicité de l'enveloppe d'attaques à l'échelle de la
    mesure : le lag d'une mesure vaut ``m`` pulsations. Un vrai 3/4 produit un
    pic d'autocorrélation à 3 (et 6) pulsations, un 4/4 à 4 (et 8).

    Trois précautions, chacune corrige une erreur observée sur le corpus réel :

    1. **Fenêtres glissantes.** L'autocorrélation globale est détruite par la
       dérive du tempo (un morceau de 13 min cumule plusieurs secondes de
       décalage). On médiane des fenêtres de 8 s, insensibles à la dérive.
    2. **Pic local, pas valeur brute.** L'autocorrélation décroît naturellement
       avec le lag : comparer 3 à 4 avantagerait toujours 3. On mesure l'excédent
       du lag par rapport à la moyenne de ses deux voisins.
    3. **Préférence binaire forte.** Sans pic ternaire net, on garde 4 : un 4/4
       lu en 3/4 décale toute la dramaturgie, l'inverse est moins visible.
    """
    if tempo <= 0 or onset_env.size == 0:
        return 4
    beat_frames = (60.0 / tempo) * (sr / float(hop_length))
    if not np.isfinite(beat_frames) or beat_frames < 2.0:
        return 4
    # On ne garde que les lags utiles (1 à 8 mesures) et on borne à la taille
    # de l'enveloppe : un morceau court ne doit pas produire de pic fantôme.
    lags = {m: int(round(m * beat_frames)) for m in range(1, 9)}
    if lags[8] >= onset_env.size // 2:
        # Pas assez de recul pour juger 8 pulsations ; on juge sur 3 et 4 seuls.
        lags = {m: lag for m, lag in lags.items() if m <= 4}
        if lags[4] >= onset_env.size // 2:
            return 4

    envelope = np.asarray(onset_env, dtype=float)
    envelope = envelope - float(np.mean(envelope))
    window = int(min(max(beat_frames * 8.0, 64.0), max(envelope.size, 1)))
    step = max(1, window // 2)
    autocorrelations: dict[int, list[float]] = {m: [] for m in lags}
    for start in range(0, max(1, envelope.size - window) + 1, step):
        chunk = envelope[start : start + window]
        total = float(np.sum(chunk**2))
        if total <= 1e-9:
            continue
        for meter, lag in lags.items():
            if lag <= 0 or lag >= chunk.size:
                continue
            autocorrelations[meter].append(float(np.dot(chunk[:-lag], chunk[lag:])) / total)
    values = {
        meter: float(np.median(samples)) if samples else 0.0
        for meter, samples in autocorrelations.items()
    }

    def peak(meter: int) -> float:
        """Excédent du lag de mesure par rapport à ses deux voisins."""
        previous = values.get(meter - 1)
        following = values.get(meter + 1)
        neighbours = [value for value in (previous, following) if value is not None]
        if not neighbours:
            return 0.0
        return values.get(meter, 0.0) - float(np.mean(neighbours))

    ternary = max(peak(3), peak(6))
    binary = max(peak(4), peak(8))
    if ternary >= TERNARY_MIN_PEAK and ternary >= binary + TERNARY_MARGIN:
        return 3
    return 4


def detect_rhythm(
    y: np.ndarray,
    sr: int,
    report: ProgressFn,
    phase: Phase,
    timings: dict[str, float] | None = None,
) -> tuple[float, list[float], list[float], int]:
    report(phase, 0.1, "Enveloppe des attaques")
    started = time.monotonic()
    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP)
    if timings is not None:
        timings["onsetSec"] = round(time.monotonic() - started, 3)
    report(phase, 0.5, "Estimation du tempo")
    started = time.monotonic()
    tempo, beat_frames = librosa.beat.beat_track(
        onset_envelope=onset_env,
        sr=sr,
        hop_length=HOP,
        trim=False,
    )
    if timings is not None:
        timings["beatTrackSec"] = round(time.monotonic() - started, 3)
    tempo_value = float(np.atleast_1d(np.asarray(tempo, dtype=float))[0])
    # Pourquoi 117,5 BPM revient sur plusieurs titres : `beat_track` choisit son
    # tempo dans une grille logarithmique de 384 valeurs (30–300 BPM). Le pas
    # vaut ~5,6 BPM autour de 120, et 117.45383522727273 est exactement le
    # point 22 de cette grille (librosa.tempo_frequencies). Ce n'est ni un
    # défaut ni un plafond : c'est la résolution de la grille, et la valeur
    # affichée est le point le plus proche du tempo réel (mesuré à 117,4-117,7
    # sur l'intervalle médian entre temps forts). On garde donc la valeur du
    # tracker, qui pilote correctement la grille de temps ; la documenter vaut
    # mieux que la bricoler avec un arrondi qui casserait l'alignement.
    # `NaN <= 0` est faux : sans le test de finitude, un tempo NaN traversait
    # toute l'analyse et faisait dériver la grille de repli jusqu'au rendu.
    if not np.isfinite(tempo_value) or tempo_value <= 0:
        tempo_value = 120.0
    report(phase, 0.8, "Temps forts et attaques")
    started = time.monotonic()
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
    if timings is not None:
        timings["onsetsSec"] = round(time.monotonic() - started, 3)
    unique_beats = sorted({round(float(b), 3) for b in beats if np.isfinite(b)})
    unique_onsets = sorted({round(float(o), 3) for o in onsets if np.isfinite(o)})
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
    if not np.isfinite(mean_energy):
        mean_energy = 0.0
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


# ------------------------------------------------------------- seuils d'impact
#
# Un impact n'est pas « une énergie qui monte » : c'est un changement durable
# d'état. Les seuils ci-dessous ont été calibrés sur le corpus réel (voir
# tools/build_diagnostic.py) pour supprimer les fausses montées — notamment les
# nuances d'un piano seul — sans relever globalement les seuils historiques.
BUILD_MIN_SPAN = 2.0
BUILD_MAX_SPAN = 30.0
BUILD_MIN_STRENGTH = 0.30
# Énergie gagnée entre le début de la montée et le plateau qui la suit.
BUILD_MIN_RISE = 0.20
# Plateau rapporté au niveau de référence (20 s avant la montée) : le gain doit
# être relatif à la dynamique du morceau, pas seulement absolu.
BUILD_MIN_RATIO = 1.35
BUILD_MIN_LIFT = 0.12
# Niveau minimal du plateau : une montée qui retombe n'est pas un impact.
BUILD_MIN_AFTER = 0.45
# Arrivée des basses : sans elle, une nuance instrumentale (piano, cordes) est
# prise pour un impact. C'est le critère qui supprime les faux impacts calmes.
BUILD_MIN_BASS_GAIN = 0.12
# Branche « retour de basse » : un climax orchestral peut déjà être au maximum
# d'énergie avant l'impact ; la basse qui double et s'installe en est la preuve.
BUILD_BASS_ONLY_GAIN = 0.20
BUILD_BASS_ONLY_RATIO = 2.0
# Un contraste d'énergie écrasant (orchestre qui éclate, sans contenu basse
# mesurable) suffit à prouver l'impact sans arrivée de basses.
BUILD_STRONG_RATIO = 2.5
BUILD_STRONG_LIFT = 0.30
# Rampe longue et régulière : le pic de pente tombe tôt, l'impact est l'arrivée
# sur le plateau (c'est le cas de la piste synthétique à 90 BPM).
BUILD_LONG_RUN = 4.0
BUILD_SHORT_MERGE_GAP = 1.5


def _window_mean(times: np.ndarray, values: np.ndarray, start: float, end: float) -> float:
    """Moyenne d'une courbe sur [start, end), interpolée si la fenêtre est vide."""
    window = (times >= start) & (times < end)
    if not window.any():
        return float(np.interp(start, times, values))
    return float(np.mean(values[window]))


def detect_builds(
    energy_points: list[list[float]],
    duration: float,
    onsets: list[float] | None = None,
    bass_points: list[list[float]] | None = None,
) -> list[dict]:
    """Montées d'énergie suivies d'un impact réel.

    Le pipeline conserve la détection historique des segments montants (pente
    lissée, recalage sur l'attaque, cut éventuel) — c'est elle qui place
    correctement les impacts existants. La correction porte sur la
    **recevabilité** : un segment montant n'est retenu que si le plateau qui le
    suit change durablement l'état du morceau (gain relatif, énergie tenue,
    arrivée des basses ou contraste écrasant).
    """
    if len(energy_points) < 8:
        return []
    times = np.array([point[0] for point in energy_points], dtype=float)
    values = sanitize_curve(np.array([point[1] for point in energy_points], dtype=float))
    if not np.all(np.isfinite(times)) or times.size < 2:
        return []
    if bass_points:
        bass_times = np.array([point[0] for point in bass_points], dtype=float)
        bass_values = sanitize_curve(np.array([point[1] for point in bass_points], dtype=float))
    else:
        bass_times = times
        bass_values = np.zeros_like(values)
    has_bass = bool(bass_points)

    rate = 1.0 / max(float(np.median(np.diff(times))) if times.size > 1 else 0.05, 1e-3)
    smooth = _smooth(values, min(2.0, max(0.5, duration / 6.0)), rate)
    if values.size < 3:
        return []
    gradient = np.gradient(smooth) * rate
    window = max(1, int(min(4.0, max(1.0, duration / 4.0)) * rate))
    derivative = np.convolve(gradient, np.ones(window) / window, mode="same")
    rising = derivative > 0.01

    # 1. Segments montants, avec le placement historique de l'impact.
    candidates: list[dict] = []
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
        run_end = float(times[min(end_index, len(times) - 1)])
        peak_slice = values[start_index : min(start_index + int(6 * rate), len(values))]
        strength = float(np.max(peak_slice)) if peak_slice.size > 0 else 0.0
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
                # On recale sur l'attaque réelle : c'est elle que l'oreille entend.
                end = _snap_to_onset(float(times[crest_index]), onsets)
                if end - start < BUILD_MIN_SPAN and run_end - start >= BUILD_LONG_RUN:
                    # Rampe régulière : le maximum de pente tombe tôt. L'impact
                    # est l'arrivée sur le plateau, pas le point le plus raide.
                    plateau_peak = float(
                        np.max(
                            smooth[
                                start_index : min(start_index + int(max(6 * rate, 1)), smooth.size)
                            ]
                        )
                    )
                    floor = float(smooth[start_index])
                    target = floor + 0.9 * max(plateau_peak - floor, 0.0)
                    reached = np.nonzero(
                        smooth[start_index : min(end_index + 1, smooth.size)] >= target
                    )[0]
                    if reached.size:
                        plateau_index = min(start_index + int(reached[-1]), len(times) - 1)
                        end = _snap_to_onset(float(times[plateau_index]), onsets)
        else:
            end = run_end
        strength = float(np.nan_to_num(strength, nan=0.0, posinf=1.0, neginf=0.0))
        if not np.isfinite(start) or not np.isfinite(end):
            index = end_index + 1
            continue
        candidates.append(
            {
                "start": start,
                "end": end,
                "start_index": start_index,
                "strength": strength,
            }
        )
        index = end_index + 1

    # 2. Un climax peut être haché en plusieurs montées courtes (cuivres, tous
    #    les pupitres) : on recolle deux montées courtes séparées de moins de
    #    1,5 s. On ne recolle jamais une montée déjà valide, pour ne pas déplacer
    #    les impacts existants.
    coalesced: list[dict] = []
    for candidate in candidates:
        if (
            coalesced
            and candidate["start"] - coalesced[-1]["end"] <= BUILD_SHORT_MERGE_GAP
            and coalesced[-1]["end"] - coalesced[-1]["start"] < BUILD_MIN_SPAN
            and candidate["end"] - candidate["start"] < BUILD_MIN_SPAN
        ):
            coalesced[-1]["end"] = max(coalesced[-1]["end"], candidate["end"])
            coalesced[-1]["strength"] = max(coalesced[-1]["strength"], candidate["strength"])
        else:
            coalesced.append(dict(candidate))

    # 3. Recevabilité : le plateau doit changer durablement l'état du morceau.
    builds: list[dict] = []
    for candidate in coalesced:
        start = float(candidate["start"])
        end = float(candidate["end"])
        span = end - start
        if not (BUILD_MIN_SPAN <= span <= BUILD_MAX_SPAN):
            continue
        if candidate["strength"] <= BUILD_MIN_STRENGTH:
            continue
        start_index = int(candidate["start_index"])
        base = _window_mean(times, smooth, max(0.0, start - 24.0), max(0.0, start - 4.0))
        after = _window_mean(times, smooth, end, min(duration, end + 8.0))
        rise = after - float(smooth[start_index])
        ratio = after / max(base, 0.05)
        lift = after - base
        before_bass = _window_mean(bass_times, bass_values, max(0.0, start - 4.0), start)
        after_bass = _window_mean(bass_times, bass_values, end, min(duration, end + 8.0))
        bass_gain = after_bass - before_bass
        energy_arrival = (
            rise >= BUILD_MIN_RISE
            and ratio >= BUILD_MIN_RATIO
            and lift >= BUILD_MIN_LIFT
            and after >= BUILD_MIN_AFTER
            and (bass_gain >= BUILD_MIN_BASS_GAIN or not has_bass)
        )
        bass_arrival = has_bass and (
            bass_gain >= BUILD_BASS_ONLY_GAIN
            and after_bass >= BUILD_BASS_ONLY_RATIO * max(before_bass, 0.02)
            and after >= BUILD_MIN_AFTER
        )
        # Contraste d'énergie sans ambiguïté : la basse n'est pas nécessaire.
        strong_arrival = (
            rise >= BUILD_MIN_RISE
            and ratio >= BUILD_STRONG_RATIO
            and lift >= BUILD_STRONG_LIFT
            and after >= BUILD_MIN_AFTER
        )
        if not (energy_arrival or bass_arrival or strong_arrival):
            continue
        builds.append(
            {
                "start": round(start, 3),
                "end": round(min(end, duration), 3),
                "strength": round(float(np.clip(candidate["strength"], 0.0, 1.0)), 3),
                "source": "rise",
            }
        )

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
    window: tuple[float, float] | None = None,
    should_cancel: Callable[[float], bool] | None = None,
) -> AnalysisResult:
    """Analyse complète, ou rapide sur `window = (début, fin)` en secondes.

    Une analyse fenêtrée renvoie `coverage` et une grille de beats extrapolée sur
    tout le morceau : le show peut démarrer immédiatement, puis être remplacé par
    l'analyse complète. `should_cancel(progress)` est consulté aux étapes clés.
    """

    def emit(message: str, value: float) -> None:
        if report is not None:
            report(message, float(min(max(value, 0.0), 1.0)))

    def check_cancel(progress: float) -> None:
        if should_cancel is not None and should_cancel(progress):
            raise AnalysisError(
                "cancelled",
                "Analyse abandonnée : le lecteur est passé à un autre morceau.",
                "",
            )

    phase_timings: dict[str, float] = {}

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
    offset = max(0.0, float(window[0])) if window is not None else 0.0
    window_span = max(1.0, float(window[1]) - offset) if window is not None else None
    emit("Décodage du fichier audio", 0.0)
    check_cancel(0.0)
    y = load_audio(
        path,
        sample_rate,
        offset=offset,
        duration=window_span,
        timings=phase_timings,
    )
    duration = float(len(y) / sample_rate) if sample_rate > 0 else 0.0
    check_cancel(0.1)

    if duration < 1.0:
        raise AnalysisError(
            "too_short",
            "Le morceau est trop court (moins d'une seconde) pour être analysé.",
        )
    if window is None:
        full_duration = duration
    else:
        try:
            full_duration = float(librosa.get_duration(path=path))
        except Exception:  # noqa: BLE001 - repli raisonnable
            full_duration = offset + duration
        full_duration = max(full_duration, offset + duration)
    if full_duration > settings.max_duration_sec:
        raise AnalysisError(
            "too_long",
            f"Morceau trop long ({full_duration / 60:.1f} min). Limite : "
            f"{settings.max_duration_sec / 60:.0f} min.",
        )

    spectrum_started = time.monotonic()
    spectrum = np.abs(librosa.stft(y, n_fft=NFFT, hop_length=HOP))
    phase_timings["stftSec"] = round(time.monotonic() - spectrum_started, 3)
    check_cancel(0.3)
    frequencies = librosa.fft_frequencies(sr=sample_rate, n_fft=NFFT)
    frame_times = librosa.frames_to_time(
        np.arange(spectrum.shape[1]), sr=sample_rate, hop_length=HOP
    )
    frame_rate = sample_rate / float(HOP)

    # Lissage large : sans lui les courbes servent le battement du morceau et
    # feraient clignoter les effets au lieu de suivre son énergie.
    features_started = time.monotonic()
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
    phase_timings["featuresSec"] = round(time.monotonic() - features_started, 3)

    tempo, beats, onsets, meter = detect_rhythm(
        y, sample_rate, progress, phases[2], timings=phase_timings
    )
    check_cancel(0.7)

    coverage: tuple[float, float] | None = None
    if window is not None:
        coverage = (round(offset, 3), round(min(full_duration, offset + duration), 3))
        beats = [round(float(beat) + offset, 3) for beat in beats]
        onsets = [round(float(onset) + offset, 3) for onset in onsets]
        frame_times = frame_times + offset
        # Hors fenêtre, la grille de beats est extrapolée avec le tempo trouvé :
        # le rendu live peut pulser correctement en attendant l'analyse finale.
        period = 60.0 / tempo if tempo > 0 else 0.0
        if period > 0.05 and beats:
            anchor = beats[0]
            first = int(np.floor((0.0 - anchor) / period))
            last = int(np.ceil((full_duration - anchor) / period))
            extrapolated = [anchor + index * period for index in range(first, last + 1)]
            beats = sorted(
                {
                    round(float(beat), 3)
                    for beat in [*beats, *extrapolated]
                    if 0.0 <= float(beat) <= full_duration
                }
            )

    # Structure locale : sections, refrains (reprise de production ou
    # répétition contrastée) et drops.
    curves_started = time.monotonic()
    energy_points = curve_to_points(frame_times, energy, settings.curve_rate_hz, full_duration)
    bass_points = curve_to_points(frame_times, bass, settings.curve_rate_hz, full_duration)
    mid_points = curve_to_points(frame_times, mid, settings.curve_rate_hz, full_duration)
    mid_low_points = curve_to_points(frame_times, mid_low, settings.curve_rate_hz, full_duration)
    mid_high_points = curve_to_points(frame_times, mid_high, settings.curve_rate_hz, full_duration)
    high_points = curve_to_points(frame_times, high, settings.curve_rate_hz, full_duration)
    phase_timings["curvesSec"] = round(time.monotonic() - curves_started, 3)
    progress(phases[3], 0.5, "détection des montées")
    builds_started = time.monotonic()
    builds = detect_builds(energy_points, full_duration, onsets, bass_points)
    phase_timings["buildsSec"] = round(time.monotonic() - builds_started, 3)
    check_cancel(0.9)
    progress(phases[3], 1.0, f"{len(builds)} montées repérées")

    # Structure locale : chroma + timbre pour les blocs qui se répètent, et
    # reprises de production recalées sur le premier temps fort du retour.
    structure_started = time.monotonic()
    chroma = librosa.feature.chroma_stft(S=spectrum, sr=sample_rate, hop_length=HOP)
    mfcc = librosa.feature.mfcc(S=librosa.power_to_db(spectrum**2 + 1e-10), n_mfcc=13)
    structure = detect_structure(
        energy_points,
        bass_points,
        frame_times,
        energy,
        bass,
        np.asarray(beats, dtype=float),
        np.asarray(onsets, dtype=float),
        chroma,
        mfcc,
        full_duration,
    )
    phase_timings["structureSec"] = round(time.monotonic() - structure_started, 3)
    sections = structure.sections or detect_sections(energy, frame_times, full_duration)
    drops = structure.drops
    # Une montée qui se terminait sur le retour des voix est prolongée jusqu'au
    # drop : le flash naît sur l'impact, pas sur la fin de la montée.
    builds = align_builds_to_drops(builds, drops)
    progress(phases[3], 1.0, f"{len(drops)} reprises repérées")
    progress(phases[4], 1.0, "données du spectacle prêtes")
    phase_timings["mfccChromaSec"] = phase_timings["structureSec"]

    return AnalysisResult(
        duration=round(full_duration, 3),
        tempo=round(tempo, 3),
        meter=meter,
        beats=beats,
        onsets=onsets,
        energy=energy_points,
        bass=bass_points,
        mid=mid_points,
        mid_low=mid_low_points,
        mid_high=mid_high_points,
        high=high_points,
        sections=sections,
        builds=builds,
        drops=drops,
        coverage=coverage,
        phase_timings=phase_timings,
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
    window: tuple[float, float] | None = None,
) -> None:
    """Point d'entrée du process d'analyse : renvoie le résultat par la queue."""

    def report(message: str, progress: float) -> None:
        # Un client parti ne doit pas tuer l'analyse.
        with contextlib.suppress(Exception):
            messages.put(("progress", message, float(progress)))

    try:
        messages.put(("started", time.monotonic()))
        result = analyze_file(Path(path), settings, report=report, window=window)
        messages.put(("done", result))
    except AnalysisError as error:
        messages.put(("analysis_error", error.code, error.message, error.detail))
    except BaseException as error:  # noqa: BLE001 - on remonte une erreur lisible
        messages.put(("crash", type(error).__name__, str(error)[:300]))


def _persistent_worker(
    tasks: Any,
    events: Any,
) -> None:
    """Processus d'analyse persistant : préchauffé une fois, puis réutilisé."""
    with contextlib.suppress(Exception):
        warmup()
    events.put(("ready", time.monotonic()))
    while True:
        task = tasks.get()
        if task is None:
            return
        task_id, path, settings, window, with_cancel = task

        def report(message: str, progress: float, tid: int = task_id) -> None:
            with contextlib.suppress(Exception):
                events.put(("progress", tid, message, float(progress)))

        # L'annulation se fait en tuant ce processus : `with_cancel` n'est là
        # que pour documenter le contrat et reste utilisé côté parent.
        try:
            result = analyze_file(
                Path(path),
                settings,
                report=report,
                window=window,
                should_cancel=(lambda _progress: False) if with_cancel else None,
            )
            events.put(("done", task_id, result))
        except AnalysisError as error:
            events.put(("analysis_error", task_id, error.code, error.message, error.detail))
        except BaseException as error:  # noqa: BLE001
            events.put(("crash", task_id, type(error).__name__, str(error)[:300]))


class _EngineUnavailable(Exception):
    pass


class PersistentAnalysis:
    """Un seul process d'analyse, gardé chaud entre les morceaux.

    Il porte le JIT numba et les imports une seule fois. Une annulation tue le
    process puis en relance un immédiatement, déjà préchauffé.
    """

    def __init__(self) -> None:
        self._context = multiprocessing.get_context("spawn")
        self._lock = threading.Lock()
        self._tasks: Any = None
        self._events: Any = None
        self._process: Any = None
        self._next_id = 0
        self._ready_sec = 0.0
        self._ready_pending = False
        self._spawn_started = 0.0

    def _spawn(self, *, wait_ready: bool = True) -> None:
        self._tasks = self._context.Queue()
        self._events = self._context.Queue()
        process = self._context.Process(
            target=_persistent_worker,
            args=(self._tasks, self._events),
            name="night-light-analysis-persistent",
            daemon=True,
        )
        self._spawn_started = time.monotonic()
        process.start()
        self._process = process
        self._ready_pending = True
        if wait_ready:
            self._await_ready()

    def _await_ready(self) -> None:
        process = self._process
        if process is None:
            raise _EngineUnavailable("aucun process d'analyse")
        deadline = time.monotonic() + 30.0
        while time.monotonic() < deadline:
            try:
                event = self._events.get(timeout=0.2)
            except queue_module.Empty:
                if not process.is_alive():
                    self._ready_pending = False
                    raise _EngineUnavailable(
                        "le process d'analyse s'est arrêté au démarrage"
                    ) from None
                continue
            if event[0] == "ready":
                self._ready_sec = round(float(event[1]) - self._spawn_started, 3)
                self._ready_pending = False
                return
        self._ready_pending = False
        self._kill()
        raise _EngineUnavailable("le process d'analyse n'a pas fini son préchauffage")

    def _kill(self) -> None:
        process = self._process
        self._process = None
        if process is None:
            return
        if process.is_alive():
            process.terminate()
        with contextlib.suppress(Exception):
            process.join(timeout=2.0)
        if process.is_alive():
            process.kill()
            process.join(timeout=1.0)

    def _restart(self, *, wait_ready: bool = True) -> None:
        self._kill()
        try:
            self._spawn(wait_ready=wait_ready)
        except _EngineUnavailable:
            raise

    def start(self) -> None:
        with self._lock:
            if self._process is not None and self._process.is_alive():
                if self._ready_pending:
                    self._await_ready()
                return
            self._spawn()

    def stop(self) -> None:
        with self._lock:
            if self._tasks is not None:
                with contextlib.suppress(Exception):
                    self._tasks.put(None)
            self._kill()

    def analyze(
        self,
        path: Path,
        settings: Settings,
        report: Callable[[str, float], None] | None = None,
        timeout_sec: float | None = None,
        should_cancel: Callable[[float], bool] | None = None,
        window: tuple[float, float] | None = None,
    ) -> AnalysisResult:
        with self._lock:
            if self._process is None or not self._process.is_alive():
                self._spawn(wait_ready=False)
            if self._ready_pending:
                self._await_ready()
            self._next_id += 1
            task_id = self._next_id
            self._tasks.put(
                (task_id, str(Path(path).resolve()), settings, window, should_cancel is not None)
            )
            limit = settings.analyze_timeout_sec if timeout_sec is None else timeout_sec
            deadline = time.monotonic() + limit if limit and limit > 0 else None
            progress = 0.0
            while True:
                if should_cancel is not None and should_cancel(progress):
                    self._restart(wait_ready=False)
                    raise AnalysisError(
                        "cancelled",
                        "Analyse abandonnée : le lecteur est passé à un autre morceau.",
                        "Le process d'analyse a été tué et relancé préchauffé.",
                    )
                remaining = 1.0 if deadline is None else deadline - time.monotonic()
                if remaining <= 0:
                    self._restart(wait_ready=False)
                    raise AnalysisError(
                        "timeout",
                        f"L'analyse a dépassé la limite de {limit:.0f} s.",
                        "Le process d'analyse a été tué.",
                    )
                try:
                    event = self._events.get(timeout=min(remaining, 0.2))
                except queue_module.Empty:
                    if self._process is None or not self._process.is_alive():
                        self._restart(wait_ready=False)
                        raise AnalysisError(
                            "analysis_failed",
                            "L'analyse du morceau a échoué.",
                            "Le process d'analyse s'est arrêté sans résultat.",
                        ) from None
                    continue
                if event[0] == "progress" and event[1] == task_id:
                    progress = max(progress, float(event[3]))
                    if report is not None:
                        report(event[2], event[3])
                elif event[0] == "done" and event[1] == task_id:
                    result = event[2]
                    result.phase_timings["processStartImportsSec"] = 0.0
                    result.phase_timings["workerWarmupSec"] = self._ready_sec
                    return result
                elif event[0] == "analysis_error" and event[1] == task_id:
                    raise AnalysisError(event[2], event[3], event[4])
                elif event[0] == "crash" and event[1] == task_id:
                    raise AnalysisError(
                        "analysis_failed",
                        "L'analyse du morceau a échoué.",
                        f"{event[2]}: {event[3]}",
                    )


_ENGINE = PersistentAnalysis()


def start_analysis_worker() -> None:
    """Préchauffe le process persistant (appelé au lifespan)."""
    with contextlib.suppress(_EngineUnavailable):
        # Le prochain appel retentera ; l'analyse par process jetable reste possible.
        _ENGINE.start()


def stop_analysis_worker() -> None:
    _ENGINE.stop()


def analyze_with_timeout(
    path: Path,
    settings: Settings,
    report: Callable[[str, float], None] | None = None,
    timeout_sec: float | None = None,
    should_cancel: Callable[[float], bool] | None = None,
    window: tuple[float, float] | None = None,
) -> AnalysisResult:
    """Analyse via le process persistant, tué et relancé en cas d'annulation."""
    try:
        return _ENGINE.analyze(
            path,
            settings,
            report=report,
            timeout_sec=timeout_sec,
            should_cancel=should_cancel,
            window=window,
        )
    except _EngineUnavailable as error:
        raise AnalysisError(
            "analysis_failed",
            "Le process d'analyse n'a pas pu démarrer.",
            str(error)[:300],
        ) from error
