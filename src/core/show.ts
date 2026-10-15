import type { Analysis } from "../types";
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
  | "burst";

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
  /** Barres de mesure détectées dans le morceau, en secondes. */
  barStarts: number[];
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
};

export const MOOD_LABELS: Record<Mood, string> = {
  calme: "ambiance calme",
  pulse: "pulsé",
  explosif: "explosif",
  aerien: "aérien",
  sombre: "sombre",
};

/** Familles posées, pour les passages sans percussion marquée. */
const CALM_FAMILIES: FamilyId[] = ["waves", "tunnel", "particles", "rings", "spiral"];
/** Familles qui suivent le rythme, pour les passages cadencés. */
const RHYTHMIC_FAMILIES: FamilyId[] = [
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
];
const ENERGETIC_FAMILIES: FamilyId[] = [
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
];

const ALL_FAMILIES: FamilyId[] = [...CALM_FAMILIES, ...RHYTHMIC_FAMILIES];

const PALETTES: Array<{ name: string; hue: number; spread: number }> = [
  { name: "indigo", hue: 252, spread: 62 },
  { name: "cyan", hue: 190, spread: 48 },
  { name: "magenta", hue: 318, spread: 70 },
  { name: "ambre", hue: 34, spread: 54 },
  { name: "émeraude", hue: 158, spread: 44 },
  { name: "violet-orange", hue: 274, spread: 120 },
  { name: "corail", hue: 8, spread: 40 },
  { name: "azur", hue: 214, spread: 66 },
];

/** Teintes de scènes voisines jamais à moins de `MIN_HUE_STEP` degrés. */
const MIN_HUE_STEP = 34;
/** Nombre de temps forts par cycle « vers ». */
const CYCLE_BEATS = 16;
/** Longueur minimale d'une scène, en secondes. */
const MIN_SCENE_SPAN = 5;

export interface Caractere {
  energy: number;
  density: number;
  brightness: number;
}

/** Caractère d'un intervalle : énergie, densité d'attaques, brillance spectrale. */
export function caractereAt(analysis: Analysis, start: number, end: number): Caractere {
  const span = Math.max(end - start, 1e-6);
  const energies: number[] = [];
  let brightness = 0.5;
  for (const [time, value] of analysis.energy) {
    if (time >= start && time <= end) energies.push(value);
  }
  for (const [time, value] of analysis.high) {
    if (time >= start && time <= end) brightness += value * 0.5;
  }
  const onsets = analysis.onsets.filter((onset) => onset >= start && onset < end).length;
  return {
    energy: energies.length > 0 ? energies.reduce((sum, value) => sum + value, 0) / energies.length : 0.3,
    density: onsets / span,
    brightness: clamp01(brightness),
  };
}

/**
 * Barres de mesure : temps forts tous les `CYCLE_BEATS`, et temps forts seuls
 * en dernier recours. C'est la grille rythmique sur laquelle le spectacle
 * pourra accrocher ses changements.
 */
export function barStarts(analysis: Analysis): number[] {
  const beats = analysis.beats;
  const beatPeriod = analysis.beatPeriod > 0 ? analysis.beatPeriod : 0.5;
  const step = beatPeriod * CYCLE_BEATS;
  if (beats.length === 0 || step <= 0) {
    // Aucun temps fort détecté : on retombe sur une grille régulière pour que le
    // spectacle ait quand même des repères.
    const regular: number[] = [];
    for (let t = 0; t < analysis.duration; t += step > 0 ? step : 8) regular.push(t);
    return regular;
  }
  const out: number[] = [];
  for (let index = 0; index < beats.length; index += CYCLE_BEATS) {
    const beat = beats[index];
    if (beat !== undefined) out.push(beat);
  }
  return out.length > 0 ? out : beats.filter((_, index) => index % CYCLE_BEATS === 0);
}

/** Famille déduite du caractère musical, sans tirage au sort. */
function familyFor(caractere: Caractere, reduced: boolean, turn: number): FamilyId {
  const { energy, density, brightness } = caractere;
  // Le rang est un entier : sans arrondi, un `list[1.4]` vaut undefined et la
  // famille retomberait toujours sur la première.
  const index = Math.max(0, Math.floor(turn));
  const pick = (list: FamilyId[]) => list[index % list.length] ?? list[0] ?? "beams";

  if (reduced) {
    if (energy < 0.22) return pick(CALM_FAMILIES);
    if (density < 0.6) return pick(CALM_FAMILIES);
    return pick(["beams", "waves", "rings", "particles"] as FamilyId[]);
  }
  if (energy < 0.22) return pick(CALM_FAMILIES);
  if (brightness > 0.62) {
    return pick(["particles", "spots", "spiral", "rings", "beams", "mirror", "parade"] as FamilyId[]);
  }
  if (density > 2.2) return pick(RHYTHMIC_FAMILIES);
  if (energy > 0.6) return pick(ENERGETIC_FAMILIES);
  return pick(ALL_FAMILIES);
}

function moodFor(caractere: Caractere, label: string): Mood {
  if (label === "silence") return "sombre";
  if (label === "montee") return "pulse";
  if (caractere.energy > 0.62) return "explosif";
  if (caractere.energy < 0.26) return "aerien";
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
export function buildShowPlan(analysis: Analysis, reduced: boolean): ShowPlan {
  const seed = hashString(`${analysis.duration.toFixed(2)}|${analysis.tempo.toFixed(3)}|${analysis.beats.length}`);
  const duration = Math.max(analysis.duration, 0.001);
  const events = sceneBoundaries(analysis);

  const scenes: Scene[] = [];
  let previousHue = -999;
  let paletteTurn = 0;

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
    const label = sectionLabelAt(analysis, start);
    // Un impact de montée impose son humeur : c'est l'événement le plus fort du
    // morceau, il ne peut pas se retrouver en ambiance calme.
    const mood = event.reason === "build" ? "explosif" : moodFor(caractere, label);
    const turn = scenes.length;
    const family = familyFor(caractere, reduced, turn + hash01(seed + turn) * 0.9);

    const calm = CALM_FAMILIES.includes(family);
    const pool = calm ? ALL_FAMILIES : CALM_FAMILIES;
    const others = pool.filter((candidate) => candidate !== family);
    const variant = others[(turn + Math.floor(hash01(seed * 7 + turn) * others.length)) % others.length] ?? family;

    const gentle = CALM_FAMILIES.filter((candidate) => candidate !== family && candidate !== variant);
    const backdrop = gentle[Math.floor(hash01(seed * 31 + turn) * gentle.length)] ?? "waves";

    // La teinte tourne d'un cran à chaque changement justifié, et dérive ensuite.
    const base = PALETTES[paletteTurn % PALETTES.length] ?? PALETTES[0]!;
    paletteTurn += 1;
    let hue = (base.hue + Math.round((hash01(seed + paletteTurn * 977) - 0.5) * 24) + 360) % 360;
    const delta = ((hue - previousHue + 540) % 360) - 180;
    if (Math.abs(delta) < MIN_HUE_STEP) {
      hue = (hue + (delta >= 0 ? MIN_HUE_STEP : -MIN_HUE_STEP) + 360) % 360;
    }
    previousHue = hue;

    scenes.push({
      index: turn,
      start: round3(start),
      end: round3(Math.min(end, duration)),
      family,
      variant,
      backdrop,
      palette: {
        name: base.name,
        hue,
        spread: base.spread,
        saturation: mood === "sombre" ? 0.6 : 0.84,
        lightness: mood === "sombre" ? 0.42 : 0.6,
      },
      intensity: clamp01(moodIntensity(mood, caractere.energy)),
      fadeIn: index === 0 ? 0.7 : event.weight >= 1 ? 1.2 : 0.7,
      fadeOut: 0.9,
      mood,
      reason: event.reason,
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
      palette: { name: "indigo", hue: 252, spread: 62, saturation: 0.82, lightness: 0.6 },
      intensity: 0.6,
      fadeIn: 0.7,
      fadeOut: 0.9,
      mood: "pulse",
      reason: "ouverture",
    });
  }

  // La dernière scène se termine toujours avec le morceau.
  const last = scenes[scenes.length - 1];
  if (last !== undefined) last.end = round3(duration);

  return { duration, seed, scenes, barStarts: barStarts(analysis) };
}

function sectionLabelAt(analysis: Analysis, t: number): string {
  for (const section of analysis.sections) {
    if (t >= section.start && t <= section.end) return section.label;
  }
  return "intense";
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
export function sceneWeight(scene: Scene, t: number): number {
  if (t < scene.start) return 0;
  const into = t - scene.start;
  const fadeIn = clamp01(into / Math.max(scene.fadeIn, 0.001));
  const toEnd = scene.end - t;
  const fadeOut = clamp01(toEnd / Math.max(scene.fadeOut, 0.001));
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
