"""Métrique 3/4 vs 4/4 et retour de basse (contrat d'analyse V3.1).

Le module ne dépend que de la STFT déjà calculée par :mod:`server.analysis` :
il ne refait ni décodage, ni STFT, ni suivi de tempo. ``analysis.py`` ne fait
qu'un appel, dans son bloc balisé ``vague3:metrique``.

Métrique
--------
Deux hypothèses seulement, 3 et 4 temps par mesure. On compare :

* l'accentuation de la bande basse (20–150 Hz) au premier temps, mesurée par
  le contraste de phase ``fold`` : moyenne des temps forts d'une phase moins
  moyenne des autres. C'est le critère principal, car la basse porte le
  premier temps d'une valse ;
* la périodicité de l'autosimilarité à l'échelle de la mesure : excédent du
  lag 3 (ou 6) par rapport à ses voisins dans l'autocorrélation de la même
  séquence d'accents ;
* un profil de valse sur les bandes médium/aigu, qui rattrape les valses
  acoustiques dont la basse est peu accentuée (La Vie en Rose), sans accepter
  un 4/4 dont la périodicité ternaire n'existe que dans le grave (Shine On).

Sous 0,6 de confiance ternaire, on retombe sur 4/4, comme le veut le contrat.
Le résultat reste déterministe : aucune source d'aléa, aucun horodatage.

Retour de basse
---------------
On suit l'énergie sous 60 Hz au niveau du temps. Une absence d'au moins deux
mesures sous un seuil relatif au morceau, suivie d'une attaque nette et d'un
niveau durablement supérieur, produit un événement ``bass-return``. L'espacement
minimal est de 8 s et aucun événement ne peut tomber à moins de 2 s d'une fin
de montée.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

LOW_BAND_HZ = (20.0, 150.0)
SUB_BAND_HZ = (20.0, 60.0)
MID_BAND_HZ = (150.0, 2000.0)
HIGH_BAND_HZ = (2000.0, 10000.0)

#: En dessous de cette confiance ternaire, le contrat impose le repli 4/4.
METER_MIN_CONFIDENCE = 0.6

#: Contraste minimal du contraste d'accent de la bande basse pour croire à 3/4.
#: Shine On plafonne à ~0,16 sur 3 à cause de sa basse 6/8 : sous ce plancher,
#: seul le profil médium/aigu peut encore conclure à une valse acoustique.
WALTZ_MIN_LOW_FOLD = 0.20
#: Excédent d'autocorrélation du lag 6 qui rattrape une valse à tempo doublé.
WALTZ_MIN_SIX_PEAK = 0.15
#: Variante : pic 6 seul, quand le tempo suivi double déjà la pulsation (Bolero).
WALTZ_SIX_ONLY_PEAK = 0.14
#: Période de mesure cherchée dans l'autocorrélation continue de la basse.
BAR_MIN_SEC = 0.25
BAR_MAX_SEC = 4.0
BAR_RATIO_TOLERANCE = 0.25
BAR_MIN_SCORE = 0.45
#: Marge minimale du profil médium/aigu (valse acoustique sans basse marquée).
WALTZ_MIN_TONE_MARGIN = 0.05
#: Tolérance de recalage de la grille de temps. La correction de retard de
#: groupe vaut ~46 ms ; moyenner les accents sur ±50 ms rend la métrique
#: insensible à ce décalage (Shine On basculait sinon de 4/4 à 3/4).
BEAT_GRID_TOLERANCE_SEC = 0.05

BASS_RETURN_MIN_SPACING_SEC = 8.0
BASS_RETURN_BUILD_GUARD_SEC = 2.0
#: Deux mesures d'absence au minimum.
BASS_RETURN_MIN_ABSENCE_BARS = 2
#: Part minimale du sous-grave dans l'énergie totale. Un orchestre sans basse
#: électronique (Bolero : 0,002 ; Gymnopédie : 0,021) reste sous ce plancher,
#: tandis que l'électro et le rap du corpus dépassent 0,04.
BASS_RETURN_MIN_SUB_RATIO = 0.03


@dataclass(frozen=True)
class MeterDecision:
    """Verdict de métrique et preuves associées (valeurs non exposées au client)."""

    beats_per_bar: int
    confidence: float
    low_fold: dict[int, float]
    low_peak: dict[int, float]

    def as_dict(self) -> dict[str, float | int]:
        return {
            "beatsPerBar": self.beats_per_bar,
            "confidence": self.confidence,
            "lowFold3": self.low_fold.get(3, 0.0),
            "lowFold4": self.low_fold.get(4, 0.0),
            "lowPeak6": self.low_peak.get(6, 0.0),
        }


def _band_mask(frequencies: np.ndarray, band: tuple[float, float]) -> np.ndarray:
    low, high = band
    return (frequencies >= low) & (frequencies < high)


def _beat_energy(
    spectrum: np.ndarray,
    frequencies: np.ndarray,
    beats: list[float],
    frame_times: np.ndarray,
    band: tuple[float, float],
) -> np.ndarray:
    """Énergie moyenne d'une bande sur chaque intervalle entre deux temps.

    Les valeurs sont compressées en log : la dynamique d'une basse électronique
    couvre plusieurs ordres de grandeur, et un seuil linéaire rendrait les
    passages calmes inaudibles pour le détecteur.
    """
    mask = _band_mask(frequencies, band)
    if not mask.any() or not beats or frame_times.size == 0:
        return np.zeros(0)
    energy = spectrum[mask].sum(axis=0)
    beat_times = np.asarray(beats, dtype=float)
    offsets = (-BEAT_GRID_TOLERANCE_SEC, 0.0, BEAT_GRID_TOLERANCE_SEC)
    per_offset: list[np.ndarray] = []
    for offset in offsets:
        indices = np.searchsorted(frame_times, beat_times + offset, side="left")
        indices = np.clip(indices, 0, max(energy.size - 1, 0))
        step = int(round(float(np.median(np.diff(indices))))) if indices.size > 1 else 1
        step = max(step, 1)
        values = []
        for position, start in enumerate(indices):
            end = indices[position + 1] if position + 1 < indices.size else start + step
            end = min(max(int(end), int(start) + 1), energy.size)
            start = min(int(start), energy.size - 1)
            values.append(float(np.mean(energy[start:end])))
        per_offset.append(np.asarray(values, dtype=float))
    values = np.mean(np.stack(per_offset, axis=0), axis=0)
    return np.log1p(values * 500.0)


def _fold(values: np.ndarray, meter: int) -> float:
    """Contraste d'accent : phase la plus forte moins le reste des temps.

    Le décalage de phase du suivi de tempo est ignoré : on essaie les ``meter``
    phases et on garde la meilleure. Une valse reste une valse quel que soit le
    temps que le tracker a choisi comme premier.
    """
    if values.size < meter * 2:
        return 0.0
    centered = np.asarray(values, dtype=float)
    deviation = float(np.std(centered))
    if deviation < 1e-9:
        return 0.0
    centered = (centered - float(np.mean(centered))) / deviation
    positions = np.arange(centered.size) % meter
    best = -1.0
    for phase in range(meter):
        mask = positions == phase
        if mask.sum() < 1 or (~mask).sum() < 1:
            continue
        best = max(best, float(np.mean(centered[mask]) - np.mean(centered[~mask])))
    return best


def _autocorrelation(values: np.ndarray, lag: int) -> float:
    if values.size <= lag + 2:
        return 0.0
    centered = np.asarray(values, dtype=float)
    deviation = float(np.std(centered))
    if deviation < 1e-9:
        return 0.0
    centered = centered - float(np.mean(centered))
    total = float(np.sum(centered * centered))
    if total < 1e-9:
        return 0.0
    return float(np.dot(centered[:-lag], centered[lag:]) / total)


def _local_peak(values: np.ndarray, lag: int) -> float:
    """Excédent du lag par rapport à la moyenne de ses deux voisins."""
    neighbours = [_autocorrelation(values, lag - 1), _autocorrelation(values, lag + 1)]
    return _autocorrelation(values, lag) - float(np.mean(neighbours))


def _clip_confidence(value: float) -> float:
    return round(float(min(max(value, 0.0), 1.0)), 3)


def _dominant_bar(
    spectrum: np.ndarray, frequencies: np.ndarray, frame_rate: float
) -> tuple[int | None, float, float]:
    """Période dominante de la basse, rapportée au temps suivi.

    Certaines valses (Blue Danube) sont suivies à un tempo qui ne correspond
    pas à la pulsation réelle : le repli par accents au niveau des temps ne voit
    alors aucune période. L'autocorrélation **continue** de la bande basse
    retrouve la période de mesure (oom-pah-pah) indépendamment de la grille de
    temps ; on la compare au temps médian pour décider 3, 4, 6 ou 8.
    """
    mask = _band_mask(frequencies, LOW_BAND_HZ)
    if not mask.any() or frame_rate <= 0:
        return None, 0.0, 0.0
    envelope = np.log1p(spectrum[mask].sum(axis=0).astype(float) * 500.0)
    if envelope.size < 4:
        return None, 0.0, 0.0
    centered = envelope - float(np.mean(envelope))
    spectrum_fft = np.fft.rfft(centered)
    autocorr = np.fft.irfft(spectrum_fft * np.conjugate(spectrum_fft), n=centered.size)
    if autocorr[0] <= 1e-9:
        return None, 0.0, 0.0
    autocorr = autocorr / autocorr[0]
    min_lag = max(1, int(BAR_MIN_SEC * frame_rate))
    max_lag = min(int(BAR_MAX_SEC * frame_rate), autocorr.size - 2)
    if max_lag <= min_lag:
        return None, 0.0, 0.0
    best_lag = min_lag
    best_score = -1.0
    for lag in range(min_lag, max_lag + 1):
        is_peak = autocorr[lag] > autocorr[lag - 1] and autocorr[lag] >= autocorr[lag + 1]
        if is_peak and autocorr[lag] > best_score:
            best_score = float(autocorr[lag])
            best_lag = lag
    if best_score < BAR_MIN_SCORE:
        return None, best_score, 0.0
    return best_lag, best_score, best_lag / frame_rate


def estimate_meter(
    spectrum: np.ndarray,
    frequencies: np.ndarray,
    frame_times: np.ndarray,
    beats: list[float],
) -> MeterDecision:
    """Décide 3/4 ou 4/4 et renvoie la confiance associée."""
    if not beats or len(beats) < 8 or spectrum.size == 0:
        return MeterDecision(4, METER_MIN_CONFIDENCE, {}, {})

    low = _beat_energy(spectrum, frequencies, beats, frame_times, LOW_BAND_HZ)
    mid = _beat_energy(spectrum, frequencies, beats, frame_times, MID_BAND_HZ)
    high = _beat_energy(spectrum, frequencies, beats, frame_times, HIGH_BAND_HZ)
    if low.size < 8:
        return MeterDecision(4, METER_MIN_CONFIDENCE, {}, {})

    low_fold = {meter: _fold(low, meter) for meter in (3, 4, 6, 8)}
    low_peak = {meter: _local_peak(low, meter) for meter in (3, 4, 6, 8)}
    mid_fold = {meter: _fold(mid, meter) for meter in (3, 4)}
    high_fold = {meter: _fold(high, meter) for meter in (3, 4)}

    # 1. Preuve principale : accent de basse sur le premier temps. Le lag 6
    #    couvre les valses dont le tempo a été suivi au double (Bolero).
    strong_low = (
        low_fold[3] >= WALTZ_MIN_LOW_FOLD
        and (low_fold[3] > low_fold[4] or low_peak[6] >= WALTZ_MIN_SIX_PEAK)
    ) or (low_peak[6] >= WALTZ_SIX_ONLY_PEAK and low_fold[3] >= 0.10)
    # 2. Profil de valse acoustique : les trois bandes s'accordent sur 3, et la
    #    basse ne contredit pas (La Vie en Rose). Shine On échoue ici parce que
    #    sa basse est plus périodique sur 4 que sur 3.
    tone_margin = min(mid_fold[3] - mid_fold[4], high_fold[3] - high_fold[4])
    tone_waltz = (
        tone_margin >= WALTZ_MIN_TONE_MARGIN and low_fold[3] > low_fold[4] and low_fold[3] >= 0.05
    )

    if strong_low or tone_waltz:
        if strong_low:
            margin = max(low_fold[3] - low_fold[4], low_peak[6] - WALTZ_MIN_SIX_PEAK)
            evidence = max(low_fold[3], low_peak[6])
        else:
            margin = tone_margin - WALTZ_MIN_TONE_MARGIN
            evidence = max(low_fold[3], tone_margin)
        confidence = 0.6 + 0.4 * min(max(0.4 * evidence + 0.6 * margin, 0.0) / 0.35, 1.0)
        return MeterDecision(3, _clip_confidence(confidence), low_fold, low_peak)

    # 3. Repli de période : lorsque la grille de temps ne porte aucune
    #    accentuation exploitable (valse suivie à un tempo étranger), la période
    #    dominante de la basse tranche. On n'accepte que si ce pic est le plus
    #    fort de l'autocorrélation, pour ne pas prendre un motif de 3 temps
    #    isolé dans un 4/4 pour une mesure.
    frame_step = float(np.median(np.diff(frame_times))) if frame_times.size > 1 else 0.0
    bar_lag, bar_score, bar_sec = _dominant_bar(
        spectrum, frequencies, 1.0 / frame_step if frame_step > 0 else 0.0
    )
    if bar_lag is not None and len(beats) > 1:
        beat_period = float(np.median(np.diff(np.asarray(beats, dtype=float))))
        if beat_period > 0:
            ratio = bar_sec / beat_period
            ratios = [ratio]
            # Le suivi de tempo peut être à l'octave (99 BPM au lieu de 172) :
            # si le rapport n'est déjà proche d'un nombre entier de temps, on
            # essaie aussi la pulsation deux fois plus rapide.
            if abs(ratio - round(ratio)) > 0.25:
                ratios.append(ratio * 2.0)
            candidates = [
                (abs(candidate - value), value)
                for candidate in ratios
                for value in (3.0, 4.0, 6.0, 8.0)
            ]
            distance, value = min(candidates)
            if distance <= BAR_RATIO_TOLERANCE:
                bar_meter = 3 if value in (3.0, 6.0) else 4
                if bar_meter == 3:
                    confidence = 0.6 + 0.4 * min(max((bar_score - BAR_MIN_SCORE) / 0.30, 0.0), 1.0)
                    return MeterDecision(3, _clip_confidence(confidence), low_fold, low_peak)

    # Repli 4/4 : confiance d'autant plus haute que la preuve binaire est nette.
    binary = max(
        low_fold[4] - low_fold[3],
        low_fold[8] - low_fold[6],
        low_peak[4] - low_peak[3],
        low_peak[8] - low_peak[6],
    )
    confidence = 0.6 + 0.4 * min(max(binary, 0.0) / 0.30, 1.0)
    return MeterDecision(4, _clip_confidence(confidence), low_fold, low_peak)


def _sub_bass(
    spectrum: np.ndarray,
    frequencies: np.ndarray,
    frame_times: np.ndarray,
    beats: list[float],
) -> np.ndarray:
    """Énergie sous 60 Hz, moyennée sur chaque temps."""
    mask = _band_mask(frequencies, SUB_BAND_HZ)
    if not mask.any() or not beats:
        return np.zeros(0)
    energy = spectrum[mask].sum(axis=0)
    indices = np.searchsorted(frame_times, np.asarray(beats, dtype=float), side="left")
    indices = np.clip(indices, 0, max(energy.size - 1, 0))
    step = int(round(float(np.median(np.diff(indices))))) if indices.size > 1 else 1
    step = max(step, 1)
    out = []
    for position, start in enumerate(indices):
        end = indices[position + 1] if position + 1 < indices.size else start + step
        end = min(max(int(end), int(start) + 1), energy.size)
        start = min(int(start), energy.size - 1)
        out.append(float(np.mean(energy[start:end])))
    return np.log1p(np.asarray(out, dtype=float) * 1000.0)


def detect_bass_returns(
    spectrum: np.ndarray,
    frequencies: np.ndarray,
    frame_times: np.ndarray,
    beats: list[float],
    meter: int,
    builds: list[dict],
    duration: float,
) -> list[dict]:
    """Détecte les retours de basse après une absence d'au moins deux mesures."""
    if not spectrum.size or not beats or meter not in (3, 4):
        return []
    values = _sub_bass(spectrum, frequencies, frame_times, beats)
    if values.size < meter * 4:
        return []
    sub_mask = _band_mask(frequencies, SUB_BAND_HZ)
    if not sub_mask.any():
        return []
    sub_ratio = float(np.mean(spectrum[sub_mask].sum(axis=0))) / max(
        float(np.mean(spectrum.sum(axis=0))), 1e-12
    )
    if not np.isfinite(sub_ratio) or sub_ratio < BASS_RETURN_MIN_SUB_RATIO:
        return []
    # La présence/absence se juge sur une moyenne d'une mesure : les creux
    # d'un seul temps (respiration, kick fantôme) ne doivent pas casser une
    # absence réelle, mais l'attaque reste mesurée sur la valeur brute.
    window = max(meter, 1)
    smoothed = (
        np.convolve(values, np.ones(window) / window, mode="same")
        if values.size >= window
        else values
    )
    low = float(np.quantile(smoothed, 0.10))
    high = float(np.quantile(smoothed, 0.90))
    spread = high - low
    if not np.isfinite(spread) or spread < 0.18:
        # Pas de dynamique sous 60 Hz : morceau sans basse électronique.
        return []
    silence = low + 0.30 * spread
    present = low + 0.60 * spread
    minimum_run = meter * BASS_RETURN_MIN_ABSENCE_BARS

    candidates: list[dict] = []
    index = 0
    while index < values.size:
        if smoothed[index] >= silence:
            index += 1
            continue
        start = index
        while index < values.size and smoothed[index] < silence:
            index += 1
        run = index - start
        if run < minimum_run or index >= values.size:
            continue
        # La moyenne glissante peut franchir le seuil un temps avant la vraie
        # attaque : on cherche dans la mesure suivante le premier temps qui
        # atteint le niveau « présent » avec une attaque nette.
        return_index = None
        for candidate_index in range(index, min(index + meter, values.size)):
            candidate_attack = float(values[candidate_index]) - float(values[candidate_index - 1])
            if float(values[candidate_index]) >= present and candidate_attack >= 0.12 * spread:
                return_index = candidate_index
                break
        if return_index is None:
            continue
        after = float(values[return_index])
        before = float(np.mean(values[start:index]))
        strength = (after - before) / spread
        candidates.append(
            {
                "t": round(float(beats[return_index]), 3),
                "kind": "bass-return",
                "strength": round(float(min(max(strength, 0.0), 1.0)), 3),
            }
        )

    # Aucun événement à moins de 2 s d'une fin de montée.
    candidates = [
        event
        for event in candidates
        if all(
            abs(event["t"] - float(build["end"])) >= BASS_RETURN_BUILD_GUARD_SEC for build in builds
        )
    ]
    # Espacement minimal : on garde le retour le plus fort de chaque grappe.
    kept: list[dict] = []
    for event in sorted(candidates, key=lambda item: (-item["strength"], item["t"])):
        if all(abs(event["t"] - other["t"]) >= BASS_RETURN_MIN_SPACING_SEC for other in kept):
            kept.append(event)
    kept.sort(key=lambda item: item["t"])
    return [event for event in kept if 0.0 <= event["t"] <= duration]


def analyse_meter_and_events(
    spectrum: np.ndarray,
    frequencies: np.ndarray,
    frame_times: np.ndarray,
    beats: list[float],
    builds: list[dict],
    duration: float,
) -> tuple[int, float, list[dict]]:
    """Point d'entrée unique appelé par le bloc ``vague3:metrique``."""
    decision = estimate_meter(spectrum, frequencies, frame_times, beats)
    events = detect_bass_returns(
        spectrum,
        frequencies,
        frame_times,
        beats,
        decision.beats_per_bar,
        builds,
        duration,
    )
    return decision.beats_per_bar, decision.confidence, events
