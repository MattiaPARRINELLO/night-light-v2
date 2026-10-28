import type { Analysis, Section } from "../types";
import { clamp01, hash01, hashString } from "./series";

export type FamilyId =
  | "beams"
  | "tunnel"
  | "particles"
  | "waves"
  | "grid"
  | "rings"
  | "shutters"
  | "bars"
  | "spiral"
  | "spots"
  | "mirror"
  | "parade"
  | "crossfire"
  | "curtain"
  | "burst"
  | "gobos"
  | "pendule"
  | "couronne"
  | "pluie"
  | "portique"
  | "etoile"
  | "vortex"
  | "lyre"
  | "mandala"
  | "treillis"
  | "rideaux"
  // Scénographie de concert : trois familles ajoutées ensemble, pour que le
  // pont, les lyres suspendues et les barres LED restent cohérents dans le
  // plan de spectacle. Toute nouvelle famille doit aussi figurer dans
  // FAMILY_LABELS et dans l'un des réservoirs ci-dessous.
  | "lyres-suspendues"
  | "barres-led"
  | "pont-concert";

/**
 * Rôle d'une scène dans la dramaturgie du concert.
 *
 * Il ne remplace pas l'humeur : il dit ce que fait la lumière. Une scène
 * `refrain` ouvre les lyres en ballyhoo, un `drop` les fait converger, une
 * `montee` déploie l'éventail et les barres LED en vague.
 */
export type SceneRole = "intro" | "couplet" | "refrain" | "montee" | "drop" | "finale";

/** Orientation des lyres pendant un drop. */
export type DropLyres = "convergence" | "croisee" | "eventail";
/** Comportement des barres LED pendant un drop. */
export type DropBarres = "onde" | "rideau" | "alterne";
/** Motif de la barre de blinders pendant un drop. */
export type DropBlinders = "tous" | "un-sur-deux" | "chenillard";

/**
 * Signature d'un drop : quatre choix tirés du morceau, pas du rôle seul.
 *
 * Deux drops ne doivent pas se ressembler, même quand ils tombent à quelques
 * secondes d'intervalle. La signature est calculée dans `buildShowPlan` à
 * partir de la graine, du rang du drop et de la force de la montée, puis
 * consommée par le rendu (`concert-rig.ts`).
 */
export interface DropSignature {
  lyres: DropLyres;
  barres: DropBarres;
  blinders: DropBlinders;
  /** Ancre de teinte : complémentaire du morceau ou pôle opposé. */
  hue: "accent" | "contraste";
}

export const SCENE_ROLE_LABELS: Record<SceneRole, string> = {
  intro: "introduction",
  couplet: "couplet",
  refrain: "refrain",
  montee: "montée",
  drop: "impact",
  finale: "finale",
};

export interface Scene {
  index: number;
  start: number;
  end: number;
  family: FamilyId;
  /** Famille qui surgit au milieu de la phrase, pour casser la répétition. */
  variant: FamilyId;
  /** Couche de fond, toujours présente mais discrète. */
  backdrop: FamilyId;
  palette: Palette;
  /** Intensité propre de la scène, 0..1. */
  intensity: number;
  /** Durée du fondu d'entrée, en secondes. */
  fadeIn: number;
  /** Durée du fondu de sortie, en secondes. */
  fadeOut: number;
  /** Caractère de la scène qui pilote les réactions aux impacts. */
  mood: Mood;
  /** Rôle dramaturgique : pilote les cinématiques de concert. */
  role: SceneRole;
  /** Signature du drop ; absente sur les scènes qui n'en sont pas. */
  drop?: DropSignature;
  /** Ce qui, dans le morceau, a déclenché ce changement d'ambiance. */
  reason: SceneReason;
}

/**
 * Ce qui a produit une frontière de scène.
 *
 * `beat` n'est pas un vestige : c'est la coupure de sécurité sur le temps fort
 * quand aucun événement musical (section, impact, cycle retenu) ne tombe dans
 * `MAX_SCENE_SPAN`. `finale` marque la dernière scène non terminée par un drop.
 * `bass-return` est le retour des basses du contrat v3 : une frontière admise,
 * qui ne crée jamais de drop.
 */
export type SceneReason =
  | "section"
  | "bass-return"
  | "build"
  | "cycle"
  | "beat"
  | "ouverture"
  | "finale";

export const SCENE_REASON_LABELS: Record<SceneReason, string> = {
  section: "nouveau passage",
  "bass-return": "retour des basses",
  build: "impact de la montée",
  cycle: "retour du cycle",
  beat: "nouvelle mesure",
  ouverture: "début du morceau",
  finale: "fin du morceau",
};

export type Mood = "calme" | "pulse" | "explosif" | "aerien" | "sombre";

export interface Palette {
  name: string;
  /** Teinte dominante, 0..360. */
  hue: number;
  /**
   * Teinte complémentaire, pour les sources secondaires : les projecteurs n'ont
   * pas à être tous de la même couleur, et une complémentaire fait vivre un
   * faisceau sur deux sans jamais jurer avec le reste.
   */
  accent: number;
  /** Écart entre teintes primaire et secondaire, en degrés. */
  spread: number;
  /** Saturation, 0..1. */
  saturation: number;
  /** Luminosité, 0..1. */
  lightness: number;
}

export interface ShowPlan {
  duration: number;
  seed: number;
  scenes: Scene[];
  /** Fenêtre analysée disponible ; absente pour une analyse complète. */
  coverage?: [number, number];
  /** Barres de mesure détectées dans le morceau, en secondes. */
  barStarts: number[];
  /**
   * Identité colorée du morceau, choisie une fois et tenue du premier au
   * dernier plan : c'est elle que suit toute la salle.
   */
  track: TrackPalette;
  /**
   * Couche de fond commune à toutes les scènes : l'élément qui reste à l'écran
   * quand tout le reste change, donc ce qui rend les changements de scène
   * presque imperceptibles.
   */
  backdrop: FamilyId;
}

/** Palette d'un morceau : une teinte, sa complémentaire, et leur écart. */
export interface TrackPalette {
  name: string;
  hue: number;
  accent: number;
  spread: number;
}

export const FAMILY_LABELS: Record<FamilyId, string> = {
  beams: "faisceaux",
  tunnel: "tunnel",
  particles: "particules",
  waves: "vagues",
  grid: "grille",
  rings: "anneaux",
  shutters: "volets",
  bars: "barres",
  spiral: "spirale",
  spots: "projecteurs",
  mirror: "miroirs",
  parade: "défilé",
  crossfire: "tirs croisés",
  curtain: "rideau de lumière",
  burst: "rayonnement",
  gobos: "formes projetées",
  pendule: "pendules",
  couronne: "couronne",
  pluie: "pluie de lumière",
  portique: "portique",
  etoile: "étoile",
  vortex: "vortex",
  lyre: "lyres",
  mandala: "rosace",
  treillis: "treillis",
  rideaux: "double rideau",
  "lyres-suspendues": "lyres suspendues",
  "barres-led": "barres LED",
  "pont-concert": "pont concert",
};

export const MOOD_LABELS: Record<Mood, string> = {
  calme: "ambiance calme",
  pulse: "pulsé",
  explosif: "explosif",
  aerien: "aérien",
  sombre: "sombre",
};

/** Familles posées, pour les passages sans percussion marquée. */
export const CALM_FAMILIES: FamilyId[] = ["waves", "tunnel", "particles", "rings", "spiral", "pluie"];
/** Familles qui suivent le rythme, pour les passages cadencés. */
export const RHYTHMIC_FAMILIES: FamilyId[] = [
  "bars",
  "beams",
  "grid",
  "shutters",
  "tunnel",
  "spots",
  "mirror",
  "parade",
  "crossfire",
  "curtain",
  "burst",
  "gobos",
  "pendule",
  "couronne",
  "pluie",
  "portique",
  "etoile",
  "vortex",
  "lyre",
  "mandala",
  "treillis",
  "rideaux",
  "lyres-suspendues",
  "barres-led",
  "pont-concert",
];
export const ENERGETIC_FAMILIES: FamilyId[] = [
  "beams",
  "spots",
  "spiral",
  "shutters",
  "bars",
  "grid",
  "mirror",
  "parade",
  "crossfire",
  "curtain",
  "burst",
  "gobos",
  "pendule",
  "couronne",
  "pluie",
  "portique",
  "etoile",
  "vortex",
  "lyre",
  "mandala",
  "treillis",
  "rideaux",
  "lyres-suspendues",
  "barres-led",
  "pont-concert",
];
/** Familles du plateau de concert (impact, refrain, montée). */
export const CONCERT_FAMILIES: FamilyId[] = ["lyres-suspendues", "barres-led", "pont-concert"];
/**
 * Réservoir du pont : volontairement **hors** du réservoir des refrains.
 *
 * Un pont est une rupture : il ne doit jamais reprendre les lyres suspendues ni
 * les barres LED d'un refrain, sinon le spectateur croit au retour du refrain.
 * Les familles choisies sont franchement différentes (vortex, rosace, treillis,
 * formes projetées…) tout en restant dans le vocabulaire du spectacle.
 */
export const PONT_FAMILIES: FamilyId[] = [
  "vortex",
  "spiral",
  "mandala",
  "treillis",
  "gobos",
  "mirror",
  "pendule",
  "couronne",
  "rideaux",
];
/** Familles de la branche « brillance » : passages clairs dans le spectre. */
export const BRIGHT_FAMILIES: FamilyId[] = [
  "particles",
  "spots",
  "spiral",
  "rings",
  "beams",
  "mirror",
  "parade",
];
/** Réservoir du mode réduit rythmé. */
export const REDUCED_RHYTHMIC_FAMILIES: FamilyId[] = ["beams", "waves", "rings", "particles"];

export const ALL_FAMILIES: FamilyId[] = [...CALM_FAMILIES, ...RHYTHMIC_FAMILIES];

/**
 * Branche de l'arbre de décision de `familyFor`.
 *
 * Le nom de la branche est une donnée d'instrumentation : il est exporté pour
 * que le rapport de mesure (`tests/support/plan_report.ts`) lise exactement le
 * même arbre que la production, sans recopie de seuils.
 */
export const FAMILY_BRANCHES = [
  "reduit-calme",
  "reduit-rythmique",
  "refrain",
  "montee",
  "pont",
  "drop",
  "calme",
  "brillance",
  "densite",
  "energie",
  "general",
] as const;
export type FamilyBranch = (typeof FAMILY_BRANCHES)[number];

/** Réservoir associé à chaque branche. */
export const FAMILY_BRANCH_RESERVOIRS: Record<FamilyBranch, readonly FamilyId[]> = {
  "reduit-calme": CALM_FAMILIES,
  "reduit-rythmique": REDUCED_RHYTHMIC_FAMILIES,
  refrain: ["lyres-suspendues", "barres-led"],
  montee: ["barres-led"],
  pont: PONT_FAMILIES,
  drop: CONCERT_FAMILIES,
  calme: CALM_FAMILIES,
  brillance: BRIGHT_FAMILIES,
  densite: RHYTHMIC_FAMILIES,
  energie: ENERGETIC_FAMILIES,
  general: ALL_FAMILIES,
};

/**
 * Palettes de morceau.
 *
 * Le spectacle éclaire une salle de soirée, pas un musée : les teintes sont
 * franches et saturées, et chaque morceau garde la même identité d'un bout à
 * l'autre (voir `buildShowPlan`). La complémentaire sert aux sources
 * secondaires, pour qu'un faisceau sur deux parte dans l'autre couleur sans
 * jamais jurer avec l'ensemble.
 */
const TRACK_PALETTES: Array<{ name: string; hue: number; accent: number; spread: number }> = [
  { name: "magenta-cyan", hue: 318, accent: 188, spread: 44 },
  { name: "ambre-azur", hue: 34, accent: 214, spread: 38 },
  { name: "émeraude-magenta", hue: 152, accent: 320, spread: 42 },
  { name: "azur-orange", hue: 212, accent: 26, spread: 40 },
  { name: "corail-turquoise", hue: 6, accent: 176, spread: 36 },
  { name: "violet-jaune", hue: 268, accent: 52, spread: 46 },
  { name: "cyan-rose", hue: 186, accent: 336, spread: 42 },
  { name: "jaune-bleu", hue: 48, accent: 222, spread: 40 },
];

/** Teintes de scènes voisines jamais à moins de `MIN_HUE_STEP` degrés. */
const MIN_HUE_STEP = 34;
/**
 * Marge du budget de couleur partagée avec le rendu, en degrés.
 *
 * Le rendu peut dériver la teinte de la scène (impact, variation) : la marge
 * garantit que cette dérive ne fait pas sortir de l'identité du morceau.
 */
export const HUE_BUDGET_MARGIN_DEG = 12;

/**
 * Écart minimal effectif entre deux scènes voisines.
 *
 * Sur un morceau à faible `spread`, exiger 34° forcerait à sortir du budget de
 * couleur : l'écart s'efface alors à 90 % du spread. C'est l'écart qui gagne
 * sur le clamp quand les deux s'opposent, en changeant d'ancre si besoin.
 */
export function minHueStepEff(spread: number): number {
  return Math.min(MIN_HUE_STEP, spread * 0.9);
}
/**
 * Mesures par cycle « vers ». La métrique détectée décide du nombre de temps
 * par mesure : sans elle, un 3/4 se décalait d'un temps à chaque cycle et les
 * scènes tombaient à contre-temps.
 */
const BARS_PER_CYCLE = 4;
/** Longueur minimale d'une scène, en secondes. */
const MIN_SCENE_SPAN = 5;
/**
 * En deçà de cette durée, une scène ne porte pas de variation : le second
 * passage d'une figure n'a pas le temps de se lire et se confond avec un
 * changement de scène raté.
 */
const MIN_VARIATION_SPAN = 8;

/**
 * Seuils de l'arbre de décision de `familyFor`.
 *
 * `brightness`, `density` et `energy` sont mesurés sur l'intervalle de la scène
 * (voir `caractereAt`). Les valeurs d'origine (0,62 / 2,2 / 0,60) avaient été
 * calibrées quand `brightness` était une **somme** saturée à ~1 : depuis son
 * passage en moyenne (échelle réelle 0..1, médiane du corpus ≈ 0,19), il faut
 * les relire sur l'histogramme du corpus (tests/support/make_corpus.py) :
 *
 * - brillance : médiane 0,19, p90 0,32, max 0,71 → 0,30 garde la branche pour
 *   les passages réellement clairs (~12 % du corpus). Alternative : 0,35.
 * - densité : médiane 5,1 attaques/s, p75 5,3 → 5,2 ne garde que les passages
 *   les plus denses (~9 %). Alternative : 4,0 (~35 %), qui étouffe la branche
 *   énergie.
 * - énergie : inchangée (0,62) : elle sépare nettement les deux modes du
 *   corpus (médiane 0,72, aucune scène entre 0,55 et 0,68).
 */
export const BRIGHTNESS_THRESHOLD = 0.3;
export const DENSITY_THRESHOLD = 5.2;
export const ENERGY_THRESHOLD = 0.62;
export const CALM_ENERGY_THRESHOLD = 0.22;
/** Densité sous laquelle le mode réduit reste dans les familles calmes. */
export const REDUCED_DENSITY_THRESHOLD = 0.6;
/** Énergie sous laquelle une scène est franchement calme (humeur). */
export const MOOD_CALM_ENERGY_THRESHOLD = 0.3;

/** Métrique validée : 3 ou 4, avec 4 comme hypothèse par défaut.
 *
 * `meter` reste la valeur utilisée (contrat v3.1) ; `meterConfidence` est une
 * information de confiance que le plan n'utilise pas pour changer la métrique.
 */
export function meterOf(analysis: Analysis): 3 | 4 {
  return analysis.meter === 3 ? 3 : 4;
}

/** Nombre de temps par cycle « vers » (quatre mesures de la métrique). */
export function cycleBeats(analysis: Analysis): number {
  return meterOf(analysis) * BARS_PER_CYCLE;
}

export interface Caractere {
  energy: number;
  density: number;
  brightness: number;
}

/** Caractère d'un intervalle : énergie, densité d'attaques, brillance spectrale. */
export function caractereAt(analysis: Analysis, start: number, end: number): Caractere {
  const span = Math.max(end - start, 1e-6);
  const energies: number[] = [];
  const highs: number[] = [];
  for (const [time, value] of analysis.energy) {
    if (time >= start && time <= end) energies.push(value);
  }
  for (const [time, value] of analysis.high) {
    if (time >= start && time <= end) highs.push(value);
  }
  const onsets = analysis.onsets.filter((onset) => onset >= start && onset < end).length;
  return {
    energy: energies.length > 0 ? energies.reduce((sum, value) => sum + value, 0) / energies.length : 0.3,
    density: onsets / span,
    // Moyenne et non somme : `high` est déjà une courbe 0..1 à 20 Hz. Une
    // somme sur une fenêtre de 8 s valait ~1 quel que soit le morceau, donc
    // la branche « brillance » était toujours prise. Une fenêtre vide retombe
    // sur le milieu de l'échelle, comme pour l'énergie.
    brightness:
      highs.length > 0 ? clamp01(highs.reduce((sum, value) => sum + value, 0) / highs.length) : 0.5,
  };
}

/**
 * Une frontière de cycle n'est retenue que si le caractère change vraiment.
 *
 * Sans ce filtre, 85 % des frontières réelles étaient des retours de cycle :
 * la lumière changeait au métronome, pas au rythme de la musique. Les écarts
 * sont calibrés sur le corpus réel (voir le rapport de la vague 1).
 */
export const CYCLE_ENERGY_DELTA = 0.3;
export const CYCLE_DENSITY_DELTA = 3.0;
export const CYCLE_BRIGHTNESS_DELTA = 0.22;
/** Fenêtre de comparaison de part et d'autre d'une frontière de cycle. */
export const CYCLE_COMPARE_WINDOW = 4;
/**
 * Durée maximale d'une scène, en secondes.
 *
 * Même quand le caractère ne change pas, une scène ne doit pas durer une
 * minute sur un morceau qui évolue : au-delà de 12 s, on coupe sur le temps
 * fort le plus proche (raison `beat`) ou sur le cycle suivant s'il est déjà
 * retenu. 12 s est la valeur qui tient la médiane réelle dans la fenêtre
 * 8–20 s tout en laissant une nappe respirer deux mesures.
 */
export const MAX_SCENE_SPAN = 12;

/**
 * Barres de mesure : temps forts tous les `cycleBeats`, et temps forts seuls
 * en dernier recours. C'est la grille rythmique sur laquelle le spectacle
 * pourra accrocher ses changements.
 */
export function barStarts(analysis: Analysis): number[] {
  const beats = analysis.beats;
  const beatPeriod = analysis.beatPeriod > 0 ? analysis.beatPeriod : 0.5;
  const cycle = cycleBeats(analysis);
  const step = beatPeriod * cycle;
  if (beats.length === 0 || step <= 0) {
    // Aucun temps fort détecté : on retombe sur une grille régulière pour que le
    // spectacle ait quand même des repères.
    const regular: number[] = [];
    for (let t = 0; t < analysis.duration; t += step > 0 ? step : 8) regular.push(t);
    return regular;
  }
  const out: number[] = [];
  for (let index = 0; index < beats.length; index += cycle) {
    const beat = beats[index];
    if (beat !== undefined) out.push(beat);
  }
  return out.length > 0 ? out : beats.filter((_, index) => index % cycle === 0);
}

/**
 * Permutation déterministe d'un réservoir, dérivée de la graine.
 *
 * Fisher-Yates avec `hash01` : aucun `Math.random`, donc deux lectures du même
 * morceau donnent exactement la même suite. On parcourt ensuite la permutation
 * en séquence au lieu de prendre `list[tour % longueur]`, qui ne dépendait que
 * du rang et ignorait complètement la graine.
 */
function permuteFamilies(list: readonly FamilyId[], seed: number): FamilyId[] {
  const out = [...list];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const other = Math.floor(hash01(seed + index * 7919.17) * (index + 1));
    const current = out[index]!;
    out[index] = out[other]!;
    out[other] = current;
  }
  return out;
}

/**
 * Famille tirée dans un réservoir pour le rang `turn`.
 *
 * La suite suit la permutation de la graine, en sautant les familles
 * `excluded` (les scènes précédentes). Si le réservoir est entièrement exclu,
 * on retombe sur le premier élément de la permutation : le plan reste défini.
 */
function pickFamily(
  list: readonly FamilyId[],
  seed: number,
  turn: number,
  excluded: readonly FamilyId[] = [],
  used?: ReadonlyMap<FamilyId, number>,
): FamilyId {
  const order = permuteFamilies(list, seed + list.length * 104_729);
  const start = ((Math.floor(turn) % order.length) + order.length) % order.length;
  // L'appelant place toujours la couche de fond en tête : elle ne doit jamais
  // devenir la famille principale. Les scènes précédentes suivent, et
  // l'avant-dernière n'est écartée que sur les réservoirs assez grands — sur
  // une liste de trois ou quatre, trois exclusions tueraient le tirage.
  const blocked = excluded.slice(0, order.length >= 5 ? 3 : 2);
  const candidates: FamilyId[] = [];
  for (let step = 0; step < order.length; step += 1) {
    const candidate = order[(start + step) % order.length]!;
    if (!blocked.includes(candidate)) candidates.push(candidate);
  }
  if (candidates.length === 0) return order[start] ?? list[0] ?? "beams";
  if (used === undefined) return candidates[0]!;
  // Couverture : à égalité de rareté, l'ordre de la permutation décide. Un
  // morceau découpé en moins de scènes doit quand même passer par toutes les
  // familles de son réservoir avant d'en répéter une.
  let best = candidates[0]!;
  let bestCount = used.get(best) ?? 0;
  for (const candidate of candidates.slice(1)) {
    const count = used.get(candidate) ?? 0;
    if (count < bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Branche de `familyFor` pour un caractère, un rôle et un mode donnés.
 *
 * `concertDrop` dit qu'un impact déploie le plateau : c'est une décision du
 * plan (`role === "drop"` hors mode réduit), pas du caractère de la scène.
 * Aucun seuil n'est recopié ailleurs : le rapport de mesure appelle cette
 * fonction, donc il ne peut pas diverger de la production.
 */
export function familyBranchFor(
  caractere: Caractere,
  reduced: boolean,
  role: SceneRole,
  concertDrop = false,
  calm?: boolean,
  pont = false,
): FamilyBranch {
  const { energy, density, brightness } = caractere;
  if (reduced) {
    if (energy < CALM_ENERGY_THRESHOLD) return "reduit-calme";
    if (density < REDUCED_DENSITY_THRESHOLD) return "reduit-calme";
    return "reduit-rythmique";
  }
  if (concertDrop) return "drop";
  // Orchestration par rôle : un refrain alterne lyres et barres LED, une
  // montée déploie franchement la vague des barres. Un pont est une rupture :
  // il puise hors du réservoir des refrains.
  if (pont) return "pont";
  if (role === "refrain") return "refrain";
  if (role === "montee") return "montee";
  // L'humeur finale fait foi : une scène lissée en « calme » par l'hystérésis
  // reste dans un réservoir calme, même si son énergie frôle le seuil.
  if (calm ?? energy < CALM_ENERGY_THRESHOLD) return "calme";
  if (brightness > BRIGHTNESS_THRESHOLD) return "brillance";
  if (density > DENSITY_THRESHOLD) return "densite";
  if (energy > ENERGY_THRESHOLD) return "energie";
  return "general";
}

/**
 * Famille déduite du caractère musical.
 *
 * Le rôle de la scène choisit la famille de concert : ballyhoo des lyres en
 * refrain, vague des barres en montée. Les autres rôles gardent les réservoirs
 * historiques, où les trois familles concert restent disponibles. Le tirage
 * dans un réservoir est déterministe (permutation de la graine) et exclut les
 * familles des scènes précédentes : deux scènes voisines ne se ressemblent pas.
 */
export function familyFor(
  caractere: Caractere,
  reduced: boolean,
  seed: number,
  turn: number,
  role: SceneRole,
  excluded: readonly FamilyId[] = [],
  calm?: boolean,
  used?: ReadonlyMap<FamilyId, number>,
  pont = false,
): FamilyId {
  const branch = familyBranchFor(caractere, reduced, role, false, calm, pont);
  if (branch === "refrain") {
    return Math.floor(turn) % 2 === 0 ? "lyres-suspendues" : "barres-led";
  }
  if (branch === "montee") return "barres-led";
  return pickFamily(FAMILY_BRANCH_RESERVOIRS[branch], seed, turn, excluded, used);
}

/**
 * Confiance minimale d'une section pour que le plan lui fasse confiance.
 *
 * En dessous, la section est traitée comme avant la v3 : aucun rôle refrain ou
 * pont, aucune humeur forcée. Une mauvaise détection ne dégrade donc rien.
 */
export const MIN_SECTION_CONFIDENCE = 0.5;

/** Confiance d'une section (1 pour une section historique sans `confidence`). */
export function sectionConfidence(section: Section | null): number {
  if (section === null) return 0;
  return section.confidence ?? 1;
}

export function isReliableSection(section: Section | null): boolean {
  return section !== null && sectionConfidence(section) >= MIN_SECTION_CONFIDENCE;
}

/** Section de silence fiable (kind v3 ou label historique). */
export function isSilenceSection(section: Section | null): boolean {
  if (!isReliableSection(section) || section === null) return false;
  return section.kind === "silence" || section.label === "silence";
}

/** Clé stable d'un groupe de matériau (`group` peut être une chaîne ou un entier). */
export function groupKeyOf(section: Section | null): string {
  const group = section?.group;
  if (group === undefined || group === null || group === "") return "";
  return String(group);
}

/**
 * L'analyse porte-t-elle un découpage v3 exploitable ?
 *
 * On se fie à la présence de `confidence`, d'un `kind` structurel ou d'un
 * `group` non vide. Les analyses historiques (une section globale
 * `kind: "section"`, aucun champ v3) gardent exactement le plan de la vague 2.
 */
export function hasStructuredAnalysis(analysis: Analysis): boolean {
  return analysis.sections.some(
    (section) =>
      section.confidence !== undefined ||
      (section.kind !== undefined && section.kind !== "section") ||
      (section.group !== undefined && section.group !== ""),
  );
}

/**
 * Rôle dramaturgique d'une scène.
 *
 * La fin d'une montée est toujours un `drop`, même si elle tombe au milieu d'un
 * refrain : c'est l'impact qui commande la lumière à cet instant. Les sections
 * identifiées par le serveur (intro, couplet, refrain, pont, silence, outro)
 * gardent ensuite leur rôle du début à la fin, **si** leur confiance atteint
 * `MIN_SECTION_CONFIDENCE`.
 */
function roleFor(
  section: Section | null,
  reason: SceneReason,
  index: number,
  dramaturgy: boolean,
): SceneRole {
  if (reason === "build") return "drop";
  if (dramaturgy && isReliableSection(section) && section !== null) {
    if (section.kind === "intro") return "intro";
    if (section.kind === "refrain") return "refrain";
    if (section.kind === "couplet") return "couplet";
    if (section.kind === "outro") return "finale";
    if (section.kind === "pont") return "montee";
    if (section.kind === "silence") return "finale";
    if (section.label === "montee") return "montee";
    if (section.label === "descente" || section.label === "silence") return "finale";
  }
  if (reason === "ouverture" || index === 0) return "intro";
  return "couplet";
}

const DROP_LYRES: readonly DropLyres[] = ["convergence", "croisee", "eventail"];
const DROP_BARRES: readonly DropBarres[] = ["onde", "rideau", "alterne"];
const DROP_BLINDERS: readonly DropBlinders[] = ["tous", "un-sur-deux", "chenillard"];
/**
 * Signature déterministe d'un drop.
 *
 * La combinaison (3 orientations × 3 barres × 3 motifs × 2 teintes = 54) est
 * tirée de `hashString(graine|rang|force)`. `attempt` sert uniquement à
 * écarter une combinaison déjà utilisée par un drop trop proche : le résultat
 * reste une fonction pure de ses arguments.
 */
export function dropSignature(
  seed: number,
  rank: number,
  strength: number,
  attempt = 0,
): DropSignature {
  const base = hashString(`${seed}|drop|${rank}|${strength.toFixed(3)}|${attempt}`);
  const combo = Math.floor(hash01(base) * DROP_LYRES.length * DROP_BARRES.length * DROP_BLINDERS.length * 2);
  return {
    lyres: DROP_LYRES[combo % DROP_LYRES.length]!,
    barres: DROP_BARRES[Math.floor(combo / DROP_LYRES.length) % DROP_BARRES.length]!,
    blinders:
      DROP_BLINDERS[Math.floor(combo / (DROP_LYRES.length * DROP_BARRES.length)) % DROP_BLINDERS.length]!,
    hue: Math.floor(combo / (DROP_LYRES.length * DROP_BARRES.length * DROP_BLINDERS.length)) % 2 === 0
      ? "accent"
      : "contraste",
  };
}

/** Clé stable d'une signature, pour garantir l'unicité dans un plan. */
function signatureKey(signature: DropSignature): string {
  return `${signature.lyres}/${signature.barres}/${signature.blinders}/${signature.hue}`;
}

/**
 * Nombre de composantes qui diffèrent entre deux signatures : lyres, barres,
 * blinders, teinte.
 *
 * Une simple unicité ne suffit pas : deux drops peuvent ne changer que d'un
 * seul paramètre et se lire comme le même geste. On exige donc au moins deux
 * composantes différentes entre deux drops consécutifs (voir la boucle
 * d'`attempt` dans `buildShowPlan`).
 */
function signatureDistance(left: DropSignature, right: DropSignature): number {
  return (
    (left.lyres !== right.lyres ? 1 : 0) +
    (left.barres !== right.barres ? 1 : 0) +
    (left.blinders !== right.blinders ? 1 : 0) +
    (left.hue !== right.hue ? 1 : 0)
  );
}

/**
 * Force minimale pour qu'un impact déploie le pont concert.
 *
 * Calibré sur le corpus réel (vague 2) : le p67 des forces de drop vaut 1,00,
 * mais treize drops s'y agglutinent — un simple seuil sur la force rendrait
 * encore le pont majoritaire. 0,98 est la force du climax le plus faible du
 * corpus (Shine On). Le seuil ne décide donc que des morceaux à un seul drop :
 * dès qu'un morceau a plusieurs impacts, seul son climax peut prendre le pont
 * (voir `buildShowPlan`).
 */
export const DROP_PONT_STRENGTH_THRESHOLD = 0.98;

/**
 * Saturation d'une humeur. Le spectacle doit éclairer une salle : les passages
 * forts sont franchement saturés, les passages calmes se permettent une couleur
 * plus retenue (mais jamais grise — c'est une soirée, pas un aquarium).
 */
function paletteSaturation(mood: Mood): number {
  if (mood === "sombre") return 0.55;
  if (mood === "calme") return 0.62;
  if (mood === "aerien") return 0.8;
  if (mood === "explosif") return 0.96;
  if (mood === "pulse") return 0.9;
  return 0.84;
}

/**
 * Luminosité d'une humeur. Les moments forts montent près du blanc — c'est ce
 * qui « allume la salle » — et les passages calmes ou juste avant un drop
 * restent sombres, pour que l'impact se voie.
 */
function paletteLightness(mood: Mood): number {
  if (mood === "sombre") return 0.38;
  if (mood === "calme") return 0.44;
  if (mood === "aerien") return 0.62;
  if (mood === "explosif") return 0.76;
  if (mood === "pulse") return 0.68;
  return 0.6;
}

/**
 * Seuil de brillance de l'humeur aérienne.
 *
 * Recalibré sur le corpus réel **hors scènes de drop** (chantier humeur) : la
 * médiane de brillance y vaut 0,244 et le p70 0,392. 0,40 réserve « aérien »
 * aux passages réellement clairs (~2 % des scènes) ; plus bas, les scènes
 * modérément lumineuses basculeraient en aérien et « pulse » disparaîtrait.
 * L'ancien 0,09 (calibré sur une échelle faussée) rendait aérien presque tout
 * ce qui n'était ni calme ni explosif.
 */
export const MOOD_BRIGHTNESS_THRESHOLD = 0.4;

/**
 * Plancher absolu de l'humeur explosive.
 *
 * L'énergie relative au morceau (quantile) suffit à répartir les humeurs, mais
 * un morceau entièrement calme ne doit pas devenir explosif à son pic : en
 * dessous de ce plancher, aucune scène n'est explosive, quel que soit son rang.
 * 0,62 est l'ancien seuil absolu, conservé comme garde-fou.
 */
export const MOOD_EXPLOSIVE_FLOOR = 0.62;
/** Quantile d'énergie du morceau au-dessus duquel une scène est explosive. */
export const MOOD_EXPLOSIVE_QUANTILE = 0.68;
/**
 * Plafond absolu de l'humeur calme.
 *
 * Le rang dans le morceau décide du calme (une scène plus douce que les autres
 * l'est), mais une scène reste « calme » seulement sous ce plafond : un morceau
 * fort de bout en bout n'a pas de passage calme simplement parce qu'il est le
 * moins fort du lot.
 */
export const MOOD_CALM_ENERGY_CEILING = 0.62;
/** Quantile d'énergie du morceau sous lequel une scène est calme. */
export const MOOD_CALM_QUANTILE = 0.4;
/**
 * Écart d'énergie sous lequel deux scènes voisines gardent la même humeur.
 *
 * Sans cette marge, deux scènes quasi identiques (écart de bruit sur la mesure
 * d'énergie) pouvaient basculer d'humeur de part et d'autre d'un seuil. Le
 * lissage ne s'applique qu'aux humeurs déduites du caractère : un impact de
 * montée ou un refrain forcé n'est jamais absorbé.
 */
export const MOOD_HYSTERESIS_ENERGY_GAP = 0.05;

/** Seuils d'énergie effectifs d'un morceau, résolus par ses scènes. */
export interface MoodThresholds {
  explosive: number;
  calm: number;
}

/** Bornes absolues historiques : utilisées seules par `moodFor`. */
export const DEFAULT_MOOD_THRESHOLDS: MoodThresholds = {
  explosive: ENERGY_THRESHOLD,
  calm: MOOD_CALM_ENERGY_THRESHOLD,
};

/** Percentile par interpolation linéaire (même définition que le rapport). */
function quantile(values: readonly number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * ratio;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  const a = sorted[low] ?? 0;
  const b = sorted[high] ?? a;
  return a + (b - a) * (position - low);
}

/**
 * Seuils d'humeur d'un morceau, à partir de l'énergie de ses scènes.
 *
 * Fonction pure et déterministe : la même liste d'énergies donne les mêmes
 * bornes. Le rapport de mesure l'appelle avec les mêmes intervalles que le plan
 * (les scènes produites), donc il ne peut pas diverger des humeurs réelles.
 */
export function moodThresholdsFor(energies: readonly number[]): MoodThresholds {
  return {
    explosive: Math.max(MOOD_EXPLOSIVE_FLOOR, quantile(energies, MOOD_EXPLOSIVE_QUANTILE)),
    calm: Math.min(MOOD_CALM_ENERGY_CEILING, quantile(energies, MOOD_CALM_QUANTILE)),
  };
}

/**
 * Branche de `moodFor` (overrides du site d'appel compris).
 *
 * Exportée pour l'instrumentation, comme `familyBranchFor` : le rapport
 * recompte l'humeur avec le même arbre que la production.
 */
export const MOOD_BRANCHES = [
  "build-explosif",
  "refrain-explosif",
  "silence-sombre",
  "montee-pulse",
  "energie-explosif",
  "calme",
  "brillance-aerien",
  "pulse",
] as const;
export type MoodBranch = (typeof MOOD_BRANCHES)[number];

/** Humeur produite par chaque branche. */
export const MOOD_OF_BRANCH: Record<MoodBranch, Mood> = {
  "build-explosif": "explosif",
  "refrain-explosif": "explosif",
  "silence-sombre": "sombre",
  "montee-pulse": "pulse",
  "energie-explosif": "explosif",
  calme: "calme",
  "brillance-aerien": "aerien",
  pulse: "pulse",
};

export function moodBranchFor(
  reason: SceneReason,
  section: Section | null,
  caractere: Caractere,
  reduced: boolean,
  thresholds: MoodThresholds = DEFAULT_MOOD_THRESHOLDS,
  dramaturgy = false,
): MoodBranch {
  if (reason === "build") return "build-explosif";
  const sain = dramaturgy && isReliableSection(section);
  if (sain && !reduced && section?.kind === "refrain") return "refrain-explosif";
  if (sain && isSilenceSection(section)) return "silence-sombre";
  if (sain && section?.label === "montee") return "montee-pulse";
  if (caractere.energy > thresholds.explosive) return "energie-explosif";
  if (caractere.energy <= thresholds.calm) return "calme";
  if (caractere.brightness > MOOD_BRIGHTNESS_THRESHOLD) return "brillance-aerien";
  return "pulse";
}

/** Humeur d'une scène : overrides (impact, refrain) puis caractère musical. */
export function moodForScene(
  reason: SceneReason,
  section: Section | null,
  caractere: Caractere,
  reduced: boolean,
  thresholds: MoodThresholds = DEFAULT_MOOD_THRESHOLDS,
  dramaturgy = false,
): Mood {
  return MOOD_OF_BRANCH[moodBranchFor(reason, section, caractere, reduced, thresholds, dramaturgy)];
}

/** Segment mesuré avant décision d'humeur (instrumentation et production). */
export interface MoodSegment {
  reason: SceneReason;
  section: Section | null;
  caractere: Caractere;
}

/**
 * Humeurs de tous les segments d'un morceau, lissage d'hystérésis compris.
 *
 * Fonction partagée par le plan et le rapport : les deux appliquent exactement
 * la même séquence, donc aucune divergence possible. Les humeurs forcées
 * (impact de montée, refrain hors mode réduit) ne sont ni absorbées ni
 * propagées.
 */
export function resolveMoods(
  segments: readonly MoodSegment[],
  reduced: boolean,
  thresholds: MoodThresholds,
  dramaturgy = false,
): Mood[] {
  const base = segments.map((segment) =>
    moodForScene(segment.reason, segment.section, segment.caractere, reduced, thresholds, dramaturgy),
  );
  const moods = [...base];
  const adjusted = Array.from({ length: base.length }, () => false);
  const forced = (segment: MoodSegment) =>
    segment.reason === "build" ||
    (dramaturgy && isSilenceSection(segment.section)) ||
    (dramaturgy &&
      !reduced &&
      isReliableSection(segment.section) &&
      segment.section?.kind === "refrain");
  for (let index = 1; index < segments.length; index += 1) {
    const current = segments[index]!;
    const previous = segments[index - 1]!;
    if (forced(current) || forced(previous)) continue;
    if (base[index] === base[index - 1]) continue;
    // Le lissage ne se propage pas : une scène déjà alignée sur sa voisine ne
    // fige pas la suivante. Sans cette garde, une rampe douce (écart < 0,05 à
    // chaque pas) resterait sur la même humeur du début à la fin.
    if (adjusted[index - 1] === true) continue;
    if (
      Math.abs(current.caractere.energy - previous.caractere.energy) <
      MOOD_HYSTERESIS_ENERGY_GAP
    ) {
      moods[index] = moods[index - 1]!;
      adjusted[index] = true;
    }
  }
  return moods;
}

/** Humeur absolue historique : sans le rang dans le morceau. */
export function moodFor(caractere: Caractere, label: string): Mood {
  if (label === "silence") return "sombre";
  if (label === "montee") return "pulse";
  if (caractere.energy > ENERGY_THRESHOLD) return "explosif";
  // Un passage vraiment calme reste sombre : c'est le creux qui rend l'impact
  // lisible, et ça repose la salle entre deux montées. L'aérien est réservé aux
  // passages modérés mais clairs dans le spectre.
  if (caractere.energy < MOOD_CALM_ENERGY_THRESHOLD) return "calme";
  if (caractere.brightness > MOOD_BRIGHTNESS_THRESHOLD) return "aerien";
  return "pulse";
}

function moodIntensity(mood: Mood, energy: number): number {
  switch (mood) {
    case "explosif":
      return 0.78 + 0.22 * energy;
    case "pulse":
      return 0.5 + 0.3 * energy;
    case "aerien":
      return 0.28 + 0.2 * energy;
    case "calme":
      return 0.24 + 0.16 * energy;
    case "sombre":
      return 0.1;
  }
}

/**
 * Le caractère change-t-il assez autour de `time` pour justifier une scène ?
 *
 * On compare une fenêtre avant et une fenêtre après la frontière. Le moindre
 * des trois écarts (énergie, densité, brillance) suffit : une nappe qui devient
 * soudain dense change de scène même si son énergie moyenne bouge peu.
 */
function cycleChangesCharacter(analysis: Analysis, time: number, lastKept: number): boolean {
  const beforeStart = Math.max(lastKept, time - CYCLE_COMPARE_WINDOW);
  const afterEnd = Math.min(analysis.duration, time + CYCLE_COMPARE_WINDOW);
  if (time - beforeStart < 1 || afterEnd - time < 1) return true;
  // Pas assez de mesures pour juger : on conserve la frontière plutôt que de
  // fusionner à l'aveugle. C'est ce qui garde la grille de secours utilisable
  // sur une analyse pauvre (courbes absentes ou très échantillonnées).
  const enough = (start: number, end: number) => {
    let energy = 0;
    let high = 0;
    for (const [sample] of analysis.energy) if (sample >= start && sample <= end) energy += 1;
    for (const [sample] of analysis.high) if (sample >= start && sample <= end) high += 1;
    return energy >= 2 && high >= 2;
  };
  if (!enough(beforeStart, time) || !enough(time, afterEnd)) return true;
  const before = caractereAt(analysis, beforeStart, time);
  const after = caractereAt(analysis, time, afterEnd);
  return (
    Math.abs(after.energy - before.energy) >= CYCLE_ENERGY_DELTA ||
    Math.abs(after.density - before.density) >= CYCLE_DENSITY_DELTA ||
    Math.abs(after.brightness - before.brightness) >= CYCLE_BRIGHTNESS_DELTA
  );
}

/**
 * Espacement minimal entre deux bass-return (contrat v3).
 *
 * Deux retours de basses trop rapprochés ne se lisent pas comme deux
 * événements : le second paraît redondant et fait clignoter le plan.
 */
export const MIN_BASS_RETURN_SPACING = 8;
/** Distance minimale entre un bass-return et la fin d'une montée (contrat v3). */
export const BASS_RETURN_BUILD_CLEARANCE = 2;
/**
 * Bonus de fusion d'un bass-return, volontairement inférieur à celui d'un
 * impact (`build` × 1,25). À 5 s d'une frontière, un impact reste prioritaire.
 */
export const BASS_RETURN_MERGE_BONUS = 1.15;
/** Durée minimale d'une scène de silence (contrat v3). */
export const MIN_SILENCE_SPAN = 1.5;

/** Événement interne de frontière, avec son drapeau silence. */
interface BoundaryEvent {
  time: number;
  reason: SceneReason;
  weight: number;
  silence?: boolean;
}

/** Score de fusion : l'impact d'abord, le bass-return ensuite, le reste après. */
function boundaryScore(candidate: Pick<BoundaryEvent, "weight" | "reason">): number {
  if (candidate.reason === "build") return candidate.weight * 1.25;
  if (candidate.reason === "bass-return") return candidate.weight * BASS_RETURN_MERGE_BONUS;
  return candidate.weight;
}

/**
 * Écart minimal entre deux frontières, silence compris.
 *
 * Une section de silence peut durer 1,5 s : la fusion à 5 s ne doit pas
 * l'avaler. Dès qu'un des deux événements est un silence, le plancher du
 * contrat s'applique.
 */
function boundaryMinGap(previous: BoundaryEvent, event: BoundaryEvent): number {
  return previous.silence === true || event.silence === true ? MIN_SILENCE_SPAN : MIN_SCENE_SPAN;
}

/**
 * Événements qui justifient un changement complet d'ambiance, triés dans le temps.
 *
 * Un changement de famille + palette n'arrive QUE sur l'un d'eux : rien ne se
 * déclenche « au hasard » au milieu d'un passage. Les frontières de section,
 * d'impact et de bass-return sont conservées ; une frontière de cycle ne l'est
 * que si le caractère change. Le plafond `MAX_SCENE_SPAN` est ensuite tenu par
 * une coupure sur le temps fort (`beat`), jamais par un cycle arbitraire.
 *
 * Le bass-return ne crée jamais de `drop` : son rôle est décidé par la section
 * locale, comme n'importe quelle autre frontière.
 */
function sceneBoundaries(analysis: Analysis): BoundaryEvent[] {
  const duration = Math.max(analysis.duration, 0.001);
  const fixed: BoundaryEvent[] = [
    { time: 0, reason: "ouverture", weight: 1 },
    { time: duration, reason: "finale", weight: 0 },
  ];

  for (const section of analysis.sections) {
    // Le plancher de 1,5 s ne s'applique qu'à un silence **V3.1** explicitement
    // typé : une analyse historique (label `silence`, sans `kind: "silence"`)
    // garde la fusion à 5 s de la vague 2, sinon son plan change octet pour
    // octet. Le poids 0,4 reste, lui, attaché au label historique.
    const silence = isReliableSection(section) && section?.kind === "silence";
    const legacySilence = section.label === "silence";
    fixed.push({
      time: section.start,
      reason: "section",
      weight: legacySilence || silence ? 0.4 : 1,
      ...(silence ? { silence: true } : {}),
    });
  }

  // Fin de chaque montée : c'est l'impact, l'événement le plus spectaculaire.
  for (const build of analysis.builds) {
    fixed.push({ time: build.end, reason: "build", weight: build.strength });
  }

  // Retours de basses du contrat v3 : frontières admises, poids = force. On
  // applique les gardes du contrat même si l'analyse les a déjà respectées :
  // un producteur fautif ne doit pas pouvoir fabriquer un plan incohérent.
  const buildEnds = analysis.builds.map((build) => build.end);
  let lastBassReturn = Number.NEGATIVE_INFINITY;
  const bassReturns = [...(analysis.events ?? [])]
    .filter((event) => event.kind === "bass-return")
    .filter((event) => Number.isFinite(event.t) && event.t > 0.01 && event.t < duration - 0.01)
    .sort((left, right) => left.t - right.t);
  for (const event of bassReturns) {
    if (event.t - lastBassReturn < MIN_BASS_RETURN_SPACING) continue;
    if (buildEnds.some((end) => Math.abs(event.t - end) < BASS_RETURN_BUILD_CLEARANCE)) continue;
    fixed.push({ time: event.t, reason: "bass-return", weight: clamp01(event.strength) });
    lastBassReturn = event.t;
  }

  const cycles: BoundaryEvent[] = [];
  for (const bar of barStarts(analysis)) {
    if (bar > 0.01 && bar < duration - 0.01) cycles.push({ time: bar, reason: "cycle", weight: 0.5 });
  }

  fixed.sort((left, right) => left.time - right.time);
  cycles.sort((left, right) => left.time - right.time);

  // Fusion des événements fixes entre eux, puis insertion des cycles retenus
  // dans l'ordre : c'est `lastKept` qui mesure la durée de la scène courante.
  const keptFixed: BoundaryEvent[] = [];
  for (const event of fixed) {
    const previous = keptFixed[keptFixed.length - 1];
    if (previous !== undefined && event.time - previous.time < boundaryMinGap(previous, event)) {
      if (boundaryScore(event) > boundaryScore(previous)) keptFixed[keptFixed.length - 1] = event;
      continue;
    }
    keptFixed.push(event);
  }

  const events: BoundaryEvent[] = [];
  let lastKept = Number.NEGATIVE_INFINITY;
  let cycleIndex = 0;
  for (const event of keptFixed) {
    // Les cycles tombés avant cet événement fixe sont évalués dans l'ordre.
    while (cycleIndex < cycles.length && cycles[cycleIndex]!.time < event.time) {
      const cycle = cycles[cycleIndex]!;
      cycleIndex += 1;
      if (cycle.time - lastKept < MIN_SCENE_SPAN) continue;
      if (cycleChangesCharacter(analysis, cycle.time, lastKept)) {
        events.push(cycle);
        lastKept = cycle.time;
      }
    }
    events.push(event);
    lastKept = event.time;
  }

  // Deux événements trop rapprochés n'en font qu'un : on garde le plus
  // marquant, sinon une scène durerait une fraction de seconde. Les impacts de
  // montée l'emportent toujours ; un bass-return l'emporte sur une section
  // ordinaire, mais jamais sur un impact.
  const merged: BoundaryEvent[] = [];
  for (const event of events) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && event.time - previous.time < boundaryMinGap(previous, event)) {
      if (boundaryScore(event) > boundaryScore(previous)) merged[merged.length - 1] = event;
      continue;
    }
    merged.push(event);
  }

  // Garde-fou de durée : si aucun événement ne tombe dans la limite (trous de
  // détection, section globale), on coupe sur le temps fort le plus proche. La
  // raison est `beat` : c'est une nouvelle mesure, pas un retour de cycle, et
  // c'est ce qui empêche une scène de durer une minute.
  const capped: BoundaryEvent[] = [];
  let previousTime = Number.NEGATIVE_INFINITY;
  for (const event of merged) {
    let anchor = previousTime;
    while (event.time - anchor > MAX_SCENE_SPAN + MIN_SCENE_SPAN) {
      const target = anchor + MAX_SCENE_SPAN;
      let time = target;
      for (const beat of analysis.beats) {
        if (beat > anchor + MIN_SCENE_SPAN && beat <= target) time = beat;
      }
      if (!(time > anchor + MIN_SCENE_SPAN)) break;
      capped.push({ time, reason: "beat", weight: 0.5 });
      anchor = time;
    }
    capped.push(event);
    previousTime = event.time;
  }
  return capped;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Écart signé le plus court entre deux teintes, dans ]-180, 180]. */
function hueDelta(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

/** Ramène une teinte dans la fenêtre ±spread de son ancre. */
function clampToAnchor(hue: number, anchor: number, spread: number): number {
  const delta = hueDelta(anchor, hue);
  const borne = Math.max(0, Math.min(spread, Math.abs(delta)));
  return (anchor + (delta >= 0 ? borne : -borne) + 360) % 360;
}

/**
 * Choisit une teinte qui respecte à la fois le budget de l'ancre et l'écart
 * minimal avec la scène précédente.
 *
 * L'ordre est celui du contrat : l'écart gagne sur le clamp. Si décaler la
 * teinte dans la fenêtre de l'ancre préféré ne suffit pas, on bascule sur
 * l'autre pôle du morceau (ancre ↔ complémentaire) plutôt que de réduire
 * l'écart.
 */
function hueWithGap(
  anchor: number,
  otherAnchor: number,
  derive: number,
  previousHue: number,
  spread: number,
): { hue: number; anchor: number } {
  const step = minHueStepEff(spread);
  const candidate = (anchor + derive + 360) % 360;
  if (Math.abs(hueDelta(previousHue, candidate)) >= step) {
    return { hue: clampToAnchor(candidate, anchor, spread), anchor };
  }

  // Même ancre : on pousse la teinte du côté qui s'éloigne de la précédente.
  const direction = hueDelta(previousHue, candidate) >= 0 ? 1 : -1;
  const pushed = clampToAnchor((candidate + direction * step + 360) % 360, anchor, spread);
  if (Math.abs(hueDelta(previousHue, pushed)) >= step) {
    return { hue: pushed, anchor };
  }

  // L'écart gagne : on change d'ancre (l'autre pôle du morceau).
  const switched = (otherAnchor + derive + 360) % 360;
  const switchedDirection = hueDelta(previousHue, switched) >= 0 ? 1 : -1;
  const switchedPushed = clampToAnchor(
    (switched + switchedDirection * step + 360) % 360,
    otherAnchor,
    spread,
  );
  if (Math.abs(hueDelta(previousHue, switchedPushed)) >= step) {
    return { hue: switchedPushed, anchor: otherAnchor };
  }

  // Repli mesuré : on garde la solution qui offre le plus grand écart réel.
  const same = clampToAnchor(candidate, anchor, spread);
  const other = clampToAnchor(switched, otherAnchor, spread);
  return Math.abs(hueDelta(previousHue, same)) >= Math.abs(hueDelta(previousHue, other))
    ? { hue: same, anchor }
    : { hue: other, anchor: otherAnchor };
}

/** Options du plan de spectacle. */
export interface ShowPlanOptions {
  /**
   * Réveille la dramaturgie portée par les sections (intro, couplet, refrain,
   * montée, pont, outro) et les labels `montee` / `silence`.
   *
   * Désactivée par défaut : l'analyseur ne produit qu'une section globale, et
   * une étiquette globale ne doit jamais figer le rôle d'une scène locale. Le
   * code reste vivant, testé avec une analyse synthétique à sections, pour le
   * jour où le serveur rendra un vrai découpage.
   */
  dramaturgy?: boolean;
}

/**
 * Compose le spectacle à partir de la structure du morceau.
 *
 * Chaque scène commence sur un **événement musical détecté** (changement de
 * section, fin de montée, retour de cycle, temps fort) et dure jusqu'au
 * suivant. Sa famille, son humeur et son intensité découlent du caractère de
 * l'intervalle — jamais d'un tirage au sort.
 *
 * Fonction pure : même analyse + même mode ⇒ même plan.
 */
export function buildShowPlan(
  analysis: Analysis,
  reduced: boolean,
  seedOverride?: number,
  options: ShowPlanOptions = {},
): ShowPlan {
  const dramaturgy = options.dramaturgy ?? hasStructuredAnalysis(analysis);
  const seed =
    seedOverride ??
    hashString(`${analysis.duration.toFixed(2)}|${analysis.tempo.toFixed(3)}|${analysis.beats.length}`);
  const duration = Math.max(analysis.duration, 0.001);
  const events = sceneBoundaries(analysis);
  // Identité du morceau : tirée du morceau lui-même, donc stable d'une lecture à
  // l'autre, et tenue du premier au dernier plan.
  const track = TRACK_PALETTES[Math.floor(hash01(seed * 13 + 5) * TRACK_PALETTES.length)] ?? TRACK_PALETTES[0]!;
  // Couche de fond commune à toutes les scènes : c'est l'élément qui reste à
  // l'écran quand tout le reste change, et qui fait qu'un changement de scène se
  // remarque à peine. Choisie une fois, tenue du début à la fin.
  // Un fond fait partie de l'écran du début à la fin : s'il anime une figure
  // centrée et pulsée (les anneaux), elle tourne en boucle pendant tout le
  // morceau et finit par gêner. Le fond se prend donc parmi les familles
  // calmes qui n'imposent pas cet effet de cercle permanent.
  const backdropFamilies = CALM_FAMILIES.filter((family) => family !== "rings");
  const fond = backdropFamilies[Math.floor(hash01(seed * 31 + 7) * backdropFamilies.length)] ?? "waves";

  const segments: Array<{
    event: (typeof events)[number];
    start: number;
    end: number;
    caractere: Caractere;
    section: Section | null;
    group: string;
  }> = [];
  for (let index = 0; index < events.length - 1; index += 1) {
    const event = events[index];
    const next = events[index + 1];
    if (event === undefined || next === undefined) continue;
    const start = clamp01(event.time / duration) * duration;
    // Les événements sont déjà espacés, mais on garde une garde-fou.
    const target = clamp01(next.time / duration) * duration;
    const end = target > start ? target : Math.min(start + MIN_SCENE_SPAN, duration);
    if (end <= start) continue;
    // Une section qui couvre tout le morceau est une étiquette **globale** :
    // elle ne doit jamais figer le rôle ni l'humeur d'une scène locale. On s'en
    // remet alors au caractère de l'intervalle et aux événements détectés.
    const section = localSectionAt(analysis, round3(start));
    const group = groupKeyOf(section);
    segments.push({ event, start, end, caractere: caractereAt(analysis, start, end), section, group });
  }

  // Forces des impacts du morceau, dans l'ordre du plan. Un impact est toujours
  // la fin d'une montée : c'est le seul événement qui donne le rôle `drop`.
  // On les connaît avant la boucle pour pouvoir désigner le climax du morceau
  // (dernier drop à la force maximale), et donc lui réserver le pont concert.
  const dropStrengths = reduced
    ? []
    : segments
        .filter((segment) => segment.event.reason === "build")
        .map((segment) => clamp01(segment.event.weight));
  const dropClimaxRank =
    dropStrengths.length > 0 ? dropStrengths.lastIndexOf(Math.max(...dropStrengths)) : -1;

  // L'humeur se calibre sur la distribution d'énergie **du morceau** : le rang
  // d'une scène décide, pas un seuil absolu tombé au milieu d'une zone peuplée.
  // Le plancher absolu empêche un morceau calme de devenir explosif à son pic.
  const thresholds = moodThresholdsFor(segments.map((segment) => segment.caractere.energy));
  const moods = resolveMoods(
    segments.map((segment) => ({
      reason: segment.event.reason,
      section: segment.section,
      caractere: segment.caractere,
    })),
    reduced,
    thresholds,
    dramaturgy,
  );

  const scenes: Scene[] = [];
  let previousHue = -999;
  // Dernière teinte de refrain : un pont doit s'en éloigner, pas seulement de
  // la scène qui le précède.
  let lastRefrainHue: number | undefined;
  // Mémoire par groupe de structure : deux sections du même matériau musical
  // (deux refrains, deux couplets) doivent se ressembler. On fige donc leur
  // famille et leur teinte à la première apparition et on les réutilise.
  const groupFamilies = new Map<string, FamilyId>();
  const groupHues = new Map<string, number>();
  // Occurrences de refrain déjà vues par groupe, et intensité maximale
  // atteinte : un même refrain doit s'intensifier au fil des retours, sans
  // jamais redescendre. Deux scènes d'une même occurrence ne comptent qu'une.
  const groupRefrainOccurrences = new Map<string, number>();
  const groupRefrainSections = new Map<string, number>();
  const groupRefrainIntensity = new Map<string, number>();
  // Familles déjà affichées et leur nombre d'apparitions : le tirage privilégie
  // la plus rare, pour que toutes les familles sortent même sur un plan court.
  const familyUse = new Map<FamilyId, number>();
  // Familles rendues par les deux scènes précédentes : le tirage les exclut
  // pour qu'on ne voie jamais deux fois la même figure d'affilée.
  let previousFamily: FamilyId | undefined;
  let beforePreviousFamily: FamilyId | undefined;
  // Rang des drops et signatures déjà jouées : deux drops d'un même morceau,
  // a fortiori rapprochés, ne rejouent pas la même combinaison.
  let dropRank = 0;
  const usedDropSignatures = new Set<string>();
  // Signature du drop précédent du morceau : deux impacts consécutifs doivent
  // différer sur au moins deux composantes, pas seulement être uniques.
  let previousDropSignature: DropSignature | undefined;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const { event, start, end, caractere, section, group } = segment;
    const grouped = group !== "";
    // Un refrain réclame de l'énergie : c'est là qu'on veut que la salle
    // s'allume. On lui impose l'humeur explosive, comme un impact de montée.
    const mood = moods[index]!;
    const turn = scenes.length;
    const role = roleFor(section, event.reason, turn, dramaturgy);
    // Un pont fiable est une rupture : il ne puise pas dans le réservoir des
    // refrains. En mode réduit, seuls les réservoirs réduits comptent.
    const pontSection =
      dramaturgy &&
      !reduced &&
      isReliableSection(section) &&
      section?.kind === "pont";
    // Identité stable d'un groupe : sert de graine partout où il faut retrouver
    // la même famille ou la même teinte d'une occurrence à l'autre.
    const groupSeed = grouped ? hashString(`${seed}|${group}`) : 0;

    // Un impact déploie le plateau complet, quelle que soit la famille du
    // groupe : c'est le moment où la scène doit se lire comme un vrai concert.
    // On ne mémorise pas cette famille dans le groupe, sinon tout le refrain
    // resterait un pont concert.
    const forceConcert = !reduced && role === "drop";
    // Force de la montée qui a produit ce drop (0 pour un drop hors build).
    const strength = event.reason === "build" ? clamp01(event.weight) : 0;
    let signature: DropSignature | undefined;
    if (forceConcert) {
      const rank = dropRank;
      // Deux drops ne partagent jamais leur signature dans un même plan, et
      // deux drops consécutifs doivent différer sur au moins deux composantes.
      // On parcourt les `attempt` dans l'ordre : la première combinaison
      // inutilisée qui respecte la distance est retenue, sinon la première
      // inutilisée (le plan reste défini). Aucun état global : la suite ne
      // dépend que de la graine, du rang, de la force et du drop précédent.
      let chosen: DropSignature | undefined;
      let fallback: DropSignature | undefined;
      for (let attempt = 0; attempt < 54; attempt += 1) {
        const candidate = dropSignature(seed, rank, strength, attempt);
        if (usedDropSignatures.has(signatureKey(candidate))) continue;
        if (fallback === undefined) fallback = candidate;
        if (
          previousDropSignature === undefined ||
          signatureDistance(candidate, previousDropSignature) >= 2
        ) {
          chosen = candidate;
          break;
        }
      }
      signature = chosen ?? fallback ?? dropSignature(seed, rank, strength);
      usedDropSignatures.add(signatureKey(signature));
      previousDropSignature = signature;
      dropRank += 1;
    }
    let family: FamilyId;
    const cachedFamily = grouped ? groupFamilies.get(group) : undefined;
    const excluded: FamilyId[] = [];
    if (previousFamily !== undefined) excluded.push(previousFamily);
    if (beforePreviousFamily !== undefined) excluded.push(beforePreviousFamily);
    if (forceConcert) {
      // Le plateau complet est réservé au tiers supérieur des forces de drop :
      // dès qu'un morceau a plusieurs impacts, seul son climax y a droit, ce qui
      // garde la scénographie maximale là où elle se remarque. Le climax fait
      // exception au seuil : c'est le sommet du morceau, même si sa montée est
      // plus douce que celle d'un autre titre. Les autres impacts alternent
      // lyres suspendues et barres LED, en évitant la famille de la scène
      // précédente.
      const isClimax = dropRank - 1 === dropClimaxRank;
      const pont =
        dropStrengths.length >= 2
          ? isClimax
          : strength >= DROP_PONT_STRENGTH_THRESHOLD;
      if (pont) {
        family = "pont-concert";
      } else {
        const alternated: FamilyId = dropRank % 2 === 1 ? "lyres-suspendues" : "barres-led";
        family =
          alternated === previousFamily
            ? alternated === "lyres-suspendues"
              ? "barres-led"
              : "lyres-suspendues"
            : alternated;
      }
    } else if (cachedFamily !== undefined) {
      // Un groupe est un matériau musical qui revient : il garde sa famille.
      family = cachedFamily;
    } else {
      // Le parcours de la permutation dépend du rang ; la graine fixe l'ordre.
      // Un groupe tire une fois, puis sa famille est mémorisée.
      family = grouped
        ? familyFor(
            caractere,
            reduced,
            groupSeed,
            Math.floor(hash01(groupSeed) * 997),
            role,
            [],
            mood === "calme" || mood === "sombre",
            familyUse,
            pontSection,
          )
        : familyFor(
            caractere,
            reduced,
            seed,
            turn,
            role,
            [fond, ...excluded],
            mood === "calme" || mood === "sombre",
            familyUse,
            pontSection,
          );
      if (grouped) groupFamilies.set(group, family);
    }

    const calm = CALM_FAMILIES.includes(family);
    const pool = calm ? ALL_FAMILIES : CALM_FAMILIES;
    const others = pool.filter((candidate) => candidate !== family);
    const variantCandidate =
      others[(turn + Math.floor(hash01(seed * 7 + turn) * others.length)) % others.length] ?? family;
    // Une scène courte n'a pas de variation : `variant` répète alors la
    // famille principale, donc aucune seconde figure ne surgit. Le rendu
    // n'a pas besoin de connaître cette règle.
    const variation = end - start >= MIN_VARIATION_SPAN;

    // La couche de fond est la même pour tout le morceau (voir `fond`) : si la
    // scène tombe dessus, elle prendrait sa place et il ne resterait aucun
    // élément commun avec les autres scènes. On reste dans la même classe — une
    // scène calme ne devient pas agitée pour autant.
    let principale = family;
    if (principale === fond) {
      const memeClasse = CALM_FAMILIES.filter((candidate) => candidate !== fond);
      const pickSeed = grouped ? hashString(`${seed}|${group}|fond`) : seed * 17 + turn;
      principale = memeClasse[Math.floor(hash01(pickSeed) * memeClasse.length)] ?? "waves";
    }
    // Ce que l'on vient réellement d'afficher : c'est cette famille, et pas
    // celle du réservoir avant substitution du fond, que la scène suivante
    // doit éviter.
    beforePreviousFamily = previousFamily;
    previousFamily = principale;
    familyUse.set(principale, (familyUse.get(principale) ?? 0) + 1);

    // Les moments forts basculent sur la complémentaire du morceau : c'est le
    // saut de couleur qui marque un refrain, sans quitter l'identité du morceau.
    const fort =
      role === "refrain" ||
      mood === "explosif" ||
      (mood === "pulse" && caractere.energy > 0.6);
    // La signature de drop choisit le pôle de teinte : tantôt la
    // complémentaire du morceau, tantôt le pôle opposé (l'ancre de base). Les
    // deux restent dans le budget de couleur autour de l'ancre de scène.
    // Un pont prend l'ancre la plus éloignée du dernier refrain (ou, à défaut,
    // de la scène précédente) : la rupture doit se voir, sans sortir de
    // l'identité du morceau.
    const ancreReference = lastRefrainHue ?? previousHue;
    const ancre = pontSection
      ? Math.abs(hueDelta(ancreReference, track.accent)) <= Math.abs(hueDelta(ancreReference, track.hue))
        ? track.hue
        : track.accent
      : signature?.hue === "contraste"
        ? fort
          ? track.hue
          : track.accent
        : fort
          ? track.accent
          : track.hue;
    const derive = grouped
      ? (hash01(hashString(`${seed}|${group}|hue`)) - 0.5) * track.spread
      : (hash01(seed + turn * 977) - 0.5) * track.spread;
    const autreAncre = ancre === track.hue ? track.accent : track.hue;
    let hue: number;
    const cachedHue = grouped ? groupHues.get(group) : undefined;
    if (cachedHue !== undefined) {
      // L'identité d'un groupe prime : deux refrains portent la même teinte.
      hue = cachedHue;
    } else if (role === "refrain") {
      // Un refrain reste sur la complémentaire du morceau : c'est le repère
      // coloré qui permet de reconnaître son retour, même quand la scène
      // précédente est proche en teinte. On pousse la dérive dans la fenêtre de
      // l'ancre au lieu de changer d'ancre, pour ne jamais sortir du
      // complémentaire.
      const desired = (track.accent + derive + 360) % 360;
      let candidate = clampToAnchor(desired, track.accent, track.spread);
      const step = minHueStepEff(track.spread);
      if (Math.abs(hueDelta(previousHue, candidate)) < step) {
        const direction = hueDelta(previousHue, candidate) >= 0 ? 1 : -1;
        candidate = clampToAnchor((desired + direction * step + 360) % 360, track.accent, track.spread);
      }
      hue = candidate;
      if (grouped) groupHues.set(group, hue);
    } else {
      // Le couple (écart minimal, budget d'ancre) est résolu ensemble : voir
      // `hueWithGap`. L'écart gagne sur le clamp, quitte à changer d'ancre.
      hue = hueWithGap(ancre, autreAncre, derive, previousHue, track.spread).hue;
      if (grouped) groupHues.set(group, hue);
    }
    previousHue = hue;
    if (role === "refrain") lastRefrainHue = hue;

    // Intensité d'un refrain : croissante au fil des occurrences du groupe.
    // C'est ce qui fait que le troisième refrain « monte » plus que le premier,
    // tout en gardant la même famille et la même teinte reconnaissables. Le
    // facteur reste sous 1, pour que la progression se voie avant la saturation.
    let intensity = clamp01(moodIntensity(mood, caractere.energy));
    if (role === "refrain" && grouped) {
      const sectionStart = section?.start ?? start;
      const nouvelleOccurrence = groupRefrainSections.get(group) !== sectionStart;
      if (nouvelleOccurrence) {
        groupRefrainSections.set(group, sectionStart);
        groupRefrainOccurrences.set(group, (groupRefrainOccurrences.get(group) ?? 0) + 1);
      }
      const rang = groupRefrainOccurrences.get(group) ?? 1;
      const facteur = Math.min(1, 0.88 + 0.06 * Math.max(0, rang - 1));
      const plancher = nouvelleOccurrence
        ? (groupRefrainIntensity.get(group) ?? 0) + 0.02
        : 0;
      intensity = clamp01(Math.max(clamp01(moodIntensity(mood, caractere.energy)) * facteur, plancher));
      groupRefrainIntensity.set(
        group,
        Math.max(groupRefrainIntensity.get(group) ?? 0, intensity),
      );
    }

    scenes.push({
      index: turn,
      start: round3(start),
      end: round3(Math.min(end, duration)),
      family: principale,
      variant: variation ? variantCandidate : principale,
      backdrop: fond,
      palette: {
        name: track.name,
        hue,
        accent: (track.accent + derive + 360) % 360,
        spread: track.spread,
        saturation: paletteSaturation(mood),
        lightness: paletteLightness(mood),
      },
      intensity,
      fadeIn: index === 0 ? 0.7 : event.weight >= 1 ? 1.2 : 0.7,
      fadeOut: isSilenceSection(section) ? 1.8 : 0.9,
      mood,
      role,
      reason: event.reason,
      ...(signature !== undefined ? { drop: signature } : {}),
    });
  }

  if (scenes.length === 0) {
    scenes.push({
      index: 0,
      start: 0,
      end: duration,
      family: "beams",
      variant: "tunnel",
      backdrop: "waves",
      palette: {
        name: track.name,
        hue: track.hue,
        accent: track.accent,
        spread: track.spread,
        saturation: 0.88,
        lightness: 0.64,
      },
      intensity: 0.6,
      fadeIn: 0.7,
      fadeOut: 0.9,
      mood: "pulse",
      role: "intro",
      reason: "ouverture",
    });
  }

  // La dernière scène se termine toujours avec le morceau et prend le rôle de
  // finale — sauf si le morceau se termine sur un impact, qui doit rester un
  // drop jusqu'à la dernière image. La scène porte aussi la raison `finale` :
  // l'événement de fin n'est plus une frontière absorbée, c'est un état lisible
  // dans le plan.
  const last = scenes[scenes.length - 1];
  if (last !== undefined) {
    last.end = round3(duration);
    if (scenes.length > 1 && last.role !== "drop") {
      last.role = "finale";
      last.reason = "finale";
    }
  }

  return {
    duration,
    seed,
    scenes,
    barStarts: barStarts(analysis),
    track,
    backdrop: fond,
    ...(analysis.coverage !== undefined ? { coverage: analysis.coverage } : {}),
  };
}

/**
 * Section **locale** contenant l'intervalle, ou `null`.
 *
 * Une section qui couvre la quasi-totalité du morceau n'est pas un repère
 * local : c'est le label global produit par `detect_sections` (une seule
 * section de 0 à la fin). La laisser piloter l'humeur ou le rôle figerait
 * toutes les scènes sur la même étiquette.
 */
function localSectionAt(analysis: Analysis, start: number): Section | null {
  const section = sectionAt(analysis, start);
  if (section === null) return null;
  const span = section.end - section.start;
  const global = span >= analysis.duration * 0.95 && section.start <= analysis.duration * 0.05;
  return global ? null : section;
}

/** Section musicale contenant l'instant `t`, ou `null`.
 *
 * Intervalles semi-ouverts `[start, end)` : à la frontière exacte entre deux
 * sections, la scène qui démarre appartient à la suivante — sans quoi le
 * premier plan d'un refrain serait étiqueté comme le couplet qui le précède.
 */
function sectionAt(analysis: Analysis, t: number): Section | null {
  for (const section of analysis.sections) {
    if (t >= section.start && t < section.end) return section;
  }
  const last = analysis.sections[analysis.sections.length - 1];
  return last !== undefined && t >= last.end ? last : null;
}

/** Scène active à l'instant `t` (la dernière commencée avant `t`). */
export function sceneAt(plan: ShowPlan, t: number): Scene {
  const scenes = plan.scenes;
  if (scenes.length === 0) throw new Error("plan de spectacle vide");
  let low = 0;
  let high = scenes.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    const scene = scenes[mid];
    if (scene !== undefined && scene.start <= t) low = mid;
    else high = mid - 1;
  }
  return scenes[low] ?? scenes[0]!;
}

/** Pondération de la scène à `t` : 0 avant son début, montée pendant `fadeIn`. */
/**
 * Poids d'une scène dans le fondu, 0..1.
 *
 * Elle monte à l'entrée, **tient jusqu'à sa fin**, et ne s'éteint qu'après la
 * frontière — pendant que la suivante monte. Les deux se croisent donc au lieu
 * de se succéder : avant, le poids tombait à zéro dès la fin de la scène, et
 * tout l'écran (fond compris) passait par le noir à chaque changement.
 */
export function sceneWeight(scene: Scene, t: number): number {
  if (t < scene.start) return 0;
  const into = t - scene.start;
  const fadeIn = clamp01(into / Math.max(scene.fadeIn, 0.001));
  const after = t - scene.end;
  const fadeOut = after <= 0 ? 1 : 1 - clamp01(after / Math.max(scene.fadeOut, 0.001));
  return Math.min(fadeIn, fadeOut);
}

/**
 * Durée médiane des scènes : c'est la cadence à laquelle l'ambiance se renouvelle.
 * Utile pour vérifier qu'un morceau produit assez de changements justifiés.
 */
export function sceneCadence(plan: ShowPlan): number {
  if (plan.scenes.length < 2) return plan.duration;
  const spans = plan.scenes.map((scene) => scene.end - scene.start).sort((a, b) => a - b);
  return spans[Math.floor(spans.length / 2)] ?? plan.duration;
}
