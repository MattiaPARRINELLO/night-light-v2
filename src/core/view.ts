import type { Analysis, Build, Point, Section } from "../types";
import { clamp01, lowerBound, lowerBoundNumbers, sampleAt } from "./series";

const BEAT_TAU = 0.11;

/**
 * Aire cumulée sous une courbe `[temps, valeur]`, point par point.
 *
 * Sert à intégrer une vitesse qui dépend de l'énergie : la phase d'une onde est
 * l'intégrale de sa vitesse, jamais `temps × vitesse`. Cette seconde forme fait
 * sauter la phase d'autant plus que le morceau avance — la moindre variation
 * d'énergie emballe alors l'effet. Les courbes sont linéaires entre deux points,
 * donc chaque segment se mesure exactement, comme un trapèze.
 */
function cumulativeArea(points: Point[]): number[] {
  const area: number[] = points.map(() => 0);
  for (let index = 1; index < points.length; index += 1) {
    const before = points[index - 1];
    const current = points[index];
    if (before === undefined || current === undefined) continue;
    const span = current[0] - before[0];
    area[index] = (area[index - 1] ?? 0) + (span > 0 ? (before[1] + current[1]) * 0.5 * span : 0);
  }
  return area;
}

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

  /** Montées triées par début, pour trouver la montée courante en binaire. */
  private readonly buildsByStart: Build[];
  private readonly buildStarts: number[];
  /** Montées triées par fin, pour ne balayer que la fenêtre utile. */
  private readonly buildsByEnd: Build[];
  private readonly buildEnds: number[];
  /** Aire cumulée sous la courbe d'énergie, pour l'intégrer en O(log n). */
  private readonly energyArea: number[];

  constructor(analysis: Analysis) {
    this.analysis = analysis;
    this.duration = analysis.duration;
    this.tempo = analysis.tempo;
    this.beatPeriod = analysis.beatPeriod;
    this.beats = analysis.beats;
    this.onsets = analysis.onsets;

    this.buildsByStart = [...analysis.builds].sort((left, right) => left.start - right.start);
    this.buildStarts = this.buildsByStart.map((build) => build.start);
    this.buildsByEnd = [...analysis.builds].sort((left, right) => left.end - right.end);
    this.buildEnds = this.buildsByEnd.map((build) => build.end);
    this.energyArea = cumulativeArea(analysis.energy);
  }

  energyAt(t: number): number {
    return sampleAt(this.analysis.energy, t);
  }

  /**
   * Intégrale de l'énergie de 0 à `t`, en valeur·seconde.
   *
   * Permet de faire dépendre une vitesse de l'énergie sans que la phase
   * résultante s'emballe : la vitesse instantanée vaut alors exactement
   * `énergie(t)`, quelle que soit la position dans le morceau.
   */
  energyIntegralAt(t: number): number {
    const points = this.analysis.energy;
    if (points.length === 0 || t <= 0) return 0;
    const index = lowerBound(points, t);
    if (index < 0) return 0;
    const base = this.energyArea[index] ?? 0;
    const current = points[index];
    const next = points[index + 1];
    if (current === undefined || next === undefined || next[0] <= current[0] || t <= current[0]) {
      return base;
    }
    const ratio = (t - current[0]) / (next[0] - current[0]);
    const value = current[1] + (next[1] - current[1]) * ratio;
    return base + (current[1] + value) * 0.5 * (t - current[0]);
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

  /** Dernier temps fort à ou avant `t`, `-Infinity` s'il n'y en a aucun. */
  lastBeatAt(t: number): number {
    const beats = this.beatsIn(t - 10, t);
    return beats.length > 0 ? (beats[beats.length - 1] ?? -Infinity) : -Infinity;
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

  /**
   * Montée courante à l'instant `t`, sinon `null`.
   *
   * Recherche binaire sur les débuts : le rendu appelle cette méthode plusieurs
   * fois par image, un balayage linéaire de toutes les montées coûterait cher
   * sur un morceau long. Les montées ne se chevauchent pas, donc la dernière
   * commencée avant `t` est la seule candidate.
   */
  buildAt(t: number): Build | null {
    const index = lowerBoundNumbers(this.buildStarts, t);
    if (index < 0) return null;
    const build = this.buildsByStart[index];
    return build !== undefined && t < build.end ? build : null;
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
    for (const build of this.buildsEndingIn(t - DROP_SPAN_SEC, t + DROP_ANTICIPATION_SEC)) {
      const age = t - build.end;
      const anticipation = age < 0 ? 0.35 * (1 + age / DROP_ANTICIPATION_SEC) : 1;
      const value = (age < 0 ? anticipation : Math.exp(-age / 0.42) * anticipation) * build.strength;
      if (value > peak) peak = value;
    }
    return clamp01(peak);
  }

  /**
   * Intensité de l'impact d'une montée **après** sa retombée, 0 avant l'impact.
   *
   * `buildIntensity` anticipe de 0,3 s (le spectacle se tend avant la reprise) ;
   * pour le flash global, la latence doit rester nulle : il naît sur l'impact,
   * pas avant. Cette variante ne regarde que les montées déjà terminées.
   */
  dropImpact(t: number): number {
    let peak = 0;
    for (const build of this.buildsEndingIn(t - DROP_SPAN_SEC, t)) {
      const value = Math.exp(-(t - build.end) / 0.42) * build.strength;
      if (value > peak) peak = value;
    }
    return clamp01(peak);
  }

  /**
   * Montées dont la fin tombe dans `[from, to]`, triées par fin croissante.
   * En binaire : le rendu n'a jamais besoin de toutes les montées du morceau,
   * seulement de celles qui sont actives à l'instant courant.
   */
  buildsEndingIn(from: number, to: number): Build[] {
    const out: Build[] = [];
    let index = lowerBoundNumbers(this.buildEnds, from);
    if (index < 0) index = 0;
    while (index < this.buildEnds.length) {
      const build = this.buildsByEnd[index];
      if (build === undefined || build.end > to) break;
      if (build.end >= from) out.push(build);
      index += 1;
    }
    return out;
  }

  /** Fin de la dernière montée terminée, `-Infinity` si aucune. */
  lastBuildEnd(t: number): number {
    const index = lowerBoundNumbers(this.buildEnds, t);
    return index < 0 ? -Infinity : this.buildEnds[index] ?? -Infinity;
  }
}

const DROP_ANTICIPATION_SEC = 0.3;
export const DROP_SPAN_SEC = 2.6;

export function createTrackView(analysis: Analysis): TrackView {
  return new TrackView(analysis);
}
