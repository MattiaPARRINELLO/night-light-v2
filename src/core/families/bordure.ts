import { clamp01, hash01, smoothstep } from "../series";
import type { TrackView } from "../view";
import { tempsTempsFort } from "./concert-rig";
import { lampHue } from "./harmony";
import type { FrameState } from "./types";

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
 * Motif courant de la bordure.
 *
 * Il change par blocs de huit temps forts, à partir du rôle, de l'énergie et
 * de la graine : la bordure ne prend donc jamais la même forme d'un passage à
 * l'autre, mais deux lectures du même instant donnent le même motif.
 */
export function motifBordure(f: FrameState, view: TrackView): MotifBordure {
  if (f.scene.role === "drop") return "plein";
  const energie = clamp01(f.energy);
  const bloc = Math.floor(tempsTempsFort(f, view) / 8);
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
      const choix = Math.floor(temps / 4) % 2 === 0 ? "gauche" : "droite";
      return diode.cote === choix ? 1 : 0.04;
    }
    case "chenillard": {
      const position = modulo(temps * 0.35, 1);
      const ecart = Math.abs(index / NOMBRE_DIODES_BORDURE - position);
      const distance = Math.min(ecart, 1 - ecart);
      return 1 - smoothstep(0.01, 0.07, distance);
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
 * Intensité de la diode `index` à l'instant courant.
 *
 * Le rail de base reste toujours un peu visible ; le motif décide de la part
 * réellement allumée, et l'éclat d'impact est dosé par le budget de flashs de
 * l'utilisateur. En mode réduit, tout est plafonné sous le seuil d'inconfort
 * lumineux.
 */
export function intensiteBordure(
  f: FrameState,
  view: TrackView,
  index: number,
  budgetFlash = 1,
): number {
  const energie = clamp01(f.energy);
  const motif = motifBordure(f, view);
  const poids = poidsMotif(f, view, index, motif);
  const rail = 0.03 + 0.08 * energie;
  const respiration = 0.85 + 0.15 * Math.sin(f.t * 1.1);
  const eclat = clamp01(f.drop) * clamp01(budgetFlash) * 0.5;
  const brut = rail + poids * (0.2 + 0.65 * energie) * respiration + eclat * Math.max(poids, 0.15);
  return f.reduced ? Math.min(0.3, brut * 0.5) : clamp01(brut);
}
