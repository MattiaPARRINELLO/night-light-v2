import { shiftHue } from "../color";
import { clamp01, hash01, mix, smoothstep } from "../series";
import type { DropSignature, SceneRole } from "../show";
import type { TrackView } from "../view";
import { softBeam } from "./beams";
import { contrastHue, lampHue, sceneChord } from "./harmony";
import { beatSwing } from "./tempo";
import type { FamilyDraw, FrameState } from "./types";
import { paint } from "./util";

/**
 * Scénographie de concert.
 *
 * Le spectacle n'est plus seulement une abstraction lumineuse : il se joue sur
 * une vraie scène. Un pont technique en treillis porte huit lyres motorisées,
 * une seconde traverse accroche seize barres LED et une barre de douze blinders
 * qui éclaire la salle dans la palette du morceau.
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
/** Nombre de blinders de la barre (deux lampes par cellule). */
export const NOMBRE_BLINDERS = 12;
/**
 * Nombre de blinders de la barre de façade du profil concert.
 *
 * La seconde barre est réservée au concert : elle descend sous les barres LED et
 * donne au plateau une profondeur que la seule barre du pont ne peut pas offrir.
 */
export const NOMBRE_BLINDERS_FACADE = 8;
/**
 * Nombre de blinders de face, à l'avant-scène, tournés vers le public.
 *
 * Ce sont eux qui éblouissent la salle : ils ne projettent pas un cône vers le
 * sol, leur champ de lumière part vers la caméra et remplit tout le cadre.
 */
export const NOMBRE_BLINDERS_FACE = 6;
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
/** Hauteur de la barre de blinders, sur le pont supérieur. */
const LIGNE_BLINDERS = 0.132;
/** Hauteur de la barre de blinders de façade, sous les barres LED. */
const LIGNE_BLINDERS_FACADE = 0.455;
/** Hauteur de la barre de face, au bord bas de la scène, tournée vers le public. */
const LIGNE_BLINDERS_FACE = 0.94;
/** Fenêtre de recherche du dernier impact, en secondes. */
const FENETRE_IMPACT = 2.6;

/**
 * Décalage de refroidissement de chaque bloc, en secondes.
 *
 * Douze filaments ne refroidissent jamais rigoureusement ensemble. Ce léger
 * décalage suffit à faire vivre la barre sans jamais tirer au hasard.
 */
const DECALAGES_BLINDERS = [
  0, 0.009, 0.018, 0.027, 0.036, 0.045, 0.054, 0.063, 0.072, 0.081, 0.09, 0.099,
] as const;

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

/**
 * Position du blinder `index` sur la barre du pont supérieur.
 *
 * Les douze cellules couvrent presque toute la largeur du pont : la barre est
 * continue, et les motifs (un sur deux, un sur quatre, chenillard) peuvent
 * parcourir toute la scène.
 */
export function positionBlinder(index: number, largeur: number, hauteur: number): PointScene {
  const i = borner(index, NOMBRE_BLINDERS);
  return {
    x: largeur * (0.09 + 0.82 * (i / (NOMBRE_BLINDERS - 1))),
    y: hauteur * LIGNE_BLINDERS,
  };
}

/**
 * Position du blinder de façade `index`.
 *
 * La barre basse est plus courte et plus centrée que celle du pont : elle
 * éclaire le devant de la scène, pas toute la salle. Huit cellules suffisent à
 * tenir une rangée lisible sans doubler le coût de la barre supérieure.
 */
export function positionBlinderFacade(index: number, largeur: number, hauteur: number): PointScene {
  const i = borner(index, NOMBRE_BLINDERS_FACADE);
  return {
    x: largeur * (0.2 + 0.6 * (i / (NOMBRE_BLINDERS_FACADE - 1))),
    y: hauteur * LIGNE_BLINDERS_FACADE,
  };
}

/**
 * Position du blinder de face `index`.
 *
 * La rangée est posée au bord bas de la scène, face au public : ses cellules ne
 * sont pas des projecteurs qui éclairent le sol, mais des sources qui regardent
 * la salle.
 */
export function positionBlinderFace(index: number, largeur: number, hauteur: number): PointScene {
  const i = borner(index, NOMBRE_BLINDERS_FACE);
  return {
    x: largeur * (0.14 + 0.72 * (i / (NOMBRE_BLINDERS_FACE - 1))),
    y: hauteur * LIGNE_BLINDERS_FACE,
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

/** Geste imposé aux huit lyres, indépendamment du rôle de la scène. */
export type GesteLyre =
  | "auto"
  | "poursuite"
  | "eventail"
  | "croisement"
  | "vague"
  | "cercle"
  | "croix"
  | "helice"
  | "tunnel"
  | "diagonale"
  | "respiration"
  | "zigzag"
  | "pluie";

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
 * `geste` remplace ce choix par rôle quand une famille veut un mouvement
 * précis : `"auto"` garde exactement le comportement historique.
 *
 * Tout reste analytique, sans état d'une image sur l'autre.
 */
export function orientationLyre(
  f: FrameState,
  view: TrackView,
  index: number,
  role: SceneRole = f.scene.role,
  geste: GesteLyre = "auto",
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
      // La signature du drop décide du geste. Aucune enveloppe ne change :
      // une lyre part toujours de la verticale et rejoint sa cible en 0,9 s.
      const gesteDrop = f.scene.drop?.lyres ?? "convergence";
      // Gestes étendus : on les confie au bloc commun des gestes imposés, plus
      // bas, qui sait déjà les dessiner. Le plateau change ainsi de geste sans
      // dupliquer une seule formule.
      if (
        gesteDrop === "croix" ||
        gesteDrop === "helice" ||
        gesteDrop === "tunnel" ||
        gesteDrop === "diagonale" ||
        gesteDrop === "zigzag" ||
        gesteDrop === "respiration" ||
        gesteDrop === "pluie"
      ) {
        geste = gesteDrop;
        ouverture = 0.021;
        intensite = 0.92;
        break;
      }
      const local = clamp01((f.t - f.scene.start) / 0.9);
      const convergence = smoothstep(0, 1, local);
      if (gesteDrop === "eventail") {
        // Éventail symétrique : même ouverture lente que la montée, tenue
        // pendant tout le drop.
        const ouvertureEventail = 0.11 * (0.7 + 0.3 * Math.sin(f.t * 0.22));
        angle = base + (i - centre) * ouvertureEventail;
      } else {
        // Convergence centrale, ou croisée : chaque tête vise le côté opposé.
        const cibleX =
          gesteDrop === "croisee"
            ? f.width * (0.5 + ((centre - i) / (NOMBRE_LYRES - 1)) * 0.9)
            : f.width * (0.5 + 0.035 * Math.sin(f.t * 0.35));
        const cibleY = f.height * 1.02;
        const { x, y } = positionLyre(i, f.width, f.height);
        const angleCible = Math.atan2(cibleY - y, cibleX - x);
        angle = base + (angleCible - base) * convergence;
      }
      ouverture = gesteDrop === "eventail" ? 0.023 : 0.017;
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

  // Gestes imposés par une famille : ils remplacent le choix par rôle, mais
  // passent ensuite par la même respiration, donc aucune tête ne clignote.
  if (geste !== "auto") {
    switch (geste) {
      case "poursuite": {
        const brut = (tempsTempsFort(f, view) * 0.5) % NOMBRE_LYRES;
        const position = ((brut % NOMBRE_LYRES) + NOMBRE_LYRES) % NOMBRE_LYRES;
        const ecart = Math.abs(i - position);
        const distance = Math.min(ecart, NOMBRE_LYRES - ecart);
        intensite = 0.12 + 0.88 * (1 - smoothstep(0.4, 1.15, distance));
        angle = base + (i - centre) * 0.006 + beatSwing(f, view, 0.12, 4, decalage) * 0.6;
        ouverture = 0.018;
        prisme = 0;
        break;
      }
      case "eventail": {
        // En mode rave, l'éventail balaie vite au lieu de respirer lentement :
        // c'est le mouvement de tête le plus lisible sur une scène de club. Le
        // concert accélère aussi, mais garde un geste plus large.
        const vitesse = f.hard ? 1.15 : f.dynamic === true ? 0.6 : 0.17;
        const amplitude = f.hard ? 0.3 : f.dynamic === true ? 0.26 : 0.2;
        const ouvertureEventail = amplitude * (0.85 + 0.15 * Math.sin(f.t * vitesse));
        angle = base + (i - centre) * ouvertureEventail;
        ouverture = 0.026;
        intensite = f.hard ? 0.9 : f.dynamic === true ? 0.86 : 0.8;
        prisme = f.reduced ? 0 : smoothstep(0.55, 0.85, f.energy) * 0.6;
        break;
      }
      case "croisement": {
        angle = base + (i - centre) * 0.075 + beatSwing(f, view, 0.18, 8, decalage) * 0.5;
        ouverture = 0.021;
        intensite = 0.85;
        prisme = f.reduced ? 0 : smoothstep(0.6, 0.9, f.energy) * 0.5;
        break;
      }
      case "vague": {
        angle = base + 0.16 * Math.sin(tempsTempsFort(f, view) * Math.PI * 0.5 - i * 0.55);
        ouverture = 0.022;
        intensite = 0.7;
        prisme = 0;
        break;
      }
      case "cercle": {
        // Les têtes tournent en cercle, chacune avec son décalage : la rangée
        // décrit une spirale au lieu de balayer en bloc.
        angle = base + Math.sin(f.t * 0.85 + i * 0.92) * 0.6;
        ouverture = 0.02 + 0.008 * (0.5 + 0.5 * Math.sin(f.t * 1.3 + i));
        intensite = 0.85;
        prisme = f.reduced ? 0 : 0.5;
        break;
      }
      case "croix": {
        // Les têtes se croisent vers le centre : moitié gauche vers la droite,
        // moitié droite vers la gauche, en respiration lente.
        const versCentre = -((i - centre) / Math.max(centre, 1));
        angle = base + versCentre * 0.55 * (0.7 + 0.3 * Math.sin(f.t * 1.15));
        ouverture = 0.022;
        intensite = 0.9;
        prisme = f.reduced ? 0 : 0.4;
        break;
      }
      case "helice": {
        // Double hélice : l'angle court le long de la rangée comme une onde
        // hélicoïdale, avec un déphasage continu. Le geste tourne sur lui-même.
        angle = base + Math.sin(f.t * 0.62 + i * 0.82) * 0.52;
        ouverture = 0.019 + 0.004 * Math.sin(f.t * 0.4 + i);
        intensite = 0.82;
        prisme = f.reduced ? 0 : 0.35;
        break;
      }
      case "tunnel": {
        // Tunnel : toutes les têtes visent un foyer qui se déplace lentement au
        // centre du sol. Les faisceaux convergent au lieu de balayer.
        const cibleX = f.width * (0.5 + 0.26 * Math.sin(f.t * 0.24));
        const cibleY = f.height * (0.78 + 0.05 * Math.sin(f.t * 0.17 + 1.3));
        const { x, y } = positionLyre(i, f.width, f.height);
        const angleCible = Math.atan2(cibleY - y, cibleX - x);
        angle = base + (angleCible - base) * 0.82;
        ouverture = 0.02;
        intensite = 0.88;
        prisme = f.reduced ? 0 : 0.45;
        break;
      }
      case "diagonale": {
        // Balayage diagonal : toute la rangée part du même côté, avec un léger
        // retard de tête en tête, puis revient. Geste lent et large.
        angle = base + (i - centre) * 0.045 + Math.sin(f.t * 0.33 - i * 0.08) * 0.46;
        ouverture = 0.022;
        intensite = 0.84;
        prisme = f.reduced ? 0 : 0.3;
        break;
      }
      case "respiration": {
        // Éventail symétrique qui s'ouvre et se referme : la scène respire.
        const ouvertureLente = 0.07 + 0.055 * Math.sin(f.t * 0.42);
        angle = base + (i - centre) * ouvertureLente;
        ouverture = 0.024;
        intensite = 0.8;
        prisme = f.reduced ? 0 : 0.4;
        break;
      }
      case "zigzag": {
        // Têtes alternées qui tirent à gauche et à droite, avec une dérive
        // lente : un zigzag lisible sur toute la largeur du plateau.
        const cote = i % 2 === 0 ? 1 : -1;
        angle = base + cote * 0.16 + Math.sin(f.t * 0.38 + i * 0.36) * 0.28;
        ouverture = 0.02;
        intensite = 0.86;
        prisme = f.reduced ? 0 : 0.25;
        break;
      }
      case "pluie": {
        // Pluie de lumière : les têtes s'allument en cascade, chacune décalée,
        // et leurs faisceaux tombent en rideau.
        angle = base + (i - centre) * 0.03 + Math.sin(f.t * 0.5 - i * 0.7) * 0.34;
        ouverture = 0.022;
        intensite = 0.7 + 0.2 * Math.sin(f.t * 0.4 - i * 0.5);
        prisme = 0;
        break;
      }
    }
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
/**
 * Part de rideau visée par une lame de barre LED à l'instant courant.
 *
 * Le refrain ferme toujours le rideau. Un drop suit sa signature : rideau
 * complet, onde qui continue, ou alternance d'une lame sur deux. Les enveloppes
 * de transition restent celles de `angleBatten` (1,2 s).
 */
function cibleRideau(f: FrameState, index: number, role: SceneRole): number {
  if (role === "refrain") return 1;
  if (role !== "drop") return 0;
  const mode = f.scene.drop?.barres ?? "rideau";
  if (mode === "onde") return 0;
  if (mode === "alterne") return index % 2 === 0 ? 1 : 0;
  return 1;
}

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
  const local = clamp01((f.t - f.scene.start) / 1.2);
  const rideau = smoothstep(0, 1, local) * cibleRideau(f, j, role);
  return vague + (base - vague) * rideau;
}

/** Décroissance pure du filament : 1 à l'impact, 0 bien après. */
export function decroissanceFilament(age: number): number {
  if (!Number.isFinite(age) || age < 0) return 0;
  return clamp01(Math.exp(-age / TAU_FILAMENT));
}

/**
 * Couleur d'une cellule de blinder.
 *
 * Un blinder de spectacle n'est pas une source « réaliste » : il remplit la
 * scène et doit donc rester dans le budget couleur du morceau. La barre puise
 * uniquement dans les une à trois teintes de la scène, et la principale occupe
 * la majorité des cellules — la secondaire et la tertiaire ne marquent que
 * quelques cellules pour éviter un aplat.
 *
 * À pleine puissance, la diode sature : la teinte ne change pas, seule la
 * saturation baisse vers un blanc de capteur. Aucune dérive vers l'ambre ou le
 * rouge, qui sortirait de la palette.
 */
export function couleurBlinder(
  f: FrameState,
  index: number,
  intensite: number,
  gel = 1,
): CouleurFilament {
  const accord = sceneChord(f.palette, f.scene.index, f.seed, f.scene.mood);
  const principale = accord[0] ?? f.palette.hue;
  const secondaire = accord[1] ?? principale;
  const tertiaire = accord[2] ?? secondaire;
  const i = Math.abs(Math.floor(index));
  // Six cellules sur huit gardent la principale ; la septième prend la
  // tertiaire, la quatrième la secondaire. La dominance est donc franche même
  // quand le morceau possède trois couleurs.
  const teinte = i % 8 === 7 ? tertiaire : i % 4 === 3 ? secondaire : principale;
  const coeur = clamp01((intensite - 0.82) / 0.18) * 0.22 * clamp01(gel);
  return {
    hue: teinte,
    saturation: mix(1, 0.35, coeur),
    lightness: mix(0.46 + 0.2 * clamp01(intensite), 0.9, coeur),
  };
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

/** Motifs de la barre de blinders. */
export type MotifBlinder = "tous" | "un-sur-deux" | "un-sur-quatre" | "chenillard";

/**
 * Motif de la barre selon le rôle de la scène.
 *
 * C'est le choix « console » : un drop allume toute la barre, un refrain alterne
 * une cellule sur deux, un couplet n'en garde qu'une sur quatre et une montée
 * fait courir un chenillard. Le motif reste une fonction pure du temps musical.
 */
export function motifBlinder(role: SceneRole, drop?: DropSignature): MotifBlinder {
  // Un drop n'allume plus systématiquement toute la barre : la signature du
  // plan choisit entre barre complète, une sur deux et chenillard.
  if (role === "drop") return drop?.blinders ?? "tous";
  if (role === "refrain") return "un-sur-deux";
  if (role === "montee") return "chenillard";
  if (role === "couplet") return "un-sur-quatre";
  return "un-sur-deux";
}

/**
 * Poids d'allumage de la cellule `index` dans la barre.
 *
 * Les motifs ne sont pas des interrupteurs : une cellule s'allume et s'éteint
 * en fondu, et au début d'une scène la barre s'allume entière avant que le
 * motif ne se mette en place. Le poids est ensuite multiplié par l'inertie
 * thermique du filament.
 */
export function poidsBlinder(
  f: FrameState,
  index: number,
  role: SceneRole = f.scene.role,
  motif: MotifBlinder = motifBlinder(role, f.scene.drop),
): number {
  const i = borner(index, NOMBRE_BLINDERS);
  const temps = f.beatIndex + clamp01(f.beatPhase);
  const entree = smoothstep(0, 1, clamp01((f.t - f.scene.start) / 1.4));
  let poids = 1;

  switch (motif) {
    case "tous":
      poids = 1;
      break;
    case "un-sur-deux": {
      const phase = (((temps / 4) % 2) + 2) % 2;
      const groupe = i % 2;
      const distance = Math.min(Math.abs(groupe - phase), 2 - Math.abs(groupe - phase));
      poids = 1 - smoothstep(0.3, 0.95, distance);
      break;
    }
    case "un-sur-quatre": {
      const phase = (((temps / 4) % 4) + 4) % 4;
      const groupe = i % 4;
      const distance = Math.min(Math.abs(groupe - phase), 4 - Math.abs(groupe - phase));
      poids = 1 - smoothstep(0.4, 1.25, distance);
      break;
    }
    case "chenillard": {
      const position =
        (((temps / 1.5) % NOMBRE_BLINDERS) + NOMBRE_BLINDERS) % NOMBRE_BLINDERS;
      const distance = Math.min(
        Math.abs(i - position),
        NOMBRE_BLINDERS - Math.abs(i - position),
      );
      poids = 1 - smoothstep(0.5, 2, distance);
      break;
    }
  }

  return clamp01(poids * entree + (1 - entree));
}

/**
 * Motif de la barre de façade du concert.
 *
 * Elle complète la barre du pont au lieu de la répéter : quand le pont allume
 * tout, la façade alterne, et l'inverse. Deux barres décalées font vivre la
 * scène sans ajouter un seul nouveau geste.
 */
export function motifBlinderFacade(role: SceneRole, drop?: DropSignature): MotifBlinder {
  if (role === "drop") return drop?.blinders === "tous" ? "un-sur-deux" : "tous";
  if (role === "refrain") return "un-sur-quatre";
  if (role === "montee") return "chenillard";
  if (role === "couplet") return "un-sur-deux";
  return "un-sur-deux";
}

/**
 * Poids d'allumage d'une cellule de la barre de façade.
 *
 * La cellule est projetée sur la grille de la grande barre pour que les motifs
 * (chenillard surtout) parcourent toute la largeur au lieu de se replier sur les
 * huit positions de la façade.
 */
export function poidsBlinderFacade(
  f: FrameState,
  index: number,
  role: SceneRole = f.scene.role,
  motif: MotifBlinder = motifBlinderFacade(role, f.scene.drop),
): number {
  const i = borner(index, NOMBRE_BLINDERS_FACADE);
  const projection = Math.round((i * (NOMBRE_BLINDERS - 1)) / (NOMBRE_BLINDERS_FACADE - 1));
  return poidsBlinder(f, projection, role, motif);
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

  // Les membrures s'effacent aux extrémités : le pont se fond dans le fond au
  // lieu de traverser toute la toile comme une barre noire.
  const membrures = ctx.createLinearGradient(x0, 0, x1, 0);
  membrures.addColorStop(0, paint(teinte, 0.16, 0.62, 0));
  membrures.addColorStop(0.08, paint(teinte, 0.16, 0.62, 0.2 * alpha));
  membrures.addColorStop(0.5, paint(teinte, 0.12, 0.7, 0.28 * alpha));
  membrures.addColorStop(0.92, paint(teinte, 0.16, 0.62, 0.2 * alpha));
  membrures.addColorStop(1, paint(teinte, 0.16, 0.62, 0));
  ctx.strokeStyle = membrures;
  ctx.lineWidth = Math.max(0.7, f.width * 0.0007);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y0);
  ctx.moveTo(x0, y1);
  ctx.lineTo(x1, y1);
  ctx.stroke();

  // Croisillons beaucoup plus discrets que les membrures : ils suggèrent le
  // treillis sans dessiner une échelle.
  const croisillons = ctx.createLinearGradient(x0, 0, x1, 0);
  croisillons.addColorStop(0, paint(teinte, 0.14, 0.54, 0));
  croisillons.addColorStop(0.15, paint(teinte, 0.14, 0.54, 0.06 * alpha));
  croisillons.addColorStop(0.5, paint(teinte, 0.12, 0.6, 0.1 * alpha));
  croisillons.addColorStop(0.85, paint(teinte, 0.14, 0.54, 0.06 * alpha));
  croisillons.addColorStop(1, paint(teinte, 0.14, 0.54, 0));
  ctx.strokeStyle = croisillons;
  ctx.lineWidth = Math.max(0.55, f.width * 0.00045);
  ctx.beginPath();
  for (let index = 0; index < segments; index += 1) {
    const gauche = x0 + index * pas;
    const droite = gauche + pas;
    ctx.moveTo(gauche, y0);
    ctx.lineTo(droite, y1);
    ctx.moveTo(droite, y0);
    ctx.lineTo(gauche, y1);
  }
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
  // Moins de segments : le treillis doit se lire comme un filigrane, pas comme
  // une échelle. La structure reste là, mais ne concurrence plus les faisceaux.
  const segments = f.reduced ? 8 : Math.min(16, Math.max(10, Math.round(w / 90)));
  const teinte = contrastHue(f);
  const corps = paint(teinte, 0.16, 0.22, 0.55);
  const lentille = paint(teinte, 0.4, 0.55, 0.35);

  dessinerPoutre(ctx, f, w * 0.055, w * 0.945, h * PONT_HAUT, h * PONT_BAS, segments, alpha);
  // Seconde traverse, plus courte et plus discrète : le rail des barres LED.
  dessinerPoutre(
    ctx,
    f,
    w * 0.245,
    w * 0.755,
    h * 0.292,
    h * 0.318,
    Math.max(5, Math.round(segments * 0.45)),
    alpha * 0.55,
  );

  // Totems latéraux : une seule ligne, qui s'efface en haut et en bas. Assez
  // pour suggérer un montant, pas assez pour dessiner un cadre.
  ctx.lineWidth = Math.max(0.55, w * 0.0005);
  for (const cote of [0.045, 0.955] as const) {
    const x = w * cote;
    const sommet = h * PONT_BAS;
    const bas = h * 0.97;
    const montant = ctx.createLinearGradient(0, sommet, 0, bas);
    montant.addColorStop(0, paint(teinte, 0.2, 0.55, 0));
    montant.addColorStop(0.18, paint(teinte, 0.2, 0.55, 0.08 * alpha));
    montant.addColorStop(0.7, paint(teinte, 0.18, 0.6, 0.05 * alpha));
    montant.addColorStop(1, paint(teinte, 0.2, 0.55, 0));
    ctx.strokeStyle = montant;
    ctx.beginPath();
    ctx.moveTo(x, sommet);
    ctx.lineTo(x, bas);
    ctx.stroke();
  }

  // Lyres : yoke, corps et lentille, ancrés au cœur de la traverse.
  for (let index = 0; index < NOMBRE_LYRES; index += 1) {
    const { x, y } = positionLyre(index, w, h);
    const demi = Math.max(3, w * 0.0042);
    const hauteur = Math.max(6, h * 0.012);
    ctx.strokeStyle = paint(teinte, 0.22, 0.45, 0.14 * alpha);
    ctx.lineWidth = Math.max(0.65, w * 0.0006);
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

  // Barre de blinders : un seul boîtier continu, divisé en douze cellules de
  // deux lampes. C'est la barre qui permet les motifs (tous, un sur deux,
  // un sur quatre, chenillard).
  dessinerBarreBlinders(ctx, f, NOMBRE_BLINDERS, positionBlinder, teinte, alpha);

  // Barre de façade : spécifique au concert. Elle pend sous les barres LED et
  // porte huit cellules, pour que la lumière vienne aussi du milieu du plateau
  // et pas seulement du pont supérieur.
  if (f.dynamic === true) {
    const premiere = positionBlinderFacade(0, w, h);
    const derniere = positionBlinderFacade(NOMBRE_BLINDERS_FACADE - 1, w, h);
    dessinerPoutre(
      ctx,
      f,
      premiere.x - w * 0.045,
      derniere.x + w * 0.045,
      h * (LIGNE_BLINDERS_FACADE - 0.014),
      h * (LIGNE_BLINDERS_FACADE + 0.014),
      Math.max(5, Math.round(segments * 0.5)),
      alpha * 0.7,
    );
    dessinerBarreBlinders(
      ctx,
      f,
      NOMBRE_BLINDERS_FACADE,
      positionBlinderFacade,
      teinte,
      alpha * 0.9,
    );
  }
}

/** Corps d'une barre de blinders : boîtier, séparateurs et deux lampes/cellule. */
function dessinerBarreBlinders(
  ctx: CanvasRenderingContext2D,
  f: FrameState,
  nombre: number,
  position: (index: number, largeur: number, hauteur: number) => PointScene,
  teinte: number,
  alpha: number,
): void {
  const { width: w, height: h } = f;
  const corps = paint(teinte, 0.16, 0.22, 0.55);
  const premier = position(0, w, h);
  const dernier = position(nombre - 1, w, h);
  const pas = (dernier.x - premier.x) / Math.max(nombre - 1, 1);
  const x0 = premier.x - pas / 2;
  const x1 = dernier.x + pas / 2;
  const hauteurBarre = Math.max(3, h * 0.006);
  const yBarre = premier.y;

  ctx.fillStyle = corps;
  ctx.beginPath();
  ctx.moveTo(x0, yBarre - hauteurBarre);
  ctx.lineTo(x1, yBarre - hauteurBarre);
  ctx.lineTo(x1, yBarre + hauteurBarre);
  ctx.lineTo(x0, yBarre + hauteurBarre);
  ctx.closePath();
  ctx.fill();

  // Séparateurs de cellules, à peine visibles.
  ctx.strokeStyle = paint(teinte, 0.16, 0.32, 0.28 * alpha);
  ctx.lineWidth = Math.max(0.5, w * 0.0004);
  ctx.beginPath();
  for (let index = 1; index < nombre; index += 1) {
    const x = x0 + index * pas;
    ctx.moveTo(x, yBarre - hauteurBarre);
    ctx.lineTo(x, yBarre + hauteurBarre);
  }
  ctx.stroke();

  for (let index = 0; index < nombre; index += 1) {
    const { x } = position(index, w, h);
    for (const cote of [-1, 1] as const) {
      // Les deux lampes du boîtier restent dans la teinte principale du morceau :
      // même éteintes, elles ne doivent pas introduire d'ambre hors palette.
      ctx.fillStyle = paint(f.palette.hue, 0.6, 0.34, 0.62);
      ctx.beginPath();
      ctx.arc(
        x + cote * pas * 0.22,
        yBarre + hauteurBarre * 0.7,
        Math.max(1.1, w * 0.0013),
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
  }
}

/**
 * Blinders : la barre du pont, dans la palette du morceau.
 *
 * Appelée en mode `lighter`. Le concert comme le rave utilisent la même source
 * colorée : cône large, cœur dense et tache au sol. La couleur ne sort jamais du
 * budget du morceau (une à trois teintes, principale dominante) ; aucun filament
 * ambré ne vient teinter la salle.
 */
export function dessinerBlinders(
  ctx: CanvasRenderingContext2D,
  f: FrameState,
  view: TrackView,
  budgetFlash = 1,
): void {
  const { width: w, height: h } = f;
  const budget = clamp01(budgetFlash);
  // Douze cellules au lieu de quatre : on baisse légèrement chaque source pour
  // que la barre complète reste dans la même plage de luminosité.
  const gainBarre = 0.68;
  // Le mur de blinders « rave » claque à chaque temps ; le concert garde le
  // motif de rôle et laisse les gros blinders frapper seuls sur les impacts.
  const rave = f.hard === true && !f.reduced;
  const concert = f.dynamic === true && !f.reduced;
  // En rave, le mur claque : toute la barre sur les pics, chenillard rapide
  // sinon. Le motif n'est plus celui du rôle de scène. Le concert garde le même
  // geste, avec un gain un peu plus bas.
  const motif: MotifBlinder = rave
    ? f.energy > 0.8
      ? "tous"
      : "chenillard"
    : motifBlinder(f.scene.role, f.scene.drop);

  // Intensité maximale de la barre : elle pilote la nappe d'ambiance colorée.
  let nappe = 0;
  // Une barre LED n'est jamais complètement éteinte : elle garde une veilleuse
  // colorée, dosée par l'énergie et le rôle. C'est ce qui rend la couleur lisible
  // entre deux impacts au lieu de surgir uniquement sur le kick.
  const veilleuse = concert
    ? clamp01(0.18 + 0.26 * f.energy) * (0.35 + 0.65 * FACTEUR_ROLE[f.scene.role])
    : 0;

  for (let index = 0; index < NOMBRE_BLINDERS; index += 1) {
    const poids = poidsBlinder(f, index, f.scene.role, motif);
    if (poids <= 0.02) continue;
    const ravePulse = rave ? clamp01(f.beat * (0.45 + 0.55 * f.bass)) : 0;
    const intensite =
      Math.max(intensiteBlinder(f, view, index), ravePulse, veilleuse) *
      poids *
      gainBarre *
      (f.hard === true ? 1.35 : f.dynamic === true ? 1.18 : 1);
    if (intensite <= 0.008) continue;
    nappe = Math.max(nappe, intensite);
    const { x, y } = positionBlinder(index, w, h);
    // La barre ne sort jamais du budget couleur du morceau : principale
    // dominante, secondaire et tertiaire sur quelques cellules seulement.
    const couleur = couleurBlinder(f, index, intensite, rave ? 1 : 0.6);
    dessinerCelluleBlinder(ctx, f, x, y, intensite, couleur, {
      rayon: Math.min(w, h) * (0.035 + 0.09 * intensite),
      budget,
      lame: concert && f.quality >= 0.6,
      jours: true,
    });
  }

  // Barre de façade : le concert l'allume en plus de la barre du pont. Les
  // cellules sont volontairement plus basses et plus faibles, pour épaissir la
  // lumière sans déplacer la vedette des lyres.
  if (concert) {
    const motifFacade = motifBlinderFacade(f.scene.role, f.scene.drop);
    const total = Math.max(3, Math.round(NOMBRE_BLINDERS_FACADE * (0.55 + 0.45 * f.quality)));
    for (let index = 0; index < total; index += 1) {
      const poids = poidsBlinderFacade(f, index, f.scene.role, motifFacade);
      if (poids <= 0.02) continue;
      const projection = Math.round(
        (index * (NOMBRE_BLINDERS - 1)) / (NOMBRE_BLINDERS_FACADE - 1),
      );
      const intensite =
        Math.max(intensiteBlinder(f, view, projection), veilleuse * 0.8) *
        poids *
        0.58 *
        (f.dynamic === true ? 1.18 : 1);
      if (intensite <= 0.008) continue;
      nappe = Math.max(nappe, intensite);
      const { x, y } = positionBlinderFacade(index, w, h);
      const couleur = couleurBlinder(f, index + 1, intensite, 1);
      dessinerCelluleBlinder(ctx, f, x, y, intensite, couleur, {
        rayon: Math.min(w, h) * (0.024 + 0.062 * intensite),
        budget,
        lame: f.quality >= 0.6,
        jours: false,
      });
    }
  }

  // Nappe d'ambiance : une barre de blinders LED ne se contente pas d'allumer
  // ses cellules, elle baigne la salle de sa couleur. La principale tient
  // presque toute la largeur ; l'accent ne marque que le bord droit.
  if (concert && nappe > 0.08) {
    const voile = ctx.createLinearGradient(0, 0, w, 0);
    voile.addColorStop(0, paint(f.palette.hue, 1, 0.56, 0.11 * nappe * f.alpha));
    voile.addColorStop(0.78, paint(f.palette.hue, 1, 0.56, 0.09 * nappe * f.alpha));
    voile.addColorStop(1, paint(f.palette.accent, 1, 0.56, 0.045 * nappe * f.alpha));
    ctx.fillStyle = voile;
    ctx.fillRect(0, 0, w, h);
  }
}

/**
 * Rangée de blinders de face, tournés vers le public.
 *
 * Ce sont les seules sources du plateau qui regardent la caméra : au lieu de
 * projeter un cône vers le sol, elles éblouissent la salle. En 2D, leur champ se
 * lit comme un grand halo frontal qui envahit le cadre, un voile vertical qui
 * lave le bas de l'image et une croix de flare — jamais une tache au sol.
 */
export function dessinerBlindersFace(
  ctx: CanvasRenderingContext2D,
  f: FrameState,
  view: TrackView,
  budgetFlash = 1,
): void {
  if (f.dynamic !== true || f.reduced) return;
  const budget = clamp01(budgetFlash);
  if (budget <= 0) return;
  const { width: w } = f;
  const veilleuse =
    clamp01(0.22 + 0.24 * f.energy) * (0.4 + 0.6 * FACTEUR_ROLE[f.scene.role]);

  // Le boîtier reste fin et bas : c'est une barre d'avant-scène.
  dessinerBarreBlinders(ctx, f, NOMBRE_BLINDERS_FACE, positionBlinderFace, f.palette.hue, 0.9);

  let nappe = 0;
  for (let index = 0; index < NOMBRE_BLINDERS_FACE; index += 1) {
    const projection = Math.round(
      (index * (NOMBRE_BLINDERS - 1)) / (NOMBRE_BLINDERS_FACE - 1),
    );
    const intensite =
      Math.max(intensiteBlinder(f, view, projection), veilleuse) *
      (0.62 + 0.16 * f.energy);
    if (intensite <= 0.012) continue;
    nappe = Math.max(nappe, intensite);
    const { x, y } = positionBlinderFace(index, w, f.height);
    const couleur = couleurBlinder(f, index + 2, intensite, 1);
    dessinerFaceBlinder(ctx, f, x, y, intensite, couleur, budget);
  }

  // Un seul voile pour toute la rangée : la lumière qui vient vers le public
  // remplit le cadre entier, elle n'est pas la somme de six cônes séparés.
  if (nappe > 0.02) {
    const voile = ctx.createLinearGradient(0, f.height, 0, 0);
    voile.addColorStop(0, paint(f.palette.hue, 0.95, 0.6, 0.13 * nappe * f.alpha));
    voile.addColorStop(0.45, paint(f.palette.hue, 0.95, 0.6, 0.05 * nappe * f.alpha));
    voile.addColorStop(1, paint(f.palette.hue, 0.95, 0.6, 0));
    ctx.fillStyle = voile;
    ctx.fillRect(0, 0, f.width, f.height);
  }
}

/** Une cellule de face : halo frontal, flare en croix et source visible. */
function dessinerFaceBlinder(
  ctx: CanvasRenderingContext2D,
  f: FrameState,
  x: number,
  y: number,
  intensite: number,
  couleur: CouleurFilament,
  budget: number,
): void {
  const { width: w, height: h } = f;
  const alpha = intensite * f.alpha;
  const rayon = Math.min(w, h) * (0.4 + 0.55 * intensite);

  // Halo frontal : la source regarde l'objectif, sa lumière s'étale dans tout
  // le cadre. Le dégradé est transparent au-delà de `rayon`, on ne remplit donc
  // que sa boîte englobante.
  const halo = ctx.createRadialGradient(x, y, 0, x, y, Math.max(rayon, 1));
  halo.addColorStop(
    0,
    paint(
      couleur.hue,
      couleur.saturation,
      Math.min(1, couleur.lightness + 0.16),
      0.5 * alpha,
    ),
  );
  halo.addColorStop(
    0.24,
    paint(couleur.hue, couleur.saturation, couleur.lightness, 0.28 * alpha),
  );
  halo.addColorStop(
    0.6,
    paint(couleur.hue, couleur.saturation, couleur.lightness * 0.9, 0.1 * alpha),
  );
  halo.addColorStop(
    1,
    paint(couleur.hue, couleur.saturation * 0.85, couleur.lightness * 0.8, 0),
  );
  ctx.fillStyle = halo;
  ctx.fillRect(
    Math.max(0, x - rayon),
    Math.max(0, y - rayon),
    Math.min(w, rayon * 2),
    Math.min(h, rayon * 2),
  );

  // Flare en croix : la signature d'un projecteur qui regarde la caméra.
  if (budget > 0) {
    const force = clamp01(intensite) * budget;
    const demi = Math.max(w * 0.36, rayon * 1.2);
    const bande = ctx.createLinearGradient(x - demi, 0, x + demi, 0);
    bande.addColorStop(0, paint(couleur.hue, couleur.saturation * 0.7, couleur.lightness, 0));
    bande.addColorStop(
      0.5,
      paint(
        couleur.hue,
        couleur.saturation * 0.4,
        Math.min(1, couleur.lightness + 0.18),
        0.5 * force * f.alpha,
      ),
    );
    bande.addColorStop(1, paint(couleur.hue, couleur.saturation * 0.7, couleur.lightness, 0));
    ctx.fillStyle = bande;
    ctx.fillRect(x - demi, y - 1.5 - 3 * force, demi * 2, 3 + 6 * force);

    // Branche verticale du flare, plus courte : sans elle, la source se lit
    // comme un simple halo et non comme un projecteur braqué sur l'objectif.
    const hauteur = h * (0.14 + 0.16 * force);
    const verticale = ctx.createLinearGradient(0, y - hauteur, 0, y + hauteur);
    verticale.addColorStop(0, paint(couleur.hue, couleur.saturation * 0.7, couleur.lightness, 0));
    verticale.addColorStop(
      0.5,
      paint(couleur.hue, couleur.saturation * 0.45, Math.min(1, couleur.lightness + 0.14), 0.32 * force * f.alpha),
    );
    verticale.addColorStop(1, paint(couleur.hue, couleur.saturation * 0.7, couleur.lightness, 0));
    ctx.fillStyle = verticale;
    ctx.fillRect(x - 0.8 - force, y - hauteur, 1.6 + 2 * force, hauteur * 2);
  }

  // Cœur de la source : une tache courte, très claire mais encore teintée.
  // Elle garde le projecteur lisible même quand un lavage d'impact blanchit
  // déjà tout le cadre.
  const coeurRayon = Math.min(w, h) * (0.05 + 0.08 * intensite);
  const coeur = ctx.createRadialGradient(x, y, 0, x, y, Math.max(coeurRayon, 1));
  coeur.addColorStop(
    0,
    paint(couleur.hue, 0.3, 0.99, 0.85 * alpha),
  );
  coeur.addColorStop(
    0.45,
    paint(couleur.hue, 0.6, 0.92, 0.35 * alpha),
  );
  coeur.addColorStop(
    1,
    paint(couleur.hue, couleur.saturation, couleur.lightness, 0),
  );
  ctx.fillStyle = coeur;
  ctx.beginPath();
  ctx.arc(x, y, Math.max(coeurRayon, 1), 0, Math.PI * 2);
  ctx.fill();

  // Les deux lampes de la cellule, teintées comme le reste de la palette.
  for (const cote of [-1, 1] as const) {
    const lx = x + cote * Math.max(3, w * 0.004);
    ctx.fillStyle = paint(
      couleur.hue,
      Math.min(1, couleur.saturation),
      Math.min(1, couleur.lightness + 0.2),
      intensite * f.alpha,
    );
    ctx.beginPath();
    ctx.arc(lx, y + 2, 1.4 + 4 * intensite, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Réglages d'une cellule de blinder lumineuse. */
interface OptionsCelluleBlinder {
  rayon: number;
  budget: number;
  /** Faisceau LED réellement projeté dans la scène, réservé au concert. */
  lame: boolean;
  /** Deux points chauds visibles : la signature de la barre du pont. */
  jours: boolean;
}

/**
 * Une cellule de blinder : halo, faisceau, flare et points chauds.
 *
 * Le halo est l'émission de la lampe. Le faisceau, propre au concert, est un
 * cône coloré complet — enveloppe large, cœur dense et tache au sol — pour que
 * la barre LED éclaire réellement la scène et pas seulement l'objectif.
 */
function dessinerCelluleBlinder(
  ctx: CanvasRenderingContext2D,
  f: FrameState,
  x: number,
  y: number,
  intensite: number,
  couleur: CouleurFilament,
  options: OptionsCelluleBlinder,
): void {
  const { width: w } = f;
  const { rayon, budget } = options;

  // Faisceau LED : la barre n'émet plus un simple halo, elle éclaire vraiment.
  // Trois cônes emboîtés (fumée large, enveloppe moyenne, cœur dense) donnent un
  // champ de lumière à bords doux, et une tache elliptique au sol vend l'idée
  // que la lumière retombe dans la salle.
  if (options.lame && intensite > 0.12) {
    const haut = y + 2;
    const portee = f.height * (0.46 + 0.28 * intensite);
    const bas = Math.min(f.height * 1.04, haut + portee);
    // Un vrai blinder n'éclaire pas pile à la verticale : chaque cellule ouvre
    // son champ vers l'extérieur de la barre.
    const basX = x + (x - f.width * 0.5) * 0.1;
    const demiHaut = Math.max(1.4, w * 0.0036);
    const demiBas = w * (0.03 + 0.075 * intensite);
    const alpha = intensite * f.alpha;

    const couches = [
      { largeur: 1.35, densite: 0.1, tete: 0.6 },
      { largeur: 0.95, densite: 0.16, tete: 0.8 },
      { largeur: 0.5, densite: 0.24, tete: 1 },
    ] as const;
    for (const couche of couches) {
      const dHaut = demiHaut * couche.tete;
      const dBas = demiBas * couche.largeur;
      const cone = ctx.createLinearGradient(0, haut, 0, bas);
      cone.addColorStop(
        0,
        paint(
          couleur.hue,
          couleur.saturation,
          Math.min(1, couleur.lightness + 0.06),
          couche.densite * alpha,
        ),
      );
      cone.addColorStop(
        0.38,
        paint(couleur.hue, couleur.saturation, couleur.lightness, couche.densite * 0.7 * alpha),
      );
      cone.addColorStop(
        1,
        paint(couleur.hue, couleur.saturation * 0.92, couleur.lightness * 0.86, 0),
      );
      ctx.fillStyle = cone;
      ctx.beginPath();
      ctx.moveTo(x - dHaut, haut);
      ctx.lineTo(x + dHaut, haut);
      ctx.lineTo(basX + dBas, bas);
      ctx.lineTo(basX - dBas, bas);
      ctx.closePath();
      ctx.fill();
    }

    // Tache au sol : ellipse douce, plus large que le cône. Elle reste dans la
    // teinte de la cellule, sans cœur blanc.
    if (f.quality >= 0.6) {
      ctx.save();
      ctx.translate(basX, bas);
      ctx.scale(1.7, 0.5);
      const sol = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(demiBas * 1.7, 1));
      sol.addColorStop(
        0,
        paint(couleur.hue, couleur.saturation, couleur.lightness, 0.3 * alpha),
      );
      sol.addColorStop(
        0.5,
        paint(couleur.hue, couleur.saturation, couleur.lightness * 0.92, 0.12 * alpha),
      );
      sol.addColorStop(
        1,
        paint(couleur.hue, couleur.saturation * 0.85, couleur.lightness * 0.8, 0),
      );
      ctx.fillStyle = sol;
      ctx.beginPath();
      ctx.arc(0, 0, Math.max(demiBas * 1.7, 1), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // Halo circulaire : la lampe elle-même, avant l'étirement de l'objectif.
  const halo = ctx.createRadialGradient(x, y, 0, x, y, Math.max(rayon, 1));
  halo.addColorStop(
    0,
    paint(couleur.hue, Math.min(1, couleur.saturation), Math.min(1, couleur.lightness + 0.14), 0.95 * intensite * f.alpha),
  );
  halo.addColorStop(
    0.35,
    paint(couleur.hue, couleur.saturation, couleur.lightness, 0.46 * intensite * f.alpha),
  );
  halo.addColorStop(1, paint(couleur.hue, couleur.saturation * 0.85, couleur.lightness * 0.6, 0));
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
    bande.addColorStop(
      0.5,
      paint(couleur.hue, couleur.saturation * 0.35, couleur.lightness, 0.62 * force * f.alpha),
    );
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

  // Les deux lampes du bloc : deux points chauds, jamais un seul. Leur cœur
  // reste dans la teinte de la source, une LED ne blanchit pas.
  const cotes = options.jours ? ([-1, 1] as const) : ([0] as const);
  for (const cote of cotes) {
    const lx = x + cote * Math.max(3, w * 0.004);
    ctx.fillStyle = paint(
      couleur.hue,
      Math.min(1, couleur.saturation),
      Math.min(1, couleur.lightness + 0.2),
      intensite * f.alpha,
    );
    ctx.beginPath();
    ctx.arc(lx, y + 2, (options.jours ? 1.5 : 1.1) + (options.jours ? 4 : 3) * intensite, 0, Math.PI * 2);
    ctx.fill();
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
function dessinerLyres(
  ctx: CanvasRenderingContext2D,
  f: FrameState,
  view: TrackView,
  geste: GesteLyre,
): void {
  const { width: w, height: h } = f;
  // Pas de terme de beat : les huit têtes ne clignotent pas ensemble sur le
  // kick. Leur intensité est déjà modulée, tête par tête, lentement. En concert,
  // les lyres sont la seule source : elles éclairent réellement la salle et
  // prennent donc beaucoup plus de puissance.
  const alpha = f.dynamic === true
    ? (0.1 + 0.32 * f.energy) * f.alpha
    : (0.08 + 0.3 * f.energy) * f.alpha;
  if (alpha <= 0.002) return;

  for (let index = 0; index < NOMBRE_LYRES; index += 1) {
    const { x, y } = positionLyre(index, w, h);
    const orientation = orientationLyre(f, view, index, f.scene.role, geste);
    const portee = Math.min(
      Math.hypot(w, h) * 1.25,
      (h * 1.04 - y) / Math.max(Math.sin(orientation.angle), 0.32),
    );
    // Effet console : faisceau fin en couplet, plus large en refrain et en drop.
    // La brume des montées/impacts épaissit aussi le cône.
    const role = f.scene.role;
    const ouvertureRole =
      role === "drop" ? 1.55 : role === "refrain" ? 1.3 : role === "montee" ? 1.15 : 1;
    const brume = 1 + 0.12 * clamp01(f.build) + 0.2 * clamp01(f.drop);
    const largeur = Math.tan(orientation.ouverture) * portee * ouvertureRole * brume;
    const prisme = Math.max(
      orientation.prisme,
      f.dynamic === true && (role === "refrain" || role === "drop") ? 0.45 : 0,
    );
    const teinte = lampHue(f, index);
    const spec = {
      x,
      y,
      angle: orientation.angle,
      length: portee,
      width: largeur,
      hue: teinte,
      saturation: f.palette.saturation,
      lightness: f.palette.lightness + (f.hard ? 0.04 : f.dynamic === true ? 0.02 : 0.08),
      quality: f.quality,
      reduced: f.reduced,
      fumee: f.haze,
      footRatio: 0.05,
      tailHue: shiftHue(teinte, 16),
    };

    if (prisme > 0.02 && !f.reduced) {
      // Trois sous-cônes très fins : le prisme d'une lyre ne double pas la
      // largeur du faisceau, il la démultiplie en lames. Les lames latérales
      // s'allument avec `prisme` (0..1) : jamais un interrupteur.
      const delta = 0.012 * prisme * Math.sin(f.t * 3);
      const central = alpha * orientation.intensite;
      const force = prisme;
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
}

/**
 * Seize barres LED : vague d'inclinaison ou rideau de lumière.
 *
 * En couplet et en montée, l'onde progressive court de diode en diode. En
 * refrain et en drop, toutes les lames tombent parallèlement et l'intensité
 * suit le spectre bas/médium : c'est le rideau qui ferme la scène.
 */
function dessinerBarres(ctx: CanvasRenderingContext2D, f: FrameState, view: TrackView): void {
  const { width: w, height: h } = f;
  // Même règle que pour les lyres : la rampe ne clignote pas sur le kick. En
  // concert, les barres LED complètent l'éclairage de salle.
  const alpha = f.dynamic === true
    ? (0.08 + 0.24 * f.energy) * f.alpha
    : (0.07 + 0.26 * f.energy) * f.alpha;
  if (alpha <= 0.002) return;

  const local = clamp01((f.t - f.scene.start) / 1.2);
  const spectre = clamp01(0.65 * f.bass + 0.35 * f.mid);
  const temps = tempsTempsFort(f, view);

  for (let index = 0; index < NOMBRE_BATTENS; index += 1) {
    const { x, y } = positionBatten(index, w, h);
    const angle = angleBatten(f, view, index);
    // Une lame sur deux peut rester en vague : le rideau n'est plus binaire.
    const rideau = smoothstep(0, 1, local) * cibleRideau(f, index, f.scene.role);
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
      lightness: f.palette.lightness + (f.hard ? 0.05 : f.dynamic === true ? 0.04 : 0.1),
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
}

/** Familles historiques : geste automatique, piloté par le rôle de la scène. */
const lyresSuspendues: FamilyDraw = (ctx, f, view) => dessinerLyres(ctx, f, view, "auto");
const barresLed: FamilyDraw = (ctx, f, view) => dessinerBarres(ctx, f, view);

/**
 * Lyres seules, geste éventail : brique du mur de lyres du mode rave.
 *
 * Le rendu les empile sur plusieurs rangées, sans les barres LED de
 * `lyres-eventail`, pour que la scène soit réellement remplie de têtes.
 */
export function dessinerLyresRave(
  ctx: CanvasRenderingContext2D,
  f: FrameState,
  view: TrackView,
  geste: GesteLyre = "eventail",
): void {
  dessinerLyres(ctx, f, view, geste);
}

/** Poursuite : une seule tête éclairée court le long du pont. */
const lyresPoursuite: FamilyDraw = (ctx, f, view) => dessinerLyres(ctx, f, view, "poursuite");

/**
 * Duo : les lyres du haut croisent leurs faisceaux pendant que les barres du
 * milieu déroulent leur vague. C'est la scène où les deux étages du plateau
 * jouent ensemble, au lieu de s'alterner.
 */
const lyresDuo: FamilyDraw = (ctx, f, view) => {
  dessinerLyres(ctx, f, view, "croisement");
  dessinerBarres(ctx, { ...f, alpha: f.alpha * 0.85 }, view);
};

/** Éventail large au-dessus du rideau de barres LED. */
const lyresEventail: FamilyDraw = (ctx, f, view) => {
  dessinerLyres(ctx, f, view, "eventail");
  dessinerBarres(ctx, { ...f, alpha: f.alpha * 0.85 }, view);
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

/** Étage de lyres : une rangée complète, décalée et mise à l'échelle. */
function dessinerEtageLyres(
  ctx: CanvasRenderingContext2D,
  f: FrameState,
  view: TrackView,
  geste: GesteLyre,
  alpha: number,
  offsetY: number,
  scale: number,
): void {
  ctx.save();
  ctx.translate(f.width * 0.5, f.height * 0.5 + offsetY);
  ctx.scale(scale, scale);
  ctx.translate(-f.width * 0.5, -f.height * 0.5);
  // Plusieurs étages se superposent : on abaisse chaque nappe pour que
  // l'addition reste colorée au lieu de saturer l'écran en blanc.
  const attenuation = f.dynamic === true ? 0.65 : 1;
  dessinerLyres(ctx, { ...f, alpha: f.alpha * alpha * attenuation }, view, geste);
  ctx.restore();
}

/**
 * Formations de groupe du concert.
 *
 * Chaque entrée est un jeu de gestes pour les étages, du fond vers l'avant. La
 * formation change toutes les 32 pulsations (8 mesures en 4/4), comme un vrai
 * show programmé qui réutilise quelques « looks » au lieu de tout changer en
 * permanence.
 */
const FORMATIONS_CONCERT: readonly (readonly GesteLyre[])[] = [
  ["vague", "croisement", "eventail", "cercle", "helice", "respiration"],
  ["tunnel", "eventail", "helice", "vague", "croisement", "respiration"],
  ["diagonale", "zigzag", "vague", "eventail", "cercle", "pluie"],
  ["respiration", "tunnel", "croisement", "helice", "vague", "eventail"],
];

/** Geste de l'étage `row` dans la formation courante. */
function gesteFormation(f: FrameState, row: number): GesteLyre {
  const look = Math.floor(Math.max(0, f.beatIndex) / 32);
  const formation = FORMATIONS_CONCERT[look % FORMATIONS_CONCERT.length] ?? FORMATIONS_CONCERT[0]!;
  return formation[row % formation.length] ?? "eventail";
}

/**
 * Cathédrale de lyres : deux étages lointains et deux étages frontaux, tous en
 * mouvement lent. C'est la scène la plus dense du profil concert, sans aucun
 * laser ni artifice de rave.
 */
const lyresCathedrale: FamilyDraw = (ctx, f, view) => {
  dessinerEtageLyres(ctx, f, view, gesteFormation(f, 0), 0.16, -f.height * 0.24, 0.34);
  dessinerEtageLyres(ctx, f, view, gesteFormation(f, 1), 0.2, -f.height * 0.17, 0.42);
  dessinerEtageLyres(ctx, f, view, gesteFormation(f, 2), 0.28, -f.height * 0.09, 0.55);
  dessinerEtageLyres(ctx, f, view, gesteFormation(f, 3), 0.55, 0, 0.78);
  dessinerEtageLyres(ctx, f, view, gesteFormation(f, 4), 0.72, f.height * 0.11, 0.94);
};

/**
 * Lyres orbitales : une rangée centrale en cercle, encadrée par deux colonnes
 * latérales qui croisent leurs faisceaux vers le milieu.
 */
const lyresOrbitale: FamilyDraw = (ctx, f, view) => {
  dessinerEtageLyres(ctx, f, view, "vague", 0.24, -f.height * 0.12, 0.5);
  dessinerEtageLyres(ctx, f, view, "cercle", 0.7, f.height * 0.02, 0.86);
};

/**
 * Rideau de lyres : trois nappes de faisceaux parallèles, de la plus lointaine
 * à la plus proche. Les têtes s'ouvrent ensemble comme un rideau de scène.
 */
const lyresRideau: FamilyDraw = (ctx, f, view) => {
  dessinerEtageLyres(ctx, f, view, "eventail", 0.3, -f.height * 0.14, 0.6);
  dessinerEtageLyres(ctx, f, view, "eventail", 0.48, 0, 0.8);
  dessinerEtageLyres(ctx, f, view, "eventail", 0.66, f.height * 0.13, 0.98);
};

/**
 * Aurore de lyres : quatre étages qui déroulent des gestes différents, du fond
 * vers l'avant. La scène brille par accumulation de têtes, pas par stroboscope.
 */
const lyresAurore: FamilyDraw = (ctx, f, view) => {
  dessinerEtageLyres(ctx, f, view, gesteFormation(f, 0), 0.14, -f.height * 0.26, 0.34);
  dessinerEtageLyres(ctx, f, view, gesteFormation(f, 1), 0.18, -f.height * 0.2, 0.4);
  dessinerEtageLyres(ctx, f, view, gesteFormation(f, 2), 0.32, -f.height * 0.1, 0.58);
  dessinerEtageLyres(ctx, f, view, gesteFormation(f, 3), 0.52, 0, 0.8);
  dessinerEtageLyres(ctx, f, view, gesteFormation(f, 4), 0.75, f.height * 0.12, 0.96);
};

/**
 * Hélice de lyres : trois étages décrivent une onde hélicoïdale continue. Les
 * faisceaux semblent tourner autour d'un axe central.
 */
const lyresHelice: FamilyDraw = (ctx, f, view) => {
  dessinerEtageLyres(ctx, f, view, "helice", 0.22, -f.height * 0.18, 0.45);
  dessinerEtageLyres(ctx, f, view, "helice", 0.36, -f.height * 0.1, 0.6);
  dessinerEtageLyres(ctx, f, view, "helice", 0.52, 0, 0.78);
  dessinerEtageLyres(ctx, f, view, "helice", 0.72, f.height * 0.12, 0.98);
};

/**
 * Tunnel de lyres : trois étages convergent vers un foyer qui glisse au centre
 * du sol. Plus la rangée est proche, plus le tunnel est serré.
 */
const lyresTunnel: FamilyDraw = (ctx, f, view) => {
  dessinerEtageLyres(ctx, f, view, "vague", 0.18, -f.height * 0.22, 0.4);
  dessinerEtageLyres(ctx, f, view, "tunnel", 0.3, -f.height * 0.14, 0.55);
  dessinerEtageLyres(ctx, f, view, "tunnel", 0.56, -f.height * 0.04, 0.75);
  dessinerEtageLyres(ctx, f, view, "tunnel", 0.78, f.height * 0.1, 0.98);
};

/**
 * Balayage diagonal : toutes les têtes partent du même côté et reviennent,
 * avec un léger retard le long de la rangée. Trois nappes superposées.
 */
const lyresDiagonale: FamilyDraw = (ctx, f, view) => {
  dessinerEtageLyres(ctx, f, view, "diagonale", 0.28, -f.height * 0.14, 0.55);
  dessinerEtageLyres(ctx, f, view, "diagonale", 0.52, 0, 0.8);
  dessinerEtageLyres(ctx, f, view, "diagonale", 0.74, f.height * 0.13, 1);
};

/**
 * Respiration de lyres : un éventail géant qui s'ouvre et se referme lentement,
 * sur quatre étages. C'est l'effet le plus ample du plateau.
 */
const lyresRespiration: FamilyDraw = (ctx, f, view) => {
  dessinerEtageLyres(ctx, f, view, gesteFormation(f, 0), 0.16, -f.height * 0.26, 0.38);
  dessinerEtageLyres(ctx, f, view, gesteFormation(f, 1), 0.2, -f.height * 0.2, 0.45);
  dessinerEtageLyres(ctx, f, view, gesteFormation(f, 2), 0.36, -f.height * 0.08, 0.65);
  dessinerEtageLyres(ctx, f, view, gesteFormation(f, 3), 0.56, f.height * 0.04, 0.86);
  dessinerEtageLyres(ctx, f, view, gesteFormation(f, 4), 0.76, f.height * 0.16, 1.04);
};

/**
 * Zigzag de lyres : les têtes alternent gauche et droite sur trois étages, avec
 * une dérive lente. Le plateau se lit comme une fermeture éclair de lumière.
 */
const lyresZigzag: FamilyDraw = (ctx, f, view) => {
  dessinerEtageLyres(ctx, f, view, "zigzag", 0.32, -f.height * 0.1, 0.6);
  dessinerEtageLyres(ctx, f, view, "zigzag", 0.55, 0, 0.82);
  dessinerEtageLyres(ctx, f, view, "zigzag", 0.76, f.height * 0.11, 1);
};

/**
 * Cascade de lyres : quatre étages de faisceaux tombent en pluie, chacun décalé
 * dans le temps. Aucun stroboscope, seulement un ruissellement de lumière.
 */
const lyresCascade: FamilyDraw = (ctx, f, view) => {
  dessinerEtageLyres(ctx, f, view, gesteFormation(f, 0), 0.14, -f.height * 0.26, 0.36);
  dessinerEtageLyres(ctx, f, view, gesteFormation(f, 1), 0.2, -f.height * 0.2, 0.42);
  dessinerEtageLyres(ctx, f, view, gesteFormation(f, 2), 0.36, -f.height * 0.07, 0.62);
  dessinerEtageLyres(ctx, f, view, gesteFormation(f, 3), 0.56, f.height * 0.05, 0.84);
  dessinerEtageLyres(ctx, f, view, gesteFormation(f, 4), 0.78, f.height * 0.17, 1.04);
};

/**
 * Colisée de lyres : une arène complète, avec deux colonnes latérales
 * croisées, une rangée frontale et un étage lointain.
 */
const lyresColisee: FamilyDraw = (ctx, f, view) => {
  dessinerEtageLyres(ctx, f, view, "vague", 0.22, -f.height * 0.15, 0.5);
  dessinerEtageLyres(ctx, f, view, "croisement", 0.55, 0, 0.8);
};

/**
 * Arène de lyres : six étages frontaux et deux colonnes latérales, la scène la
 * plus dense du plateau. Elle est faite pour les refrains où tout doit être
 * allumé en même temps.
 */
const lyresArena: FamilyDraw = (ctx, f, view) => {
  dessinerEtageLyres(ctx, f, view, gesteFormation(f, 0), 0.12, -f.height * 0.28, 0.32);
  dessinerEtageLyres(ctx, f, view, gesteFormation(f, 1), 0.16, -f.height * 0.22, 0.4);
  dessinerEtageLyres(ctx, f, view, gesteFormation(f, 2), 0.24, -f.height * 0.15, 0.52);
  dessinerEtageLyres(ctx, f, view, gesteFormation(f, 3), 0.38, -f.height * 0.06, 0.68);
  dessinerEtageLyres(ctx, f, view, gesteFormation(f, 4), 0.58, f.height * 0.04, 0.86);
  dessinerEtageLyres(ctx, f, view, gesteFormation(f, 5), 0.78, f.height * 0.14, 1.04);
};

/**
 * Gros blinders de concert : quatre pods qui éblouissent la salle sur les
 * impacts. Comme la barre, ils restent dans le budget couleur du morceau : la
 * teinte principale tient la majorité des pods, l'accent marque les autres.
 */
const GROS_BLINDERS_WINDOW_SEC = 0.5;

/**
 * Force des gros blinders à l'instant courant.
 *
 * Ils ne claquent pas sur chaque temps : uniquement dans la demi-seconde qui
 * suit un vrai impact. Le reste du temps, ils sont éteints.
 */
export function forceGrosBlinders(f: FrameState, budgetFlash = 1): number {
  if (f.dynamic !== true || f.reduced) return 0;
  const budget = clamp01(budgetFlash);
  if (budget <= 0) return 0;
  const age = f.dropAge;
  if (!Number.isFinite(age) || age < 0 || age > GROS_BLINDERS_WINDOW_SEC) return 0;
  const envelope = Math.pow(1 - age / GROS_BLINDERS_WINDOW_SEC, 2);
  return clamp01(envelope * (1.05 + 0.25 * f.energy) * budget);
}

export function dessinerGrosBlinders(
  ctx: CanvasRenderingContext2D,
  f: FrameState,
  _view: TrackView,
  budgetFlash = 1,
): void {
  if (f.dynamic !== true || f.reduced) return;
  const force = forceGrosBlinders(f, budgetFlash);
  if (force <= 0.02) return;

  const { width: w, height: h } = f;
  // Six pods au lieu de quatre : deux paires latérales viennent épauler les
  // deux centrales. Chaque pod reçoit un léger décalage de hauteur pour que la
  // rangée se lise en profondeur, pas comme six pastilles alignées au cordeau.
  const positions = [
    { x: 0.1, y: 0.1 },
    { x: 0.26, y: 0.125 },
    { x: 0.42, y: 0.095 },
    { x: 0.58, y: 0.095 },
    { x: 0.74, y: 0.125 },
    { x: 0.9, y: 0.1 },
  ];
  for (let index = 0; index < positions.length; index += 1) {
    const pod = positions[index]!;
    const x = w * pod.x;
    const y = h * pod.y;
    const variation = 0.85 + 0.3 * hash01(index * 97 + f.seed);
    const intensite = clamp01(force * variation);
    // LED : le pod éclaire dans la couleur du morceau, avec un cœur légèrement
    // délave au centre (saturation du capteur) et une enveloppe saturée. La
    // couleur principale tient deux pods sur trois.
    const teinte = index % 3 === 0 ? f.palette.accent : f.palette.hue;
    const rayon = Math.min(w, h) * (0.1 + 0.16 * intensite);
    const halo = ctx.createRadialGradient(x, y, 0, x, y, Math.max(rayon, 1));
    halo.addColorStop(0, paint(teinte, 0.45, 0.96, 1 * intensite * f.alpha));
    halo.addColorStop(0.16, paint(teinte, 0.6, 0.92, 0.88 * intensite * f.alpha));
    halo.addColorStop(0.42, paint(teinte, 0.9, 0.74, 0.55 * intensite * f.alpha));
    halo.addColorStop(0.72, paint(teinte, 0.95, 0.6, 0.22 * intensite * f.alpha));
    halo.addColorStop(1, paint(teinte, 1, 0.5, 0));
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(rayon, 1), 0, Math.PI * 2);
    ctx.fill();

    // Flare anamorphique : la signature des blinders de concert.
    const demi = Math.max(w * 0.24, rayon * 7);
    const bande = ctx.createLinearGradient(x - demi, 0, x + demi, 0);
    bande.addColorStop(0, paint(teinte, 0.45, 1, 0));
    bande.addColorStop(0.42, paint(teinte, 0.85, 0.82, 0.5 * intensite * f.alpha));
    bande.addColorStop(0.5, paint(teinte, 0.3, 1, 0.8 * intensite * f.alpha));
    bande.addColorStop(0.58, paint(teinte, 0.85, 0.82, 0.5 * intensite * f.alpha));
    bande.addColorStop(1, paint(teinte, 0.45, 1, 0));
    ctx.fillStyle = bande;
    ctx.fillRect(x - demi, y - 2 - 5 * intensite, demi * 2, 4 + 10 * intensite);

    // Croix lumineuse : un second flare vertical, court et large, pour que le
    // pod ressemble à une source ponctuelle intense et pas à une simple tache.
    const bras = rayon * (1.3 + 1.4 * intensite);
    const vertical = ctx.createLinearGradient(0, y - bras, 0, y + bras);
    vertical.addColorStop(0, paint(teinte, 0.7, 1, 0));
    vertical.addColorStop(0.5, paint(teinte, 0.4, 1, 0.46 * intensite * f.alpha));
    vertical.addColorStop(1, paint(teinte, 0.7, 1, 0));
    ctx.fillStyle = vertical;
    ctx.fillRect(x - (1.4 + 2.2 * intensite), y - bras, 2.8 + 4.4 * intensite, bras * 2);

    ctx.fillStyle = paint(teinte, 0.2, 1, intensite * f.alpha);
    ctx.beginPath();
    ctx.arc(x, y, 4 + 11 * intensite, 0, Math.PI * 2);
    ctx.fill();
  }

  // Éblouissement global : une nappe colorée très brève sur les gros impacts.
  if (force > 0.2) {
    ctx.fillStyle = paint(f.palette.hue, 0.75, 0.72, (force - 0.2) * 0.38 * f.alpha);
    ctx.fillRect(0, 0, w, h);
  }
}

/** Familles de la scénographie concert. */
export const CONCERT_FAMILIES = {
  "lyres-suspendues": lyresSuspendues,
  "barres-led": barresLed,
  "pont-concert": pontConcert,
  "lyres-poursuite": lyresPoursuite,
  "lyres-duo": lyresDuo,
  "lyres-eventail": lyresEventail,
  "lyres-cathedrale": lyresCathedrale,
  "lyres-orbitale": lyresOrbitale,
  "lyres-rideau": lyresRideau,
  "lyres-aurore": lyresAurore,
  "lyres-helice": lyresHelice,
  "lyres-tunnel": lyresTunnel,
  "lyres-diagonale": lyresDiagonale,
  "lyres-respiration": lyresRespiration,
  "lyres-zigzag": lyresZigzag,
  "lyres-cascade": lyresCascade,
  "lyres-colisee": lyresColisee,
  "lyres-arena": lyresArena,
} as const;
