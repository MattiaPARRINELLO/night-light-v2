"""Découverte de la structure répétitive d'un morceau (couplet, refrain…).

Un morceau de soirée est presque toujours bâti sur des blocs qui **reviennent** :
le refrain est le même matériau musical à plusieurs endroits, le couplet aussi.
Savoir qu'une section est la *répétition* d'une autre permet de lui donner le
même éclairage (un refrain doit se reconnaître) et de doser son énergie.

Le découpage s'appuie sur l'algorithme de structure musicale de `msaf`, qui
renvoie à la fois les frontières et un **groupe** (étiquette) par section : deux
sections étiquetées pareil sont le même passage rejoué.

`msaf` 0.1.80 (dernière version) est resté sur scipy < 1.12 : il fait
`from scipy import inf`, un attribut retiré depuis. On le réinjecte avant
l'import (voir `_load_msaf`). Rien ici n'est fatal à l'analyse : si msaf manque
ou échoue, on renvoie `None` et l'analyse garde son découpage de repli.
"""

from __future__ import annotations

import logging
import shutil
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import scipy

_LOGGER = logging.getLogger("night-light.structure")

# `msaf.config` est global : deux analyses simultanées se marcheraient dessus en
# se partageant le même dossier temporaire. Le verrou sérialise l'appel.
_MSAF_LOCK = threading.Lock()

# Combinaison d'algorithmes retenue : `olda` (frontières) et `cnmf` (étiquettes).
# Testée sur des morceaux A-B-A-B, elle regroupe correctement les répétitions,
# là où les algorithmes par défaut de msaf renvoient des étiquettes vides sur du
# matériau synthétique.
BOUNDARIES_ID = "olda"
LABELS_ID = "cnmf"

# Longueur minimale d'un bloc : en dessous, msaf a découpé du souffle et la
# « section » n'a pas de sens musical. On la fusionne avec sa voisine.
MIN_SEGMENT_SEC = 2.5
# Nombre minimal de blocs pour parler de structure (au moins trois passages…).
_MIN_SEGMENTS = 3


@dataclass(frozen=True)
class StructureSegment:
    """Bloc structural : une section et le groupe qu'elle partage avec ses jumelles."""

    start: float
    end: float
    #: Lettre du groupe (« A », « B »…). Deux segments de même lettre jouent le
    #: même passage ; l'ordre suit la première apparition.
    group: str


def _load_msaf():
    """Importe msaf en réinjectant les attributs scipy retirés depuis 1.12."""
    if not hasattr(scipy, "inf"):
        scipy.inf = np.inf  # type: ignore[attr-defined]
    import msaf  # noqa: PLC0415 - l'import doit suivre le correctif ci-dessus

    return msaf


def _process(path: Path, boundaries_id: str, labels_id: str):
    """Appelle msaf dans un dossier temporaire isolé, à l'abri du répertoire courant.

    Sans ça, msaf écrit ses features et ses estimations (`.features_msaf_tmp.json`,
    `estimations/*.jams`) dans le répertoire courant du serveur. Le fichier de
    features est propre à chaque appel : le laisser partagé ferait réutiliser les
    features d'un morceau précédent, identiques en apparence mais fausses.
    """
    msaf = _load_msaf()
    work_dir = Path(tempfile.mkdtemp(prefix="night-light-msaf-"))
    try:
        with _MSAF_LOCK:
            msaf.config.features_tmp_file = str(work_dir / "features.json")
            msaf.config.dataset.estimations_dir = str(work_dir / "estimations")
            return msaf.process(str(path), boundaries_id=boundaries_id, labels_id=labels_id)
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


def _letters(labels: list[object]) -> list[str]:
    """Traduit les étiquettes brutes de msaf en lettres ordonnées A, B, C…"""
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


def estimate_structure(
    path: Path,
    boundaries_id: str = BOUNDARIES_ID,
    labels_id: str = LABELS_ID,
) -> list[StructureSegment] | None:
    """Estime les blocs répétés d'un fichier audio, ou `None` si indécidable.

    `None` est un résultat normal : msaf absent ou en échec, morceau trop court,
    découpage dégénéré, ou aucun bloc qui se répète — dans ce cas la structure
    n'apprendrait rien et l'analyse garde son découpage de repli.
    """
    try:
        boundaries, labels = _process(path, boundaries_id, labels_id)
    except Exception as error:  # noqa: BLE001 - la structure est un bonus, jamais fatal
        _LOGGER.warning("Structure indisponible (%s) : %s", path.name, error)
        return None

    times = [float(value) for value in np.atleast_1d(boundaries)]
    groups = _letters(list(np.atleast_1d(labels)))
    if len(groups) != len(times) - 1:
        return None

    raw: list[StructureSegment] = []
    for index in range(len(times) - 1):
        start = times[index]
        end = times[index + 1]
        if end - start <= 0.3:
            continue
        raw.append(StructureSegment(start=round(start, 3), end=round(end, 3), group=groups[index]))

    segments = _coalesce(raw)
    repeated = len({segment.group for segment in segments}) < len(segments)
    if len(segments) < _MIN_SEGMENTS or not repeated:
        _LOGGER.info("Pas de structure répétitive exploitable dans %s", path.name)
        return None
    return segments
