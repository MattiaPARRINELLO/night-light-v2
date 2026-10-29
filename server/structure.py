"""Structure musicale : sections locales, refrains et reprises de production.

Le détecteur historique ne produisait qu'une section globale et prenait la fin
d'une montée d'énergie pour un impact. Sur le corpus rap, cela plaçait l'impact
au début de la montée ou 1,5 à 2 s après la reprise. Ce module ajoute deux
choses, mesurées sur les mêmes courbes que le reste de l'analyse :

* un découpage **local** (chroma + timbre, similarité entre blocs) qui retrouve
  les blocs qui se répètent et leur rôle (refrain, montée, pont/calme) ;
* un détecteur de **reprise de production** : un creux (baisse d'énergie ou de
  basse sur au moins une mesure) suivi d'un retour de basse et d'attaques qui
  tient au moins quatre secondes, recalé sur le premier temps fort de la
  reprise. Un simple début de couplet, sans creux préalable, ne passe pas.
* une notion plus large de **reprise** (R5) : le même creux suivi d'un retour
  d'énergie, **sans condition de basse**, utilisé seulement pour corroborer un
  refrain. Les drops restent un sous-ensemble strict des reprises ; une reprise
  sans drop n'allume rien.

Aucun seuil n'est propre à un titre : tout est calculé sur les courbes du
morceau et les paramètres ci-dessous sont communs au corpus.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

# --------------------------------------------------------------- paramètres

# Fenêtre de comparaison de part et d'autre d'une frontière de section, en
# temps. Huit temps couvrent deux mesures en 4/4 : assez pour entendre un
# matériau, assez court pour ne pas lisser un changement de beat.
STRUCTURE_WINDOW_BEATS = 8
# Une frontière doit dépasser ce seuil de nouveauté pour exister.
STRUCTURE_MIN_NOVELTY = 0.10
# Deux frontières plus proches que cette durée (secondes) n'en font qu'une.
STRUCTURE_MIN_SPACING = 8.0
# Similarité minimale (chroma + timbre) pour dire que deux blocs sont le même
# matériau musical.
GROUP_MIN_SIMILARITY = 0.80
# Le chroma moyen est presque identique d'un bloc à l'autre sur le rap ; le
# timbre (MFCC) est le vrai discriminant entre un refrain qui revient et un
# couplet dense. Seuil mesuré sur les références : les vrais refrains se
# retrouvent à ≥ 0,99, les couplets denses restent sous 0,985.
GROUP_MIN_MFCC_SIMILARITY = 0.985
# Part de l'énergie maximale du morceau sous laquelle un bloc répété n'est pas
# un refrain.
REFRAIN_MIN_RELATIVE_ENERGY = 0.62
# Tolérance (secondes) entre le début d'un refrain et une reprise de production.
# Aucune mesure de timbre ne sépare proprement un vrai refrain d'un couplet
# dense sur le corpus rap (voir le diagnostic R4 : MFCC ≥ 0,985 partout,
# énergie, brillance et densité se recouvrent). Le seul fait indépendant qui
# distingue les refrains de Gogo et Karma est le **saut complémentaire** : le
# matériau revient avec une reprise de production au même instant. Un bloc
# répété qui ne porte aucun retour de production reste donc un couplet/pulse.
# Une reprise sans condition de basse (voir R5) compte comme saut : elle peut
# ancrer un refrain sans déclencher d'impact visuel.
REFRAIN_DROP_TOLERANCE = 0.75
# Durée minimale d'un creux de production, en secondes (une mesure à 120 BPM).
DROP_MIN_TROUGH = 1.2
# Durée minimale du retour, en secondes : la prod doit tenir, pas seulement
# claquer une fois.
DROP_SUSTAIN = 4.0
# Fenêtre de recherche du creux avant la reprise.
DROP_TROUGH_SEARCH = 4.0
# Énergie minimale du bloc qui suit pour parler de production revenue.
DROP_MIN_ENERGY = 0.30
# Basse minimale du bloc qui suit (un drop peut être porté par les médiums,
# mais une basse franche est la signature la plus fiable).
DROP_MIN_BASS = 0.42
# Gain minimal par rapport au bloc précédent pour une reprise franche.
# Un creux est « calme » sous ces niveaux (courbes normalisées 0..1).
# Deux drops plus proches que cette durée sont fusionnés.
DROP_MIN_SPACING = 18.0

# ------------------------------------------- reprises sans condition de basse
# Une **reprise** est le retour de la production après un creux net, sans
# exiger que la basse remonte : sur la house et l'électro, la basse continue
# pendant le break, seul le niveau d'ensemble revient. Les drops restent un
# sous-ensemble strict des reprises (mêmes horodatages) ; une reprise sans
# drop peut corroborer un refrain, mais ne déclenche ni flash ni plateau.
#
# Énergie du bloc qui suit : la production doit être réellement revenue.
REPRISE_MIN_AFTER_ENERGY = 0.50
# Le retour doit tenir (même fenêtre que DROP_SUSTAIN).
REPRISE_MIN_SUSTAIN_ENERGY = 0.30
# Creux maximal avant le retour : en dessous, le bloc précédent est une vraie
# baisse et non une simple respiration. 0,25 attrape le retour de They Don't
# Care (10,5 s, creux 0,05) sans ouvrir les blocs déjà forts.
REPRISE_MAX_TROUGH_ENERGY = 0.25
# Saut minimal entre le creux et le retour. C'est ce qui distingue une reprise
# d'un passage fort déjà installé.
REPRISE_MIN_ENERGY_JUMP = 0.30
# Le bloc qui commence doit être plus énergique que celui qui le précède :
# un retour qui redescend en moyenne n'est pas une reprise.
REPRISE_MIN_SECTION_GAIN = 0.05
# La densité ne doit pas s'effondrer : une reprise peut perdre un peu
# d'attaques (Latch 95,6 s), jamais la moitié du tissu rythmique.
REPRISE_MIN_DENSITY_KEEP = 0.5
# Énergie minimale du bloc qui précède une **première entrée de production**
# (section d'intro). En dessous, c'est une intro quasi silencieuse : l'entrée
# est l'exposition du morceau, pas une reprise. Mesure : Focus 15,6 s suit
# 0,06 (silence, exposition) tandis que They Don't Care 10,5 s suit 0,18
# (bloc audible nettement plus faible). Le seuil 0,15 les sépare sans règle
# par titre.
REPRISE_MIN_PREVIOUS_ENERGY = 0.15


@dataclass
class Structure:
    sections: list[dict]
    drops: list[dict]
    # Reprises de production (drops inclus). Sert à corroborer un refrain sans
    # modifier drops : `drops` reste le sous-ensemble qui déclenche la lumière.
    reprises: list[dict] = field(default_factory=list)


def _mean(values: np.ndarray, times: np.ndarray, start: float, end: float) -> float:
    window = (times >= start) & (times < end)
    if not window.any():
        return float(np.interp(start, times, values)) if times.size else 0.0
    return float(np.mean(values[window]))


def _beat_sync(matrix: np.ndarray, times: np.ndarray, beats: np.ndarray) -> np.ndarray:
    """Moyenne une matrice (features × frames) sur chaque intervalle de temps."""
    columns: list[np.ndarray] = []
    for index in range(max(0, beats.size - 1)):
        start = float(beats[index])
        end = float(beats[index + 1])
        window = (times >= start) & (times < end)
        if window.any():
            columns.append(matrix[:, window].mean(axis=1))
        elif columns:
            columns.append(columns[-1])
        else:
            columns.append(np.zeros(matrix.shape[0]))
    if not columns:
        return np.zeros((matrix.shape[0], 0))
    return np.column_stack(columns)


def _unit(matrix: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(matrix, axis=0, keepdims=True)
    return matrix / np.maximum(norms, 1e-9)


def _cosine(left: np.ndarray, right: np.ndarray) -> float:
    denominator = float(np.linalg.norm(left) * np.linalg.norm(right))
    if denominator <= 1e-9:
        return 0.0
    return float(np.dot(left, right) / denominator)


def _novelty_curve(features: np.ndarray, window: int) -> np.ndarray:
    """Distance entre le bloc qui précède et celui qui suit chaque temps."""
    count = features.shape[1]
    scores = np.zeros(count, dtype=float)
    if count == 0:
        return scores
    for index in range(count):
        before = features[:, max(0, index - window) : index]
        after = features[:, index : min(count, index + window)]
        if before.shape[1] == 0 or after.shape[1] == 0:
            continue
        scores[index] = 1.0 - _cosine(before.mean(axis=1), after.mean(axis=1))
    return scores


def _peaks(scores: np.ndarray, beats: np.ndarray, minimum: float, spacing: float) -> list[float]:
    """Maxima locaux de la nouveauté, espacés d'au moins `spacing` secondes."""
    candidates: list[tuple[float, float]] = []
    for index in range(6, max(7, scores.size - 6)):
        left = max(0, index - 6)
        right = min(scores.size, index + 7)
        if scores[index] >= float(np.max(scores[left:right])) and scores[index] >= minimum:
            candidates.append((float(beats[index]), float(scores[index])))
    candidates.sort(key=lambda item: item[1], reverse=True)
    kept: list[tuple[float, float]] = []
    for time, score in candidates:
        if all(abs(time - other) > spacing for other, _ in kept):
            kept.append((time, score))
    return sorted(time for time, _ in kept)


def _trough(
    energy: np.ndarray,
    bass: np.ndarray,
    times: np.ndarray,
    target: float,
    length: float,
) -> tuple[float, float]:
    """Creux le plus bas d'une mesure dans les secondes qui précèdent.

    Un creux de reprise dure au moins une mesure, mais il ne finit pas
    forcément juste avant la frontière : le dernier temps peut déjà porter
    l'attaque. On cherche donc la mesure la plus basse sur ``length`` secondes
    qui se termine dans la dernière mesure avant ``target``.
    """
    best_energy = float("inf")
    best_bass = float("inf")
    for end in np.arange(target, target - length - 1e-9, -0.25):
        if end - length < 0.0:
            break
        candidate_energy = _mean(energy, times, end - length, end)
        candidate_bass = _mean(bass, times, end - length, end)
        if candidate_energy < best_energy:
            best_energy = candidate_energy
            best_bass = candidate_bass
    if not np.isfinite(best_energy):
        return 0.0, 0.0
    return float(best_energy), float(best_bass)


def _trough_length(beats: np.ndarray) -> float:
    if beats.size < 2:
        return 2.0
    period = float(np.median(np.diff(beats)))
    return float(np.clip(4.0 * period, DROP_MIN_TROUGH, 2.6))


def _late_return(
    energy: np.ndarray,
    bass: np.ndarray,
    times: np.ndarray,
    beats: np.ndarray,
    start: float,
    horizon: float,
) -> float | None:
    """Premier temps fort plein d'une reprise qui suit une frontière molle.

    Une frontière de section peut tomber un ou deux temps avant l'impact réel
    (constat R3 sur Focus 197,1 → 200). Quand la section qui commence est de
    faible énergie, on cherche dans les ``horizon`` secondes un creux court
    (basse quasi absente) suivi d'un retour de production, et on rend le
    **premier temps fort dont la mesure précédente est déjà pleine** : c'est lui
    qui porte l'impact, pas l'échantillon de bascule.
    """
    period = float(np.median(np.diff(beats))) if beats.size > 1 else 0.5
    trough = max(0.5, min(1.0, period * 1.5))
    for index in range(1, beats.size):
        beat = float(beats[index])
        if beat <= start or beat > start + horizon:
            continue
        if beat > float(times[-1]) - 6.0:
            break
        window = (times >= max(0.0, beat - trough)) & (times < beat)
        if not window.any():
            continue
        before_bass = float(bass[window].mean())
        before_energy = float(energy[window].mean())
        if before_bass > 0.22 or before_energy > 0.62:
            continue
        after_energy = _mean(energy, times, beat, beat + 1.2)
        after_bass = _mean(bass, times, beat, beat + 1.2)
        if after_energy < 0.30 or (after_bass < 0.42 and after_energy < 0.55):
            continue
        sustain_energy = _mean(energy, times, beat + 4.0, beat + 8.0)
        sustain_bass = _mean(bass, times, beat + 4.0, beat + 8.0)
        if not (sustain_energy >= 0.28 or sustain_bass >= 0.35):
            continue
        # Recalage : premier temps fort dont la mesure précédente est pleine.
        for following in range(index, min(index + 4, beats.size - 1)):
            left = float(beats[following])
            right = float(beats[following + 1])
            if _mean(bass, times, left, right) >= 0.42 or _mean(energy, times, left, right) >= 0.55:
                return round(right, 3)
    return None


def _boundaries(
    energy: np.ndarray,
    bass: np.ndarray,
    times: np.ndarray,
    beats: np.ndarray,
    chroma: np.ndarray,
    mfcc: np.ndarray,
    duration: float,
) -> list[float]:
    synced_chroma = _unit(_beat_sync(chroma, times, beats))
    synced_mfcc = _beat_sync(mfcc, times, beats)
    synced_mfcc = (synced_mfcc - synced_mfcc.mean(axis=1, keepdims=True)) / (
        synced_mfcc.std(axis=1, keepdims=True) + 1e-9
    )
    synced_energy = _beat_sync(energy[None, :], times, beats)
    synced_bass = _beat_sync(bass[None, :], times, beats)
    features = np.vstack(
        [
            synced_chroma,
            0.30 * synced_mfcc,
            0.20 * synced_energy,
            0.20 * synced_bass,
        ]
    )
    features = _unit(features)
    scores = _novelty_curve(features, STRUCTURE_WINDOW_BEATS)
    boundaries = _peaks(scores, beats, STRUCTURE_MIN_NOVELTY, STRUCTURE_MIN_SPACING)

    # Le pic de nouveauté tombe souvent un ou deux temps avant la reprise
    # elle-même (le timbre change pendant le dernier temps du creux). On recale
    # chaque frontière sur le premier temps fort où la production remonte, sans
    # jamais déplacer de plus de trois secondes.
    snapped: list[float] = []
    for time in boundaries:
        candidates = [float(beat) for beat in beats if abs(float(beat) - time) <= 3.0]
        if not candidates:
            snapped.append(time)
            continue
        best = max(
            candidates,
            key=lambda beat: (
                _mean(bass, times, beat, beat + 2.0)
                + _mean(energy, times, beat, beat + 2.0)
                - _mean(bass, times, max(0.0, beat - 2.0), beat)
                - 0.5 * _mean(energy, times, max(0.0, beat - 2.0), beat)
            ),
        )
        snapped.append(best)
    boundaries = snapped

    boundaries = [time for time in sorted(boundaries) if 4.0 < time < duration - 4.0]
    merged: list[float] = [0.0]
    for time in boundaries:
        if time - merged[-1] >= STRUCTURE_MIN_SPACING:
            merged.append(round(time, 3))
    if duration - merged[-1] >= STRUCTURE_MIN_SPACING:
        merged.append(round(duration, 3))
    else:
        merged[-1] = round(duration, 3)
    return merged


def _section_features(
    start: float,
    end: float,
    energy: np.ndarray,
    bass: np.ndarray,
    times: np.ndarray,
    onsets: np.ndarray,
    chroma: np.ndarray,
    mfcc: np.ndarray,
) -> dict:
    span = max(end - start, 1e-6)
    window = (times >= start) & (times < end)
    onset_window = (onsets >= start) & (onsets < end)
    return {
        "start": start,
        "end": end,
        "energy": _mean(energy, times, start, end),
        "bass": _mean(bass, times, start, end),
        "density": float(np.count_nonzero(onset_window) / span),
        "chroma": chroma[:, window].mean(axis=1) if window.any() else np.zeros(chroma.shape[0]),
        "mfcc": mfcc[:, window].mean(axis=1) if window.any() else np.zeros(mfcc.shape[0]),
    }


def _label_for(energy: float, rising: bool) -> str:
    if energy < 0.22:
        return "calme"
    if rising:
        return "montee"
    return "intense"


def detect_structure(
    energy_points: list[list[float]],
    bass_points: list[list[float]],
    times: np.ndarray,
    energy: np.ndarray,
    bass: np.ndarray,
    beats: np.ndarray,
    onsets: np.ndarray,
    chroma: np.ndarray,
    mfcc: np.ndarray,
    duration: float,
) -> Structure:
    """Découpe le morceau en sections locales et repère les reprises de prod."""
    if duration < 8.0 or beats.size < 8 or times.size < 8:
        return Structure(sections=[], drops=[])

    boundaries = _boundaries(energy, bass, times, beats, chroma, mfcc, duration)
    raw = [
        _section_features(
            boundaries[index],
            boundaries[index + 1],
            energy,
            bass,
            times,
            onsets,
            chroma,
            mfcc,
        )
        for index in range(len(boundaries) - 1)
    ]
    if not raw:
        return Structure(sections=[], drops=[])

    maximum_energy = max(section["energy"] for section in raw)

    # Les reprises de production sont calculées **avant** le rôle des sections :
    # elles servent de corroboration au refrain (voir REFRAIN_DROP_TOLERANCE).
    # Seule l'intro conditionne ce calcul ; elle ne dépend pas du refrain.
    intro = [index == 0 and section["energy"] < 0.18 for index, section in enumerate(raw)]

    drops: list[dict] = []
    for index in range(1, len(raw)):
        previous = raw[index - 1]
        current = raw[index]
        start = current["start"]
        if start < 20.0 or current["end"] - start < 5.0:
            continue
        if intro[index - 1]:
            continue
        before_energy, before_bass = _trough(energy, bass, times, start, _trough_length(beats))
        after_energy = _mean(energy, times, start, start + DROP_SUSTAIN)
        after_bass = _mean(bass, times, start, start + DROP_SUSTAIN)
        sustain_energy = _mean(energy, times, start + DROP_SUSTAIN, start + 2 * DROP_SUSTAIN)
        sustain_bass = _mean(bass, times, start + DROP_SUSTAIN, start + 2 * DROP_SUSTAIN)
        if not (
            after_energy >= DROP_MIN_ENERGY
            and (after_bass >= DROP_MIN_BASS or after_energy >= 0.48)
        ):
            continue
        if not (sustain_energy >= 0.28 or sustain_bass >= 0.35):
            continue
        energy_gain = current["energy"] - previous["energy"]
        bass_gain = current["bass"] - previous["bass"]
        # Le premier bloc de production pleine est l'exposition du morceau :
        # ce n'est pas une reprise, même quand il contraste avec l'intro.
        had_production = any(
            _mean(energy, times, window, window + 4.0) >= 0.55
            or _mean(bass, times, window, window + 4.0) >= 0.40
            for window in np.arange(max(0.0, start - 30.0), start - 1.0, 1.0)
        )
        if not had_production:
            continue
        reprise = (
            before_bass <= 0.15
            and bass_gain >= 0.10
            and (energy_gain >= 0.08 or bass_gain >= 0.20)
            and (energy_gain >= 0.25 or before_energy <= 0.45)
        )
        # Drop léger : plus aucune basse pendant une mesure, puis un bloc
        # plein qui tient. C'est le cas d'un refrain qui revient sans impact
        # spectaculaire ; il doit rester un drop, avec une force modérée.
        light = before_bass <= 0.015 and after_energy >= 0.70 and after_bass >= 0.25
        if not (reprise or light):
            continue
        strength = float(
            np.clip(
                0.18
                + 0.45 * min(1.0, max(0.0, energy_gain, after_energy - before_energy) / 0.45)
                + 0.30 * min(1.0, max(0.0, bass_gain, after_bass - before_bass) / 0.45)
                + 0.20 * min(1.0, max(0.0, current["density"] - previous["density"]) / 1.5),
                0.15,
                1.0,
            )
        )
        drops.append(
            {
                "time": round(start, 3),
                "strength": round(strength, 3),
                "source": "return",
            }
        )

    # Frontières molles : la section commence bas, mais la production ne
    # revient qu'un ou deux temps plus loin. On recale l'impact sur ce retour
    # (Focus : frontière 197,1 s, impact 198,6 s, vérité 200 s).
    for index in range(1, len(raw)):
        section = raw[index]
        start = section["start"]
        if start < 20.0 or section["energy"] >= 0.70:
            continue
        # La frontière doit être réellement molle : les toutes premières
        # secondes de la section restent basses. Sinon c'est un simple
        # enchaînement de couplets, pas une reprise décalée.
        if _mean(energy, times, start, start + 0.75) > 0.35:
            continue
        if any(abs(drop["time"] - start) <= 3.0 for drop in drops):
            continue
        late = _late_return(energy, bass, times, beats, start, 2.0)
        if late is None:
            continue
        drops.append({"time": late, "strength": 0.85, "source": "return"})

    drops.sort(key=lambda drop: drop["time"])
    merged_drops: list[dict] = []
    for drop in drops:
        if merged_drops and drop["time"] - merged_drops[-1]["time"] < DROP_MIN_SPACING:
            if drop["strength"] > merged_drops[-1]["strength"]:
                merged_drops[-1] = drop
        else:
            merged_drops.append(drop)

    # Reprises sans condition de basse (R5). On part des drops déjà validés :
    # le sous-ensemble est garanti et leurs horodatages ne peuvent pas bouger.
    # Puis on ajoute les retours d'énergie qui suivent un creux net, y compris
    # la **première entrée de production** quand elle suit un bloc réellement
    # plus faible (jamais une intro quasi silencieuse : c'est l'exposition).
    reprises: list[dict] = [dict(drop) for drop in merged_drops]
    for index in range(1, len(raw)):
        previous = raw[index - 1]
        current = raw[index]
        start = current["start"]
        if current["end"] - start < 5.0:
            continue
        if intro[index - 1] and previous["energy"] < REPRISE_MIN_PREVIOUS_ENERGY:
            continue
        before_energy, _ = _trough(energy, bass, times, start, _trough_length(beats))
        after_energy = _mean(energy, times, start, start + DROP_SUSTAIN)
        sustain_energy = _mean(energy, times, start + DROP_SUSTAIN, start + 2 * DROP_SUSTAIN)
        if before_energy > REPRISE_MAX_TROUGH_ENERGY:
            continue
        if after_energy < REPRISE_MIN_AFTER_ENERGY:
            continue
        if sustain_energy < REPRISE_MIN_SUSTAIN_ENERGY:
            continue
        if after_energy - before_energy < REPRISE_MIN_ENERGY_JUMP:
            continue
        if current["energy"] - previous["energy"] < REPRISE_MIN_SECTION_GAIN:
            continue
        if current["density"] < REPRISE_MIN_DENSITY_KEEP * previous["density"]:
            continue
        if any(abs(start - reprise["time"]) <= REFRAIN_DROP_TOLERANCE for reprise in reprises):
            continue
        jump = after_energy - before_energy
        reprises.append(
            {
                "time": round(start, 3),
                "strength": round(float(np.clip(0.15 + 0.55 * jump, 0.15, 1.0)), 3),
                "source": "reprise",
            }
        )
    reprises.sort(key=lambda reprise: reprise["time"])

    sections: list[dict] = []
    for index, section in enumerate(raw):
        start = section["start"]
        end = section["end"]
        span = end - start
        front = _mean(energy, times, start, start + span * 0.25)
        back = _mean(energy, times, end - span * 0.25, end)
        rising = back - front >= 0.12 and back >= 0.30
        neighbour_energies = [
            raw[other]["energy"] for other in (index - 1, index + 1) if 0 <= other < len(raw)
        ]
        neighbour = float(np.mean(neighbour_energies)) if neighbour_energies else 0.0
        # Un refrain est un bloc qui **revient** : sans une autre occurrence
        # de même énergie, de même basse et de même densité (à distance, pas
        # la section voisine), ce n'est qu'un passage fort.
        repeated = any(
            abs(other - index) >= 2
            and 0.5 <= span / max(raw[other]["end"] - raw[other]["start"], 1e-6) <= 2.0
            and abs(raw[other]["energy"] - section["energy"]) <= 0.10
            and abs(raw[other]["bass"] - section["bass"]) <= 0.15
            and abs(raw[other]["density"] - section["density"]) <= 1.2
            # Même matériau musical : énergie et densité proches ne suffisent
            # pas, un couplet dense ressemble à un refrain. On exige la
            # similarité chroma + timbre entre les deux occurrences.
            and _cosine(section["chroma"], raw[other]["chroma"]) >= GROUP_MIN_SIMILARITY
            and _cosine(section["mfcc"], raw[other]["mfcc"]) >= GROUP_MIN_MFCC_SIMILARITY
            and any(
                raw[between]["energy"] <= section["energy"] - 0.10
                for between in range(min(index, other) + 1, max(index, other))
            )
            for other in range(len(raw))
        )
        after_calm = index > 0 and sections[index - 1]["kind"] == "pont"
        # Confiance R4 : le retour du matériau ne suffit pas, il doit coïncider
        # avec une reprise de production. Sans ce saut complémentaire, le bloc
        # garde le rôle couplet/pulse (Minimum et Focus n'ont aucun refrain).
        corroborated = any(
            abs(reprise["time"] - start) <= REFRAIN_DROP_TOLERANCE for reprise in reprises
        )
        refrain = (
            (repeated or after_calm)
            and corroborated
            and index not in (0, len(raw) - 1)
            and section["energy"] >= REFRAIN_MIN_RELATIVE_ENERGY * max(maximum_energy, 1e-6)
            and section["energy"] >= neighbour + 0.02
        )
        if index == 0 and section["energy"] < 0.18:
            kind = "intro"
        elif index == len(raw) - 1 and section["energy"] < 0.18:
            kind = "outro"
        elif refrain:
            kind = "refrain"
        elif section["energy"] < 0.26:
            kind = "pont"
        else:
            kind = "couplet"
        sections.append(
            {
                "start": round(start, 3),
                "end": round(end, 3),
                "label": _label_for(section["energy"], rising),
                "energy": round(float(np.clip(section["energy"], 0.0, 1.0)), 3),
                "group": "",
                "kind": kind,
                "occurrence": 0,
                "bass": round(float(np.clip(section["bass"], 0.0, 1.0)), 3),
                "density": round(float(section["density"]), 3),
            }
        )

    return Structure(sections=sections, drops=merged_drops, reprises=reprises)
