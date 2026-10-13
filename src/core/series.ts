import type { Point } from "../types";

/** Recherche binaire : index du dernier point dont le temps est <= t. */
export function lowerBound(points: Point[], t: number): number {
  let lo = 0;
  let hi = points.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const point = points[mid];
    if (point === undefined) break;
    if (point[0] <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** Recherche binaire sur un tableau de nombres triés : index du dernier élément <= x. */
export function lowerBoundNumbers(values: number[], x: number): number {
  let lo = 0;
  let hi = values.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const value = values[mid];
    if (value === undefined) break;
    if (value <= x) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * Échantillonne une courbe `[temps, valeur]` à l'instant `t`.
 * La valeur est interpolée linéairement entre les deux points encadrants.
 */
export function sampleAt(points: Point[], t: number): number {
  if (points.length === 0) return 0;
  const index = lowerBound(points, t);
  if (index < 0) return points[0]?.[1] ?? 0;
  const current = points[index];
  const next = points[index + 1];
  if (current === undefined || next === undefined) return current?.[1] ?? 0;
  if (next[0] <= current[0]) return current[1];
  const ratio = (t - current[0]) / (next[0] - current[0]);
  return current[1] + (next[1] - current[1]) * ratio;
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/**
 * Paliers de qualité utilisés par le rendu.
 *
 * La qualité brute issue du fps varie en continu ; la passer telle quelle à
 * `count()` fait changer le nombre d'éléments d'une image à l'autre (de 1 à 3
 * unités pour un écart de 0,02). Comme presque toutes les familles calculent
 * leurs positions avec `i / n`, un seul cran de différence décalait tout d'un
 * coup : c'était la cause du rendu qui « saute ». Un petit nombre de paliers
 * borne le problème : le rendu ne change plus que quelques fois par morceau.
 */
export const QUALITY_STEPS = [0.3, 0.45, 0.6, 0.75, 0.9, 1] as const;

/** Arrondit une qualité continue au palier le plus proche. */
export function quantizeQuality(quality: number): number {
  const value = clamp01(quality);
  let best: number = QUALITY_STEPS[0];
  for (const step of QUALITY_STEPS) {
    if (Math.abs(step - value) < Math.abs(best - value)) best = step;
  }
  return best;
}

export function mix(a: number, b: number, ratio: number): number {
  return a + (b - a) * ratio;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Bruit déterministe et stable, indexé par entier. */
export function hash01(seed: number): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}
