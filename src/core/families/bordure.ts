import { clamp01, hash01, mix, smoothstep } from "../series";
import type { TrackView } from "../view";
import { tempsTempsFort } from "./concert-rig";
import { contrastHue, lampHue } from "./harmony";
import type { FrameState } from "./types";
import { paint } from "./util";

/**
 * Bordure de diodes qui fait le tour de l'écran.
 *
 * Ce n'est pas une famille de scène : c'est une couche permanente, dessinée
 * par-dessus n'importe quel effet. Elle décide seule de s'allumer — un rail
 * discret au repos, un côté, un chenillard, une respiration, ou tout le
 * pourtour sur un impact — et reste analytique : aucune diode ne garde d'état
 * d'une image à l'autre.
 */

/** Nombre de diodes réparties sur le périmètre. */
export const NOMBRE_DIODES_BORDURE = 72;

/** Retrait de la bordure par rapport au bord, en fraction du petit côté. */
const MARGE_BORDURE = 0.012;

export type MotifBordure =
  | "rail"
  | "haut"
  | "cote"
  | "alternance"
  | "chenillard"
  | "respiration"
  | "plein";

export interface DiodeBordure {
  x: number;
  y: number;
  /** Orientation du segment, en radians (0 = vers la droite). */
  angle: number;
  cote: "haut" | "bas" | "gauche" | "droite";
}

function modulo(value: number, total: number): number {
  return ((value % total) + total) % total;
}

/**
 * Position de la diode `index` sur le périmètre.
 *
 * Le parcours part du coin haut-gauche et tourne dans le sens horaire. La marge
 * est calculée sur le petit côté : en portrait comme en paysage, la bordure
 * reste entièrement dans le cadre.
 */
export function positionBordure(index: number, largeur: number, hauteur: number): DiodeBordure {
  const marge = Math.min(largeur, hauteur) * MARGE_BORDURE;
  const largeurUtile = Math.max(largeur - 2 * marge, 0);
  const hauteurUtile = Math.max(hauteur - 2 * marge, 0);
  const perimetre = 2 * (largeurUtile + hauteurUtile);
  if (perimetre <= 0) {
    return { x: largeur / 2, y: hauteur / 2, angle: 0, cote: "haut" };
  }

  const position = modulo(index, NOMBRE_DIODES_BORDURE) * (perimetre / NOMBRE_DIODES_BORDURE);

  if (position < largeurUtile) {
    return { x: marge + position, y: marge, angle: 0, cote: "haut" };
  }
  if (position < largeurUtile + hauteurUtile) {
    return {
      x: largeur - marge,
      y: marge + (position - largeurUtile),
      angle: Math.PI / 2,
      cote: "droite",
    };
  }
  if (position < 2 * largeurUtile + hauteurUtile) {
    return {
      x: largeur - marge - (position - largeurUtile - hauteurUtile),
      y: hauteur - marge,
      angle: Math.PI,
      cote: "bas",
    };
  }
  return {
    x: marge,
    y: hauteur - marge - (position - 2 * largeurUtile - hauteurUtile),
    angle: -Math.PI / 2,
    cote: "gauche",
  };
}

/**
 * Motif d'un bloc de huit temps forts.
 *
 * En mode réduit, ni chenillard ni plein : seulement un rail ou une respiration,
 * pour ne jamais faire courir un point lumineux.
 */
function motifPourBloc(f: FrameState, bloc: number): MotifBordure {
  const energie = clamp01(f.energy);
  if (f.reduced) return energie > 0.5 ? "respiration" : "rail";
  if (f.scene.role === "drop") return "plein";
  const tirage = hash01(bloc * 7919 + f.seed + f.scene.index * 131);

  if (f.scene.role === "refrain") {
    if (tirage < 0.3) return "chenillard";
    if (tirage < 0.55) return "alternance";
    if (tirage < 0.8) return "respiration";
    return "plein";
  }
  if (f.scene.role === "montee") {
    if (clamp01(f.build) > 0.6) return "plein";
    return tirage < 0.5 ? "haut" : "chenillard";
  }
  if (energie < 0.3) return "rail";
  if (energie > 0.75) return tirage < 0.5 ? "plein" : "chenillard";
  return tirage < 0.4 ? "cote" : tirage < 0.7 ? "respiration" : "rail";
}

/**
 * Motif courant de la bordure.
 *
 * Il change par blocs de huit temps forts, à partir du rôle, de l'énergie et
 * de la graine : la bordure ne prend donc jamais la même forme d'un passage à
 * l'autre, mais deux lectures du même instant donnent le même motif.
 */
export function motifBordure(f: FrameState, view: TrackView): MotifBordure {
  return motifPourBloc(f, Math.floor(tempsTempsFort(f, view) / 8));
}

/**
 * Part allumée de la diode `index` dans un motif, 0..1.
 *
 * Un motif n'est pas un interrupteur : les diodes éteintes gardent une veilleuse
 * très faible, et le chenillard comme la respiration sont des fonctions lisses.
 */
export function poidsMotif(
  f: FrameState,
  view: TrackView,
  index: number,
  motif: MotifBordure = motifBordure(f, view),
): number {
  const diode = positionBordure(index, f.width, f.height);
  const temps = tempsTempsFort(f, view);

  switch (motif) {
    case "haut":
      return diode.cote === "haut" ? 1 : 0.04;
    case "cote": {
      const bloc = Math.floor(temps / 8);
      const choix = hash01(bloc * 7919 + f.seed) < 0.5 ? "gauche" : "droite";
      return diode.cote === choix ? 1 : 0.04;
    }
    case "alternance": {
      // Bascule de côté lissée sur ~0,2 s : sans ce fondu, tout un bord
      // s'éteindrait entre deux images.
      const position = temps / 4;
      const blocAlt = Math.floor(position);
      const local = position - blocAlt;
      const courant = blocAlt % 2 === 0 ? "gauche" : "droite";
      const precedent = (blocAlt - 1) % 2 === 0 ? "gauche" : "droite";
      const cible = diode.cote === courant ? 1 : 0.04;
      const avant = diode.cote === precedent ? 1 : 0.04;
      return mix(avant, cible, smoothstep(0, 0.2, local));
    }
    case "chenillard": {
      // Course lente, profil gaussien : le point chaud s'élargit au lieu de
      // sauter d'une diode à l'autre image après image.
      const position = modulo(temps * 0.2, 1);
      const ecart = Math.abs(index / NOMBRE_DIODES_BORDURE - position);
      const distance = Math.min(ecart, 1 - ecart);
      return Math.exp(-(distance * distance) / (2 * 0.11 * 0.11));
    }
    case "respiration":
      return 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(f.t * 0.8));
    case "plein":
      return 1;
    case "rail":
    default:
      return 0.15;
  }
}

/** Teinte de la diode : celle de la scène, parcourue comme les autres lampes. */
export function couleurBordure(f: FrameState, index: number): number {
  return lampHue(f, index);
}

/**
 * Poids effectif d'une diode, fondus de motif compris.
 *
 * Le motif d'un bloc arrive en fondu sur le premier dixième du bloc : le
 * pourtour se transforme au lieu de basculer d'un coup. Au passage d'un bloc au
 * suivant, la valeur est exactement continue (le motif sortant devient le motif
 * précédent, et le fondu repart de zéro).
 */
function poidsCourant(f: FrameState, view: TrackView, index: number): number {
  const temps = tempsTempsFort(f, view);
  const bloc = Math.floor(temps / 8);
  const local = temps / 8 - bloc;
  const fondu = smoothstep(0, 0.12, local);
  const avant = poidsMotif(f, view, index, motifPourBloc(f, bloc - 1));
  const apres = poidsMotif(f, view, index, motifPourBloc(f, bloc));
  return mix(avant, apres, fondu);
}

/**
 * Intensité de la diode `index` à l'instant courant.
 *
 * Le rail de base reste toujours un peu visible ; le motif décide de la part
 * réellement allumée, et l'éclat d'impact est dosé par le budget de flashs de
 * l'utilisateur. En mode réduit, ni chenillard ni éclat : tout est plafonné
 * sous le seuil d'inconfort lumineux.
 */
export function intensiteBordure(
  f: FrameState,
  view: TrackView,
  index: number,
  budgetFlash = 1,
): number {
  const energie = clamp01(f.energy);
  const poids = poidsCourant(f, view, index);
  const rail = 0.03 + 0.08 * energie;
  const respiration = 0.85 + 0.15 * Math.sin(f.t * 1.1);
  const eclat = f.reduced ? 0 : clamp01(f.drop) * clamp01(budgetFlash) * 0.5;
  const brut = rail + poids * (0.2 + 0.65 * energie) * respiration + eclat * Math.max(poids, 0.15);
  return f.reduced ? Math.min(0.3, brut * 0.5) : clamp01(brut);
}

/**
 * Dessine la bordure : le rail continu, puis chaque diode allumée.
 *
 * Aucune transformation de contexte et aucun dégradé par diode : le coût reste
 * une passe de trait plus deux remplissages par diode visible, quel que soit
 * l'écran.
 */
export function dessinerBordure(
  ctx: CanvasRenderingContext2D,
  f: FrameState,
  view: TrackView,
  budgetFlash = 1,
): void {
  const { width: w, height: h } = f;
  const marge = Math.min(w, h) * MARGE_BORDURE;
  const energie = clamp01(f.energy);

  // Rail continu : présent même quand aucune diode n'est allumée, il donne son
  // architecture à la scène.
  ctx.strokeStyle = paint(contrastHue(f), 0.2, 0.5, 0.1 + 0.08 * energie);
  ctx.lineWidth = Math.max(0.8, Math.min(w, h) * 0.0009);
  ctx.beginPath();
  ctx.moveTo(marge, marge);
  ctx.lineTo(w - marge, marge);
  ctx.lineTo(w - marge, h - marge);
  ctx.lineTo(marge, h - marge);
  ctx.closePath();
  ctx.stroke();

  const base = Math.max(1, Math.min(w, h) * 0.0018);
  for (let index = 0; index < NOMBRE_DIODES_BORDURE; index += 1) {
    const intensite = intensiteBordure(f, view, index, budgetFlash);
    if (intensite <= 0.01) continue;
    const { x, y } = positionBordure(index, w, h);
    const teinte = couleurBordure(f, index);

    // Halo court, puis cœur : deux remplissages, jamais un gradient radial.
    ctx.fillStyle = paint(teinte, 0.8, 0.6, intensite * 0.22);
    ctx.beginPath();
    ctx.arc(x, y, base * 3, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = paint(teinte, 0.85, 0.9, intensite);
    ctx.beginPath();
    ctx.arc(x, y, base * (0.8 + 0.5 * intensite), 0, Math.PI * 2);
    ctx.fill();
  }
}
