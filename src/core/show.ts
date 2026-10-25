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

export type SceneReason = "section" | "build" | "cycle" | "beat" | "ouverture" | "finale";

export const SCENE_REASON_LABELS: Record<SceneReason, string> = {
  section: "nouveau passage",
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

/** Métrique validée : 3 ou 4, avec 4 comme hypothèse par défaut. */
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
): FamilyId {
  const order = permuteFamilies(list, seed + list.length * 104_729);
  const start = ((Math.floor(turn) % order.length) + order.length) % order.length;
  // L'appelant place toujours la couche de fond en tête : elle ne doit jamais
  // devenir la famille principale. Les scènes précédentes suivent, et
  // l'avant-dernière n'est écartée que sur les réservoirs assez grands — sur
  // une liste de trois ou quatre, trois exclusions tueraient le tirage.
  const blocked = excluded.slice(0, order.length >= 5 ? 3 : 2);
  for (let step = 0; step < order.length; step += 1) {
    const candidate = order[(start + step) % order.length]!;
    if (!blocked.includes(candidate)) return candidate;
  }
  return order[start] ?? list[0] ?? "beams";
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
): FamilyBranch {
  const { energy, density, brightness } = caractere;
  if (reduced) {
    if (energy < CALM_ENERGY_THRESHOLD) return "reduit-calme";
    if (density < REDUCED_DENSITY_THRESHOLD) return "reduit-calme";
    return "reduit-rythmique";
  }
  if (concertDrop) return "drop";
  // Orchestration par rôle : un refrain alterne lyres et barres LED, une
  // montée déploie franchement la vague des barres.
  if (role === "refrain") return "refrain";
  if (role === "montee") return "montee";
  if (energy < CALM_ENERGY_THRESHOLD) return "calme";
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
): FamilyId {
  const branch = familyBranchFor(caractere, reduced, role);
  if (branch === "refrain") {
    return Math.floor(turn) % 2 === 0 ? "lyres-suspendues" : "barres-led";
  }
  if (branch === "montee") return "barres-led";
  return pickFamily(FAMILY_BRANCH_RESERVOIRS[branch], seed, turn, excluded);
}

/**
 * Rôle dramaturgique d'une scène.
 *
 * La fin d'une montée est toujours un `drop`, même si elle tombe au milieu d'un
 * refrain : c'est l'impact qui commande la lumière à cet instant. Les sections
 * identifiées par le serveur (intro, couplet, refrain, outro) gardent ensuite
 * leur rôle du début à la fin.
 */
function roleFor(section: Section | null, reason: SceneReason, index: number): SceneRole {
  if (reason === "build") return "drop";
  if (section?.kind === "intro") return "intro";
  if (section?.kind === "refrain") return "refrain";
  if (section?.kind === "couplet") return "couplet";
  if (section?.kind === "outro") return "finale";
  if (section?.kind === "pont") return "montee";
  if (reason === "ouverture" || index === 0) return "intro";
  if (section?.label === "montee") return "montee";
  if (section?.label === "descente" || section?.label === "silence") return "finale";
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
 * Même cause que `BRIGHTNESS_THRESHOLD` : l'ancien 0,68 était une valeur de
 * somme saturée. Sur l'échelle réelle (médiane ≈ 0,19), 0,68 ne laissait plus
 * qu'une scène du corpus devenir aérienne. 0,09 restaure une humeur « aérien »
 * minoritaire (~7 %), sans empiéter sur « calme » (énergie < 0,3) ni sur
 * « explosif » (énergie > 0,62). Alternative mesurée : 0,08 (~9 %).
 */
export const MOOD_BRIGHTNESS_THRESHOLD = 0.09;

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
): MoodBranch {
  if (reason === "build") return "build-explosif";
  if (!reduced && section?.kind === "refrain") return "refrain-explosif";
  const label = section?.label ?? "intense";
  if (label === "silence") return "silence-sombre";
  if (label === "montee") return "montee-pulse";
  if (caractere.energy > ENERGY_THRESHOLD) return "energie-explosif";
  if (caractere.energy < MOOD_CALM_ENERGY_THRESHOLD) return "calme";
  if (caractere.brightness > MOOD_BRIGHTNESS_THRESHOLD) return "brillance-aerien";
  return "pulse";
}

/** Humeur d'une scène : overrides (impact, refrain) puis caractère musical. */
export function moodForScene(
  reason: SceneReason,
  section: Section | null,
  caractere: Caractere,
  reduced: boolean,
): Mood {
  return MOOD_OF_BRANCH[moodBranchFor(reason, section, caractere, reduced)];
}

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
 * Événements qui justifient un changement complet d'ambiance, triés dans le temps.
 *
 * Un changement de famille + palette n'arrive QUE sur l'un d'eux : rien ne se
 * déclenche « au hasard » au milieu d'un passage.
 */
function sceneBoundaries(analysis: Analysis): Array<{ time: number; reason: SceneReason; weight: number }> {
  const duration = Math.max(analysis.duration, 0.001);
  const events: Array<{ time: number; reason: SceneReason; weight: number }> = [
    { time: 0, reason: "ouverture", weight: 1 },
    { time: duration, reason: "finale", weight: 0 },
  ];

  for (const section of analysis.sections) {
    events.push({ time: section.start, reason: "section", weight: section.label === "silence" ? 0.4 : 1 });
  }

  // Fin de chaque montée : c'est l'impact, l'événement le plus spectaculaire.
  for (const build of analysis.builds) {
    events.push({ time: build.end, reason: "build", weight: build.strength });
  }

  for (const bar of barStarts(analysis)) {
    if (bar > 0.01 && bar < duration - 0.01) events.push({ time: bar, reason: "cycle", weight: 0.5 });
  }

  events.sort((left, right) => left.time - right.time);

  // Deux événements à moins de MIN_SCENE_SPAN secondes d'écart n'en font qu'un :
  // on garde le plus marquant, sinon une scène durerait une fraction de seconde.
  const merged: typeof events = [];
  for (const event of events) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && event.time - previous.time < MIN_SCENE_SPAN) {
      // Les impacts de montée l'emportent : c'est le moment qu'on remarque le
      // plus dans un morceau, il mérite son changement d'ambiance.
      const score = (candidate: { weight: number; reason: SceneReason }) =>
        candidate.weight * (candidate.reason === "build" ? 1.25 : 1);
      if (score(event) > score(previous)) {
        merged[merged.length - 1] = { time: event.time, reason: event.reason, weight: event.weight };
      }
      continue;
    }
    merged.push(event);
  }
  return merged;
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
export function buildShowPlan(analysis: Analysis, reduced: boolean, seedOverride?: number): ShowPlan {
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

  const scenes: Scene[] = [];
  let previousHue = -999;
  // Mémoire par groupe de structure : deux sections du même matériau musical
  // (deux refrains, deux couplets) doivent se ressembler. On fige donc leur
  // famille et leur teinte à la première apparition et on les réutilise.
  const groupFamilies = new Map<string, FamilyId>();
  const groupHues = new Map<string, number>();
  // Familles rendues par les deux scènes précédentes : le tirage les exclut
  // pour qu'on ne voie jamais deux fois la même figure d'affilée.
  let previousFamily: FamilyId | undefined;
  let beforePreviousFamily: FamilyId | undefined;
  // Rang des drops et signatures déjà jouées : deux drops d'un même morceau,
  // a fortiori rapprochés, ne rejouent pas la même combinaison.
  let dropRank = 0;
  const usedDropSignatures = new Set<string>();

  for (let index = 0; index < events.length - 1; index += 1) {
    const event = events[index];
    const next = events[index + 1];
    if (event === undefined || next === undefined) continue;
    const start = clamp01(event.time / duration) * duration;
    // Les événements sont déjà espacés, mais on garde une garde-fou.
    const target = clamp01(next.time / duration) * duration;
    const end = target > start ? target : Math.min(start + MIN_SCENE_SPAN, duration);
    if (end <= start) continue;

    const caractere = caractereAt(analysis, start, end);
    // Une section qui couvre tout le morceau est une étiquette **globale** :
    // elle ne doit jamais figer le rôle ni l'humeur d'une scène locale. On s'en
    // remet alors au caractère de l'intervalle et aux événements détectés.
    const section = localSectionAt(analysis, start);
    const group = section?.group !== undefined && section.group !== "" ? section.group : "";
    const grouped = group !== "";
    // Un refrain réclame de l'énergie : c'est là qu'on veut que la salle
    // s'allume. On lui impose l'humeur explosive, comme un impact de montée.
    const mood = moodForScene(event.reason, section, caractere, reduced);
    const turn = scenes.length;
    const role = roleFor(section, event.reason, turn);
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
      signature = dropSignature(seed, rank, strength);
      // Deux drops ne partagent jamais leur signature dans un même plan : la
      // contrainte des 15 s est couverte, et un morceau très long épuise les
      // 54 combinaisons avant de répéter. On décale la combinaison d'un cran,
      // de façon déterministe.
      for (let attempt = 1; attempt < 54; attempt += 1) {
        if (!usedDropSignatures.has(signatureKey(signature))) break;
        signature = dropSignature(seed, rank, strength, attempt);
      }
      usedDropSignatures.add(signatureKey(signature));
      dropRank += 1;
    }
    let family: FamilyId;
    const cachedFamily = grouped ? groupFamilies.get(group) : undefined;
    const excluded: FamilyId[] = [];
    if (previousFamily !== undefined) excluded.push(previousFamily);
    if (beforePreviousFamily !== undefined) excluded.push(beforePreviousFamily);
    if (forceConcert) {
      // Le plateau complet est réservé aux vrais impacts ; une montée plus
      // douce alterne lyres suspendues et barres LED.
      family =
        strength >= 0.6
          ? "pont-concert"
          : dropRank % 2 === 1
            ? "lyres-suspendues"
            : "barres-led";
    } else if (cachedFamily !== undefined) {
      // Un groupe est un matériau musical qui revient : il garde sa famille.
      family = cachedFamily;
    } else {
      // Le parcours de la permutation dépend du rang ; la graine fixe l'ordre.
      // Un groupe tire une fois, puis sa famille est mémorisée.
      family = grouped
        ? familyFor(caractere, reduced, groupSeed, Math.floor(hash01(groupSeed) * 997), role)
        : familyFor(caractere, reduced, seed, turn, role, [fond, ...excluded]);
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

    // Les moments forts basculent sur la complémentaire du morceau : c'est le
    // saut de couleur qui marque un refrain, sans quitter l'identité du morceau.
    const fort =
      section?.kind === "refrain" ||
      mood === "explosif" ||
      (mood === "pulse" && caractere.energy > 0.6);
    // La signature de drop choisit le pôle de teinte : tantôt la
    // complémentaire du morceau, tantôt le pôle opposé (l'ancre de base). Les
    // deux restent dans le budget de couleur autour de l'ancre de scène.
    const ancre =
      signature?.hue === "contraste"
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
    } else {
      // Le couple (écart minimal, budget d'ancre) est résolu ensemble : voir
      // `hueWithGap`. L'écart gagne sur le clamp, quitte à changer d'ancre.
      hue = hueWithGap(ancre, autreAncre, derive, previousHue, track.spread).hue;
      if (grouped) groupHues.set(group, hue);
    }
    previousHue = hue;

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
      intensity: clamp01(moodIntensity(mood, caractere.energy)),
      fadeIn: index === 0 ? 0.7 : event.weight >= 1 ? 1.2 : 0.7,
      fadeOut: 0.9,
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
  // drop jusqu'à la dernière image.
  const last = scenes[scenes.length - 1];
  if (last !== undefined) {
    last.end = round3(duration);
    if (scenes.length > 1 && last.role !== "drop") last.role = "finale";
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
