/**
 * Petits utilitaires partagés par le tableau de bord.
 *
 * Ils vivaient dans `main.ts` ; ils sont sortis ici pour que le tracé
 * (`trackChart.ts`) formate et échantillonne exactement comme le reste de la
 * page, sans dupliquer les règles.
 */

import type { Point } from "../types";

/** `m:ss.d` — le format des étiquettes de temps. */
export function fmtTime(value: number): string {
  const minutes = Math.floor(value / 60);
  const secondsPart = value % 60;
  return `${minutes}:${secondsPart.toFixed(1).padStart(4, "0")}`;
}

/** Valeur d'une courbe à `timeValue`, interpolée linéairement entre deux points. */
export function sampleCurve(curve: Point[], timeValue: number): number {
  if (curve.length === 0) return 0;
  if (timeValue <= curve[0]![0]) return curve[0]![1];
  const last = curve[curve.length - 1]!;
  if (timeValue >= last[0]) return last[1];
  // Recherche dichotomique : la courbe est relue à chaque image du tracé, hors
  // de question de la parcourir entièrement à chaque fois.
  let lo = 0;
  let hi = curve.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (curve[mid]![0] <= timeValue) lo = mid;
    else hi = mid;
  }
  const point = curve[lo]!;
  const next = curve[hi]!;
  const factor = (timeValue - point[0]) / Math.max(next[0] - point[0], 1e-6);
  return point[1] + (next[1] - point[1]) * factor;
}
