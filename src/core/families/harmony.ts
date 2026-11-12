import type { Mood, Palette } from "../show";
import { hash01 } from "../series";
import type { FrameState } from "./types";

/**
 * Couleurs d'une scène : exactement deux teintes, jamais plus.
 *
 * Le morceau possède une teinte et sa complémentaire. Une scène n'a donc pas
 * d'accord à quatre ou six membres : elle joue l'un des deux pôles, et la
 * troisième couleur n'existe pas. Les paramètres de tirage sont conservés pour
 * l'API de diagnostic, mais le résultat est volontairement invariant.
 */
export function sceneChord(
  palette: Palette,
  _sceneIndex?: number,
  _seed?: number,
  _mood?: Mood,
): number[] {
  return palette.accent === palette.hue ? [palette.hue] : [palette.hue, palette.accent];
}

/**
 * Teinte de la lampe `index`.
 *
 * Les lampes alternent entre les deux seules couleurs du morceau. La rotation
 * est tirée de la graine pour que la rangée ne commence pas toujours par le
 * même pôle, mais elle ne peut jamais introduire une troisième teinte.
 */
export function lampHue(f: FrameState, index: number): number {
  const accord = sceneChord(f.palette, f.scene.index, f.seed, f.scene.mood);
  if (accord.length < 2) return accord[0] ?? f.palette.hue;
  const rotation = Math.floor(hash01(f.scene.index * 104729 + f.seed) * 2);
  return accord[(((index + rotation) % 2) + 2) % 2] ?? f.palette.hue;
}

/**
 * Teinte de contraste d'une scène : l'autre couleur du morceau.
 *
 * C'est ce qui empêche l'image d'être monochrome : le fond, le halo commun et
 * le foyer de chaque famille s'en servent. Avec deux couleurs, le contraste est
 * toujours l'autre pôle, jamais une teinte inventée.
 */
export function contrastHue(f: FrameState): number {
  const accord = sceneChord(f.palette, f.scene.index, f.seed, f.scene.mood);
  for (const hue of accord) {
    if (hue !== f.palette.hue) return hue;
  }
  return f.palette.hue;
}
