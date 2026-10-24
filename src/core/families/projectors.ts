import { shiftHue } from "../color";
import { hash01 } from "../series";
import { softBeam } from "./beams";
import { rowPositions } from "./geometry";
import { contrastHue, lampHue } from "./harmony";
import { beatSwing, elementEnvelopeForEnergy } from "./tempo";
import type { FamilyDraw, FrameState } from "./types";
import { GRAND_BALAYAGE_BEATS, PETIT_ELEMENT_BEATS } from "./types";
import { activeSlots, count, paint } from "./util";

const spotOrigin = (i: number, w: number, h: number, seed: number) => {
  // Les projecteurs peuvent venir des quatre bords, coins compris : un show
  // n'éclaire pas que depuis le sol.
  const roll = hash01(i * 8191 + seed);
  if (roll < 0.34) {
    const x = w * (0.08 + hash01(i * 337 + seed) * 0.84);
    return { x, y: h };
  }
  if (roll < 0.67) {
    const x = w * (0.08 + hash01(i * 421 + seed) * 0.84);
    return { x, y: 0 };
  }
  if (roll < 0.85) {
    return { x: 0, y: h * (0.08 + hash01(i * 523 + seed) * 0.84) };
  }
  return { x: w, y: h * (0.08 + hash01(i * 677 + seed) * 0.84) };
};

const spots: FamilyDraw = (ctx, f, view) => {
  const { width: w, height: h } = f;
  const lamps = count(7, f.quality, f.reduced);
  const length = Math.hypot(w, h) * 1.15;
  const sweep = f.reduced ? 0.22 : 0.5;
  const cx = w * 0.5;
  const cy = h * 0.5;

  for (let i = 0; i < lamps; i += 1) {
    const origin = spotOrigin(i, w, h, f.seed);
    // Chaque lampe a son propre décalage : la salle n'est jamais éclairée
    // d'un seul mouvement, mais tout le monde reste sur le tempo.
    const drift = beatSwing(f, view, sweep, i % 3 === 0 ? PETIT_ELEMENT_BEATS * 2 : PETIT_ELEMENT_BEATS, i * 0.31);
    const aimX = cx + (hash01(i * 733 + f.seed) - 0.5) * w * 0.9 + drift * w * 0.35;
    const aimY = cy + (hash01(i * 887 + f.seed) - 0.5) * h * 0.9 + drift * h * 0.2;
    const angle = Math.atan2(aimY - origin.y, aimX - origin.x);
    const aperture = (f.reduced ? 0.03 : 0.062) * (0.7 + f.energy * 0.9 + f.beat * 0.4);
    // Une lampe sur deux part sur la complémentaire : les projecteurs n'ont pas
    // à être tous de la même couleur, c'est ce qui donne du relief à la scène.
    const hue = lampHue(f, i);
    // Les projecteurs ne restent pas tous allumés : chacun a son cycle, donc la
    // salle change de visage sans qu'aucun ne s'éteigne d'un coup. Le cycle
    // s'accélère avec l'énergie, mais par mélange : un seuil franc décalait la
    // phase de toutes les lampes en une image.
    const allumage = elementEnvelopeForEnergy(f, view, i * 3 + 1, 22, 12, 0.8);
    if (allumage <= 0.01) continue;
    const alpha = (0.06 + 0.28 * f.energy + 0.18 * f.beat) * f.alpha * allumage;

    softBeam(ctx, {
      x: origin.x,
      y: origin.y,
      angle,
      length,
      width: Math.tan(aperture) * length,
      hue,
      saturation: 0.85,
      lightness: 0.72,
      alpha,
      quality: f.quality,
      reduced: f.reduced,
      fumee: f.haze,
      footRatio: 0.04,
      tailHue: shiftHue(hue, 24),
    });

    // Lampe elle-même : un point lumineux sur son bord.
    ctx.fillStyle = paint(hue, 0.9, 0.82, alpha * 1.5);
    ctx.beginPath();
    ctx.arc(origin.x, origin.y, 3 + f.beat * 8, 0, Math.PI * 2);
    ctx.fill();
  }
};

/**
 * Faisceaux miroirs : des paires de projecteurs parfaitement symétriques de
 * part et d'autre de l'axe vertical. Chaque lampe a sa jumelle exactement en
 * face, au même instant, à la même hauteur — et les deux visent leur reflet.
 *
 * C'est le seul effet du spectacle où deux faisceaux se répondent, donc le
 * seul qui donne l'impression d'un vrai show réglé à la main. Les ouvertures
 * sont volontairement étroites : un faisceau long et net se lit beaucoup mieux
 * de loin qu'un large pâté de lumière.
 */
const mirror: FamilyDraw = (ctx, f, view) => {
  const { width: w, height: h } = f;
  const pairs = count(8, f.quality, f.reduced);
  const cx = w * 0.5;
  const cy = h * 0.5;
  // La portée dépasse largement l'écran : le faisceau doit traverser la scène
  // sans s'arrêter au bord.
  const reach = Math.hypot(w, h) * 1.35;

  for (let i = 0; i < pairs; i += 1) {
    const row = hash01(i * 711 + f.seed);
    const originY = h * (0.1 + row * 0.8);
    const aimY = cy + (hash01(i * 911 + f.seed) - 0.5) * h * 0.62;
    // Un décalage entre deux lampes voisines : les paires ne balayent jamais
    // toutes dans le même sens, le motif respire — mais sur le tempo.
    const swing = beatSwing(f, view, 0.8, GRAND_BALAYAGE_BEATS, hash01(i * 1213 + f.seed));
    const aimX = cx + swing * w * 0.4;
    const hue = lampHue(f, i);
    const alpha = (0.05 + 0.26 * f.energy + 0.14 * f.beat) * f.alpha;
    if (alpha <= 0.002) continue;
    const aperture = (0.013 + hash01(i * 1367 + f.seed) * 0.018) * (0.7 + f.bass * 0.7 + f.beat * 0.3);

    for (const side of [-1, 1] as const) {
      const originX = side < 0 ? 0 : w;
      // Reflet du point visé par rapport au centre : c'est tout le secret de
      // la symétrie, et elle tient même quand le point se déplace.
      const targetX = side < 0 ? aimX : w - aimX;
      const angle = Math.atan2(aimY - originY, targetX - originX);
      const range = reach * (0.8 + hash01(i * 1517 + f.seed) * 0.5);
      softBeam(ctx, {
        x: originX,
        y: originY,
        angle,
        length: range,
        width: Math.tan(aperture) * range,
        hue,
        saturation: 0.9,
        lightness: 0.76,
        alpha,
        quality: f.quality,
      reduced: f.reduced,
      fumee: f.haze,
        footRatio: 0.03,
        tailHue: shiftHue(hue, 14),
      });

      ctx.fillStyle = paint(hue, 0.92, 0.82, alpha * 1.4);
      ctx.beginPath();
      ctx.arc(originX, originY, 3 + f.beat * 7, 0, Math.PI * 2);
      ctx.fill();
    }
  }
};

/**
 * Rangée de projecteurs alignée sur un même bord, tous parallèles, qui
 * balayent d'un seul bloc. À l'inverse de `mirror`, il n'y a pas de paire :
 * une seule direction, une seule impulsion, comme une rangée de lampes de
 * concert qui pivote ensemble sur sa structure.
 */
const parade: FamilyDraw = (ctx, f, view) => {
  const { width: w, height: h } = f;
  const slotCount = count(9, 1, f.reduced);
  const lamps = count(9, f.quality, f.reduced);
  const active = activeSlots(slotCount, lamps, f.seed);
  if (lamps < 1) return;
  // La rangée déborde des deux bords (voir `rowPositions`) : c'est ce qui évite
  // le trou du côté vers lequel les faisceaux se penchent.
  const positions = rowPositions(slotCount, w, w * 0.14);
  const reach = Math.hypot(w, h) * 1.35;
  // Un pas tous les deux temps forts : la rangée s'incline *avec* la musique.
  const sweep = beatSwing(f, view, f.reduced ? 0.3 : 0.7, GRAND_BALAYAGE_BEATS);
  const tilt = -Math.PI / 2 + sweep;
  const lampY = h * 0.98;
  const alpha = (0.05 + 0.24 * f.energy + 0.12 * f.beat) * f.alpha;
  if (alpha <= 0.002) return;

  for (const i of active) {
    // Léger décalage par lampe : la rangée reste parallèle sans être rigide.
    const angle = tilt + (hash01(i * 311 + f.seed) - 0.5) * 0.07;
    const hue = lampHue(f, i);
    const aperture = (0.02 + hash01(i * 433 + f.seed) * 0.014) * (0.7 + f.bass * 0.8 + f.beat * 0.25);
    const range = reach * (0.75 + hash01(i * 557 + f.seed) * 0.6);
    const originX = positions[i] ?? 0;
    softBeam(ctx, {
      x: originX,
      y: lampY,
      angle,
      length: range,
      width: Math.tan(aperture) * range,
      hue,
      saturation: 0.88,
      lightness: 0.74,
      alpha,
      quality: f.quality,
      reduced: f.reduced,
      fumee: f.haze,
      footRatio: 0.04,
    });

    ctx.fillStyle = paint(hue, 0.9, 0.8, alpha * 1.3);
    ctx.beginPath();
    ctx.arc(originX, lampY, 3 + f.beat * 6, 0, Math.PI * 2);
    ctx.fill();
  }
};

/**
 * Tirs croisés : un projecteur par coin, quatre faisceaux longs et fins qui
 * se croisent au milieu de l'écran. Chaque lampe visant le centre, la figure
 * reste une étoile quelle que soit la taille de l'écran ; la respiration
 * lente élarg puis resserre l'écart, ce qui donne un effet de « ouverture de
 * porte » sans jamais cesser de converger.
 */
const crossfire: FamilyDraw = (ctx, f, view) => {
  const { width: w, height: h } = f;
  const cx = w * 0.5;
  const cy = h * 0.5;
  const reach = Math.hypot(w, h) * 1.45;
  const breath = beatSwing(f, view, f.reduced ? 0.12 : 0.34, GRAND_BALAYAGE_BEATS);
  const alpha = (0.06 + 0.3 * f.energy + 0.16 * f.beat) * f.alpha;
  if (alpha <= 0.002) return;

  for (let corner = 0; corner < 4; corner += 1) {
    const originX = corner === 0 || corner === 3 ? 0 : w;
    const originY = corner < 2 ? 0 : h;
    // Angle vers le centre, décalé d'un quart de tour par coin : les quatre
    // tirs restent écartés de 90° et se croisent tous au même point.
    const base = Math.atan2(cy - originY, cx - originX);
    const angle = base + breath;
    const hue = lampHue(f, corner);
    const aperture = (0.014 + 0.012 * hash01(corner * 97 + f.seed)) * (0.7 + f.energy * 0.8 + f.beat * 0.35);
    softBeam(ctx, {
      x: originX,
      y: originY,
      angle,
      length: reach,
      width: Math.tan(aperture) * reach,
      hue,
      saturation: 0.9,
      lightness: 0.78,
      alpha,
      quality: f.quality,
      reduced: f.reduced,
      fumee: f.haze,
      footRatio: 0.03,
      tailHue: shiftHue(hue, 20),
    });

    ctx.fillStyle = paint(hue, 0.92, 0.84, alpha * 1.5);
    ctx.beginPath();
    ctx.arc(originX, originY, 3 + f.beat * 8, 0, Math.PI * 2);
    ctx.fill();
  }
};

/**
 * Grand wash de projecteurs : couche massive utilisée après un impact.
 * Beaucoup de faisceaux larges venant des quatre bords, qui balayent tout
 * l'écran. C'est l'effet « salle entière qui s'allume ».
 */
export function drawWash(ctx: CanvasRenderingContext2D, f: FrameState): void {
  const { width: w, height: h } = f;
  const lamps = count(16, f.quality, f.reduced);
  const length = Math.hypot(w, h) * 1.35;
  const sweep = 0.26;
  const alpha = (0.13 + 0.12 * f.energy + 0.04 * f.beat) * f.alpha;

  for (let i = 0; i < lamps; i += 1) {
    const origin = spotOrigin(i * 3 + 1, w, h, f.seed + 17);
    // Période de 20 à 50 s selon la lampe : les nappes glissent au lieu de
    // balayer, ce qui est exactement ce qu'on attend d'un wash.
    const phase = f.t * (0.08 + hash01(i * 1291 + f.seed) * 0.14) + i * 1.9;
    const target = i % 2 === 0
      ? { x: w * (0.1 + hash01(i * 1543 + f.seed) * 0.8), y: h * 0.5 }
      : { x: w * 0.5, y: h * (0.1 + hash01(i * 1777 + f.seed) * 0.8) };
    const angle = Math.atan2(target.y - origin.y, target.x - origin.x) + Math.sin(phase) * sweep;
    // Ouverture et portée varient d'une lampe à l'autre : sans ça, tous les
    // faisceaux se ressemblent et le wash ressemble à un éventail régulier.
    const width = 0.04 + hash01(i * 1979 + f.seed) * 0.05;
    const range = length * (0.75 + hash01(i * 2267 + f.seed) * 0.7);
    const aperture = width * (0.8 + f.energy * 0.5 + f.beat * 0.45);
    const hue = lampHue(f, i);

    softBeam(ctx, {
      x: origin.x,
      y: origin.y,
      angle,
      length: range,
      width: Math.tan(aperture) * range,
      hue,
      saturation: 0.85,
      lightness: 0.74,
      alpha,
      // Le wash couvre tout l'écran : ses seize faisceaux sont larges, donc tous
      // déposés dans la surface de fumée et floutés en une seule passe. C'est
      // exactement ce qui rend cet impact tenable.
      quality: f.quality,
      reduced: f.reduced,
      fumee: f.haze,
      layers: f.reduced ? 1 : 2,
      footRatio: 0.05,
      tailHue: shiftHue(hue, 16),
    });
  }
}

/**
 * Noyau lumineux commun à toutes les familles : sans lui, les familles
 * concentriques laissent un trou sombre au centre et le spectacle paraît vide.
 * Il pulse sur les basses et les temps forts.
 */
export function drawCoreGlow(ctx: CanvasRenderingContext2D, f: FrameState): void {
  const { width: w, height: h } = f;
  const cx = w * 0.5;
  const cy = h * 0.5;
  const radius = Math.max(Math.min(w, h) * (0.16 + f.bass * 0.42 + f.beat * 0.14), 1);
  const alpha = (0.05 + 0.17 * f.bass + 0.09 * f.beat) * f.alpha;
  if (alpha <= 0.003) return;
  const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
  // Le halo commun prend la teinte de contraste : sans lui, toutes les familles
  // concentriques posaient le même centre monochrome, quelle que soit la scène.
  const teinte = contrastHue(f);
  gradient.addColorStop(0, paint(teinte, 0.72, 0.72, alpha));
  gradient.addColorStop(0.35, paint(teinte, 0.8, 0.6, alpha * 0.4));
  gradient.addColorStop(1, paint(teinte, 0.8, 0.5, 0));
  ctx.fillStyle = gradient;
  // Cadre du dégradé seulement : le halo est nul au-delà de `radius`, remplir
  // tout l'écran ajoutait une passe additive plein écran par image.
  ctx.fillRect(Math.max(0, cx - radius), Math.max(0, cy - radius), Math.min(w, radius * 2), Math.min(h, radius * 2));
}

/**
 * Rideau de lumière : des faisceaux serrés qui montent du plancher sur toute la
 * largeur, bords compris, et s'ouvrent en éventail. C'est l'effet qui remplit le
 * mieux une salle vue de loin — aucune zone ne reste sombre, même quand les
 * faisceaux s'inclinent — et il porte les moments forts sans dépendre d'un
 * mouvement de caméra.
 */
const curtain: FamilyDraw = (ctx, f, view) => {
  const { width: w, height: h } = f;
  const slotCount = count(15, 1, f.reduced);
  const rangs = count(15, f.quality, f.reduced);
  const active = activeSlots(slotCount, rangs, f.seed);
  const length = Math.hypot(w, h) * 1.15;
  const positions = rowPositions(slotCount, w, w * 0.11);
  const balance = beatSwing(f, view, f.reduced ? 0.08 : 0.26, GRAND_BALAYAGE_BEATS);
  const alpha = (0.05 + 0.26 * f.energy + 0.16 * f.beat) * f.alpha;
  if (alpha <= 0.002) return;

  for (const i of active) {
    const originX = positions[i] ?? 0;
    const ratio = positions.length === 1 ? 0.5 : i / (positions.length - 1);
    const angle = -Math.PI / 2 + (ratio - 0.5) * 0.55 + balance;
    // Un faisceau sur deux part sur la complémentaire : le rideau n'est jamais
    // monochrome, et la couleur alterne régulièrement sur toute la largeur.
    const hue = lampHue(f, i);
    // Chaque faisceau s'allume et s'éteint à son tour, sur un cycle musical :
    // la lumière « voyage » le long de la rangée au lieu de clignoter en bloc.
    const phase = elementEnvelopeForEnergy(f, view, i, 20, 10, 0.85);
    if (phase <= 0.01) continue;
    const aperture = (0.01 + 0.016 * hash01(i * 271 + f.seed)) * (0.6 + phase * 0.8 + f.beat * 0.3);
    const portee = length * (0.78 + phase * 0.35);
    const intensite = alpha * phase;

    softBeam(ctx, {
      x: originX,
      y: h,
      angle,
      length: portee,
      width: portee * aperture,
      hue,
      saturation: 0.92,
      lightness: 0.78,
      alpha: intensite,
      quality: f.quality,
      reduced: f.reduced,
      fumee: f.haze,
      footRatio: 0.03,
      tailHue: shiftHue(hue, 16),
    });

    // Le pied de chaque projecteur reste visible : c'est ce qui donne
    // l'impression d'une rangée d'appareils au sol.
    ctx.fillStyle = paint(hue, 0.95, 0.85, intensite * 1.4);
    ctx.beginPath();
    ctx.arc(originX, h, 2.5 + f.beat * 5, 0, Math.PI * 2);
    ctx.fill();
  }
};

/**
 * Rayonnement : un tour complet de faisceaux partant du centre de l'image,
 * comme un projecteur rotatif de salle. Les faisceaux dépassent largement les
 * bords, donc le cadre est entièrement balayé quel que soit l'angle, et la
 * rotation est continue — c'est l'effet « soirée » par excellence.
 */
const burst: FamilyDraw = (ctx, f, view) => {
  const { width: w, height: h } = f;
  const cx = w * 0.5;
  const cy = h * 0.52;
  const slotCount = count(18, 1, f.reduced);
  const rayons = count(18, f.quality, f.reduced);
  const active = activeSlots(slotCount, rayons, f.seed);
  const reach = Math.hypot(w, h) * 1.5;
  // La tête tourne par quarts de tour sur la mesure, avec un léger glissement
  // continu : ça tourne, mais ça tourne sur la musique.
  const rotation = beatSwing(f, view, f.reduced ? 0.4 : 1.1, GRAND_BALAYAGE_BEATS) + f.t * (f.reduced ? 0.02 : 0.05);
  const alpha = (0.045 + 0.24 * f.energy + 0.15 * f.beat) * f.alpha;
  if (alpha <= 0.002) return;

  for (const i of active) {
    const ratio = i / slotCount;
    const angle = rotation + ratio * Math.PI * 2;
    // Chaque rayon prend sa teinte dans l'accord de la scène : la roue est
    // multicolore, aucun rayon ne répète son voisin.
    const hue = lampHue(f, i);
    const aperture = (0.012 + 0.02 * hash01(i * 613 + f.seed)) * (0.7 + f.energy * 0.9 + f.beat * 0.4);
    const portee = reach * (0.7 + 0.3 * hash01(i * 719 + f.seed));
    // Alternance de densité : les rayons ne se valent pas, la roue a du relief.
    const intensite = alpha * (i % 2 === 1 ? 0.72 : 1);

    softBeam(ctx, {
      x: cx,
      y: cy,
      angle,
      length: portee,
      width: portee * aperture,
      hue,
      saturation: 0.9,
      lightness: 0.8,
      alpha: intensite,
      quality: f.quality,
      reduced: f.reduced,
      fumee: f.haze,
      footRatio: 0.03,
    });
  }

  // Le moyeu : la source, toujours au centre, qui respire avec les basses.
  const moyeu = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(Math.min(w, h) * (0.08 + f.bass * 0.16), 1));
  const teinteMoyeu = contrastHue(f);
  moyeu.addColorStop(0, paint(teinteMoyeu, 0.9, 0.86, (0.2 + 0.3 * f.bass) * f.alpha));
  moyeu.addColorStop(1, paint(teinteMoyeu, 0.9, 0.6, 0));
  ctx.fillStyle = moyeu;
  ctx.fillRect(0, 0, w, h);
};

/** Familles de projecteurs : lampes, faisceaux et wash. */
export const PROJECTOR_FAMILIES = {
  spots,
  mirror,
  parade,
  crossfire,
  curtain,
  burst,
} as const;
