import { shiftHue } from "../color";
import { clamp01, hash01, mix, smoothstep } from "../series";
import type { SceneRole } from "../show";
import type { TrackView } from "../view";
import { softBeam } from "./beams";
import { contrastHue, lampHue } from "./harmony";
import { beatSwing } from "./tempo";
import type { FamilyDraw, FrameState } from "./types";
import { paint } from "./util";

/**
 * Scénographie de concert.
 *
 * Le spectacle n'est plus seulement une abstraction lumineuse : il se joue sur
 * une vraie scène. Un pont technique en treillis porte huit lyres motorisées,
 * une seconde traverse accroche seize barres LED et quatre blocs de blinders
 * tungstène éclairent la salle.
 *
 * Règle absolue : tout est calculé à partir de `(time, view, plan, frameState)`.
 * Aucun angle ne s'accumule d'une image à l'autre, aucun filament ne garde son
 * état. Une pause ou un saut à `t = 42,5 s` redonne donc exactement la même
 * image, au pixel près.
 */

/** Nombre de lyres du pont principal. */
export const NOMBRE_LYRES = 8;
/** Nombre de diodes des barres LED. */
export const NOMBRE_BATTENS = 16;
/** Nombre de blocs de blinders (deux lampes par bloc). */
export const NOMBRE_BLINDERS = 4;
/**
 * Constante de refroidissement du filament tungstène, en secondes.
 *
 * Un vrai blinders ne s'éteint pas : son filament rougeoie encore longtemps
 * après la coupure. 0,22 s donne cette extinction vive puis traînante qui
 * distingue la lumière tungsten d'un flash LED.
 */
export const TAU_FILAMENT = 0.22;

/** Traverse supérieure : le pont des lyres. */
const PONT_HAUT = 0.112;
/** Traverse inférieure du pont des lyres. */
const PONT_BAS = 0.158;
/** Hauteur exacte des ancrages de lyres, au cœur du pont. */
const LIGNE_LYRES = 0.14;
/** Traverse des barres LED. */
const LIGNE_BATTENS = 0.3;
/** Hauteur des blocs de blinders, sur le pont supérieur. */
const LIGNE_BLINDERS = 0.132;
/** Fenêtre de recherche du dernier impact, en secondes. */
const FENETRE_IMPACT = 2.6;

/**
 * Décalage de refroidissement de chaque bloc, en secondes.
 *
 * Quatre filaments ne refroidissent jamais rigoureusement ensemble. Ce léger
 * décalage suffit à faire vivre la rangée sans jamais tirer au hasard.
 */
const DECALAGES_BLINDERS = [0, 0.018, 0.034, 0.052] as const;

/** Point d'ancrage dans l'espace de la toile, en pixels CSS. */
export interface PointScene {
  x: number;
  y: number;
}

/** Orientation d'une lyre à l'instant courant. */
export interface OrientationLyre {
  /** Direction du faisceau, en radians (π/2 = vers le sol). */
  angle: number;
  /** Demi-ouverture du cône, en radians. */
  ouverture: number;
  /** 0 = faisceau simple, 1 = prisme à trois sous-cônes. */
  prisme: number;
  /** Intensité relative de la tête, 0..1. */
  intensite: number;
}

/** Couleur d'un filament tungstène, en HSL. */
export interface CouleurFilament {
  hue: number;
  saturation: number;
  lightness: number;
}

/** Borne un index dans une rangée, sans arrondir les formules de position. */
function borner(index: number, total: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(index, 0), total - 1);
}

/**
 * Position de la lyre `index` sur le pont principal.
 *
 * La formule est celle du cahier des charges : les têtes sont réparties
 * symétriquement entre 15 % et 85 % de la largeur, à 14 % de la hauteur.
 * L'ancrage tombe donc exactement au milieu de la traverse dessinée par
 * `dessinerStructure`.
 */
export function positionLyre(index: number, largeur: number, hauteur: number): PointScene {
  const i = borner(index, NOMBRE_LYRES);
  return {
    x: largeur * (0.15 + 0.7 * (i / (NOMBRE_LYRES - 1))),
    y: hauteur * LIGNE_LYRES,
  };
}

/**
 * Position de la diode `index` de la rampe LED.
 *
 * Les seize diodes sont volontairement très serrées au centre de la scène :
 * c'est ce qui transforme seize faisceaux en rideau continu plutôt qu'en
 * éventail de projecteurs isolés.
 */
export function positionBatten(index: number, largeur: number, hauteur: number): PointScene {
  const j = borner(index, NOMBRE_BATTENS);
  return {
    x: largeur * (0.3 + 0.4 * (j / (NOMBRE_BATTENS - 1))),
    y: hauteur * LIGNE_BATTENS,
  };
}

/** Position du bloc de blinders `index`, sur le pont supérieur. */
export function positionBlinder(index: number, largeur: number, hauteur: number): PointScene {
  const i = borner(index, NOMBRE_BLINDERS);
  return {
    x: largeur * (0.1 + 0.8 * (i / (NOMBRE_BLINDERS - 1))),
    y: hauteur * LIGNE_BLINDERS,
  };
}

/**
 * Temps musical continu, en temps forts.
 *
 * La phase d'une lyre doit se lire sur la grille rythmique, pas sur le temps
 * mural : un morceau à 90 BPM ne bouge pas comme un morceau à 150 BPM. Sans
 * grille détectée (mode direct), on retombe sur la période estimée.
 */
export function tempsTempsFort(f: FrameState, view: TrackView): number {
  if (view.beats.length > 0) return f.beatIndex + clamp01(f.beatPhase);
  const periode = view.beatPeriod > 0 ? view.beatPeriod : 0.5;
  return f.t / periode;
}

/**
 * Cinématique pan/tilt d'une lyre.
 *
 * Les gestes de console se succèdent selon le rôle de la scène :
 * - `drop` : convergence vers le centre du sol, progressive sur ~0,9 s ;
 * - `refrain` : ballyhoo lent, les têtes balaient sur huit temps forts ;
 * - `montee` : éventail symétrique qui s'ouvre lentement ;
 * - `couplet`/`intro` : dérive presque immobile.
 *
 * Le mouvement ne suit plus un sinus rapide : `beatSwing` vise une position,
 * la rejoint sur les 70 % du bloc puis la tient. Les changements de direction
 * sont donc espacés de plusieurs secondes, comme sur une vraie console, au lieu
 * de repartir à chaque temps fort. L'intensité ne clignote pas sur le beat :
 * seules une respiration lente et une présence propre à chaque tête la font
 * varier.
 *
 * Tout reste analytique, sans état d'une image sur l'autre.
 */
export function orientationLyre(
  f: FrameState,
  view: TrackView,
  index: number,
  role: SceneRole = f.scene.role,
): OrientationLyre {
  const i = borner(index, NOMBRE_LYRES);
  const phase = (i / (NOMBRE_LYRES - 1)) * Math.PI * 2;
  const centre = (NOMBRE_LYRES - 1) / 2;
  const base = Math.PI / 2;
  // Décalage en temps forts, pas en radians : deux têtes voisines n'arrivent
  // jamais exactement ensemble sur leur cible.
  const decalage = (i / (NOMBRE_LYRES - 1)) * 2.2;
  let angle = base;
  let ouverture = 0.024;
  let prisme = 0;
  let intensite = 0.6;

  switch (role) {
    case "drop": {
      // Convergence : toutes les têtes visent le même point au sol, mais la
      // tête ne saute pas. Elle part de la verticale et rejoint la cible en
      // 0,9 s : c'est le temps d'un vrai mouvement de lyre, pas une coupure.
      const cibleX = f.width * (0.5 + 0.035 * Math.sin(f.t * 0.35));
      const cibleY = f.height * 1.02;
      const { x, y } = positionLyre(i, f.width, f.height);
      const angleCible = Math.atan2(cibleY - y, cibleX - x);
      const local = clamp01((f.t - f.scene.start) / 0.9);
      const convergence = smoothstep(0, 1, local);
      angle = base + (angleCible - base) * convergence;
      ouverture = 0.017;
      prisme = f.reduced ? 0 : smoothstep(0.55, 0.85, f.energy);
      intensite = 0.95;
      break;
    }
    case "refrain": {
      // Ballyhoo lent : la cible change tous les huit temps forts, et la tête
      // met toute une phrase à la rejoindre. C'est la lenteur qui rend le
      // balayage crédible.
      const pan = beatSwing(f, view, 0.52, 8, decalage);
      const tilt = beatSwing(f, view, 0.26, 6, decalage * 1.3 + 0.9);
      angle = base + pan * 0.9 + tilt * 0.5;
      ouverture = 0.021;
      // Le prisme s'ouvre progressivement avec l'énergie : jamais un
      // interrupteur qui fait apparaître trois lames d'un coup.
      prisme = f.reduced ? 0 : smoothstep(0.5, 0.85, f.energy) * 0.7;
      intensite = 0.9;
      break;
    }
    case "montee": {
      // Éventail symétrique, ouvert sur une période très lente : les têtes
      // s'écartent et se resserrent sans à-coup.
      const ouvertureEventail = 0.11 * (0.7 + 0.3 * Math.sin(f.t * 0.22));
      angle = base + (i - centre) * ouvertureEventail;
      ouverture = 0.023;
      intensite = 0.8 + 0.12 * clamp01(f.build);
      break;
    }
    case "intro":
      angle = base + beatSwing(f, view, 0.12, 24, decalage);
      ouverture = 0.026;
      intensite = 0.5;
      break;
    case "finale":
      angle = base + beatSwing(f, view, 0.18, 16, decalage) * 0.8;
      ouverture = 0.022;
      intensite = 0.65;
      break;
    case "couplet":
    default:
      angle = base + beatSwing(f, view, 0.2, 12, decalage) * 0.8 + (i - centre) * 0.008;
      ouverture = 0.024;
      intensite = 0.6;
      break;
  }

  // Aucun terme de beat ici : une lyre ne s'éteint pas sur chaque kick. La
  // respiration est lente, et chaque tête a sa propre présence, décalée.
  const presence = 0.82 + 0.18 * Math.sin(f.t * 0.19 + phase * 1.7);
  const respiration = (0.72 + 0.28 * f.energy) * presence;
  return {
    angle,
    ouverture,
    prisme: clamp01(prisme),
    intensite: clamp01(intensite * respiration),
  };
}

/**
 * Angle de la diode `index` de la rampe LED.
 *
 * En refrain et en drop, tous les faisceaux sont parallèles vers le bas : c'est
 * le rideau de lumière. Ailleurs, une onde progressive court le long de la
 * rampe (`sin(time · 2π · f_tempo − j · 0,4)`), ce qui donne la vague
 * d'inclinaison typique des barres motorisées.
 */
export function angleBatten(
  f: FrameState,
  view: TrackView,
  index: number,
  role: SceneRole = f.scene.role,
): number {
  const j = borner(index, NOMBRE_BATTENS);
  const base = Math.PI / 2;
  const tempo = view.tempo > 0 ? view.tempo / 60 : 2;
  const frequence = Math.max(0.35, tempo * 0.5) * (role === "montee" ? 1.25 : 1);
  const amplitude = (role === "montee" ? 0.42 : 0.22) * (0.65 + 0.55 * f.energy);
  const vague = base + amplitude * Math.sin(f.t * Math.PI * 2 * frequence - j * 0.4);

  // Le passage de la vague au rideau se fait en douceur sur 1,2 s : les lames
  // se redressent progressivement au lieu de basculer d'un coup à la frontière.
  const cibleRideau = role === "drop" || role === "refrain" ? 1 : 0;
  const local = clamp01((f.t - f.scene.start) / 1.2);
  const rideau = smoothstep(0, 1, local) * cibleRideau;
  return vague + (base - vague) * rideau;
}

/** Décroissance pure du filament : 1 à l'impact, 0 bien après. */
export function decroissanceFilament(age: number): number {
  if (!Number.isFinite(age) || age < 0) return 0;
  return clamp01(Math.exp(-age / TAU_FILAMENT));
}

const BLANC_CHAUD: CouleurFilament = { hue: 42, saturation: 0.16, lightness: 0.96 };
const AMBRE: CouleurFilament = { hue: 34, saturation: 0.88, lightness: 0.68 };
const ROUGE: CouleurFilament = { hue: 10, saturation: 0.94, lightness: 0.42 };
const ROUGE_PROFOND: CouleurFilament = { hue: 4, saturation: 0.96, lightness: 0.28 };

function melangeCouleur(a: CouleurFilament, b: CouleurFilament, ratio: number): CouleurFilament {
  return {
    hue: mix(a.hue, b.hue, ratio),
    saturation: mix(a.saturation, b.saturation, ratio),
    lightness: mix(a.lightness, b.lightness, ratio),
  };
}

/**
 * Dérive chromatique du filament.
 *
 * Les seuils du cahier des charges sont respectés — blanc chaud au-dessus de
 * 0,8, ambre entre 0,3 et 0,8, rouge en dessous — mais les frontières sont
 * adoucies : un filament ne change pas de couleur d'un coup, il refroidit.
 *
 * C'est la seule couleur du spectacle qui ne sort pas de la palette : un
 * blinders tungstène est physiquement chaud, on ne peut pas le teinter sans
 * mentir sur la source. La structure et les faisceaux, eux, continuent de
 * suivre la palette de la scène.
 */
export function couleurBlinder(intensite: number): CouleurFilament {
  const i = clamp01(intensite);
  if (i > 0.8) return melangeCouleur(AMBRE, BLANC_CHAUD, smoothstep(0.82, 0.98, i));
  if (i > 0.3) return melangeCouleur(ROUGE, AMBRE, smoothstep(0.3, 0.62, i));
  return melangeCouleur(ROUGE_PROFOND, ROUGE, smoothstep(0.05, 0.3, i));
}

/** Impact le plus récent : fin de montée ou temps fort porteur de basses. */
interface ImpactMajeur {
  temps: number;
  force: number;
}

/**
 * Dernier impact majeur avant `t`.
 *
 * On ne conserve aucun état : la fonction relit les montées et les temps forts
 * de la fenêtre courante. La cadence des temps forts dépend du rôle — un
 * couplet ne fait pas claquer les blinders à chaque mesure.
 */
function dernierImpactMajeur(view: TrackView, t: number, role: SceneRole): ImpactMajeur | null {
  let dernier: ImpactMajeur | null = null;

  for (const build of view.buildsEndingIn(t - FENETRE_IMPACT, t)) {
    if (dernier === null || build.end > dernier.temps) {
      dernier = { temps: build.end, force: clamp01(build.strength) };
    }
  }

  const cadence = role === "drop" || role === "refrain" ? 1 : role === "montee" ? 2 : 4;
  for (const beat of view.beatsIn(t - FENETRE_IMPACT, t)) {
    const basse = view.bassAt(beat);
    if (basse < 0.3) continue;
    if (view.beatIndexAt(beat) % cadence !== 0) continue;
    if (dernier === null || beat > dernier.temps) {
      dernier = { temps: beat, force: clamp01(0.35 + 0.65 * basse) };
    }
  }

  return dernier;
}

/** Part de l'éclat maximal selon le rôle de la scène. */
const FACTEUR_ROLE: Record<SceneRole, number> = {
  intro: 0.3,
  couplet: 0.5,
  montee: 0.7,
  refrain: 0.9,
  drop: 1,
  finale: 0.55,
};

/**
 * Intensité du blinder `index` à l'instant courant.
 *
 * `I(t) = clamp01(exp(−Δt / τ))`, pondérée par la force de l'impact, l'énergie
 * de la scène et le rôle musical. Le décalage par bloc vient uniquement de
 * `DECALAGES_BLINDERS` : aucune horloge, aucun état.
 */
export function intensiteBlinder(f: FrameState, view: TrackView, index: number): number {
  const i = borner(index, NOMBRE_BLINDERS);
  const decalage = DECALAGES_BLINDERS[i] ?? 0;
  const impact = dernierImpactMajeur(view, f.t, f.scene.role);
  if (impact === null) {
    // Mode direct : il n'y a ni montée ni grille de temps forts. Le transient
    // live prend alors le relais, toujours à partir de l'état de l'image.
    if (view.beats.length > 0 || f.beat <= 0.02) return 0;
    const direct =
      f.beat *
      (0.35 + 0.65 * clamp01(f.bass)) *
      (0.45 + 0.55 * clamp01(f.energy)) *
      FACTEUR_ROLE[f.scene.role];
    return clamp01(f.reduced ? Math.min(0.32, direct * 0.55) : direct);
  }

  const age = f.t - impact.temps + decalage;
  if (age < 0) return 0;

  const force = 0.4 + 0.6 * clamp01(impact.force);
  const energie = 0.45 + 0.55 * clamp01(f.energy);
  const brut = decroissanceFilament(age) * force * energie * FACTEUR_ROLE[f.scene.role];
  // En mode réduit, le filament rougeoie doucement mais ne claque jamais : on
  // plafonne l'intensité pour rester sous le seuil du flare.
  return clamp01(f.reduced ? Math.min(0.32, brut * 0.55) : brut);
}

/**
 * Traverse en treillis : deux membrures parallèles et des croisillons en X.
 *
 * Dessinée en traits fins et semi-transparents, elle doit se lire comme une
 * structure métallique en filigrane, jamais comme un cadre noir.
 */
function dessinerPoutre(
  ctx: CanvasRenderingContext2D,
  f: FrameState,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  segments: number,
  alpha: number,
): void {
  const teinte = contrastHue(f);
  const pas = (x1 - x0) / Math.max(segments, 1);
  ctx.strokeStyle = paint(teinte, 0.28, 0.55, 0.34 * alpha);
  ctx.lineWidth = Math.max(1, f.width * 0.0011);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y0);
  ctx.moveTo(x0, y1);
  ctx.lineTo(x1, y1);
  for (let index = 0; index < segments; index += 1) {
    const gauche = x0 + index * pas;
    const droite = gauche + pas;
    ctx.moveTo(gauche, y0);
    ctx.lineTo(droite, y1);
    ctx.moveTo(droite, y0);
    ctx.lineTo(gauche, y1);
  }
  ctx.stroke();

  // Lisse centrale : donne l'épaisseur de la poutre sans alourdir le trait.
  ctx.strokeStyle = paint(teinte, 0.2, 0.42, 0.2 * alpha);
  ctx.beginPath();
  ctx.moveTo(x0, (y0 + y1) / 2);
  ctx.lineTo(x1, (y0 + y1) / 2);
  ctx.stroke();
}

/**
 * Structure fixe : ponts, totems et corps d'appareils.
 *
 * Appelée une fois par image, avant les faisceaux et en mode `source-over`.
 * Les ancrages des appareils sont exactement ceux des formules de position,
 * donc un faisceau part toujours de sa traverse.
 */
export function dessinerStructure(ctx: CanvasRenderingContext2D, f: FrameState): void {
  const { width: w, height: h } = f;
  const alpha = 0.8 + 0.2 * f.energy;
  const segments = f.reduced ? 10 : Math.min(26, Math.max(12, Math.round(w / 56)));
  const teinte = contrastHue(f);
  const corps = paint(teinte, 0.18, 0.16, 0.92);
  const lentille = paint(teinte, 0.45, 0.58, 0.55);

  dessinerPoutre(ctx, f, w * 0.055, w * 0.945, h * PONT_HAUT, h * PONT_BAS, segments, alpha);
  // Seconde traverse, plus courte : c'est le rail des barres LED, en retrait.
  dessinerPoutre(ctx, f, w * 0.245, w * 0.755, h * 0.292, h * 0.318, Math.max(8, Math.round(segments * 0.6)), alpha * 0.9);

  // Totems latéraux : deux montants fins qui descendent jusqu'au plancher.
  ctx.strokeStyle = paint(teinte, 0.3, 0.5, 0.22 * alpha);
  ctx.lineWidth = Math.max(1, w * 0.0009);
  for (const cote of [0.045, 0.955] as const) {
    const x = w * cote;
    const ecart = w * 0.0055;
    const sommet = h * PONT_BAS;
    const bas = h * 0.985;
    ctx.beginPath();
    ctx.moveTo(x - ecart, sommet);
    ctx.lineTo(x - ecart, bas);
    ctx.moveTo(x + ecart, sommet);
    ctx.lineTo(x + ecart, bas);
    for (let index = 0; index < 10; index += 1) {
      const y0 = sommet + ((bas - sommet) * index) / 10;
      const y1 = sommet + ((bas - sommet) * (index + 1)) / 10;
      ctx.moveTo(x - ecart, y0);
      ctx.lineTo(x + ecart, y1);
      ctx.moveTo(x + ecart, y0);
      ctx.lineTo(x - ecart, y1);
    }
    ctx.stroke();
  }

  // Lyres : yoke, corps et lentille, ancrés au cœur de la traverse.
  for (let index = 0; index < NOMBRE_LYRES; index += 1) {
    const { x, y } = positionLyre(index, w, h);
    const demi = Math.max(3, w * 0.0042);
    const hauteur = Math.max(6, h * 0.012);
    ctx.strokeStyle = paint(teinte, 0.25, 0.45, 0.32 * alpha);
    ctx.lineWidth = Math.max(1, w * 0.0009);
    ctx.beginPath();
    ctx.moveTo(x, h * PONT_BAS);
    ctx.lineTo(x, y - hauteur * 0.45);
    ctx.stroke();

    ctx.fillStyle = corps;
    ctx.beginPath();
    ctx.moveTo(x - demi * 0.72, y - hauteur * 0.45);
    ctx.lineTo(x + demi * 0.72, y - hauteur * 0.45);
    ctx.lineTo(x + demi, y + hauteur * 0.55);
    ctx.lineTo(x - demi, y + hauteur * 0.55);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = lentille;
    ctx.beginPath();
    ctx.arc(x, y + hauteur * 0.5, Math.max(1.2, w * 0.0014), 0, Math.PI * 2);
    ctx.fill();
  }

  // Barres LED : une ligne de diodes serrées sous leur traverse.
  for (let index = 0; index < NOMBRE_BATTENS; index += 1) {
    const { x, y } = positionBatten(index, w, h);
    const demi = Math.max(2, w * 0.0022);
    const hauteur = Math.max(2, h * 0.004);
    ctx.fillStyle = corps;
    ctx.beginPath();
    ctx.moveTo(x - demi, y - hauteur);
    ctx.lineTo(x + demi, y - hauteur);
    ctx.lineTo(x + demi, y + hauteur);
    ctx.lineTo(x - demi, y + hauteur);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = lentille;
    ctx.beginPath();
    ctx.arc(x, y + hauteur * 1.6, Math.max(1, w * 0.0011), 0, Math.PI * 2);
    ctx.fill();
  }

  // Blinders : quatre blocs de deux lampes, accrochés au pont supérieur.
  for (let index = 0; index < NOMBRE_BLINDERS; index += 1) {
    const { x, y } = positionBlinder(index, w, h);
    const demi = Math.max(5, w * 0.008);
    const hauteur = Math.max(3, h * 0.006);
    ctx.fillStyle = corps;
    ctx.beginPath();
    ctx.moveTo(x - demi, y - hauteur);
    ctx.lineTo(x + demi, y - hauteur);
    ctx.lineTo(x + demi, y + hauteur);
    ctx.lineTo(x - demi, y + hauteur);
    ctx.closePath();
    ctx.fill();

    for (const cote of [-1, 1] as const) {
      ctx.fillStyle = paint(34, 0.55, 0.32, 0.8);
      ctx.beginPath();
      ctx.arc(x + cote * demi * 0.46, y + hauteur * 0.7, Math.max(1.2, w * 0.0014), 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/**
 * Blinders tungstène et flares anamorphiques.
 *
 * Appelée en mode `lighter`. Le halo extérieur reprend la teinte d'accent de la
 * scène ; le cœur, lui, reste chaud — c'est un filament, pas une LED.
 */
export function dessinerBlinders(
  ctx: CanvasRenderingContext2D,
  f: FrameState,
  view: TrackView,
  budgetFlash = 1,
): void {
  const { width: w, height: h } = f;
  const budget = clamp01(budgetFlash);

  for (let index = 0; index < NOMBRE_BLINDERS; index += 1) {
    const intensite = intensiteBlinder(f, view, index);
    if (intensite <= 0.008) continue;
    const { x, y } = positionBlinder(index, w, h);
    const couleur = couleurBlinder(intensite);
    const rayon = Math.min(w, h) * (0.035 + 0.09 * intensite);

    // Halo circulaire : la lampe elle-même, avant l'étirement de l'objectif.
    const halo = ctx.createRadialGradient(x, y, 0, x, y, Math.max(rayon, 1));
    halo.addColorStop(0, paint(couleur.hue, couleur.saturation * 0.55, couleur.lightness, 0.95 * intensite * f.alpha));
    halo.addColorStop(0.35, paint(couleur.hue, couleur.saturation, couleur.lightness * 0.85, 0.42 * intensite * f.alpha));
    halo.addColorStop(1, paint(shiftHue(couleur.hue, 12), couleur.saturation * 0.8, couleur.lightness * 0.6, 0));
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(rayon, 1), 0, Math.PI * 2);
    ctx.fill();

    // Flare anamorphique : un trait horizontal très étiré, signature des
    // caméras de concert. On l'approche par un rectangle rempli d'un dégradé
    // horizontal, sans transformation de contexte — le rendu reste testable et
    // le coût se limite à un remplissage.
    if (intensite > 0.6 && !f.reduced && budget > 0) {
      const force = clamp01((intensite - 0.6) / 0.4) * budget;
      const demi = Math.max(w * 0.3, rayon * 6);
      const bande = ctx.createLinearGradient(x - demi, 0, x + demi, 0);
      bande.addColorStop(0, paint(couleur.hue, couleur.saturation * 0.6, couleur.lightness, 0));
      bande.addColorStop(0.5, paint(couleur.hue, couleur.saturation * 0.35, couleur.lightness, 0.62 * force * f.alpha));
      bande.addColorStop(1, paint(couleur.hue, couleur.saturation * 0.6, couleur.lightness, 0));
      ctx.fillStyle = bande;
      ctx.beginPath();
      ctx.moveTo(x - demi, y - 2.2 - 3 * force);
      ctx.lineTo(x + demi, y - 2.2 - 3 * force);
      ctx.lineTo(x + demi, y + 2.2 + 3 * force);
      ctx.lineTo(x - demi, y + 2.2 + 3 * force);
      ctx.closePath();
      ctx.fill();

      // Cœur blanc du flare, plus court et plus fin.
      const coeur = ctx.createLinearGradient(x - demi * 0.35, 0, x + demi * 0.35, 0);
      coeur.addColorStop(0, paint(couleur.hue, 0.1, 0.98, 0));
      coeur.addColorStop(0.5, paint(couleur.hue, 0.12, 0.99, 0.55 * force * f.alpha));
      coeur.addColorStop(1, paint(couleur.hue, 0.1, 0.98, 0));
      ctx.fillStyle = coeur;
      ctx.beginPath();
      ctx.moveTo(x - demi * 0.35, y - 0.8);
      ctx.lineTo(x + demi * 0.35, y - 0.8);
      ctx.lineTo(x + demi * 0.35, y + 0.8);
      ctx.lineTo(x - demi * 0.35, y + 0.8);
      ctx.closePath();
      ctx.fill();
    }

    // Les deux lampes du bloc : deux points chauds, jamais un seul.
    for (const cote of [-1, 1] as const) {
      const lx = x + cote * Math.max(3, w * 0.004);
      ctx.fillStyle = paint(couleur.hue, couleur.saturation * 0.25, 0.98, intensite * f.alpha);
      ctx.beginPath();
      ctx.arc(lx, y + 2, 1.5 + 4 * intensite, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/**
 * Huit lyres suspendues et leurs cônes volumétriques.
 *
 * Le faisceau est un trapèze dégradé, plus dense à la source qu'au sol, déposé
 * dans la nappe de fumée existante. Le prisme ne s'ouvre que sur les sections
 * à haute énergie : trois sous-cônes décalés d'un angle fin qui oscille à
 * `sin(time · 4)`.
 */
const lyresSuspendues: FamilyDraw = (ctx, f, view) => {
  const { width: w, height: h } = f;
  // Pas de terme de beat : les huit têtes ne clignotent pas ensemble sur le
  // kick. Leur intensité est déjà modulée, tête par tête, lentement.
  const alpha = (0.08 + 0.3 * f.energy) * f.alpha;
  if (alpha <= 0.002) return;

  for (let index = 0; index < NOMBRE_LYRES; index += 1) {
    const { x, y } = positionLyre(index, w, h);
    const orientation = orientationLyre(f, view, index);
    const portee = Math.min(
      Math.hypot(w, h) * 1.25,
      (h * 1.04 - y) / Math.max(Math.sin(orientation.angle), 0.32),
    );
    const largeur = Math.tan(orientation.ouverture) * portee;
    const teinte = lampHue(f, index);
    const spec = {
      x,
      y,
      angle: orientation.angle,
      length: portee,
      width: largeur,
      hue: teinte,
      saturation: f.palette.saturation,
      lightness: f.palette.lightness + 0.08,
      quality: f.quality,
      reduced: f.reduced,
      fumee: f.haze,
      footRatio: 0.05,
      tailHue: shiftHue(teinte, 16),
    };

    if (orientation.prisme > 0.02 && !f.reduced) {
      // Trois sous-cônes très fins : le prisme d'une lyre ne double pas la
      // largeur du faisceau, il la démultiplie en lames. Les lames latérales
      // s'allument avec `prisme` (0..1) : jamais un interrupteur.
      const delta = 0.012 * orientation.prisme * Math.sin(f.t * 3);
      const central = alpha * orientation.intensite;
      const force = orientation.prisme;
      softBeam(ctx, {
        ...spec,
        angle: orientation.angle,
        alpha: central * (0.82 + 0.18 * force),
        width: largeur * 1.08,
      });
      for (const cote of [-1, 1] as const) {
        softBeam(ctx, {
          ...spec,
          angle: orientation.angle + cote * delta,
          alpha: central * 0.5 * force,
          width: largeur * 0.78,
          // Les lames latérales sont fines : une seule couche suffit, la nappe
          // de fumée se charge d'adoucir leur bord. On garde le budget de
          // dessin pour le cœur du faisceau et les seize barres LED.
          layers: 1,
        });
      }
    } else {
      softBeam(ctx, { ...spec, alpha: alpha * orientation.intensite });
    }

    // La lentille : sans ce point, le faisceau semble partir du vide. Son
    // diamètre suit l'énergie, pas le beat — une lampe ne strobe pas.
    ctx.fillStyle = paint(teinte, 0.95, 0.88, alpha * orientation.intensite * 1.9);
    ctx.beginPath();
    ctx.arc(x, y, 2.2 + f.energy * 1.4, 0, Math.PI * 2);
    ctx.fill();
  }
};

/**
 * Seize barres LED : vague d'inclinaison ou rideau de lumière.
 *
 * En couplet et en montée, l'onde progressive court de diode en diode. En
 * refrain et en drop, toutes les lames tombent parallèlement et l'intensité
 * suit le spectre bas/médium : c'est le rideau qui ferme la scène.
 */
const barresLed: FamilyDraw = (ctx, f, view) => {
  const { width: w, height: h } = f;
  // Même règle que pour les lyres : la rampe ne clignote pas sur le kick.
  const alpha = (0.07 + 0.26 * f.energy) * f.alpha;
  if (alpha <= 0.002) return;

  const cibleRideau = f.scene.role === "drop" || f.scene.role === "refrain" ? 1 : 0;
  const local = clamp01((f.t - f.scene.start) / 1.2);
  const rideau = smoothstep(0, 1, local) * cibleRideau;
  const spectre = clamp01(0.65 * f.bass + 0.35 * f.mid);
  const temps = tempsTempsFort(f, view);

  for (let index = 0; index < NOMBRE_BATTENS; index += 1) {
    const { x, y } = positionBatten(index, w, h);
    const angle = angleBatten(f, view, index);
    const portee = Math.min(
      Math.hypot(w, h) * 1.2,
      (h * 1.06 - y) / Math.max(Math.sin(angle), 0.45),
    );
    const ouverture = 0.007 + hash01(index * 271 + f.seed) * 0.004;
    const vague = 0.5 + 0.5 * Math.sin(temps * Math.PI - index * 0.25);
    const modulationVague = (0.4 + 0.6 * spectre) * (0.65 + 0.35 * vague);
    const modulationRideau = 0.35 + 0.65 * spectre;
    const modulation = modulationVague + (modulationRideau - modulationVague) * rideau;
    // La teinte glisse de la vague au rideau au lieu de basculer d'un coup.
    const teinteVague = lampHue(f, index % 4);
    const teinteRideau = lampHue(f, 0);
    const ecartTeinte = ((teinteRideau - teinteVague + 540) % 360) - 180;
    const teinte = shiftHue(teinteVague, ecartTeinte * rideau);

    softBeam(ctx, {
      x,
      y,
      angle,
      length: portee,
      width: Math.tan(ouverture) * portee,
      hue: teinte,
      saturation: f.palette.saturation,
      lightness: f.palette.lightness + 0.1,
      alpha: alpha * modulation,
      quality: f.quality,
      reduced: f.reduced,
      fumee: f.haze,
      // Une lame de barre LED est presque un trait : une seule couche suffit,
      // et c'est ce qui permet de garder seize faisceaux dans le budget.
      layers: 1,
      footRatio: 0.03,
      tailHue: shiftHue(teinte, 10),
    });

    ctx.fillStyle = paint(teinte, 0.95, 0.88, alpha * modulation * 2.2);
    ctx.beginPath();
    ctx.arc(x, y, 1.8 + f.energy * 1.1, 0, Math.PI * 2);
    ctx.fill();
  }
};

/**
 * Le plateau complet : lyres et barres LED ensemble.
 *
 * C'est la scène de refrain ou de drop, celle qui doit se lire immédiatement
 * comme un concert. Les barres sont légèrement en retrait pour que les lyres
 * gardent la vedette sur le pont supérieur.
 */
const pontConcert: FamilyDraw = (ctx, f, view) => {
  lyresSuspendues(ctx, f, view);
  barresLed(ctx, { ...f, alpha: f.alpha * 0.85 }, view);
};

/** Familles de la scénographie concert. */
export const CONCERT_FAMILIES = {
  "lyres-suspendues": lyresSuspendues,
  "barres-led": barresLed,
  "pont-concert": pontConcert,
} as const;
