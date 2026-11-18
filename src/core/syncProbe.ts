/**
 * Sonde de synchronisation audio ↔ show.
 *
 * Le show calé sur un lecteur externe ne sait rien de ce qui sort réellement
 * des enceintes : il ne connaît que la position MPRIS et la grille d'analyse du
 * fichier téléchargé. Un mauvais master, un silence d'intro différent ou un
 * retard d'affichage produisent donc un décalage que personne ne mesure.
 *
 * Cette sonde apporte la seule preuve disponible : elle compare l'enveloppe du
 * son capturé (niveau RMS) à l'enveloppe d'énergie que le show est en train de
 * dessiner. Les deux séries sont horodatées sur la même horloge, puis
 * corrélées pour trouver le décalage qui les superpose.
 *
 * Elle ne corrige rien : elle mesure. Une correction automatique suppose de
 * connaître la latence de la capture elle-même, sinon on avance le show de
 * tout le retard de mesure.
 */

/** Échantillon apparé : niveau entendu et énergie dessinée au même instant. */
interface ProbeSample {
  /** Horodatage epoch, en millisecondes. */
  at: number;
  /** Niveau capturé au moment de l'échantillon, 0..1. */
  level: number;
  /** Énergie de la courbe analysée à l'instant du show, 0..1. */
  energy: number;
}

export interface ProbeEstimate {
  /**
   * Décalage à appliquer au temps du show, en millisecondes.
   * Positif : le show est en retard, il faut l'avancer.
   */
  offsetMs: number;
  /** Corrélation au meilleur décalage, entre -1 et 1. */
  score: number;
  /** Nombre de points effectivement comparés. */
  samples: number;
}

export interface ProbeOptions {
  /** Décalage maximal recherché, en millisecondes. */
  maxLagMs?: number;
  /** Pas de la grille de comparaison, en millisecondes. */
  gridMs?: number;
  /** Durée minimale couverte par les échantillons, en secondes. */
  minSpanSec?: number;
}

const DEFAULT_MAX_LAG_MS = 800;
const DEFAULT_GRID_MS = 40;
const DEFAULT_MIN_SPAN_SEC = 4;
/** En dessous de cette variance, une série est plate : aucune corrélation n'a de sens. */
const MIN_VARIANCE = 1e-6;
/** Nombre minimal de points comparés pour publier une mesure. */
const MIN_PAIRS = 40;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Moyenne et écart-type d'un tableau, sans copie. */
function stats(values: number[]): { mean: number; variance: number } {
  if (values.length === 0) return { mean: 0, variance: 0 };
  let sum = 0;
  for (const value of values) sum += value;
  const mean = sum / values.length;
  let squares = 0;
  for (const value of values) {
    const delta = value - mean;
    squares += delta * delta;
  }
  return { mean, variance: squares / values.length };
}

export class SyncProbe {
  private samples: ProbeSample[] = [];

  constructor(private readonly windowSec = 24) {}

  /** Nombre d'échantillons conservés, pour l'overlay de debug. */
  get size(): number {
    return this.samples.length;
  }

  /** Ajoute une paire (niveau capturé, énergie dessinée) au même instant. */
  push(at: number, level: number, energy: number): void {
    if (!Number.isFinite(at) || !Number.isFinite(level) || !Number.isFinite(energy)) return;
    // Une horloge qui recule (changement d'heure, resynchronisation) invalide la
    // fenêtre : mieux vaut repartir de zéro que comparer deux temps mêlés.
    const last = this.samples[this.samples.length - 1];
    if (last !== undefined && at <= last.at) return;
    this.samples.push({ at, level: clamp01(level), energy: clamp01(energy) });
    const floor = at - this.windowSec * 1000;
    while (this.samples.length > 0 && this.samples[0]!.at < floor) this.samples.shift();
  }

  reset(): void {
    this.samples = [];
  }

  /**
   * Cherche le décalage qui superpose les deux enveloppes.
   *
   * Pour chaque candidat `k`, on compare l'énergie de l'échantillon `i` au
   * niveau de l'échantillon `i + k`. Le signe est ensuite retourné : un `k`
   * négatif signifie que le son est en avance sur le show, donc que le show doit
   * être avancé.
   */
  estimate(options: ProbeOptions = {}): ProbeEstimate | null {
    const maxLagMs = options.maxLagMs ?? DEFAULT_MAX_LAG_MS;
    const gridMs = options.gridMs ?? DEFAULT_GRID_MS;
    const minSpanSec = options.minSpanSec ?? DEFAULT_MIN_SPAN_SEC;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (first === undefined || last === undefined) return null;
    if ((last.at - first.at) / 1000 < minSpanSec) return null;

    // Rééchantillonnage sur une grille fixe : la cadence des images varie, et
    // une corrélation sur des pas irréguliers n'aurait pas de sens.
    const levels: number[] = [];
    const energies: number[] = [];
    let cursor = 0;
    for (let at = first.at; at <= last.at; at += gridMs) {
      while (cursor + 1 < this.samples.length && this.samples[cursor + 1]!.at <= at) cursor += 1;
      const sample = this.samples[cursor]!;
      levels.push(sample.level);
      energies.push(sample.energy);
    }
    if (levels.length < MIN_PAIRS) return null;

    const levelStats = stats(levels);
    const energyStats = stats(energies);
    if (levelStats.variance < MIN_VARIANCE || energyStats.variance < MIN_VARIANCE) return null;

    const maxLagSteps = Math.max(1, Math.round(maxLagMs / gridMs));
    let best: { lagSteps: number; score: number; pairs: number } | null = null;
    for (let lag = -maxLagSteps; lag <= maxLagSteps; lag += 1) {
      const pairs: Array<[number, number]> = [];
      for (let index = 0; index < energies.length; index += 1) {
        const other = index + lag;
        if (other < 0 || other >= levels.length) continue;
        pairs.push([energies[index]!, levels[other]!]);
      }
      if (pairs.length < MIN_PAIRS) continue;
      const score = correlation(pairs);
      if (score === null) continue;
      if (best === null || score > best.score) {
        best = { lagSteps: lag, score, pairs: pairs.length };
      }
    }
    if (best === null) return null;
    return {
      offsetMs: -best.lagSteps * gridMs,
      score: best.score,
      samples: best.pairs,
    };
  }
}

/** Corrélation de Pearson d'une liste de paires, `null` si une série est plate. */
function correlation(pairs: Array<[number, number]>): number | null {
  let sumX = 0;
  let sumY = 0;
  for (const [x, y] of pairs) {
    sumX += x;
    sumY += y;
  }
  const meanX = sumX / pairs.length;
  const meanY = sumY / pairs.length;
  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  for (const [x, y] of pairs) {
    const dx = x - meanX;
    const dy = y - meanY;
    covariance += dx * dy;
    varianceX += dx * dx;
    varianceY += dy * dy;
  }
  if (varianceX < MIN_VARIANCE * pairs.length || varianceY < MIN_VARIANCE * pairs.length) return null;
  return covariance / Math.sqrt(varianceX * varianceY);
}
