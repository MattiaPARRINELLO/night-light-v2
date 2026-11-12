import { softBeam } from "./beams";
import { lampHue } from "./harmony";
import type { FamilyDraw, FrameState } from "./types";
import { activeSlots, count, paint } from "./util";

/**
 * Lumières de scène du profil concert, autres que les lyres.
 *
 * Ces familles remplissent la salle avec des sources fixes ou motorisées qui ne
 * sont pas des têtes mobiles : PAR wash, découpes, tours, rampe de façade,
 * barres de projecteurs et poursuites croisées. Aucun laser ni effet de rave :
 * on reste dans le vocabulaire d'un concert.
 */

/** Puissance de base : le concert éclaire vraiment, le studio reste plus doux. */
function puissance(f: FrameState): number {
  return (f.dynamic === true ? 0.06 + 0.26 * f.energy : 0.06 + 0.2 * f.energy) * f.alpha;
}

/** Faisceau + lentille, brique commune à toutes les nouvelles sources. */
function source(
  ctx: CanvasRenderingContext2D,
  f: FrameState,
  x: number,
  y: number,
  angle: number,
  ouverture: number,
  hue: number,
  alpha: number,
  portee: number,
  layers = 2,
): void {
  if (alpha <= 0.002) return;
  const largeur = Math.tan(ouverture) * portee;
  softBeam(ctx, {
    x,
    y,
    angle,
    length: portee,
    width: largeur,
    hue,
    saturation: Math.min(1, f.palette.saturation + 0.04),
    lightness: f.palette.lightness + (f.dynamic === true ? 0.04 : 0.08),
    alpha,
    quality: f.quality,
    reduced: f.reduced,
    fumee: f.haze,
    layers,
    footRatio: 0.08,
  });
  ctx.fillStyle = paint(hue, 0.9, 0.9, alpha * 2.1);
  ctx.beginPath();
  ctx.arc(x, y, 2.4 + f.energy * 1.8, 0, Math.PI * 2);
  ctx.fill();
}

/** PAR wash : dix grands cônes larges depuis le haut, qui baignent la salle. */
const parWash: FamilyDraw = (ctx, f) => {
  const { width: w, height: h } = f;
  const alpha = puissance(f);
  if (alpha <= 0.002) return;
  const portee = Math.hypot(w, h) * 1.1;
  const slots = 10;
  const visibles = activeSlots(slots, count(slots, f.quality, f.reduced), f.seed);
  const respiration = 0.82 + 0.18 * Math.sin(f.t * 0.32);
  for (const index of visibles) {
    const t = index / (slots - 1);
    const x = w * (0.08 + 0.84 * t);
    const y = -h * 0.04;
    const angle = Math.PI / 2 + (t - 0.5) * 0.9;
    source(ctx, f, x, y, angle, 0.16, lampHue(f, index), alpha * respiration * 1.1, portee, 3);
  }
};

/** Découpes : douze faisceaux fins et nets, en éventail lent depuis le pont. */
const decoupes: FamilyDraw = (ctx, f) => {
  const { width: w, height: h } = f;
  const alpha = puissance(f);
  if (alpha <= 0.002) return;
  const portee = Math.hypot(w, h) * 1.2;
  for (let index = 0; index < 12; index += 1) {
    const t = index / 11;
    const x = w * (0.06 + 0.88 * t);
    const y = -h * 0.02;
    const angle = Math.PI / 2 + Math.sin(f.t * 0.22 + index * 0.5) * 0.18 + (t - 0.5) * 0.55;
    source(ctx, f, x, y, angle, 0.02, lampHue(f, index + 1), alpha * 1.15, portee, 2);
  }
};

/** Tours lumière : deux colonnes latérales qui croisent leurs faisceaux. */
const toursLumiere: FamilyDraw = (ctx, f) => {
  const { width: w, height: h } = f;
  const alpha = puissance(f);
  if (alpha <= 0.002) return;
  const portee = Math.hypot(w, h) * 1.05;
  for (const side of [0, 1] as const) {
    const x = side === 0 ? w * 0.03 : w * 0.97;
    for (let index = 0; index < 6; index += 1) {
      const y = h * (0.16 + index * 0.12);
      const versCentre = side === 0 ? 0 : Math.PI;
      const angle = versCentre + (side === 0 ? 1 : -1) * (0.3 + index * 0.08);
      source(ctx, f, x, y, angle, 0.09, lampHue(f, index + side), alpha * 0.95, portee, 2);
    }
  }
};

/** Rampe de façade : seize sources basses qui lavent le devant de la scène. */
const rampeFacade: FamilyDraw = (ctx, f) => {
  const { width: w, height: h } = f;
  const alpha = puissance(f);
  if (alpha <= 0.002) return;
  const portee = h * 1.2;
  const slots = 16;
  const visibles = activeSlots(slots, count(slots, f.quality, f.reduced), f.seed);
  for (const index of visibles) {
    const t = index / (slots - 1);
    const x = w * (0.04 + 0.92 * t);
    const angle = -Math.PI / 2 + (t - 0.5) * 0.55;
    source(ctx, f, x, h * 1.02, angle, 0.13, lampHue(f, index + 2), alpha * 0.9, portee, 2);
  }
};

/** Barres de projecteurs : quatre rangées de petits PAR sur le pont arrière. */
const barresProjecteurs: FamilyDraw = (ctx, f) => {
  const { width: w, height: h } = f;
  const alpha = puissance(f);
  if (alpha <= 0.002) return;
  const portee = Math.hypot(w, h) * 0.9;
  const slots = 7;
  const colonnes = activeSlots(slots, count(slots, f.quality, f.reduced), f.seed);
  for (let row = 0; row < 4; row += 1) {
    const y = h * (0.06 + row * 0.09);
    for (const col of colonnes) {
      const t = col / (slots - 1);
      const x = w * (0.1 + 0.8 * t);
      const angle = Math.PI / 2 + (t - 0.5) * 0.7 + Math.sin(f.t * 0.25 + row) * 0.08;
      source(ctx, f, x, y, angle, 0.05, lampHue(f, row + col), alpha * 0.6, portee, 2);
    }
  }
};

/** Poursuites croisées : quatre followspots qui se cherchent sur la scène. */
const poursuitesCroisees: FamilyDraw = (ctx, f) => {
  const { width: w, height: h } = f;
  const alpha = puissance(f);
  if (alpha <= 0.002) return;
  const portee = Math.hypot(w, h) * 1.25;
  for (const side of [0, 1] as const) {
    for (let paire = 0; paire < 2; paire += 1) {
      const phase = f.t * 0.28 + side * Math.PI + paire * 1.7;
      const x = w * (side === 0 ? 0.06 : 0.94);
      const y = h * (0.02 + paire * 0.04);
      const cibleX = w * (0.5 + 0.34 * Math.sin(phase));
      const cibleY = h * (0.72 + 0.12 * Math.cos(phase * 1.3));
      const angle = Math.atan2(cibleY - y, cibleX - x);
      source(ctx, f, x, y, angle, 0.028, lampHue(f, side + paire), alpha * 1.1, portee, 2);
    }
  }
};

/** Lumières de scène ajoutées au profil concert. */
export const CONCERT_LIGHT_FAMILIES = {
  "par-wash": parWash,
  decoupes,
  "tours-lumiere": toursLumiere,
  "rampe-facade": rampeFacade,
  "barres-projecteurs": barresProjecteurs,
  "poursuites-croisees": poursuitesCroisees,
} as const;
