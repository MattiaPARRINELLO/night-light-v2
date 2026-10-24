import { hash01 } from "../series";
import { softBeam } from "./beams";
import { rowPositions } from "./geometry";
import { lampHue } from "./harmony";
import { beatSwing, colorFlip, elementEnvelope } from "./tempo";
import type { FamilyDraw } from "./types";
import { GRAND_BALAYAGE_BEATS } from "./types";
import { activeSlots, count, paint } from "./util";

/** Formes projetées par les gobos : cercle, anneau, losange, triangle. */
const GOBOS = ["cercle", "anneau", "losange", "triangle"] as const;

/**
 * Dessine une forme projetée.
 *
 * Les sommets sont calculés à la main plutôt qu'avec `rotate` : le rendu reste
 * une fonction pure des coordonnées, testable sans contexte graphique complet.
 */
function drewGobo(
  ctx: CanvasRenderingContext2D,
  forme: number,
  x: number,
  y: number,
  rayon: number,
  rotation: number,
  hue: number,
  saturation: number,
  alpha: number,
): void {
  const centre = ctx.createRadialGradient(x, y, 0, x, y, Math.max(rayon, 1));
  centre.addColorStop(0, paint(hue, saturation, 0.78, alpha));
  centre.addColorStop(1, paint(hue, saturation, 0.6, 0));

  if (forme === 0) {
    // Cercle plein : la tache de lumière la plus simple, et la plus lisible.
    ctx.fillStyle = centre;
    ctx.beginPath();
    ctx.arc(x, y, rayon, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  const sommets = forme === 1 ? 0 : forme === 2 ? 4 : 3;
  if (sommets === 0) {
    // Anneau : deux cercles, le second en creux. Un anneau large se lit de loin.
    ctx.fillStyle = centre;
    ctx.beginPath();
    ctx.arc(x, y, rayon, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    ctx.arc(x, y, rayon * 0.62, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "lighter";
    return;
  }

  ctx.fillStyle = centre;
  ctx.beginPath();
  for (let i = 0; i < sommets; i += 1) {
    const angle = rotation + (i / sommets) * Math.PI * 2;
    const px = x + Math.cos(angle) * rayon;
    const py = y + Math.sin(angle) * rayon;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
}

/**
 * Gobos : des formes projetées sur le mur, réparties sur tout le cadre.
 *
 * Chaque forme s'allume et s'éteint à son tour (`elementEnvelope`), tourne
 * lentement, et une sur deux prend la complémentaire. C'est l'effet « boîte de
 * nuit » : beaucoup de petits motifs qui vivent indépendamment, sans jamais
 * apparaître ni disparaître d'un coup.
 *
 * Quand il y en a beaucoup, le mouvement ne suffit plus à se lire : une ou deux
 * formes basculent alors franchement sur la couleur opposée (`colorFlip`). Le
 * déplacement devient couleur — le geste du projecteur qui tourne sa roue — et
 * l'œil est attiré sans qu'aucun motif n'ait bougé.
 */
const gobos: FamilyDraw = (ctx, f, view) => {
  const { width: w, height: h } = f;
  const formes = count(f.energy > 0.55 ? 14 : 9, f.quality, f.reduced);
  const rayon = Math.min(w, h) * (0.07 + f.energy * 0.05 + f.beat * 0.02);
  const cycle = f.reduced ? 28 : f.energy > 0.55 ? 9 : 20;
  // Les bascules vivent plus vite qu'un allumage, mais restent sur la mesure.
  const cycleBascule = f.reduced ? 10 : f.energy > 0.55 ? 6 : 9;

  for (let i = 0; i < formes; i += 1) {
    const enveloppe = elementEnvelope(f, view, i, cycle, 0.55);
    if (enveloppe <= 0.01) continue;
    // Répartition sur tout le cadre, bords compris : aucune zone ne reste vide.
    const x = w * (0.06 + hash01(i * 1709 + f.seed) * 0.88);
    const y = h * (0.1 + hash01(i * 2017 + f.seed) * 0.8);
    const taille = rayon * (0.6 + hash01(i * 3001 + f.seed) * 0.7);
    const sens = i % 2 === 0 ? 1 : -1;
    const rotation = f.t * (0.08 + hash01(i * 2311 + f.seed) * 0.2) * sens;
    const teinte = lampHue(f, i);
    // La bascule ajoute 180° : la forme porte brièvement la couleur opposée à
    // la sienne. Comme la teinte est un angle, le passage d'une couleur à
    // l'autre est une rotation continue de la roue — jamais un saut.
    const bascule = colorFlip(f, view, i, cycleBascule);
    const hue = teinte + 180 * bascule;
    // Un léger regain accompagne la bascule : la couleur opposée doit se voir.
    const alpha = enveloppe * (0.08 + 0.3 * f.energy + 0.16 * f.beat) * f.alpha * (1 + 0.55 * bascule);
    if (alpha <= 0.004) continue;
    drewGobo(
      ctx,
      i % GOBOS.length,
      x,
      y,
      taille,
      rotation,
      hue,
      Math.min(1, f.palette.saturation + 0.06),
      alpha,
    );
  }
};

/**
 * Pendules : une rangée de têtes sur un portique qui se balancent ensemble.
 *
 * Le balancement est lent (une phrase) et un retard court le long de la rangée :
 * la vague traverse le portique au lieu de tout basculer d'un bloc. Les têtes
 * des extrémités balaient plus large que celles du centre, comme un vrai
 * balancier. C'est la figure classique d'un concert.
 */
const pendule: FamilyDraw = (ctx, f, view) => {
  const { width: w, height: h } = f;
  const slotCount = count(9, 1, f.reduced);
  const tetes = count(9, f.quality, f.reduced);
  const active = activeSlots(slotCount, tetes, f.seed);
  // Un faible débordement suffit : les têtes visent vers le bas, donc une tête
  // hors cadre n'éclairerait rien du tout.
  const positions = rowPositions(slotCount, w, w * 0.03);
  const portique = h * 0.05;
  const portee = Math.hypot(w, h) * 1.05;
  const alpha = (0.06 + 0.28 * f.energy + 0.16 * f.beat) * f.alpha;
  if (alpha <= 0.002) return;

  for (const i of active) {
    const x = positions[i] ?? 0;
    const ratio = positions.length === 1 ? 0.5 : i / (positions.length - 1);
    // Retard le long de la rangée : la vague traverse le portique en trois temps.
    const retard = ratio * 3;
    // Balancement contenu : à 45° de la verticale, un faisceau partant du
    // portique quitte le cadre par le côté et n'éclaire plus rien.
    const balance = beatSwing(f, view, f.reduced ? 0.4 : 0.9, GRAND_BALAYAGE_BEATS, retard);
    const angle = Math.PI / 2 + balance;
    const hue = lampHue(f, i);
    const ouverture = 0.85 + 0.5 * f.beat + 0.35 * f.energy;
    softBeam(ctx, {
      x,
      y: portique,
      angle,
      length: portee,
      width: Math.min(w, h) * 0.024 * ouverture,
      hue,
      saturation: f.palette.saturation,
      lightness: f.palette.lightness + 0.05,
      alpha,
      quality: f.quality,
      reduced: f.reduced,
      fumee: f.haze,
      footRatio: 0.05,
    });
    // La tête, posée sur le portique.
    ctx.fillStyle = paint(hue, 0.95, 0.86, alpha * 1.4);
    ctx.beginPath();
    ctx.arc(x, portique, 2.5 + f.beat * 5, 0, Math.PI * 2);
    ctx.fill();
  }
};

/**
 * Couronne : les têtes sont posées sur l'arc supérieur d'une ellipse et visent
 * vers l'extérieur, comme une tiare. La couronne tourne lentement d'un bloc, et
 * chaque faisceau s'allume à son tour : la lumière fait le tour de la couronne.
 */
const couronne: FamilyDraw = (ctx, f, view) => {
  const { width: w, height: h } = f;
  const slotCount = count(11, 1, f.reduced);
  const tetes = count(11, f.quality, f.reduced);
  const active = activeSlots(slotCount, tetes, f.seed);
  const cx = w * 0.5;
  const cy = h * 0.68;
  const rx = w * 0.44;
  const ry = h * 0.34;
  const rotation = beatSwing(f, view, f.reduced ? 0.25 : 0.7, GRAND_BALAYAGE_BEATS);
  const portee = Math.hypot(w, h) * 1.15;
  const alpha = (0.05 + 0.26 * f.energy + 0.15 * f.beat) * f.alpha;
  if (alpha <= 0.002) return;
  const cycle = f.reduced ? 28 : f.energy > 0.55 ? 12 : 20;

  for (const i of active) {
    const part = slotCount === 1 ? 0.5 : i / (slotCount - 1);
    // Arc supérieur : la couronne se lit comme une tiare, pas comme un anneau.
    const autour = Math.PI + part * Math.PI + rotation;
    const x = cx + Math.cos(autour) * rx;
    const y = cy + Math.sin(autour) * ry;
    // Vers l'extérieur, mais relevé vers le haut : une tiare éclaire vers le
    // ciel. Sans ce redressement, les rayons des extrémités partent à
    // l'horizontale et quittent le cadre aussitôt.
    const angle = Math.atan2(y - cy, x - cx) * 0.5 - Math.PI * 0.25;
    const hue = lampHue(f, i);
    // Chaque faisceau s'allume à son tour : la lumière fait le tour de la couronne.
    const allumage = elementEnvelope(f, view, i, cycle, 0.8);
    if (allumage <= 0.01) continue;
    softBeam(ctx, {
      x,
      y,
      angle,
      length: portee,
      width: Math.min(w, h) * 0.014 * (0.8 + f.energy * 0.5 + f.beat * 0.3),
      hue,
      saturation: f.palette.saturation,
      lightness: f.palette.lightness + 0.08,
      alpha: alpha * allumage,
      quality: f.quality,
      reduced: f.reduced,
      fumee: f.haze,
      footRatio: 0.04,
    });
    ctx.fillStyle = paint(hue, 0.95, 0.86, alpha * allumage * 1.5);
    ctx.beginPath();
    ctx.arc(x, y, 2.5 + f.beat * 5, 0, Math.PI * 2);
    ctx.fill();
  }
};

/**
 * Pluie de lumière : des colonnes tombent du plafond, chacune s'allumant et
 * s'éteignant à son rythme et sur une longueur qui lui est propre. Dans la
 * fumée, ça se lit comme une averse — et comme les colonnes ne clignotent pas
 * ensemble, la scène ne bat jamais la mesure à contretemps.
 */
const pluie: FamilyDraw = (ctx, f, view) => {
  const { width: w, height: h } = f;
  const slotCount = count(16, 1, f.reduced);
  const colonnes = count(16, f.quality, f.reduced);
  const active = activeSlots(slotCount, colonnes, f.seed);
  const positions = rowPositions(slotCount, w, w * 0.05);
  // Plus nourrie qu'avant : ces colonnes sont le seul dessin de la scène, et
  // elles doivent tenir tête au halo du fond.
  const alpha = (0.09 + 0.34 * f.energy + 0.2 * f.beat) * f.alpha;
  if (alpha <= 0.002) return;
  const cycle = f.reduced ? 30 : f.energy > 0.55 ? 10 : 18;

  for (const i of active) {
    const x = positions[i] ?? 0;
    const ratio = positions.length === 1 ? 0.5 : i / (positions.length - 1);
    const allumage = elementEnvelope(f, view, i * 7 + 2, cycle, 0.65);
    if (allumage <= 0.01) continue;
    const hue = lampHue(f, i);
    // Longueur propre à chaque colonne : l'averse n'est pas régulière. Aucune
    // n'est courte — une colonne courte se lit comme une tache, pas comme une
    // chute.
    const longueur = h * (0.5 + hash01(i * 311 + f.seed) * 0.75) * allumage;
    softBeam(ctx, {
      x,
      y: -h * 0.05,
      angle: Math.PI / 2 + (ratio - 0.5) * 0.1,
      length: longueur,
      // Assez large pour survivre à la fumée fine : en deçà, la colonne se
      // dissout dans la nappe au lieu de tomber.
      width: Math.min(w, h) * 0.015 * (0.8 + f.energy * 0.5),
      hue,
      saturation: f.palette.saturation,
      lightness: f.palette.lightness + 0.05,
      alpha: alpha * allumage,
      quality: f.quality,
      reduced: f.reduced,
      fumee: f.haze,
      footRatio: 0.45,
    });
  }
};

/**
 * Portique : les faisceaux montent du plancher mais se penchent vers le centre,
 * dessinant une porte de lumière. La porte s'ouvre sur les moments forts et se
 * referme sur les passages calmes — c'est elle qui donne le sentiment d'un
 * passage, d'un seuil, au lieu d'un simple rideau.
 */
const portique: FamilyDraw = (ctx, f, view) => {
  const { width: w, height: h } = f;
  const slotCount = count(13, 1, f.reduced);
  const faisceaux = count(13, f.quality, f.reduced);
  const active = activeSlots(slotCount, faisceaux, f.seed);
  const positions = rowPositions(slotCount, w, w * 0.08);
  const portee = Math.hypot(w, h) * 1.15;
  // Ouverture : 0 = porte fermée (les rayons se rejoignent en haut), 1 = grands
  // rayons verticaux. Elle suit l'énergie, donc l'impact ouvre la porte.
  const ouverture = f.reduced ? 0.55 : 0.35 + 0.55 * f.energy + 0.35 * f.beat;
  const alpha = (0.06 + 0.3 * f.energy + 0.16 * f.beat) * f.alpha;
  if (alpha <= 0.002) return;

  for (const i of active) {
    const ratio = positions.length === 1 ? 0.5 : i / (positions.length - 1);
    const x = positions[i] ?? 0;
    // Penché vers le centre : chaque rayon vise le haut de l'axe médian.
    const penche = (0.5 - ratio) * 1.15 * (1 - Math.min(ouverture, 1));
    // Le balancement lent garde la porte vivante sans la faire clignoter.
    const balance = beatSwing(f, view, f.reduced ? 0.2 : 0.4, GRAND_BALAYAGE_BEATS, ratio);
    const angle = -Math.PI / 2 + penche + balance;
    const hue = lampHue(f, i);
    softBeam(ctx, {
      x,
      y: h * 1.02,
      angle,
      length: portee,
      width: Math.min(w, h) * 0.022 * (0.85 + f.energy * 0.5 + f.beat * 0.3),
      hue,
      saturation: f.palette.saturation,
      lightness: f.palette.lightness + 0.05,
      alpha,
      quality: f.quality,
      reduced: f.reduced,
      fumee: f.haze,
      footRatio: 0.04,
    });
  }
};

/** Familles à formes projetées : gobos et rangées de têtes. */
export const SHAPE_FAMILIES = {
  gobos,
  pendule,
  couronne,
  pluie,
  portique,
} as const;
