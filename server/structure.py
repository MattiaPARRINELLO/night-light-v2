"""Détection des sections locales d'un morceau (vague 3 — Structure).

Le module ne décide ni du plan de spectacle ni du rendu : il produit une
partition **locale** du morceau (intro, couplet, refrain, pont, silence, outro)
destinée à `sections[]`, avec un groupe de matériau musical et une confiance.

Méthode, dans l'ordre :

1. grille de mesures déduite des temps forts (``beats[::mètre]``) ;
2. chroma et MFCC moyennés par mesure — le chroma décrit l'harmonie, le MFCC
   le timbre ; les deux ensemble distinguent un couplet d'un refrain sur une
   même boucle d'accords ;
3. matrice d'autosimilarité (cosinus chroma + noyau gaussien MFCC) ;
4. nouveauté par noyau en damier (checkerboard) sur la diagonale ;
5. frontières = pics de nouveauté, recalés sur les débuts de mesure, puis
   fusion des sections trop courtes (4 s, 1,5 s pour un silence) ;
6. regroupement agglomératif (liaison moyenne) des sections par similarité ;
7. étiquetage : le groupe répété le plus énergique et le plus cohérent est le
   refrain ; un passage unique et contrasté après un refrain est un pont ;
   l'énergie RMS quasi nulle pendant ≥ 1,5 s est un silence ;
8. confiance par section : netteté de la frontière × cohérence du groupe.

Tout est déterministe : aucune horloge, aucun aléatoire, aucune donnée réseau.
L'audio n'est jamais relu : chroma et MFCC sont calculés depuis le spectre déjà
produit par `analysis.py`.
"""

from __future__ import annotations

import librosa
import numpy as np

# ------------------------------------------------------------------ contrat
KINDS = ("intro", "couplet", "refrain", "pont", "silence", "outro")
MIN_SECTION_SEC = 4.0
MIN_SILENCE_SEC = 1.5

# --------------------------------------------------------------- frontières
# Demi-largeur du noyau en damier, en mesures. 4 mesures de chaque côté = un
# contexte de 8 mesures : assez large pour ignorer un break d'un temps, assez
# court pour ne pas lisser deux couplets consécutifs.
NOVELTY_HALF_BARS = 3
# Un pic doit dépasser moyenne + k·écart-type de la nouveauté du morceau.
NOVELTY_K = 0.7
# Écart minimal entre deux frontières (en mesures) : une section de moins de
# deux mesures est presque toujours une respiration, pas une partie.
MIN_BOUNDARY_BARS = 4

# ---------------------------------------------------------------- similarité
CHROMA_WEIGHT = 0.40
MFCC_WEIGHT = 1.0 - CHROMA_WEIGHT
# Seuil de liaison moyenne pour réunir deux sections dans le même groupe.
GROUP_THRESHOLD = 0.62

# -------------------------------------------------------------------- refrain
# Un refrain doit revenir, être cohérent avec lui-même et dominer en énergie.
REFRAIN_MIN_OCCURRENCES = 2
REFRAIN_MIN_SIMILARITY = 0.60
REFRAIN_MIN_ENERGY_MARGIN = 0.03

# -------------------------------------------------------------------- silence
# Un silence musical tombe sous 2 % de la puissance courante du morceau.
SILENCE_RELATIVE = 0.02
SILENCE_ABSOLUTE = 1e-4


def _bar_grid(beats: list[float], beats_per_bar: int, duration: float) -> np.ndarray:
    """Débuts de mesure, avec repli régulier si la grille de temps est pauvre."""
    bar = beats_per_bar if beats_per_bar in (3, 4) else 4
    valid = sorted({round(float(b), 3) for b in beats if np.isfinite(b) and 0.0 <= b < duration})
    grid = [valid[index] for index in range(0, len(valid), bar)]
    if not grid or grid[0] > 0.75:
        grid.insert(0, 0.0)
    grid = [t for t in grid if t < duration]
    grid.append(round(float(duration), 3))
    if len(grid) < 3:
        # Moins de deux mesures exploitables : grille régulière à défaut.
        period = float(np.median(np.diff(valid))) * bar if len(valid) > 1 else 2.0
        period = max(period, 0.5)
        grid = list(np.arange(0.0, duration, period)) + [float(duration)]
    return np.asarray(sorted(set(grid)), dtype=float)


def _aggregate(feature: np.ndarray, times: np.ndarray, grid: np.ndarray) -> np.ndarray:
    """Moyenne d'une matrice (dimensions × trames) sur chaque mesure."""
    rows: list[np.ndarray] = []
    for start, end in zip(grid[:-1], grid[1:], strict=False):
        window = (times >= start) & (times < end)
        if not window.any():
            index = int(np.clip(np.searchsorted(times, start), 0, times.size - 1))
            rows.append(feature[:, index])
        else:
            rows.append(feature[:, window].mean(axis=1))
    return np.asarray(rows, dtype=float)


def _self_similarity(chroma: np.ndarray, mfcc: np.ndarray) -> np.ndarray:
    """Similarité 0..1 entre mesures : harmonie (cosinus) + timbre (MFCC)."""
    chroma = chroma / np.maximum(np.linalg.norm(chroma, axis=1, keepdims=True), 1e-9)
    mfcc = (mfcc - mfcc.mean(axis=0)) / np.maximum(mfcc.std(axis=0), 1e-9)
    distances = np.sqrt(np.maximum(((mfcc[:, None, :] - mfcc[None, :, :]) ** 2).mean(axis=-1), 0.0))
    finite = distances[distances > 0]
    scale = float(np.median(finite)) if finite.size else 1.0
    scale = max(scale, 1e-3)
    timbre = np.exp(-distances / scale)
    harmony = chroma @ chroma.T
    similarity = CHROMA_WEIGHT * harmony + MFCC_WEIGHT * timbre
    return np.clip(similarity, 0.0, 1.0)


def _checkerboard_novelty(similarity: np.ndarray, half: int) -> np.ndarray:
    """Nouveauté par noyau en damier gaussien (pic = changement de matériau)."""
    size = 2 * half + 1
    positions = np.arange(-half, half + 1, dtype=float)
    taper = np.exp(-0.5 * (positions / max(half / 2.0, 1e-6)) ** 2)
    kernel = np.outer(taper, taper)
    kernel[:half, :] *= -1.0
    kernel[:, :half] *= -1.0
    padded = np.pad(similarity, half, mode="edge")
    novelty = np.array(
        [
            float(np.sum(padded[index : index + size, index : index + size] * kernel))
            for index in range(similarity.shape[0])
        ]
    )
    return novelty


def _pick_boundaries(novelty: np.ndarray, grid: np.ndarray, duration: float) -> list[int]:
    """Indices de mesures qui portent une frontière, du plus net au plus faible."""
    if novelty.size == 0:
        return []
    threshold = float(np.mean(novelty) + NOVELTY_K * np.std(novelty))
    candidates = [
        index
        for index in range(1, novelty.size - 1)
        if novelty[index] >= threshold
        and novelty[index] >= novelty[index - 1]
        and novelty[index] >= novelty[index + 1]
    ]
    candidates.sort(key=lambda index: (-novelty[index], index))
    kept: list[int] = []
    for index in candidates:
        start = float(grid[index])
        if start <= 0.0 or start >= duration:
            continue
        if all(
            abs(start - float(grid[other])) >= MIN_BOUNDARY_BARS * _bar_span(grid) for other in kept
        ):
            kept.append(index)
    return sorted(kept)


def _bar_span(grid: np.ndarray) -> float:
    spans = np.diff(grid)
    spans = spans[spans > 0]
    return float(np.median(spans)) if spans.size else 2.0


def _segments(
    grid: np.ndarray, boundary_indices: list[int], duration: float
) -> list[tuple[float, float]]:
    """Sections provisoires, en respectant les durées minimales du contrat."""
    bounds = [0.0] + [float(grid[index]) for index in boundary_indices] + [float(duration)]
    bounds = sorted({round(value, 3) for value in bounds if 0.0 <= value <= duration})
    bounds[0] = 0.0
    bounds[-1] = round(float(duration), 3)
    merged = [bounds[0]]
    for value in bounds[1:-1]:
        if value - merged[-1] >= MIN_SECTION_SEC and duration - value >= MIN_SECTION_SEC:
            merged.append(value)
    if duration - merged[-1] < MIN_SECTION_SEC and len(merged) > 1:
        merged.pop()
    merged.append(round(float(duration), 3))
    return [(merged[index], merged[index + 1]) for index in range(len(merged) - 1)]


def _segment_features(
    chroma: np.ndarray,
    mfcc: np.ndarray,
    grid: np.ndarray,
    spans: list[tuple[float, float]],
    duration: float,
) -> list[tuple[np.ndarray, np.ndarray]]:
    """Chroma et MFCC moyens d'une section, pondérés par le temps de chaque mesure."""
    features: list[tuple[np.ndarray, np.ndarray]] = []
    bar_starts = grid[:-1]
    bar_ends = grid[1:]
    for start, end in spans:
        weights = np.clip(np.minimum(bar_ends, end) - np.maximum(bar_starts, start), 0.0, None)
        if float(weights.sum()) <= 0.0:
            weights = np.ones_like(weights)
        weights = weights / float(weights.sum())
        features.append((weights @ chroma, weights @ mfcc))
    return features


def _section_distance(
    left: tuple[np.ndarray, np.ndarray], right: tuple[np.ndarray, np.ndarray]
) -> tuple[float, float]:
    """Similarité harmonique (cosinus) et distance timbrale (RMS des MFCC)."""
    left_chroma, left_mfcc = left
    right_chroma, right_mfcc = right
    harmony = float(
        np.dot(left_chroma, right_chroma)
        / max(np.linalg.norm(left_chroma) * np.linalg.norm(right_chroma), 1e-9)
    )
    timbre = float(np.linalg.norm(left_mfcc - right_mfcc) / np.sqrt(left_mfcc.size))
    return harmony, timbre


def _similarity_matrix(
    features: list[tuple[np.ndarray, np.ndarray]],
) -> np.ndarray:
    """Similarité entre sections, calibrée sur la dynamique timbrale du morceau.

    Le chroma seul ne sépare pas un couplet d'un refrain bâti sur la même boucle
    d'accords (cosinus ≈ 1 partout) : c'est le timbre qui tranche. On normalise
    donc la distance MFCC par la distance médiane **entre sections du morceau**,
    pas par celle des trames — deux ordres de grandeur différents.
    """
    count = len(features)
    similarity = np.eye(count)
    if count < 2:
        return similarity
    distances = np.zeros((count, count))
    harmony = np.eye(count)
    for left in range(count):
        for right in range(left + 1, count):
            value, distance = _section_distance(features[left], features[right])
            harmony[left, right] = harmony[right, left] = value
            distances[left, right] = distances[right, left] = distance
    off_diagonal = distances[~np.eye(count, dtype=bool)]
    scale = float(np.median(off_diagonal))
    scale = max(scale * 0.6, 1e-3)
    timbre = np.exp(-distances / scale)
    similarity = CHROMA_WEIGHT * harmony + MFCC_WEIGHT * timbre
    return np.clip(similarity, 0.0, 1.0)


def _cluster(similarity: np.ndarray) -> list[int]:
    """Regroupement agglomératif à liaison moyenne, seuil `GROUP_THRESHOLD`."""
    count = int(similarity.shape[0])
    if count == 0:
        return []
    clusters: list[list[int]] = [[index] for index in range(count)]
    while len(clusters) > 1:
        best_pair: tuple[int, int] | None = None
        best_value = GROUP_THRESHOLD
        for left in range(len(clusters)):
            for right in range(left + 1, len(clusters)):
                value = float(
                    np.mean([similarity[a, b] for a in clusters[left] for b in clusters[right]])
                )
                if value >= best_value:
                    best_value = value
                    best_pair = (left, right)
        if best_pair is None:
            break
        left, right = best_pair
        clusters[left] = sorted(clusters[left] + clusters[right])
        clusters.pop(right)
    clusters.sort(key=lambda cluster: cluster[0])
    labels = [-1] * count
    for label, cluster in enumerate(clusters):
        for index in cluster:
            labels[index] = label
    return labels


def _run_count(members: list[int]) -> int:
    """Nombre de blocs contigus d'un groupe (1 = pas de vrai retour)."""
    if not members:
        return 0
    runs = 1
    for previous, current in zip(members, members[1:], strict=False):
        if current != previous + 1:
            runs += 1
    return runs


def _contrasted_returns(members: list[int], energies: list[float], mean_energy: float) -> bool:
    """Vrai si au moins un retour du groupe suit un vrai contraste d'énergie.

    Un thème qui revient après une simple nuance (fin de « Bolero », où tout
    monte de 0,84 à 0,92) n'est pas un refrain : c'est la même masse sonore qui
    continue. Un couplet, lui, redescend nettement avant que le refrain revienne.
    """
    if len(members) < 2:
        return False
    gaps: list[list[int]] = []
    current: list[int] = [members[0]]
    for previous, current_index in zip(members, members[1:], strict=False):
        if current_index == previous + 1:
            current.append(current_index)
        else:
            gaps.append(current)
            current = [current_index]
    gaps.append(current)
    if len(gaps) < 2:
        return False
    for left, right in zip(gaps, gaps[1:], strict=False):
        if right[0] <= left[-1] + 1:
            continue
        between = energies[left[-1] + 1 : right[0]]
        if between and max(between) <= 0.88 * mean_energy:
            return True
    return False


def _group_coherence(similarity: np.ndarray, labels: list[int]) -> dict[int, float]:
    """Similarité moyenne intra-groupe, 0 pour un groupe d'une seule section."""
    coherence: dict[int, float] = {}
    for label in sorted(set(labels)):
        members = [index for index, value in enumerate(labels) if value == label]
        if len(members) < 2:
            coherence[label] = 0.0
            continue
        pairs = [
            float(similarity[members[i], members[j]])
            for i in range(len(members))
            for j in range(i + 1, len(members))
        ]
        coherence[label] = float(np.mean(pairs)) if pairs else 0.0
    return coherence


def _section_energy(
    energy_times: np.ndarray, energy_values: np.ndarray, start: float, end: float
) -> float:
    window = (energy_times >= start) & (energy_times < end)
    if not window.any():
        return float(np.interp(start, energy_times, energy_values)) if energy_times.size else 0.0
    return float(np.mean(energy_values[window]))


def _silence_spans(
    rms: np.ndarray,
    frame_times: np.ndarray,
    duration: float,
) -> list[tuple[float, float]]:
    """Intervalles où le niveau RMS brut reste quasi nul pendant ≥ 1,5 s.

    On travaille sur le RMS **brut**, pas sur la courbe normalisée : la
    normalisation par quantiles ramène à 0 les 35 % de trames les plus faibles,
    ce qui fabriquerait de faux silences de plusieurs secondes dans un morceau
    continu.
    """
    if rms.size == 0 or frame_times.size != rms.size:
        return []
    level = float(np.quantile(rms, 0.95))
    threshold = max(SILENCE_ABSOLUTE, SILENCE_RELATIVE * level)
    quiet = rms <= threshold
    spans: list[tuple[float, float]] = []
    index = 0
    while index < quiet.size:
        if not quiet[index]:
            index += 1
            continue
        end = index
        while end + 1 < quiet.size and quiet[end + 1]:
            end += 1
        start_sec = float(frame_times[index])
        end_sec = float(frame_times[end]) + _frame_step(frame_times)
        if end_sec - start_sec >= MIN_SILENCE_SEC and start_sec > 0.0 and end_sec < duration:
            spans.append((round(start_sec, 3), round(min(end_sec, duration), 3)))
        index = end + 1
    return sorted(set(spans))


def _frame_step(frame_times: np.ndarray) -> float:
    if frame_times.size < 2:
        return 0.0
    return float(np.median(np.diff(frame_times)))


def _split_on_silences(
    spans: list[tuple[float, float]], silences: list[tuple[float, float]]
) -> list[tuple[float, float]]:
    """Découpe les sections sur les silences ; aucune section ne chevauche un silence."""
    if not silences:
        return list(spans)
    pieces: list[tuple[float, float]] = []
    for start, end in spans:
        cursor = start
        for silence_start, silence_end in silences:
            if silence_end <= cursor or silence_start >= end:
                continue
            if silence_start > cursor:
                pieces.append((cursor, silence_start))
            if not pieces or pieces[-1] != (silence_start, silence_end):
                pieces.append((silence_start, silence_end))
            cursor = max(cursor, silence_end)
        if cursor < end:
            pieces.append((cursor, end))
    cleaned: list[tuple[float, float]] = []
    for piece in sorted(pieces):
        if piece[1] - piece[0] <= 0.0:
            continue
        if cleaned and piece[0] < cleaned[-1][1] - 1e-6:
            piece = (cleaned[-1][1], piece[1])
        if (
            cleaned
            and abs(piece[0] - cleaned[-1][0]) < 1e-6
            and abs(piece[1] - cleaned[-1][1]) < 1e-6
        ):
            continue
        cleaned.append(piece)
    return cleaned


def _label_sections(
    spans: list[tuple[float, float]],
    similarity: np.ndarray,
    labels: list[int],
    coherence: dict[int, float],
    energies: list[float],
    boundaries: dict[int, float],
    silences: list[tuple[float, float]],
) -> list[dict]:
    """Assemble les étiquettes, groupes, occurrences et confiances."""
    count = len(spans)
    kinds = ["couplet"] * count
    groups = [""] * count
    confidence = [0.0] * count

    # Groupes : lettre par ordre de première apparition.
    letters: dict[int, str] = {}
    for index, label in enumerate(labels):
        if label < 0:
            continue
        if label not in letters:
            letters[label] = _group_letter(len(letters))
        groups[index] = letters[label]

    # Silences : étiquette prioritaire.
    silence_flags = [False] * count
    for index, (start, end) in enumerate(spans):
        if any(abs(start - a) < 0.01 and abs(end - b) < 0.01 for a, b in silences):
            kinds[index] = "silence"
            silence_flags[index] = True
            confidence[index] = min(1.0, 0.6 + 0.4 * min((end - start) / 4.0, 1.0))

    usable = [index for index in range(count) if not silence_flags[index]]
    if usable:
        median_energy = float(np.median([energies[index] for index in usable]))
        # Refrain : groupe répété et cohérent, le plus énergique. Il faut au
        # moins deux **retours** distincts : un groupe qui ne fait que prolonger
        # son propre bloc (deux sections voisines) est une évolution continue
        # (fin de « Bolero »), pas un refrain.
        candidates: list[tuple[float, int]] = []
        for label in sorted(set(labels)):
            members = [index for index in usable if labels[index] == label]
            if len(members) < REFRAIN_MIN_OCCURRENCES:
                continue
            # Un refrain **revient** : deux blocs contigus ne sont qu'une seule
            # occurrence (sinon les deux phrases d'un même thème de Gymnopédie
            # deviennent un refrain).
            if _run_count(members) < REFRAIN_MIN_OCCURRENCES:
                continue
            if coherence.get(label, 0.0) < REFRAIN_MIN_SIMILARITY:
                continue
            mean_energy = float(np.mean([energies[index] for index in members]))
            if mean_energy < median_energy + REFRAIN_MIN_ENERGY_MARGIN:
                continue
            if not _contrasted_returns(members, energies, mean_energy):
                continue
            score = mean_energy + 0.15 * coherence[label] + 0.02 * np.log(len(members))
            candidates.append((float(score), label))
        refrain_label = max(candidates)[1] if candidates else -1
        refrain_indices = [index for index in usable if labels[index] == refrain_label]

        for index in usable:
            kinds[index] = "couplet"

        # Refrain.
        for index in refrain_indices:
            kinds[index] = "refrain"

        # Pont : section unique, immédiatement après un refrain, contrastée.
        for index in usable:
            if kinds[index] != "couplet" or index == 0:
                continue
            if kinds[index - 1] != "refrain":
                continue
            if labels[index] >= 0 and labels[index] == refrain_label:
                continue
            if groups[index] != "" and labels.count(labels[index]) > 1:
                continue
            if (
                refrain_indices
                and float(np.mean([similarity[index, other] for other in refrain_indices])) < 0.6
            ):
                kinds[index] = "pont"

        # Intro : uniquement la première section, discrète et distincte.
        first = usable[0]
        if (
            first == 0
            and kinds[first] == "couplet"
            and labels[first] != refrain_label
            and energies[first] < median_energy
        ):
            kinds[first] = "intro"

        # Outro : uniquement la dernière section, discrète et distincte.
        last = usable[-1]
        if (
            last == count - 1
            and kinds[last] == "couplet"
            and labels[last] != refrain_label
            and energies[last] < median_energy
        ):
            kinds[last] = "outro"

        # Confidence : netteté de la frontière d'entrée × cohérence du groupe.
        for index in usable:
            sharpness = boundaries.get(index, 0.0)
            coherence_value = coherence.get(labels[index], 0.0) if labels[index] >= 0 else 0.0
            if kinds[index] == "couplet":
                base = 0.35 + 0.30 * sharpness + 0.20 * coherence_value
            elif kinds[index] == "refrain":
                base = 0.50 + 0.30 * sharpness + 0.30 * coherence_value
            elif kinds[index] == "pont":
                base = 0.40 + 0.30 * sharpness
            else:
                base = 0.30 + 0.30 * sharpness
            if index == 0:
                base = min(base + 0.15, 0.9)
            confidence[index] = float(np.clip(base, 0.0, 1.0))

    occurrences: dict[str, int] = {}
    sections: list[dict] = []
    for index, (start, end) in enumerate(spans):
        group = groups[index]
        if kinds[index] == "silence":
            group = ""
        occurrence = 0
        if group:
            occurrences[group] = occurrences.get(group, 0) + 1
            occurrence = occurrences[group]
        sections.append(
            {
                "start": round(float(start), 3),
                "end": round(float(end), 3),
                "label": _legacy_label(energies[index], kinds[index]),
                "energy": round(float(np.clip(energies[index], 0.0, 1.0)), 3),
                "group": group,
                "kind": kinds[index],
                "occurrence": occurrence,
                "confidence": round(float(confidence[index]), 3),
            }
        )
    return sections


def _group_letter(index: int) -> str:
    """A, B, …, Z, AA, AB… : identifiant stable et lisible d'un groupe."""
    if index < 26:
        return chr(ord("A") + index)
    return chr(ord("A") + index // 26 - 1) + chr(ord("A") + index % 26)


def _legacy_label(energy: float, kind: str) -> str:
    """Libellé global historique (le front le lit encore), aligné sur le contrat."""
    if kind == "silence" or energy < 0.08:
        return "silence"
    if energy > 0.5:
        return "intense"
    return "calme"


def detect_structure(
    *,
    duration: float,
    beats: list[float],
    meter: int,
    spectrum: np.ndarray,
    sample_rate: int,
    hop_length: int,
    frame_times: np.ndarray,
    energy_points: list[list[float]],
    audio: np.ndarray,
) -> list[dict]:
    """Sections locales conformes au contrat V3.1, triées et couvrant [0, durée]."""
    duration = round(float(duration), 3)
    if duration <= 0.0 or spectrum.ndim != 2 or spectrum.shape[1] == 0:
        return [
            {
                "start": 0.0,
                "end": max(duration, 0.0),
                "label": "calme",
                "energy": 0.0,
                "group": "",
                "kind": "couplet",
                "occurrence": 0,
                "confidence": 0.0,
            }
        ]

    beats_per_bar = meter if meter in (3, 4) else 4
    grid = _bar_grid(beats, beats_per_bar, duration)

    # Descripteurs par mesure, depuis le spectre déjà calculé.
    chroma = librosa.feature.chroma_stft(
        S=spectrum, sr=sample_rate, hop_length=hop_length, tuning=0.0
    )
    mel = librosa.feature.melspectrogram(
        S=spectrum**2, sr=sample_rate, hop_length=hop_length, n_mels=64
    )
    mfcc = librosa.feature.mfcc(S=librosa.power_to_db(mel + 1e-10), n_mfcc=13)
    if chroma.shape[1] != frame_times.size:
        frame_times = librosa.frames_to_time(
            np.arange(chroma.shape[1]), sr=sample_rate, hop_length=hop_length
        )
    chroma_bars = _aggregate(chroma, frame_times, grid)
    mfcc_bars = _aggregate(mfcc, frame_times, grid)

    similarity = _self_similarity(chroma_bars, mfcc_bars)
    novelty = _checkerboard_novelty(similarity, NOVELTY_HALF_BARS)
    boundary_indices = _pick_boundaries(novelty, grid, duration)

    energy_times = np.array([point[0] for point in energy_points], dtype=float)
    energy_values = np.array([point[1] for point in energy_points], dtype=float)
    raw_rms = librosa.feature.rms(y=audio, hop_length=hop_length)[0]
    if raw_rms.size != frame_times.size:
        # Analyse fenêtrée : `frame_times` est déjà décalé de l'offset du
        # morceau, pas la grille locale du RMS. On les remet sur la même base.
        offset = float(frame_times[0]) if frame_times.size else 0.0
        raw_times = (
            librosa.frames_to_time(np.arange(raw_rms.size), sr=sample_rate, hop_length=hop_length)
            + offset
        )
        raw_rms = np.interp(frame_times, raw_times, raw_rms)
    silences = _silence_spans(raw_rms, frame_times, duration)

    spans = _split_on_silences(_segments(grid, boundary_indices, duration), silences)
    # Un silence ne doit pas être absorbé par la fusion des sections courtes.
    spans = _merge_short_spans(spans, silences, duration)

    # Une seule passe de regroupement : recoller deux sections voisines du même
    # groupe effacerait la frontière d'un refrain qui démarre sur le même
    # matériau harmonique que le couplet précédent (cas de « They Don't Care
    # About Us »). On garde donc toutes les frontières de phrase.
    features = _segment_features(chroma_bars, mfcc_bars, grid, spans, duration)
    similarity = _similarity_matrix(features)
    labels = _cluster(similarity)
    coherence = _group_coherence(similarity, labels)

    energies = [_section_energy(energy_times, energy_values, start, end) for start, end in spans]
    max_novelty = float(np.max(novelty)) if novelty.size else 0.0
    boundaries: dict[int, float] = {}
    for index, (start, _end) in enumerate(spans):
        if index == 0:
            boundaries[index] = 0.0
            continue
        if max_novelty <= 0.0:
            boundaries[index] = 0.0
            continue
        position = int(np.argmin(np.abs(grid - start)))
        local = float(np.max(novelty[max(0, position - 1) : position + 2]))
        boundaries[index] = float(np.clip(local / max_novelty, 0.0, 1.0))

    sections = _label_sections(spans, similarity, labels, coherence, energies, boundaries, silences)
    # Sans refrain, sans pont et sans silence, aucune frontière n'est assez
    # fiable pour être publiée : l'ancien détecteur produisait justement des
    # frontières de couplet plus fausses qu'utiles (constat de la vague 2). On
    # préfère alors une section unique, exactement comme la version 4.
    if not any(section["kind"] in {"refrain", "pont", "silence"} for section in sections):
        mean_energy = float(np.mean(energy_values)) if energy_values.size else 0.0
        return [
            {
                "start": 0.0,
                "end": duration,
                "label": _legacy_label(mean_energy, "couplet"),
                "energy": round(float(np.clip(mean_energy, 0.0, 1.0)), 3),
                "group": "",
                "kind": "couplet",
                "occurrence": 0,
                "confidence": 0.5,
            }
        ]
    return sections


def _merge_short_spans(
    spans: list[tuple[float, float]],
    silences: list[tuple[float, float]],
    duration: float,
) -> list[tuple[float, float]]:
    """Fusionne les sections non-silence plus courtes que le minimum du contrat."""
    if not spans:
        return [(0.0, round(duration, 3))]
    result = list(spans)
    changed = True
    while changed and len(result) > 1:
        changed = False
        for index, (start, end) in enumerate(result):
            is_silence = any(abs(start - a) < 0.01 and abs(end - b) < 0.01 for a, b in silences)
            if is_silence:
                continue
            if end - start >= MIN_SECTION_SEC:
                continue
            if index > 0:
                previous_start, _ = result[index - 1]
                result[index - 1] = (previous_start, end)
                result.pop(index)
            else:
                _, following_end = result[index + 1]
                result[index] = (start, following_end)
                result.pop(index + 1)
            changed = True
            break
    # Respecte l'intervalle total.
    if result[0][0] != 0.0:
        result[0] = (0.0, result[0][1])
    if result[-1][1] != round(duration, 3):
        result[-1] = (result[-1][0], round(duration, 3))
    return result
