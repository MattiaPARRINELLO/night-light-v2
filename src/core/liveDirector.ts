/**
 * Direction musicale du mode direct.
 *
 * La capture audio ne fournit que des niveaux lissés (rms, bandes,
 * transitoire). Le mode analysé, lui, dispose d'une grille de temps forts,
 * d'une courbe d'énergie et de montées détectées. Sans ces évènements, le
 * direct restait un fond qui respirait à peine : pas d'impact, pas de montée,
 * pas de flash admis.
 *
 * Ce module reconstruit ces évènements en temps réel. Il ne devine pas le
 * morceau : il suit ce qui est réellement audible. Un temps fort est une
 * attaque (transitoire) franche, un impact est un saut de niveau au-dessus de
 * la moyenne lente, une montée est une énergie qui grimpe sur plusieurs
 * secondes. Tout ce qui n'est pas prouvé reste à zéro, comme dans l'analyse.
 */

import type { LiveAudioFeatures } from "./liveAudio";
import { isSilent } from "./liveAudio";

/** État musical instantané dérivé du direct, dans l'échelle du rendu analysé. */
export interface LiveMusic {
  /** Niveau normalisé 0..1 : l'énergie réellement perçue, gain automatique appliqué. */
  level: number;
  /** Énergie de rendu, 0..1 : niveau et attaque combinés. */
  energy: number;
  /** Enveloppe du dernier temps fort, 0..1 (décroissance depuis l'attaque). */
  beat: number;
  /** Phase dans le temps fort courant, 0..1. */
  beatPhase: number;
  /** Numéro du temps fort courant. */
  beatIndex: number;
  /** Secondes écoulées depuis le dernier temps fort (Infinity si aucun). */
  beatAge: number;
  /** Intervalle estimé entre deux temps forts, en secondes (0 si inconnu). */
  beatInterval: number;
  /** Enveloppe de l'impact courant, 0..1. */
  drop: number;
  /** Secondes écoulées depuis le dernier impact (Infinity si aucun). */
  dropAge: number;
  /** Force de l'impact au moment où il a frappé, 0..1. */
  impactStrength: number;
  /** Progression dans une montée, 0..1 (0 si aucune). */
  build: number;
  /** Force de la montée courante, 0..1. */
  buildStrength: number;
  /** Vitesse de montée de l'énergie, 0..1 (0 quand ça descend). */
  surge: number;
  /** Un flash est-il autorisé à naître maintenant ? */
  admitted: boolean;
  /** Tempo estimé, en battements par minute (0 tant qu'aucun temps n'est détecté). */
  bpm: number;
}

export const EMPTY_LIVE_MUSIC: LiveMusic = {
  level: 0,
  energy: 0,
  beat: 0,
  beatPhase: 0,
  beatIndex: 0,
  beatAge: Infinity,
  beatInterval: 0,
  drop: 0,
  dropAge: Infinity,
  impactStrength: 0,
  build: 0,
  buildStrength: 0,
  surge: 0,
  admitted: false,
  bpm: 0,
};

/** En dessous de ce niveau, rien n'est musical : on laisse tout retomber. */
const SILENCE_LEVEL = 0.015;
/** Plancher de la référence de gain : évite une normalisation qui explose dans le bruit. */
const REFERENCE_FLOOR = 0.03;
/** Constante de temps de la référence : elle suit l'album, pas le passage. */
const REFERENCE_SEC = 12;
/** Gain appliqué autour de la référence : un morceau moyen vit autour de 0,7. */
const LEVEL_GAIN = 0.72;
/** Lissage rapide du niveau (attaque d'un coup, presque sans traînée). */
const FAST_SEC = 0.11;
/** Lissage lent : la référence de « niveau habituel » du morceau. */
const SLOW_SEC = 3.5;
/** Lissage rapide du rms brut, pour juger un saut d'impact. */
const RMS_FAST_SEC = 0.12;
/** Lissage lent du rms brut, référence du saut. */
const RMS_REF_SEC = 3.5;
/** Enveloppe d'un temps fort : assez courte pour battre, assez longue pour se voir. */
const BEAT_DECAY_SEC = 0.2;
/** Enveloppe d'un impact : plus large qu'un temps fort, l'impact occupe la salle. */
const DROP_DECAY_SEC = 0.95;
/** Deux impacts plus rapprochés que ça ne sont qu'un seul geste. */
const IMPACT_COOLDOWN_SEC = 2.8;
/** Fenêtre d'analyse de la pente d'énergie. */
const TREND_WINDOW_SEC = 2.5;
/** Longueur de l'historique conservé (secondes). */
const HISTORY_SEC = 4;
/** Intervalle minimal entre deux temps forts, en secondes. */
const MIN_BEAT_GAP_SEC = 0.18;
/** Intervalle maximal crédible entre deux temps forts. */
const MAX_BEAT_GAP_SEC = 2.4;
/** Un seul flash de temps fort sur ce nombre : le direct reste une salle, pas un stroboscope. */
const BEAT_FLASH_DIVISOR = 2;
/** Durée pendant laquelle un temps fort ou un impact ouvre un flash. */
const ADMITTED_AGE_SEC = 0.32;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Interpolation exponentielle indépendante de la cadence des images. */
function approach(current: number, target: number, dt: number, tauSec: number): number {
  if (dt <= 0) return current;
  const alpha = 1 - Math.exp(-dt / Math.max(tauSec, 0.001));
  return current + (target - current) * alpha;
}

/**
 * Détecteur d'évènements du direct.
 *
 * Une seule instance par session de capture. `update` peut être appelé à chaque
 * image : seule l'arrivée d'un nouvel échantillon (`updatedAt` différent)
 * déclenche la détection, les enveloppes continuent de décroître entre deux
 * échantillons.
 */
export class LiveDirector {
  /** Référence glissante de niveau : le gain automatique s'y accroche. */
  private reference = REFERENCE_FLOOR;
  /** Vrai dès le premier échantillon : la référence s'initialise sur lui. */
  private referenceReady = false;
  /** Niveau lissé rapidement (réaction). */
  private fast = 0;
  /** Niveau lissé lentement (référence). */
  private slow = 0;
  /** Rms brut lissé vite et lentement, pour les sauts d'impact. */
  private rmsFast = 0;
  private rmsRef = REFERENCE_FLOOR;
  /** Vrai dès le premier échantillon : la référence rms s'initialise sur lui. */
  private rmsRefReady = false;
  /** Moyenne lente du transitoire : seuil adaptatif des temps forts. */
  private transientAverage = 0.05;
  /** Horodatage du dernier échantillon pris en compte. */
  private lastSampleAt = -1;
  /** Dernier temps fort détecté et intervalle estimé. */
  private beatAt = -Infinity;
  private beatInterval = 0.5;
  private beatIndex = 0;
  private beatEnvelope = 0;
  /** Dernier impact détecté et sa force. */
  private impactAt = -Infinity;
  private impactStrength = 0;
  private dropEnvelope = 0;
  /** Montée en cours. */
  private build = 0;
  private surge = 0;
  /** Historique court du niveau, pour les pentes. */
  private history: Array<{ t: number; level: number; rms: number }> = [];
  /** Dernière image musicale produite. */
  private music: LiveMusic = { ...EMPTY_LIVE_MUSIC };
  private lastT = -1;

  /** Remet le détecteur à zéro, par exemple à la reconnexion de la capture. */
  reset(): void {
    this.reference = REFERENCE_FLOOR;
    this.referenceReady = false;
    this.fast = 0;
    this.slow = 0;
    this.rmsFast = 0;
    this.rmsRef = REFERENCE_FLOOR;
    this.rmsRefReady = false;
    this.transientAverage = 0.05;
    this.lastSampleAt = -1;
    this.beatAt = -Infinity;
    this.beatInterval = 0.5;
    this.beatIndex = 0;
    this.beatEnvelope = 0;
    this.impactAt = -Infinity;
    this.impactStrength = 0;
    this.dropEnvelope = 0;
    this.build = 0;
    this.surge = 0;
    this.history = [];
    this.music = { ...EMPTY_LIVE_MUSIC };
    this.lastT = -1;
  }

  /**
   * Fait avancer la direction musicale.
   *
   * @param t temps de la session live, en secondes.
   * @param features dernier état reçu de la capture.
   */
  update(t: number, features: LiveAudioFeatures): LiveMusic {
    const dt = this.lastT < 0 ? 0 : Math.max(0, t - this.lastT);
    this.lastT = t;

    const silent = isSilent(features) || features.state === "silent";
    const rms = Number.isFinite(features.rms) ? Math.max(0, features.rms) : 0;

    // Référence de gain : elle suit la moyenne du morceau (quelques secondes),
    // pas ses pics. Un morceau mixé bas remonte donc à l'échelle du rendu, et
    // une montée reste une montée au lieu d'être écrasée par le pic courant.
    if (!this.referenceReady && rms > 0) {
      this.reference = Math.max(REFERENCE_FLOOR, rms);
      this.referenceReady = true;
    } else {
      this.reference = approach(
        this.reference,
        Math.max(REFERENCE_FLOOR, silent ? this.reference : rms),
        dt,
        REFERENCE_SEC,
      );
    }
    // Normalisation : le niveau audible se lit relativement à la référence.
    // Sans elle, un morceau mixé bas restait dans les 10 % d'énergie et le show
    // ne dépassait jamais son plancher.
    const target = silent
      ? 0
      : clamp01((rms / Math.max(this.reference, REFERENCE_FLOOR)) * LEVEL_GAIN);

    this.fast = approach(this.fast, target, dt, FAST_SEC);
    this.slow = approach(this.slow, target, dt, SLOW_SEC);

    // Rms brut pour les sauts d'impact : un drop est un écart relatif au niveau
    // habituel, pas un volume absolu. L'échelle du morceau n'entre plus en jeu.
    if (!this.rmsRefReady && rms > 0) {
      this.rmsRef = rms;
      this.rmsFast = rms;
      this.rmsRefReady = true;
    } else {
      this.rmsFast = approach(this.rmsFast, rms, dt, RMS_FAST_SEC);
      this.rmsRef = approach(this.rmsRef, rms, dt, RMS_REF_SEC);
    }

    // Enveloppes : elles vivent même entre deux échantillons, sinon le flash
    // resterait figé pendant les 80 ms qui séparent deux messages SSE.
    this.beatEnvelope *= Math.exp(-dt / BEAT_DECAY_SEC);
    this.dropEnvelope *= Math.exp(-dt / DROP_DECAY_SEC);
    if (silent) {
      this.build = approach(this.build, 0, dt, 0.6);
      this.surge = approach(this.surge, 0, dt, 0.4);
    }

    if (features.updatedAt !== this.lastSampleAt) {
      this.lastSampleAt = features.updatedAt;
      this.detect(t, features, silent);
      this.record(t);
    }

    const level = this.fast;
    const beatAge = t - this.beatAt;
    const dropAge = t - this.impactAt;
    const beat = clamp01(this.beatEnvelope);
    // L'énergie de rendu combine le niveau tenu et l'attaque : c'est exactement
    // ce que fait le mode analysé avec `visibleEnergy` et le poids du temps fort.
    const energy = clamp01(level * 0.82 + beat * 0.3 + this.dropEnvelope * 0.18);
    const freshBeat = Number.isFinite(beatAge) && beatAge <= ADMITTED_AGE_SEC;
    const freshImpact = Number.isFinite(dropAge) && dropAge <= ADMITTED_AGE_SEC + 0.1;
    this.music = {
      level,
      energy,
      beat,
      beatPhase: Number.isFinite(beatAge) ? clamp01(beatAge / Math.max(this.beatInterval, 0.001)) : 0,
      beatIndex: this.beatIndex,
      beatAge,
      beatInterval: this.beatIndex > 0 ? this.beatInterval : 0,
      drop: clamp01(this.dropEnvelope),
      dropAge,
      impactStrength: this.impactStrength,
      build: clamp01(this.build),
      buildStrength: clamp01(level * 0.85 + this.beatEnvelope * 0.15),
      surge: clamp01(this.surge),
      admitted:
        freshImpact || (freshBeat && level > 0.18 && this.beatIndex % BEAT_FLASH_DIVISOR === 0),
      bpm: this.beatIndex > 0 ? 60 / Math.max(this.beatInterval, 0.001) : 0,
    };
    return this.music;
  }

  /** Détection sur un nouvel échantillon : temps forts, impacts, montées. */
  private detect(t: number, features: LiveAudioFeatures, silent: boolean): void {
    const level = this.fast;
    const transient = Number.isFinite(features.transient) ? clamp01(features.transient) : 0;
    const bass = Number.isFinite(features.bass) ? clamp01(features.bass) : 0;
    if (silent || level < SILENCE_LEVEL) {
      this.transientAverage = approach(this.transientAverage, 0, 0.08, 2);
      return;
    }

    // Seuil adaptatif : un morceau très percussif ne déclenche pas sur chaque
    // charley, un morceau doux garde ses attaques. Le plancher absolu évite que
    // le bruit de fond ne devienne un temps fort.
    this.transientAverage = approach(this.transientAverage, transient, 0.08, 2);
    const threshold = Math.max(0.1, this.transientAverage * 1.35);
    const gap = t - this.beatAt;
    const minGap = Math.min(
      MAX_BEAT_GAP_SEC,
      Math.max(MIN_BEAT_GAP_SEC, this.beatInterval * 0.42),
    );
    // Un temps fort porte une attaque. La basse n'est pas obligatoire (une
    // caisse claire compte aussi), mais une attaque sans aucune basse et sans
    // force est un hi-hat : elle ne fait pas battre la salle.
    const crash = transient >= threshold && gap >= minGap && level > 0.22;
    const porteuse = bass >= 0.2 || transient >= 0.45;
    if (crash && porteuse) {
      if (this.beatIndex > 0 && gap <= MAX_BEAT_GAP_SEC && gap >= MIN_BEAT_GAP_SEC) {
        this.beatInterval = approach(this.beatInterval, gap, 0.08, 0.35);
      }
      this.beatAt = t;
      this.beatIndex += 1;
      this.beatEnvelope = Math.max(this.beatEnvelope, clamp01(0.45 + 0.75 * transient));
    }

    // Impact : un saut du rms instantané au-dessus du rms habituel, accompagné
    // d'une vraie attaque. Une montée lente ne déclenche pas : elle prépare le
    // terrain, l'impact est le moment où la musique éclate.
    const jump = (this.rmsFast - this.rmsRef) / Math.max(this.rmsRef, REFERENCE_FLOOR);
    const cooldown = t - this.impactAt;
    const sharpJump = jump >= 0.25 && transient >= 0.38 && level >= 0.45;
    const hugeJump = jump >= 0.9 && transient >= 0.15 && level >= 0.5;
    if ((sharpJump || hugeJump) && cooldown >= IMPACT_COOLDOWN_SEC) {
      this.impactAt = t;
      this.impactStrength = clamp01(jump * 0.62 + transient * 0.45);
      this.dropEnvelope = Math.max(this.dropEnvelope, this.impactStrength);
      // L'impact est la conclusion d'une montée : la suivante repart de zéro.
      this.build = 0;
    }

    this.updateTrends(t);
  }

  /** Pente du rms brut : montée en cours et vitesse de la montée. */
  private updateTrends(t: number): void {
    const reference = this.rmsAt(t - TREND_WINDOW_SEC);
    const scale = Math.max(this.rmsRef, REFERENCE_FLOOR);
    const slope = reference === null ? 0 : (this.rmsFast - reference) / TREND_WINDOW_SEC / scale;
    const rising = slope > 0.04 && this.fast > 0.2;
    // Une pente de 0,1 par seconde (le niveau gagne 10 % de la référence chaque
    // seconde) vaut déjà une belle montée.
    const buildTarget = rising ? clamp01(slope * 2.5) : 0;
    // La montée s'installe en une seconde, retombe plus vite quand la musique
    // redescend : un drop doit trouver la montée déjà effacée.
    this.build = approach(this.build, buildTarget, 0.08, rising ? 1.1 : 0.35);
    const surgeTarget = rising ? clamp01(slope * 3) : 0;
    this.surge = approach(this.surge, surgeTarget, 0.08, 0.5);
  }

  /** Rms lissé le plus proche d'un instant passé, si l'historique le couvre. */
  private rmsAt(t: number): number | null {
    if (this.history.length === 0) return null;
    let candidate: number | null = null;
    for (let index = this.history.length - 1; index >= 0; index -= 1) {
      const sample = this.history[index]!;
      if (sample.t <= t) {
        candidate = sample.rms;
        break;
      }
    }
    return candidate;
  }

  /** Mémorise le niveau courant pour les pentes. */
  private record(t: number): void {
    this.history.push({ t, level: this.fast, rms: this.rmsFast });
    const floor = t - HISTORY_SEC;
    while (this.history.length > 0 && this.history[0]!.t < floor) this.history.shift();
  }
}
