import type { Analysis, Build, Section } from "../types";
import { clamp01, lowerBoundNumbers, sampleAt } from "./series";

const BEAT_TAU = 0.11;

/**
 * Vue de lecture d'une analyse : accès O(log n) à l'état musical à un instant
 * donné. Le rendu ne dépend que de cette vue et du temps, ce qui garantit une
 * image identique après une pause, une reprise ou un retour en arrière.
 */
export class TrackView {
  readonly analysis: Analysis;
  readonly duration: number;
  readonly tempo: number;
  readonly beatPeriod: number;
  readonly beats: number[];
  readonly onsets: number[];

  constructor(analysis: Analysis) {
    this.analysis = analysis;
    this.duration = analysis.duration;
    this.tempo = analysis.tempo;
    this.beatPeriod = analysis.beatPeriod;
    this.beats = analysis.beats;
    this.onsets = analysis.onsets;
  }

  energyAt(t: number): number {
    return sampleAt(this.analysis.energy, t);
  }

  bassAt(t: number): number {
    return sampleAt(this.analysis.bass, t);
  }

  midAt(t: number): number {
    return sampleAt(this.analysis.mid, t);
  }

  highAt(t: number): number {
    return sampleAt(this.analysis.high, t);
  }

  /** Proportion d'aigus dans le spectre courant, 0..1 (facies sonore). */
  brightnessAt(t: number): number {
    const bass = this.bassAt(t);
    const mid = this.midAt(t);
    const high = this.highAt(t);
    const total = bass + mid + high;
    if (total <= 1e-6) return 0.33;
    return clamp01(0.15 + 0.7 * (high / total));
  }

  sectionAt(t: number): Section {
    const sections = this.analysis.sections;
    if (sections.length === 0) {
      return { start: 0, end: Math.max(this.duration, 0.001), label: "intense", energy: 0.5 };
    }
    let low = 0;
    let high = sections.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      const section = sections[mid];
      if (section !== undefined && section.start <= t) low = mid;
      else high = mid - 1;
    }
    const section = sections[low];
    if (section !== undefined && t <= section.end) return section;
    const first = sections[0];
    if (first !== undefined && t < first.start) return first;
    const last = sections[sections.length - 1] ?? section;
    return last ?? { start: 0, end: Math.max(this.duration, 0.001), label: "intense", energy: 0.5 };
  }

  /** Temps forts compris dans `[from, to]`. */
  beatsIn(from: number, to: number): number[] {
    const out: number[] = [];
    if (this.beats.length === 0) return out;
    let index = lowerBoundNumbers(this.beats, from) + 1;
    if (index < 0) index = 0;
    while (index < this.beats.length) {
      const beat = this.beats[index];
      if (beat === undefined || beat > to) break;
      out.push(beat);
      index += 1;
    }
    return out;
  }

  /** Attaques comprises dans `[from, to]`. */
  onsetsIn(from: number, to: number): number[] {
    const out: number[] = [];
    let index = lowerBoundNumbers(this.onsets, from) + 1;
    if (index < 0) index = 0;
    while (index < this.onsets.length) {
      const onset = this.onsets[index];
      if (onset === undefined || onset > to) break;
      out.push(onset);
      index += 1;
    }
    return out;
  }

  /**
   * Impulsion de temps fort : 1 immédiatement après un temps, décroissance
   * exponentielle sur `window` secondes, 0 en dehors.
   */
  beatPulse(t: number, window = 0.45): number {
    const beats = this.beatsIn(t - window, t);
    let peak = 0;
    for (const beat of beats) {
      const age = t - beat;
      const value = Math.exp(-age / BEAT_TAU);
      if (value > peak) peak = value;
    }
    return peak;
  }

  /** Battement du morceau (phase 0..1 dans la mesure), utile pour les motifs. */
  beatPhase(t: number): number {
    if (this.beats.length > 0) {
      const index = Math.max(lowerBoundNumbers(this.beats, t), 0);
      const current = this.beats[index];
      const next = this.beats[index + 1];
      if (current === undefined || next === undefined || next <= current) return 0;
      return clamp01((t - current) / (next - current));
    }
    if (this.beatPeriod <= 0) return 0;
    return clamp01(((t % this.beatPeriod) + this.beatPeriod) / this.beatPeriod);
  }

  /** Numéro du temps fort courant (0 si inconnu). */
  beatIndexAt(t: number): number {
    return Math.max(lowerBoundNumbers(this.beats, t), 0);
  }

  /** Montée en cours à l'instant `t`, sinon `null`. */
  buildAt(t: number): Build | null {
    for (const build of this.analysis.builds) {
      if (t >= build.start && t < build.end) return build;
    }
    return null;
  }

  /** Progression 0..1 dans la montée courante (0 si aucune). */
  buildProgress(t: number): number {
    const build = this.buildAt(t);
    if (build === null) return 0;
    const span = build.end - build.start;
    if (span <= 0) return 1;
    return clamp01((t - build.start) / span);
  }

  /** Pente d'énergie sur `window` secondes, -1..1. */
  energyTrend(t: number, window = 1.5): number {
    const now = this.energyAt(t);
    const before = this.energyAt(Math.max(t - window, 0));
    return clamp01((now - before) * 1.6);
  }

  /**
   * Intensité d'un « drop » : le moment où une montée retombe sur l'impact.
   * 1 au point d'impact, décroissance rapide sur ~1,5 s, et une courte
   * anticipation juste avant (le spectacle se tend avant la reprise).
   */
  buildIntensity(t: number): number {
    let peak = 0;
    for (const build of this.analysis.builds) {
      const age = t - build.end;
      if (age < -DROP_ANTICIPATION_SEC) continue;
      if (age > DROP_SPAN_SEC) continue;
      const anticipation = age < 0 ? 0.35 * (1 + age / DROP_ANTICIPATION_SEC) : 1;
      const value = (age < 0 ? anticipation : Math.exp(-age / 0.42) * anticipation) * build.strength;
      if (value > peak) peak = value;
    }
    return clamp01(peak);
  }
}

const DROP_ANTICIPATION_SEC = 0.3;
export const DROP_SPAN_SEC = 2.6;

export function createTrackView(analysis: Analysis): TrackView {
  return new TrackView(analysis);
}
