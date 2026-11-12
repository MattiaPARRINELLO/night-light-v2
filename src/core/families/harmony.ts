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
  const colors = [palette.hue, palette.accent];
  if (palette.tertiary !== undefined) colors.push(palette.tertiary);
  return [...new Set(colors)];
}

/**
 * Teinte de la lampe `index`.
 *
 * Les lampes parcourent les une à trois couleurs du morceau. La rotation est
 * tirée de la graine pour que la rangée ne commence pas toujours par la même
 * teinte ; elle ne peut jamais en introduire une quatrième.
 */
export function lampHue(f: FrameState, index: number): number {
  const accord = sceneChord(f.palette, f.scene.index, f.seed, f.scene.mood);
  if (accord.length < 2) return accord[0] ?? f.palette.hue;
  const rotation = Math.floor(hash01(f.scene.index * 104729 + f.seed) * accord.length);
  return accord[(((index + rotation) % accord.length) + accord.length) % accord.length] ?? f.palette.hue;
}

/**
 * Teinte de contraste d'une scène : la couleur du morceau la plus éloignée de sa
 * dominante.
 */
export function contrastHue(f: FrameState): number {
  const accord = sceneChord(f.palette, f.scene.index, f.seed, f.scene.mood);
  for (const hue of accord) {
    if (hue !== f.palette.hue) return hue;
  }
  return f.palette.hue;
}
