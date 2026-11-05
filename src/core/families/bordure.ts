import { shiftHue } from "../color";
import { clamp01, hash01, mix, smoothstep } from "../series";
import type { TrackView } from "../view";
import { tempsTempsFort, intensiteBlinder } from "./concert-rig";
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

/** Nombre de diodes réparties sur le périmètre : un vrai ruban LED, dense. */
export const NOMBRE_DIODES_BORDURE = 240;

/**
 * Retrait du centre du ruban par rapport au bord, en fraction du petit côté.
 * Quasi nul : le ruban est collé au bord, seul son halo déborde hors cadre.
 */
const MARGE_BORDURE = 0.003;

export type MotifBordure =
  | "rail"
  | "haut"
  | "cote"
  | "alternance"
  | "chenillard"
  | "comete"
  | "respiration"
  | "progression"
  | "haut-bas"
  | "milieu"
  | "vague"
  | "vumetre"
  | "pluie"
  | "scintillement"
  | "strobe"
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
/**
 * Point du ruban à une position fractionnaire du périmètre.
 *
 * Les tronçons sont dessinés entre deux positions fractionnaires voisines
 * (`index ± 0,55`) : ils se raccordent exactement, y compris dans les coins où
 * le sens change. Un tronçon centré sur sa diode laissait un trou à chaque angle.
 */
function pointBordure(position: number, largeur: number, hauteur: number): DiodeBordure {
  const marge = Math.min(largeur, hauteur) * MARGE_BORDURE;
  const largeurUtile = Math.max(largeur - 2 * marge, 0);
  const hauteurUtile = Math.max(hauteur - 2 * marge, 0);
  const perimetre = 2 * (largeurUtile + hauteurUtile);
  if (perimetre <= 0) {
    return { x: largeur / 2, y: hauteur / 2, angle: 0, cote: "haut" };
  }

  const p = modulo(position, NOMBRE_DIODES_BORDURE) * (perimetre / NOMBRE_DIODES_BORDURE);

  if (p < largeurUtile) {
    return { x: marge + p, y: marge, angle: 0, cote: "haut" };
  }
  if (p < largeurUtile + hauteurUtile) {
    return {
      x: largeur - marge,
      y: marge + (p - largeurUtile),
      angle: Math.PI / 2,
      cote: "droite",
    };
  }
  if (p < 2 * largeurUtile + hauteurUtile) {
    return {
      x: largeur - marge - (p - largeurUtile - hauteurUtile),
      y: hauteur - marge,
      angle: Math.PI,
      cote: "bas",
    };
  }
  return {
    x: marge,
    y: hauteur - marge - (p - 2 * largeurUtile - hauteurUtile),
    angle: -Math.PI / 2,
    cote: "gauche",
  };
}

/**
 * Position de la diode `index` sur le périmètre.
 *
 * Le parcours part du coin haut-gauche et tourne dans le sens horaire. La marge
 * est calculée sur le petit côté : en portrait comme en paysage, la bordure
 * reste entièrement dans le cadre.
 */
export function positionBordure(index: number, largeur: number, hauteur: number): DiodeBordure {
  return pointBordure(index, largeur, hauteur);
}

/**
 * Motif d'un bloc de huit temps forts.
 *
 * En mode réduit, ni chenillard ni plein : seulement un rail ou une respiration,
 * pour ne jamais faire courir un point lumineux.
 */
function motifPourBloc(f: FrameState, bloc: number): MotifBordure {
  // Le motif ne dépend QUE du bloc et du rôle : jamais de l'énergie courante,
  // qui oscille et ferait clignoter la bande d'une image à l'autre autour d'un
  // seuil. L'énergie ne module que l'intensité, pas le choix du motif.
  if (f.reduced) return "respiration";
  const tirage = hash01(bloc * 7919 + f.seed + f.scene.index * 131);

  // Un drop n'est pas un mur de lumière continu : les blocs alternent entre
  // plein et des motifs qui laissent le ruban s'éteindre par endroits.
  if (f.scene.role === "drop") {
    // Le profil hard réserve une part plus large au strobe : sur ce répertoire,
    // l'impact doit claquer au lieu de dérouler un motif.
    if (f.hard && tirage < 0.18) return "strobe";
    // Le strobe « fort et sale » est réservé aux gros drops : une montée qui
    // n'a pas assez de force ne le déclenche jamais.
    const grosDrop = clamp01(f.buildStrength) >= 0.8;
    if (tirage < 0.12) return "plein";
    if (tirage < 0.24) return "chenillard";
    if (tirage < 0.35) return "comete";
    if (tirage < 0.46) return "vumetre";
    if (tirage < 0.56) return "progression";
    if (tirage < 0.66) return "haut-bas";
    if (tirage < 0.74) return "milieu";
    if (tirage < 0.82) return "vague";
    if (tirage < 0.89) return "pluie";
    if (tirage < 0.95) return "scintillement";
    return grosDrop ? "strobe" : "plein";
  }
  if (f.scene.role === "refrain") {
    if (tirage < 0.16) return "chenillard";
    if (tirage < 0.3) return "comete";
    if (tirage < 0.42) return "alternance";
    if (tirage < 0.54) return "respiration";
    if (tirage < 0.64) return "progression";
    if (tirage < 0.74) return "haut-bas";
    if (tirage < 0.82) return "milieu";
    if (tirage < 0.9) return "vague";
    if (tirage < 0.96) return "pluie";
    return "vumetre";
  }
  if (f.scene.role === "montee") {
    if (tirage < 0.26) return "haut";
    if (tirage < 0.46) return "chenillard";
    if (tirage < 0.62) return "progression";
    if (tirage < 0.76) return "haut-bas";
    if (tirage < 0.88) return "comete";
    return "plein";
  }
  if (f.scene.role === "intro") return tirage < 0.45 ? "rail" : tirage < 0.75 ? "respiration" : "progression";
  if (f.hard && tirage > 0.92) return "strobe";
  if (tirage < 0.2) return "rail";
  if (tirage < 0.36) return "cote";
  if (tirage < 0.5) return "respiration";
  if (tirage < 0.62) return "progression";
  if (tirage < 0.72) return "milieu";
  if (tirage < 0.82) return "vague";
  if (tirage < 0.9) return "pluie";
  return "comete";
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

/** Part d'une diode qui reste visible même quand le motif l'éteint. */
const VEILLEUSE = 0.08;

function avecVeilleuse(brut: number): number {
  return VEILLEUSE + (1 - VEILLEUSE) * clamp01(brut);
}

/**
 * Part allumée de la diode `index` dans un motif, 0..1.
 *
 * Un motif n'est pas un interrupteur, et la bande n'est jamais éteinte : même
 * la diode que le motif laisse de côté garde une veilleuse. Le chenillard comme
 * la respiration sont des fonctions lisses.
 */
export function poidsMotif(
  f: FrameState,
  view: TrackView,
  index: number,
  motif: MotifBordure = motifBordure(f, view),
  budgetFlash = 1,
): number {
  const diode = positionBordure(index, f.width, f.height);
  const temps = tempsTempsFort(f, view);
  const marge = Math.min(f.width, f.height) * MARGE_BORDURE;
  const largeurUtile = Math.max(f.width - 2 * marge, 1);
  const hauteurUtile = Math.max(f.height - 2 * marge, 1);
  // Position spatiale le long du bord, 0..1. Les bords haut et bas se lisent de
  // gauche à droite, les côtés de haut en bas.
  const u =
    diode.cote === "gauche" || diode.cote === "droite"
      ? (diode.y - marge) / hauteurUtile
      : (diode.x - marge) / largeurUtile;

  switch (motif) {
    case "haut":
      return avecVeilleuse(diode.cote === "haut" ? 1 : 0);
    case "cote": {
      const bloc = Math.floor(temps / 8);
      const choix = hash01(bloc * 7919 + f.seed) < 0.5 ? "gauche" : "droite";
      return avecVeilleuse(diode.cote === choix ? 1 : 0);
    }
    case "alternance": {
      // Bascule de côté lissée sur ~0,2 s : sans ce fondu, tout un bord
      // s'éteindrait entre deux images.
      const position = temps / 4;
      const blocAlt = Math.floor(position);
      const local = position - blocAlt;
      const courant = blocAlt % 2 === 0 ? "gauche" : "droite";
      const precedent = (blocAlt - 1) % 2 === 0 ? "gauche" : "droite";
      const cible = diode.cote === courant ? 1 : 0;
      const avant = diode.cote === precedent ? 1 : 0;
      return avecVeilleuse(mix(avant, cible, smoothstep(0, 0.2, local)));
    }
    case "chenillard": {
      // Course lente, profil gaussien : le point chaud s'élargit au lieu de
      // sauter d'une diode à l'autre image après image.
      const position = modulo(temps * 0.2, 1);
      const ecart = Math.abs(index / NOMBRE_DIODES_BORDURE - position);
      const distance = Math.min(ecart, 1 - ecart);
      return avecVeilleuse(Math.exp(-(distance * distance) / (2 * 0.11 * 0.11)));
    }
    case "respiration":
      return avecVeilleuse(0.6 + 0.4 * (0.5 + 0.5 * Math.sin(f.t * 0.8)));
    case "progression": {
      // Remplissage qui part du coin haut-gauche, fait le tour, puis se vide :
      // le front oscille (0 → 1 → 0) pour ne jamais se réinitialiser d'un coup.
      const front = 0.5 - 0.5 * Math.cos((temps * Math.PI) / 8);
      const position = index / NOMBRE_DIODES_BORDURE;
      return avecVeilleuse(1 - smoothstep(front - 0.03, front + 0.03, position));
    }
    case "haut-bas": {
      // D'abord le bord haut de gauche à droite, puis le bord bas.
      if (diode.cote !== "haut" && diode.cote !== "bas") return avecVeilleuse(0);
      const front = 1 - Math.cos((temps * Math.PI) / 8);
      const etape = (diode.cote === "bas" ? 1 : 0) + u;
      return avecVeilleuse(1 - smoothstep(front - 0.05, front + 0.05, etape));
    }
    case "milieu": {
      // La lumière part du milieu de chaque bord et gagne les extrémités.
      const front = 0.5 - 0.5 * Math.cos((temps * Math.PI) / 8);
      const distance = Math.abs(u - 0.5) * 2;
      return avecVeilleuse(1 - smoothstep(front - 0.04, front + 0.04, distance));
    }
    case "vague": {
      // Deux ondes courent le long du pourtour ; le bouclage est continu.
      const position = index / NOMBRE_DIODES_BORDURE;
      return avecVeilleuse(0.5 + 0.5 * Math.sin(position * Math.PI * 4 - temps * 1.1));
    }
    case "comete": {
      // Une tête vive, une traînée qui s'éteint derrière elle. La tête est
      // symétrique : la diode s'allume en douceur quand la comète l'approche,
      // au lieu de sauter de 0 à 1 à son passage.
      const tete = modulo(temps * 0.08, 1);
      const position = index / NOMBRE_DIODES_BORDURE;
      const d = modulo(position - tete + 0.5, 1) - 0.5;
      const teteVive = Math.exp(-(d * d) / (2 * 0.06 * 0.06));
      const queue = d < 0 ? Math.exp(d / 0.2) : 0;
      return avecVeilleuse(Math.max(teteVive, queue));
    }
    case "vumetre": {
      // Chaque bord est une barre : les basses en bas, les aigus en haut, les
      // médiums sur les côtés.
      const niveau =
        diode.cote === "haut" ? f.high : diode.cote === "bas" ? f.bass : f.mid;
      const front = clamp01(niveau);
      return avecVeilleuse(1 - smoothstep(front - 0.04, front + 0.04, u));
    }
    case "pluie": {
      // Des gouttes déterministes : chaque diode a sa phase et s'éteint vite.
      const offset = hash01(index * 97 + f.seed);
      const phase = modulo(temps * 0.2 + offset, 1);
      return avecVeilleuse(Math.exp(-phase / 0.18));
    }
    case "scintillement": {
      // Micro-éclats sur les aigus, par paliers de temps et par diode.
      const etape = Math.floor(temps * 2);
      const local = temps * 2 - etape;
      const tirage = hash01(index * 131 + etape * 7919 + f.seed);
      const eclat = tirage > 0.72 ? Math.exp(-local * 3) : 0;
      return avecVeilleuse(eclat * clamp01(f.high));
    }
    case "strobe": {
      // Strobe rapide, dosé par le budget de flashs. En mode réduit, le motif
      // n'est jamais choisi.
      const allumage = modulo(temps * 8, 1) < 0.5 ? 1 : 0;
      return avecVeilleuse(allumage * clamp01(budgetFlash));
    }
    case "plein":
      return 1;
    case "rail":
    default:
      return avecVeilleuse(0);
  }
}

/**
 * Teinte du ruban.
 *
 * Une seule couleur de fil, pas un arc-en-ciel : une ondulation très douce sur
 * le pourtour (8° d'amplitude, périodique donc sans raccord visible) et une
 * dérive lente dans le budget de teinte de la scène. Deux diodes voisines sont
 * donc presque identiques — c'est un fil, pas une guirlande.
 */
export function couleurBordure(f: FrameState, index: number): number {
  const progression = (index % NOMBRE_DIODES_BORDURE) / NOMBRE_DIODES_BORDURE;
  const ondulation = Math.sin(progression * Math.PI * 2) * 8;
  const derive = Math.sin(f.t * 0.05 + f.scene.index) * Math.min(f.palette.spread, 18) * 0.35;
  return shiftHue(f.palette.hue, ondulation + derive);
}

/**
 * Poids effectif d'une diode, fondus de motif compris.
 *
 * Le motif d'un bloc arrive en fondu sur le premier dixième du bloc : le
 * pourtour se transforme au lieu de basculer d'un coup. Au passage d'un bloc au
 * suivant, la valeur est exactement continue (le motif sortant devient le motif
 * précédent, et le fondu repart de zéro).
 */
function poidsCourant(f: FrameState, view: TrackView, index: number, budgetFlash = 1): number {
  const temps = tempsTempsFort(f, view);
  const bloc = Math.floor(temps / 8);
  const local = temps / 8 - bloc;
  const fondu = smoothstep(0, 0.12, local);
  const avant = poidsMotif(f, view, index, motifPourBloc(f, bloc - 1), budgetFlash);
  const apres = poidsMotif(f, view, index, motifPourBloc(f, bloc), budgetFlash);
  const motif = mix(avant, apres, fondu);

  // Le beat reprend le dessus sur le motif : à chaque temps fort, tout le
  // ruban monte vers l'allumé, puis le motif réapparaît en s'éteignant. La
  // fusion est partielle (75 %) pour que les deux restent lisibles.
  const battement = clamp01(f.beat);
  const fusion = f.reduced ? Math.min(0.25, battement * 0.25) : battement * 0.75;
  return mix(motif, 1, fusion);
}

/**
 * Part de blinder du ruban.
 *
 * Le ruban n'est pas qu'un décor : il sert aussi de barre de blinders. Sur un
 * impact, il reprend l'inertie du filament tungstène (`intensiteBlinder`), avec
 * le même décalage par bloc, et le budget de flashs de l'utilisateur. En mode
 * réduit, il ne flashe jamais.
 */
export function blinderBordure(
  f: FrameState,
  view: TrackView,
  index: number,
  budgetFlash = 1,
): number {
  if (f.reduced) return 0;
  // Petit blinder : un pulse bref sur chaque beat, avec une attaque douce de
  // ~60 ms. Sans elle, la diode passait de 0 au maximum en une seule image — un
  // clignotement, pas un blinder.
  const attaque = smoothstep(0, 0.06, Number.isFinite(f.beatAge) ? f.beatAge : 1);
  const petit =
    clamp01(f.beat) * attaque * clamp01(budgetFlash) * (0.18 + 0.25 * clamp01(f.bass));
  // Gros blinder : le ruban prend le relais sur les moments qui le méritent.
  const role = f.scene.role;
  const autorise =
    role === "drop" ||
    role === "refrain" ||
    role === "finale" ||
    (role === "montee" && clamp01(f.build) > 0.25) ||
    (role === "couplet" && clamp01(f.energy) > 0.55);
  const ageImpact = Math.min(
    Number.isFinite(f.beatAge) ? f.beatAge : Infinity,
    Number.isFinite(f.dropAge) ? f.dropAge : Infinity,
  );
  const attaqueImpact = Number.isFinite(ageImpact) ? smoothstep(0, 0.05, ageImpact) : 1;
  const impact = autorise
    ? intensiteBlinder(f, view, index % 12) * 1.2 * clamp01(budgetFlash) * attaqueImpact
    : 0;
  return clamp01(Math.max(petit, impact));
}

/**
 * Couleur du ruban à un instant donné.
 *
 * Une seule teinte de fil, qui reste celle de la scène même quand le blinder
 * frappe : le blinder du ruban est **de couleur**, pas tungstène. Il gagne
 * seulement en saturation et en luminosité au moment de l'éclat.
 */
export function teinteBordure(
  f: FrameState,
  view: TrackView,
  index: number,
  budgetFlash = 1,
): { hue: number; saturation: number; lightness: number } {
  const blinder = blinderBordure(f, view, index, budgetFlash);
  return {
    hue: couleurBordure(f, index),
    saturation: 0.75 + 0.2 * blinder,
    lightness: 0.8 + 0.12 * blinder,
  };
}

/**
 * Intensité de la diode `index` à l'instant courant.
 *
 * Le rail de base reste toujours un peu visible ; le motif décide de la part
 * réellement allumée ; le blinder ajoute son éclat chaud sur les impacts. En
 * mode réduit, ni chenillard ni éclat : tout est plafonné sous le seuil
 * d'inconfort lumineux.
 */
export function intensiteBordure(
  f: FrameState,
  view: TrackView,
  index: number,
  budgetFlash = 1,
): number {
  const energie = clamp01(f.energy);
  const poids = poidsCourant(f, view, index, budgetFlash);
  const rail = 0.03 + 0.08 * energie;
  const respiration = 0.85 + 0.15 * Math.sin(f.t * 1.1);
  const eclat = f.reduced ? 0 : clamp01(f.drop) * clamp01(budgetFlash) * 0.5;
  const blinder = blinderBordure(f, view, index, budgetFlash);
  const brut =
    rail +
    poids * (0.2 + 0.65 * energie) * respiration +
    eclat * Math.max(poids, 0.15) +
    blinder;
  return f.reduced ? Math.min(0.3, brut * 0.5) : clamp01(brut);
}

/**
 * Luminosité d'ensemble du ruban, 0..1.
 *
 * Moyenne du poids des diodes sur le pourtour : c'est elle qui fait respirer le
 * tube diffuseur et le cœur du fil. Sans elle, un tracé constant écraserait les
 * motifs — un chenillard ou une respiration deviendraient invisibles.
 */
export function moyenneBordure(f: FrameState, view: TrackView): number {
  const echantillons = 8;
  let total = 0;
  for (let index = 0; index < echantillons; index += 1) {
    total += poidsCourant(
      f,
      view,
      Math.floor((index * NOMBRE_DIODES_BORDURE) / echantillons),
    );
  }
  return total / echantillons;
}

/** Trace un tronçon en suivant le périmètre, coin compris. */
function tracerTroncon(
  ctx: CanvasRenderingContext2D,
  deIndex: number,
  versIndex: number,
  largeur: number,
  hauteur: number,
): void {
  const marge = Math.min(largeur, hauteur) * MARGE_BORDURE;
  const largeurUtile = Math.max(largeur - 2 * marge, 0);
  const hauteurUtile = Math.max(hauteur - 2 * marge, 0);
  const perimetre = 2 * (largeurUtile + hauteurUtile);
  const pas = perimetre / NOMBRE_DIODES_BORDURE;
  const coins = [
    0,
    largeurUtile / pas,
    (largeurUtile + hauteurUtile) / pas,
    (2 * largeurUtile + hauteurUtile) / pas,
    NOMBRE_DIODES_BORDURE,
  ];

  const debut = pointBordure(deIndex, largeur, hauteur);
  ctx.beginPath();
  ctx.moveTo(debut.x, debut.y);
  for (const coin of coins) {
    if (coin <= deIndex || coin >= versIndex) continue;
    const point = pointBordure(coin, largeur, hauteur);
    ctx.lineTo(point.x, point.y);
  }
  const fin = pointBordure(versIndex, largeur, hauteur);
  ctx.lineTo(fin.x, fin.y);
  ctx.stroke();
}

/**
 * Dessine le ruban : un fil continu, puis les diodes qui le composent.
 *
 * Le fil est toujours là — deux traits (halo extérieur, cœur) — et les diodes
 * ne font que renforcer localement. Aucune transformation de contexte et aucun
 * dégradé par diode : le coût reste borné par le pas d'échantillonnage, qui
 * suit la qualité.
 */
export function dessinerBordure(
  ctx: CanvasRenderingContext2D,
  f: FrameState,
  view: TrackView,
  budgetFlash = 1,
): void {
  const { width: w, height: h } = f;
  const marge = Math.min(w, h) * MARGE_BORDURE;
  const petitCote = Math.min(w, h);
  const energie = clamp01(f.energy);
  const fil = teinteBordure(f, view, 0, budgetFlash);

  const traceRuban = () => {
    ctx.beginPath();
    ctx.moveTo(marge, marge);
    ctx.lineTo(w - marge, marge);
    ctx.lineTo(w - marge, h - marge);
    ctx.lineTo(marge, h - marge);
    ctx.closePath();
    ctx.stroke();
  };

  const tube = Math.max(4.5, petitCote * 0.009);

  // Piste permanente, volontairement presque éteinte : elle donne l'axe du
  // cadre, mais c'est le motif qui fait la lumière. Sans ça, le ruban reste
  // uniformément allumé et la différence allumé/éteint disparaît.
  ctx.strokeStyle = paint(fil.hue, fil.saturation * 0.45, 0.35, (0.03 + 0.03 * energie) * (0.4 + 0.6 * moyenneBordure(f, view)));
  ctx.lineWidth = Math.max(1.2, tube * 0.35);
  traceRuban();

  // Le corps du ruban est dessiné diode par diode : les zones que le motif
  // laisse de côté retombent à une veilleuse très faible.
  const pas = f.reduced ? 3 : f.quality >= 0.85 ? 1 : f.quality >= 0.6 ? 2 : 3;
  for (let index = 0; index < NOMBRE_DIODES_BORDURE; index += 1) {
    const intensite = intensiteBordure(f, view, index, budgetFlash);
    const { x, y } = positionBordure(index, w, h);
    const couleur = teinteBordure(f, view, index, budgetFlash);
    // Variation déterministe : deux diodes voisines ne brillent jamais
    // exactement pareil, comme sur un vrai ruban.
    const variation = 0.9 + 0.2 * hash01(index * 97 + f.seed);

    // Diffusion locale : uniquement autour des zones allumées.
    if (intensite > 0.12) {
      ctx.strokeStyle = paint(couleur.hue, couleur.saturation * 0.7, 0.55, 0.12 * intensite);
      ctx.lineWidth = tube * (1.9 + 0.9 * intensite);
      tracerTroncon(ctx, index - 0.6, index + 0.6, w, h);
    }

    // Corps : c'est lui qui porte le contraste allumé/éteint.
    ctx.strokeStyle = paint(
      couleur.hue,
      couleur.saturation,
      couleur.lightness,
      (0.03 + 0.85 * intensite) * variation,
    );
    ctx.lineWidth = tube * (0.45 + 0.75 * intensite);
    tracerTroncon(ctx, index - 0.6, index + 0.6, w, h);

    // Cœur du tube, plus fin et plus clair, pour le côté néon.
    ctx.strokeStyle = paint(
      couleur.hue,
      couleur.saturation,
      0.88,
      (0.02 + 0.7 * intensite) * variation,
    );
    ctx.lineWidth = Math.max(0.8, tube * 0.28 * (0.7 + 0.5 * intensite));
    tracerTroncon(ctx, index - 0.6, index + 0.6, w, h);

    // Les émetteurs, eux, peuvent être échantillonnés : ce sont les points.
    if (index % pas !== 0) continue;

    // Halo de la diode (diffusion dans le tube).
    const rayon = tube * 0.26 * (0.5 + intensite) * variation;
    ctx.fillStyle = paint(couleur.hue, couleur.saturation * 0.7, 0.62, 0.25 * intensite);
    ctx.beginPath();
    ctx.arc(x, y, rayon * 2.6, 0, Math.PI * 2);
    ctx.fill();

    // Cœur de la diode : coloré, jamais blanc.
    ctx.fillStyle = paint(
      couleur.hue,
      couleur.saturation,
      0.68 + 0.17 * intensite,
      clamp01(0.2 + 0.8 * intensite),
    );
    ctx.beginPath();
    ctx.arc(x, y, rayon, 0, Math.PI * 2);
    ctx.fill();
  }
}
