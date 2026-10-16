import { clamp01 } from "../series";
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
