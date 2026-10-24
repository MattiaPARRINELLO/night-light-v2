import { clamp01, hash01 } from "../series";
import { hslToRgb, shorthand } from "../color";

/** Couleur CSS d'une teinte HSL, avec alpha. */
export function paint(h: number, s: number, l: number, a: number): string {
  return shorthand(hslToRgb({ h, s, l }), a);
}

/** Nombre d'éléments d'une famille, dégradé par la qualité et le mode réduit. */
export function count(base: number, quality: number, reduced: boolean): number {
  const scaled = base * (reduced ? 0.55 : 1) * (0.45 + 0.55 * clamp01(quality));
  return Math.max(3, Math.round(scaled));
}

/**
 * Emplacements d'une famille sur sa grille maximale.
 *
 * Le nombre d'éléments baisse avec la qualité, mais les positions ne doivent
 * pas bouger pour autant : sinon toute la famille se redistribue à chaque cran
 * et l'image « saute ». On place donc les éléments sur la grille du palier 1 et
 * on en éteint une partie, dans un ordre déterministe.
 *
 * Le pas de permutation est premier avec `slots`, donc `i → (i·a + b) mod slots`
 * est une bijection : le nombre d'emplacements allumés vaut exactement
 * `visible`, et les ensembles sont emboîtés quand la qualité monte.
 */
export function activeSlots(slots: number, visible: number, seed: number): number[] {
  const total = Math.max(0, Math.floor(slots));
  const shown = Math.max(0, Math.min(total, Math.floor(visible)));
  if (shown === 0) return [];
  if (shown >= total) return Array.from({ length: total }, (_, index) => index);
  const stride = permutationStride(total, seed);
  const offset = Math.floor(hash01(seed + 17) * total);
  const out: number[] = [];
  for (let index = 0; index < total; index += 1) {
    if ((index * stride + offset) % total < shown) out.push(index);
  }
  return out;
}

/** Pas de permutation premier avec `slots`, dérivé de la graine. */
function permutationStride(slots: number, seed: number): number {
  const start = 1 + Math.floor(hash01(seed * 3 + 1) * Math.max(slots - 1, 1));
  for (let attempt = 0; attempt < slots; attempt += 1) {
    const candidate = ((start - 1 + attempt) % Math.max(slots - 1, 1)) + 1;
    if (gcd(candidate, slots) === 1) return candidate;
  }
  return 1;
}

function gcd(a: number, b: number): number {
  let x = a;
  let y = b;
  while (y !== 0) {
    const reste = x % y;
    x = y;
    y = reste;
  }
  return x;
}
