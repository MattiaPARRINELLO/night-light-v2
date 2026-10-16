import { hash01 } from "../series";
import type { TrackView } from "../view";
import { curvedBeam, softBeam } from "./beams";
import { rowPositions } from "./geometry";
import { contrastHue, lampHue } from "./harmony";
import { beatSwing, elementEnvelope } from "./tempo";
import type { FamilyDraw, FrameState } from "./types";
import { GRAND_BALAYAGE_BEATS } from "./types";
import { count, paint } from "./util";

/**
 * Étoile : quelques rayons partant d'un foyer qui dérive lentement, chacun
 * pulsant à son tour. C'est un projecteur rotatif vu de loin — peu de branches,
 * des longueurs inégales, et un foyer qui se déplace au lieu de rester planté au
 * milieu.
 */
const etoile: FamilyDraw = (ctx, f, view) => {
  const { width: w, height: h } = f;
  // Douze branches : avec sept, et comme chacune pulse à son tour, on n'en voyait
  // que trois ou quatre — une croix floue, pas une étoile.
  const branches = f.reduced ? 6 : count(12, f.quality, false);
  // Foyer qui dérive lentement dans le cadre, jamais au bord.
  const derive = Math.sin(f.t * 0.07) * 0.18;
  const cx = w * (0.5 + derive);
  const cy = h * (0.48 + Math.cos(f.t * 0.05) * 0.12);
  const portee = Math.hypot(w, h) * 1.25;
  const rotation = beatSwing(f, view, f.reduced ? 0.3 : 0.9, GRAND_BALAYAGE_BEATS) + f.t * 0.03;
  const alpha = (0.09 + 0.32 * f.energy + 0.18 * f.beat) * f.alpha;
  if (alpha <= 0.002) return;
  const cycle = f.reduced ? 24 : f.energy > 0.55 ? 8 : 14;

  for (let i = 0; i < branches; i += 1) {
    const part = i / branches;
    const angle = rotation + part * Math.PI * 2;
    // Chaque branche pulse à son tour — mais sur une longueur qui varie peu :
    // c'est ce qui garde la forme d'étoile reconnaissable.
    const pulsation = elementEnvelope(f, view, i, cycle, 0.7);
    if (pulsation <= 0.01) continue;
    const longueur = portee * (0.78 + 0.28 * hash01(i * 811 + f.seed)) * (0.45 + 0.55 * pulsation);
    const hue = lampHue(f, i);
    softBeam(ctx, {
      x: cx,
      y: cy,
      angle,
      length: longueur,
      width: Math.min(w, h) * 0.02 * (0.8 + f.energy * 0.6),
      hue,
      saturation: f.palette.saturation,
      lightness: f.palette.lightness + 0.11,
      alpha: alpha * pulsation,
      quality: f.quality,
      reduced: f.reduced,
      fumee: f.haze,
      footRatio: 0.03,
    });
  }

  // Le foyer : une source, pas un point géométrique. Serré, pour ne pas noyer
  // les branches qu'il allume.
  const noyau = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(Math.min(w, h) * (0.045 + f.bass * 0.11), 1));
  const teinteNoyau = contrastHue(f);
  noyau.addColorStop(0, paint(teinteNoyau, 0.9, 0.84, (0.14 + 0.26 * f.bass) * f.alpha));
  noyau.addColorStop(1, paint(teinteNoyau, 0.9, 0.6, 0));
  ctx.fillStyle = noyau;
  ctx.fillRect(Math.max(0, cx - w * 0.12), Math.max(0, cy - h * 0.12), w * 0.24, h * 0.24);
};

/**
 * Vortex : un éventail dont les rayons sont vrillés — serrés d'un côté, ouverts
 * de l'autre — et dont la vrille tourne lentement. Le mouvement se lit comme
 * une spirale qui tourne, là où un éventail régulier ne fait que basculer.
 */
const vortex: FamilyDraw = (ctx, f, view) => {
  const { width: w, height: h } = f;
  const rayons = count(11, f.quality, f.reduced);
  const cx = w * 0.5;
  const cy = h * 0.56;
  const portee = Math.hypot(w, h) * 0.98;
  const alpha = (0.1 + 0.34 * f.energy + 0.2 * f.beat) * f.alpha;
  if (alpha <= 0.002) return;
  // La vrille suit l'énergie : un passage fort enroule la spirale plus serré.
  const vrille = 0.9 + 0.9 * f.energy;
  const tour = beatSwing(f, view, f.reduced ? 0.5 : 1.5, GRAND_BALAYAGE_BEATS) + f.t * 0.14;
  // Les rayons ne partent pas tous du même point : ils s'accrochent en couronne
  // autour du foyer, et c'est ce départ décalé qui fait tourner l'ensemble.
  const depart = Math.min(w, h) * 0.06;

  for (let i = 0; i < rayons; i += 1) {
    const part = rayons === 1 ? 0.5 : i / (rayons - 1);
    const angle = tour + part * Math.PI * 2 * 0.9;
    const hue = lampHue(f, i);
    curvedBeam(ctx, {
      x: cx + Math.cos(angle) * depart,
      y: cy + Math.sin(angle) * depart,
      angle,
      length: portee * (0.75 + 0.4 * hash01(i * 53 + f.seed)),
      // Assez épais pour être un rayon de lumière, assez fin pour que la courbure
      // reste lisible : un gros faisceau la perdrait dans le flou.
      width: Math.min(w, h) * 0.019 * (0.8 + f.bass * 0.7),
      courbure: vrille * (0.6 + 0.8 * hash01(i * 97 + f.seed)),
      hue,
      saturation: f.palette.saturation,
      lightness: f.palette.lightness,
      alpha,
      quality: f.quality,
      reduced: f.reduced,
      fumee: f.haze,
    });
  }

  // L'œil du tourbillon : une lueur diffuse plutôt qu'une bille au centre.
  const noyau = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(Math.min(w, h) * (0.05 + f.bass * 0.14), 1));
  const teinteOeil = contrastHue(f);
  noyau.addColorStop(0, paint(teinteOeil, 0.9, 0.8, (0.1 + 0.2 * f.bass) * f.alpha));
  noyau.addColorStop(1, paint(teinteOeil, 0.9, 0.6, 0));
  ctx.fillStyle = noyau;
  ctx.fillRect(Math.max(0, cx - w * 0.2), Math.max(0, cy - h * 0.2), w * 0.4, h * 0.4);
};

/**
 * Lyres : un portique de têtes mobiles, alignées au sol, qui balaient ensemble.
 *
 * C'est le classique du métier — la vague court le long du portique, chaque lyre
 * décalée de la précédente — et c'est aussi une figure très géométrique : les
 * faisceaux restent parallèles entre eux, inclinés du même angle qui se déplace.
 * Les têtes s'inclinent plus largement sur les basses, et la vitesse de la vague
 * suit l'énergie, mais doucement : c'est la lenteur de la rangée qui fait sa
 * beauté.
 */

/** Tours par seconde de la vague des lyres, au repos (0) et par unité d'énergie. */
const LYRE_VITESSE = { base: 0.16, gain: 0.12 } as const;
const LYRE_VITESSE_REDUITE = { base: 0.1, gain: 0.07 } as const;

/**
 * Avance de la vague des lyres, en radians, pour la tête `index` à l'instant
 * courant.
 *
 * La phase est **l'intégrale** de la vitesse, pas le produit du temps par une
 * vitesse qui bouge. L'ancienne écriture `f.t × vitesse(énergie)` faisait sauter
 * la phase d'autant plus que le morceau avançait : passé une minute, la moindre
 * variation d'énergie envoyait la rangée à une vitesse de fou. Intégrée, la
 * vitesse instantanée reste exactement celle qu'on veut — un passage fort
 * accélère la vague, mais toujours lentement.
 *
 * Exportée pour vérifier cette propriété dans les tests.
 */
export function lyreWavePhase(f: FrameState, view: TrackView, index: number): number {
  const vitesse = f.reduced ? LYRE_VITESSE_REDUITE : LYRE_VITESSE;
  const cadence = beatSwing(f, view, f.reduced ? 0.2 : 0.45, GRAND_BALAYAGE_BEATS) * 2;
  const avance = f.t * vitesse.base + view.energyIntegralAt(f.t) * vitesse.gain;
  return avance * Math.PI * 2 - index * 0.95 + cadence;
}

const lyre: FamilyDraw = (ctx, f, view) => {
  const { width: w, height: h } = f;
  const tetes = count(7, f.quality, f.reduced);
  const positions = rowPositions(tetes, w, w * 0.08);
  const y = h * 0.985;
  const portee = Math.hypot(w, h) * 1.05;
  const alpha = (0.11 + 0.3 * f.energy + 0.2 * f.beat) * f.alpha;
  if (alpha <= 0.002) return;

  const amplitude = (f.reduced ? 0.32 : 0.6) * (0.75 + 0.5 * f.bass) + f.beat * 0.06;

  // Le portique : une ligne de lumière au sol, plus dense vers le centre.
  const sol = ctx.createLinearGradient(0, 0, w, 0);
  const teinteSol = lampHue(f, 0);
  const teinteCentre = contrastHue(f);
  sol.addColorStop(0, paint(teinteSol, 0.9, 0.7, 0));
  sol.addColorStop(0.5, paint(teinteCentre, 0.9, 0.75, (0.12 + 0.3 * f.energy) * f.alpha));
  sol.addColorStop(1, paint(teinteSol, 0.9, 0.7, 0));
  ctx.fillStyle = sol;
  ctx.fillRect(0, y - 2, w, 2.5);

  for (let i = 0; i < positions.length; i += 1) {
    const x = positions[i] ?? 0;
    const phase = lyreWavePhase(f, view, i);
    const angle = -Math.PI / 2 + Math.sin(phase) * amplitude;
    // Chaque lyre porte sa teinte, prise dans l'accord de la scène : la rangée
    // est multicolore, comme un vrai portique réglé tête par tête.
    const hue = lampHue(f, i);
    // Une lyre est une tête fine : c'est ce qui distingue son faisceau d'un
    // projecteur de wash, et c'est ce qui garde la figure nette.
    softBeam(ctx, {
      x,
      y,
      angle,
      length: portee,
      width: Math.min(w, h) * 0.014 * (0.8 + f.bass * 0.6),
      hue,
      saturation: f.palette.saturation,
      lightness: f.palette.lightness + 0.08,
      alpha: alpha * (0.75 + 0.25 * Math.sin(phase)),
      quality: f.quality,
      reduced: f.reduced,
      fumee: f.haze,
      footRatio: 0.08,
    });
    // La tête elle-même : sans elle, un faisceau n'est qu'un trait.
    ctx.fillStyle = paint(hue, 0.95, 0.88, alpha * 2.2);
    ctx.beginPath();
    ctx.arc(x, y, 2.6 + f.beat * 4, 0, Math.PI * 2);
    ctx.fill();
  }
};

/**
 * Rosace : une figure à symétrie de rotation, faite de pétales en V et de
 * polygones concentriques qui respirent.
 *
 * Tout y est symétrique, et c'est justement ce qui la rend géométrique : huit
 * pétales identiques répartis au tour, un hexagone qui tourne dans un sens et un
 * triangle dans l'autre. Les pétales s'ouvrent sur les moments forts.
 */
const mandala: FamilyDraw = (ctx, f, view) => {
  const { width: w, height: h } = f;
  const cx = w * 0.5;
  const cy = h * 0.5;
  const rayon = Math.min(w, h);
  const petales = count(8, f.quality, f.reduced);
  const portee = Math.hypot(w, h) * 0.92;
  const alpha = (0.1 + 0.3 * f.energy + 0.18 * f.beat) * f.alpha;
  if (alpha <= 0.002) return;

  const tour = beatSwing(f, view, f.reduced ? 0.25 : 0.7, GRAND_BALAYAGE_BEATS) + f.t * 0.05;
  // L'ouverture du V suit l'énergie : une rosace fermée se lit comme une étoile,
  // une rosace ouverte comme une fleur.
  const ouverture = (0.17 + 0.12 * f.energy) * (1 + 0.25 * Math.sin(f.t * 0.6));

  for (let i = 0; i < petales; i += 1) {
    const part = petales === 1 ? 0.5 : i / petales;
    const base = tour + part * Math.PI * 2;
    const hue = lampHue(f, i);
    const allumage = elementEnvelope(f, view, i * 5, f.reduced ? 26 : f.energy > 0.55 ? 8 : 14, 0.75);
    if (allumage <= 0.01) continue;
    for (const cote of [-1, 1]) {
      softBeam(ctx, {
        x: cx,
        y: cy,
        angle: base + cote * ouverture,
        length: portee * (0.85 + 0.2 * hash01(i * 31 + f.seed)),
        width: rayon * 0.014 * (0.8 + f.bass * 0.5),
        hue,
        saturation: f.palette.saturation,
        lightness: f.palette.lightness + 0.08,
        alpha: alpha * allumage,
        quality: f.quality,
        reduced: f.reduced,
        fumee: f.haze,
        footRatio: 0.05,
      });
    }
  }

  // Les polygones : deux figures régulières qui tournent en sens contraires et
  // respirent sur les basses. C'est la partie franchement géométrique.
  const polygone = (cotes: number, rayonC: number, rotation: number, epaisseur: number, teinte: number, opacite: number) => {
    ctx.strokeStyle = paint(teinte, 0.85, 0.8, alpha * opacite);
    ctx.lineWidth = epaisseur;
    ctx.beginPath();
    for (let i = 0; i <= cotes; i += 1) {
      const a = rotation + (i / cotes) * Math.PI * 2;
      const px = cx + Math.cos(a) * rayonC;
      const py = cy + Math.sin(a) * rayonC;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.stroke();
  };
  const respiration = 1 + 0.16 * f.bass + 0.1 * f.beat;
  // Les deux polygones prennent deux teintes de l'accord : ils se distinguent
  // l'un de l'autre sans sortir de la gamme de la scène.
  polygone(6, rayon * 0.19 * respiration, -tour * 0.7, 1.6 + f.beat * 2, lampHue(f, petales), 1.6);
  polygone(3, rayon * 0.34 * respiration, tour * 0.5 + Math.PI * 0.5, 1.2 + f.beat * 1.6, lampHue(f, petales + 1), 1.1);
};

/**
 * Treillis : des faisceaux parallèles croisés en deux directions, qui dessinent
 * un maillage de losanges sur toute la scène.
 *
 * C'est l'effet le plus franchement géométrique du lot : rien n'est posé au
 * hasard, tout est une grille qui tourne lentement et s'écarte sur les temps
 * forts. Les faisceaux courent au-delà du cadre, sinon le maillage s'arrêterait
 * avant les bords et la scène ne serait pas remplie.
 */
const treillis: FamilyDraw = (ctx, f) => {
  const { width: w, height: h } = f;
  const brins = count(9, f.quality, f.reduced);
  const portee = Math.hypot(w, h) * 1.35;
  const alpha = (0.09 + 0.26 * f.energy + 0.16 * f.beat) * f.alpha;
  if (alpha <= 0.002) return;

  // L'inclinaison dérive lentement, et le maillage s'écarte sur les temps forts.
  const inclinaison = Math.PI * 0.25 + Math.sin(f.t * 0.08) * 0.16;
  const ecart = 1 + 0.3 * f.beat + 0.2 * f.bass;
  const largeur = Math.min(w, h) * 0.013 * (0.85 + f.bass * 0.5);

  const nappe = (theta: number, sens: number) => {
    // On répartit les origines le long de la normale commune : les faisceaux sont
    // donc strictement parallèles entre eux.
    const nx = -Math.sin(theta);
    const ny = Math.cos(theta);
    const etendue = (Math.abs(nx) * w + Math.abs(ny) * h) * ecart;
    for (let i = 0; i < brins; i += 1) {
      const ratio = brins === 1 ? 0 : i / (brins - 1) - 0.5;
      const d = ratio * etendue;
      // Le départ est reculé d'une demi-portée : le faisceau traverse tout le
      // cadre au lieu de commencer au milieu.
      const x = w * 0.5 + nx * d - Math.cos(theta) * portee * 0.5;
      const y = h * 0.5 + ny * d - Math.sin(theta) * portee * 0.5;
      // Les deux nappes ne partagent pas leurs teintes : décaler l'index de la
      // seconde donne un maillage à quatre couleurs au lieu de deux.
      const hue = lampHue(f, i + (sens > 0 ? 0 : brins));
      softBeam(ctx, {
        x,
        y,
        angle: theta,
        length: portee,
        width: largeur,
        hue,
        saturation: f.palette.saturation * 0.9,
        lightness: f.palette.lightness + 0.06,
        alpha: alpha * (sens > 0 ? 1 : 0.85),
        quality: f.quality,
        reduced: f.reduced,
        fumee: f.haze,
        footRatio: 0.5,
      });
    }
  };

  nappe(inclinaison, 1);
  nappe(-inclinaison, -1);
};

/** Familles géométriques : figures à symétrie, spirales et maillages. */
export const FIGURE_FAMILIES = {
  etoile,
  vortex,
  lyre,
  mandala,
  treillis,
} as const;
