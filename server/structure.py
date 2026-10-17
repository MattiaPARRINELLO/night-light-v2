"""Découverte de la structure répétitive d'un morceau (couplet, refrain…).

Un morceau de soirée est presque toujours bâti sur des blocs qui **reviennent** :
le refrain est le même matériau musical à plusieurs endroits, le couplet aussi.
Savoir qu'une section est la *répétition* d'une autre permet de lui donner le
même éclairage (un refrain doit se reconnaître) et de doser son énergie.

Le découpage se fait **en local**, avec librosa, sur le spectre et les temps
forts déjà calculés par l'analyse (`server/analysis.py`) : aucune source n'est
rechargée, aucun HPSS ni beat-tracking redondant. On décrit chaque temps fort par
son chroma (harmonie) et ses MFCC (timbre), on segmente par regroupement
agglomératif, puis on rapproche les sections qui partagent le même matériau pour
leur donner une lettre de groupe (A, B…).

La fonction est volontairement sans état et à repli : si le morceau est trop
court ou trop uniforme pour qu'une répétition se dégage, elle renvoie `None` et
l'analyse garde son découpage de sections de repli.
"""

from __future__ import annotations

from dataclasses import dataclass

import librosa
import numpy as np

# Doivent correspondre au STFT de `server/analysis.py` : on réutilise son spectre.
HOP_LENGTH = 512
N_FFT = 2048
N_MELS = 64
N_MFCC = 13

# Longueur minimale d'un bloc : en dessous, c'est du souffle découpé, pas une
# section musicale. On la fusionne avec sa voisine.
MIN_SEGMENT_SEC = 2.5
# En dessous de cette durée, il n'y a pas de structure à apprendre d'un morceau.
MIN_STRUCTURE_SEC = 30.0
# Nombre minimal de blocs pour parler de structure (au moins trois passages…).
_MIN_SEGMENTS = 3
# Pas du repli (en secondes) quand aucun temps fort n'a été détecté.
_FALLBACK_STEP_SEC = 2.0
# Seuil de rapprochement : une section rejoint un groupe si sa distance au
# centre de ce groupe descend sous cette fraction de l'étalement typique des
# sections du morceau. Relatif, donc valable pour tous les morceaux.
#
# La référence (médiane des distances entre sections) mesure l'écart entre deux
# passages *différents* : c'est la distance au hasard. La moitié de cet écart
# sépare donc le matériau partagé du matériau distinct. Au-delà, des sections
# sans rapport se fondent dans un même groupe, le morceau n'a plus qu'un seul
# groupe répété et `assign_roles` ne peut plus dégager de couplet.
_GROUP_THRESHOLD = 0.5


@dataclass(frozen=True)
class StructureSegment:
    """Bloc structural : une section et le groupe qu'elle partage avec ses jumelles."""

    start: float
    end: float
    #: Lettre du groupe (« A », « B »…). Deux segments de même lettre jouent le
    #: même passage ; l'ordre suit la première apparition.
    group: str


def section_count(duration: float) -> int:
    """Nombre de sections visées : environ une section toutes les 12 secondes,
    avec un minimum pour les morceaux courts.

    La maille large d'autrefois (une section par 30 s) fondait couplet et
    refrain en un seul bloc : sur un morceau où les deux partagent la même
    boucle, le « refrain » avalait alors le couplet qui le précède et démarrait
    bien trop tôt. On vise donc la longueur d'un passage (8 à 16 mesures selon
    le tempo) plutôt qu'une durée ronde.
    """
    target = round(duration / 12.0) + 2 + (1 if duration < 60 else 0)
    return int(max(3, min(16, target)))


def _letters(labels: list[object]) -> list[str]:
    """Traduit des étiquettes brutes en lettres ordonnées A, B, C…"""
    seen: dict[str, str] = {}
    out: list[str] = []
    for label in labels:
        key = "" if label is None else str(label)
        if key not in seen:
            seen[key] = chr(ord("A") + len(seen) % 26)
        out.append(seen[key])
    return out


def _coalesce(segments: list[StructureSegment]) -> list[StructureSegment]:
    """Fusionne les blocs trop courts avec leur voisin : ce sont des artefacts.

    On absorbe vers l'arrière (le bloc court est rattaché à la fin du précédent),
    sinon vers l'avant pour le tout premier bloc.
    """
    out: list[StructureSegment] = []
    for segment in segments:
        if out and segment.end - segment.start < MIN_SEGMENT_SEC:
            previous = out[-1]
            out[-1] = StructureSegment(start=previous.start, end=segment.end, group=previous.group)
            continue
        out.append(segment)
    while len(out) >= 2 and out[0].end - out[0].start < MIN_SEGMENT_SEC:
        second = out[1]
        out[0] = StructureSegment(start=out[0].start, end=second.end, group=second.group)
        del out[1]
    return out


def _frame_features(spectrum: np.ndarray, sr: int, hop_length: int) -> np.ndarray:
    """Matrice de description par trame : chroma (harmonie) puis MFCC (timbre).

    On réutilise le spectre de l'analyse : pas de source rechargée. Les MFCC sont
    normalisés par coefficient pour que ni le timbre ni l'harmonie n'écrase
    l'autre au moment de comparer deux sections.
    """
    chroma = librosa.feature.chroma_stft(S=spectrum, sr=sr, hop_length=hop_length)
    mel = librosa.feature.melspectrogram(
        S=spectrum**2, sr=sr, n_fft=N_FFT, hop_length=hop_length, n_mels=N_MELS
    )
    mfcc = librosa.feature.mfcc(S=librosa.power_to_db(mel + 1e-10), n_mfcc=N_MFCC)
    return np.vstack([librosa.util.normalize(mfcc, axis=1), chroma])


def _beat_edges(
    beats: list[float], duration: float, n_frames: int, sr: int, hop_length: int
) -> np.ndarray:
    """Bornes de trames de chaque temps fort, commençant à 0.

    Sans temps fort exploitable, on retombe sur une grille régulière : le
    découpage perd en finesse mais reste possible.
    """
    interior = np.asarray([beat for beat in beats if 0.0 < beat < duration], dtype=float)
    if interior.size >= _MIN_SEGMENTS - 1:
        frames = librosa.time_to_frames(interior, sr=sr, hop_length=hop_length)
    else:
        step = max(1, int(round(_FALLBACK_STEP_SEC * sr / hop_length)))
        frames = np.arange(step, n_frames, step)
    frames = np.unique(frames[(frames > 0) & (frames < n_frames)]).astype(int)
    return np.concatenate(([0], frames, [n_frames]))


def _sync(features: np.ndarray, edges: np.ndarray) -> np.ndarray:
    """Agrège les trames entre deux bornes (moyenne), une colonne par segment."""
    columns = [
        features[:, start:end].mean(axis=1)
        for start, end in zip(edges[:-1], edges[1:], strict=False)
        if end > start
    ]
    if not columns:
        return np.zeros((features.shape[0], 0))
    return np.asarray(columns).T


def _group_sections(section_features: np.ndarray) -> list[int]:
    """Rapproche les sections au matériau musical proche et les numérote.

    Chaque section est décrite par la moyenne de ses temps forts (harmonie +
    timbre). On normalise chaque descripteur (z-score) pour équilibrer chroma et
    MFCC, puis on rattache chaque section au groupe le plus proche tant qu'elle
    reste sous un seuil dérivé de l'étalement du morceau : la moitié de la
    distance typique entre deux passages distincts.
    """
    count = len(section_features)
    if count == 0:
        return []
    mean = section_features.mean(axis=0, keepdims=True)
    std = section_features.std(axis=0, keepdims=True)
    scaled = (section_features - mean) / (std + 1e-9)

    if count == 1:
        return [0]
    pair = np.triu_indices(count, 1)
    spread = float(np.median(np.linalg.norm(scaled[pair[0]] - scaled[pair[1]], axis=1)))
    threshold = max(_GROUP_THRESHOLD * spread, 1e-6)

    groups: list[int] = []
    centroids: list[np.ndarray] = []
    for vector in scaled:
        if centroids:
            deltas = [float(np.linalg.norm(vector - centroid)) for centroid in centroids]
            nearest = int(np.argmin(deltas))
            if deltas[nearest] <= threshold:
                groups.append(nearest)
                centroids[nearest] = (centroids[nearest] + vector) / 2.0
                continue
        centroids.append(vector.copy())
        groups.append(len(centroids) - 1)
    return groups


def estimate_structure(
    spectrum: np.ndarray,
    beats: list[float],
    sr: int,
    duration: float,
    hop_length: int = HOP_LENGTH,
) -> list[StructureSegment] | None:
    """Estime les blocs répétés d'un morceau, ou `None` si indécidable.

    `None` est un résultat normal : morceau trop court, aucune répétition nette,
    ou découpage dégénéré — dans ce cas la structure n'apprendrait rien et
    l'analyse garde son découpage de repli.
    """
    if duration < MIN_STRUCTURE_SEC or spectrum.size == 0:
        return None

    features = _frame_features(spectrum, sr, hop_length)
    n_frames = features.shape[1]
    edges = _beat_edges(beats, duration, n_frames, sr, hop_length)
    sync = _sync(features, edges)
    n_columns = sync.shape[1]
    if n_columns < _MIN_SEGMENTS:
        return None

    count = min(section_count(duration), max(_MIN_SEGMENTS, n_columns // 2))
    bounds = np.unique(
        np.concatenate(([0], librosa.segment.agglomerative(sync, count), [n_columns]))
    )
    if bounds.size < _MIN_SEGMENTS:
        return None

    column_times = librosa.frames_to_time(edges[:-1], sr=sr, hop_length=hop_length)
    times = np.append(column_times, duration)

    section_features = np.asarray(
        [
            sync[:, bounds[index] : bounds[index + 1]].mean(axis=1)
            for index in range(len(bounds) - 1)
        ]
    )
    groups = _letters(_group_sections(section_features))

    # On ne supprime aucun bloc, même minuscule : `_coalesce` fusionne les
    # artefacts avec leur voisin, et cela garantit que le premier bloc commence
    # à 0 et que le dernier finit avec le morceau.
    raw = [
        StructureSegment(
            start=round(float(times[bounds[index]]), 3),
            end=round(float(times[bounds[index + 1]]), 3),
            group=group,
        )
        for index, group in enumerate(groups)
    ]

    segments = _coalesce(raw)
    repeated = len({segment.group for segment in segments}) < len(segments)
    if len(segments) < _MIN_SEGMENTS or not repeated:
        return None
    return segments
