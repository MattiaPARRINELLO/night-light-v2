import type { Palette, Scene } from "../show";
import type { TrackView } from "../view";

/** État complet d'une image, dérivé uniquement du temps musical. */
export interface FrameState {
  /** Position de lecture, en secondes. */
  t: number;
  width: number;
  height: number;
  /** Échelle de rendu (device pixel ratio), pour garder des tailles cohérentes. */
  dpr: number;
  scene: Scene;
  palette: Palette;
  energy: number;
  bass: number;
  mid: number;
  high: number;
  /** Battement 0..1 (décroissance depuis le dernier temps fort). */
  beat: number;
  /** Phase dans le temps fort, 0..1. */
  beatPhase: number;
  /** Numéro du temps fort courant. */
  beatIndex: number;
  /** Progression dans une montée, 0..1 (0 si aucune). */
  build: number;
  /** Force de la montée courante, 0..1. */
  buildStrength: number;
  /** Impact d'une montée déjà retombée, 0..1 (0 avant l'impact). */
  drop: number;
  /** Secondes écoulées depuis le dernier temps fort (Infinity si aucun). */
  beatAge: number;
  /** Secondes écoulées depuis le dernier impact (Infinity si aucun). */
  dropAge: number;
  /** Vitesse de montée de l'énergie, 0..1 (0 quand ça descend). */
  surge: number;
  /** Intensité effective = scène * réglage utilisateur. */
  intensity: number;
  /** Poids de la scène dans le fondu, 0..1. */
  alpha: number;
  reduced: boolean;
  /** Qualité adaptative 0..1 : pilote le nombre d'éléments dessinés. */
  quality: number;
  seed: number;
  /** Surface de fumée de l'image, quand le rendu en fournit une. */
  haze?: HazeTarget;
  /** Numéro d'image. */
  frame: number;
}

/**
 * Une nappe de fumée : où les faisceaux se déposent, et la surface où ils sont
 * floutés.
 */
export interface HazeLayer {
  /** Où les familles déposent leurs faisceaux. */
  ctx: CanvasRenderingContext2D;
  /** Seconde surface, de même taille : flouter sans relire la première. */
  blurPass: CanvasRenderingContext2D;
  /** Rapport de résolution de la surface (0,5 = deux fois plus petite). */
  scale: number;
  /** Vrai si un faisceau y a été déposé pendant cette image. */
  used: boolean;
}

/**
 * Les nappes de fumée d'une image : une fine pour les traits, une large pour les
 * gros faisceaux.
 *
 * Il en faut deux, et c'est la leçon de la pluie de lumière. Un rayon de flou
 * unique broie tout ce qui est plus étroit que lui : les colonnes de la pluie,
 * larges de sept pixels, disparaissaient dans une nappe rose uniforme alors
 * qu'elles se lisaient parfaitement sans flou. Un trait doit donc diffuser moins
 * qu'un gros pâté de lumière — comme dans une salle enfumée, où l'on voit encore
 * la finesse d'un faisceau serré.
 *
 * Le coût reste borné : deux passes de flou, chacune sur une surface quatre fois
 * plus petite que la toile, au lieu d'une passe par projecteur. La nappe qui n'a
 * rien reçu n'est même pas floutée.
 */
export interface HazeTarget {
  /** Pour les faisceaux étroits, dont le trait doit survivre au flou. */
  fine: HazeLayer;
  /** Pour les faisceaux larges : c'est la fumée proprement dite. */
  large: HazeLayer;
}

/**
 * Au-delà de cette demi-largeur, un faisceau part dans la nappe large : flouté
 * au rayon des traits, il perdrait sa masse.
 */
export const BEAM_FINE_MAX = 22;

export type FamilyDraw = (ctx: CanvasRenderingContext2D, f: FrameState, view: TrackView) => void;

/**
 * Pas des grands balayages, en temps forts.
 *
 * Une phrase entière : les éventails, rideaux et défilés ne changent donc de
 * direction que toutes les ~16 pulsations (7 à 8 secondes). C'est leur lenteur
 * qui fait leur beauté — les faire bouger sur deux temps les agitait et on
 * perdait l'effet de nappe.
 */
export const GRAND_BALAYAGE_BEATS = 16;

/** Pas des petits éléments (projecteurs, formes) : ils vivent plus vite. */
export const PETIT_ELEMENT_BEATS = 2;

/** Une couche du faisceau : de l'enveloppe la plus large au cœur le plus dense. */
export interface BeamLayer {
  /** Demi-largeur au bout du faisceau. */
  halfWidth: number;
  /** Demi-largeur au pied (au niveau du projecteur). */
  footHalfWidth: number;
  alpha: number;
  lightness: number;
}

export interface BeamSpec {
  /** Origine, au niveau du projecteur. */
  x: number;
  y: number;
  /** Direction du faisceau, en radians. */
  angle: number;
  length: number;
  /** Demi-largeur au bout. */
  width: number;
  hue: number;
  saturation: number;
  lightness: number;
  alpha: number;
  /**
   * Qualité adaptative et mode réduit. Ils décident du flou — donc de la fumée —
   * et, si le navigateur ne sait pas flouter, du nombre de couches de repli.
   */
  quality?: number;
  reduced?: boolean;
  /** Force un nombre de couches, pour les tests. */
  layers?: number;
  /** Surface de fumée de l'image (voir HazeTarget). */
  fumee?: HazeTarget;
  /** Largeur du pied en fraction de `width` : une lampe ponctuelle vaut ~0. */
  footRatio?: number;
  /** Teinte de fin de course (par défaut, la même teinte décalée). */
  tailHue?: number;
}
