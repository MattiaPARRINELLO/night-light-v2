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
  if (f.scene.role === "drop") return "plein";
  const tirage = hash01(bloc * 7919 + f.seed + f.scene.index * 131);

  if (f.scene.role === "refrain") {
    if (tirage < 0.3) return "chenillard";
    if (tirage < 0.55) return "alternance";
    if (tirage < 0.8) return "respiration";
    return "plein";
  }
  if (f.scene.role === "montee") {
    if (tirage < 0.5) return "haut";
    if (tirage < 0.8) return "chenillard";
    return "plein";
  }
  if (f.scene.role === "intro") return tirage < 0.6 ? "rail" : "respiration";
  if (tirage < 0.35) return "rail";
  if (tirage < 0.7) return "cote";
  return "respiration";
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
const VEILLEUSE = 0.3;

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
): number {
  const diode = positionBordure(index, f.width, f.height);
  const temps = tempsTempsFort(f, view);

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
  const poids = poidsCourant(f, view, index);
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
  // Le corps du ruban suit la moyenne du motif : le tube respire, et un
  // chenillard laisse réellement des zones plus sombres sur le pourtour.
  const eclairage = 0.25 + 0.75 * moyenneBordure(f, view);

  // 1. Bloom : trois passes de plus en plus larges et de plus en plus faibles.
  // C'est la lumière que le ruban jette sur le cadre et dans la salle.
  const blooms = [
    [3.6, 0.028],
    [2.1, 0.055],
    [1.35, 0.1],
  ] as const;
  for (const [facteur, alpha] of blooms) {
    ctx.strokeStyle = paint(
      fil.hue,
      fil.saturation * 0.7,
      0.55,
      alpha * (0.35 + 0.65 * eclairage) * (0.7 + 0.6 * energie),
    );
    ctx.lineWidth = tube * facteur;
    traceRuban();
  }

  // 2. Tube diffuseur : le plastique laiteux qui rend la bande continue.
  ctx.strokeStyle = paint(
    fil.hue,
    fil.saturation * 0.85,
    0.72,
    (0.1 + 0.2 * energie) * eclairage,
  );
  ctx.lineWidth = tube;
  traceRuban();

  // 3. Cœur du tube, plus fin et plus clair.
  ctx.strokeStyle = paint(fil.hue, fil.saturation, 0.85, (0.12 + 0.22 * energie) * eclairage);
  ctx.lineWidth = tube * 0.45;
  traceRuban();

  // 4. Émetteurs : de vraies diodes, petites, colorées et régulièrement
  // espacées. Le tronçon assure la continuité, le point donne la granularité de
  // la bande réelle — sans redevenir un chapelet de points blancs.
  const pas = f.reduced ? 3 : f.quality >= 0.85 ? 1 : f.quality >= 0.6 ? 2 : 3;
  for (let index = 0; index < NOMBRE_DIODES_BORDURE; index += pas) {
    const intensite = intensiteBordure(f, view, index, budgetFlash);
    const { x, y } = positionBordure(index, w, h);
    const couleur = teinteBordure(f, view, index, budgetFlash);
    // Variation déterministe : deux diodes voisines ne brillent jamais
    // exactement pareil, comme sur un vrai ruban.
    const variation = 0.9 + 0.2 * hash01(index * 97 + f.seed);
    // Tronçon entre deux positions fractionnaires : les morceaux se raccordent
    // exactement, coins compris.
    const debut = pointBordure(index - 0.6, w, h);
    const fin = pointBordure(index + 0.6, w, h);

    ctx.strokeStyle = paint(
      couleur.hue,
      couleur.saturation,
      couleur.lightness,
      (0.04 + 0.96 * intensite) * variation,
    );
    ctx.lineWidth = tube * (0.45 + 0.75 * intensite);
    ctx.beginPath();
    ctx.moveTo(debut.x, debut.y);
    ctx.lineTo(fin.x, fin.y);
    ctx.stroke();

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
