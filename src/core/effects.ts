/**
 * Inventaire des effets et timeline synthétique du studio.
 *
 * Le studio d'effets (`/effets.html`) doit pouvoir lancer n'importe quelle
 * famille sans qu'on recopie une liste : l'inventaire est dérivé de
 * `FAMILY_GROUPS`, et les libellés de `FAMILY_LABELS`. Ajouter une famille dans
 * un module la fait apparaître automatiquement dans la galerie.
 *
 * Le studio n'a pas de morceau à analyser : il se fabrique une courte timeline
 * synthétique (temps forts, montées, impacts, courbes d'énergie) qui alimente
 * exactement le même `TrackView` et le même `renderFrame` que le spectacle.
 * C'est ce qui garantit que l'aperçu est fidèle, et non une imitation.
 */

import { ANALYSIS_SCHEMA, type Analysis, type Build, type Point, type Section } from "../types";
import { FAMILIES, FAMILY_GROUPS } from "./families";
import {
  FAMILY_LABELS,
  type DropSignature,
  type FamilyId,
  type Mood,
  type Palette,
  type Scene,
  type SceneRole,
  type ShowPlan,
  type TrackPalette,
} from "./show";
import { TrackView } from "./view";

export type EffectCategoryId = keyof typeof FAMILY_GROUPS;

export const EFFECT_CATEGORY_LABELS: Record<EffectCategoryId, string> = {
  ambiance: "Ambiance",
  projecteurs: "Projecteurs",
  rideaux: "Rideaux",
  formes: "Formes",
  figures: "Figures",
  concert: "Scène de concert",
  "concert-lumieres": "Lumières de scène",
};

export interface EffectInfo {
  id: FamilyId;
  label: string;
  category: EffectCategoryId;
  categoryLabel: string;
}

export interface EffectCategory {
  id: EffectCategoryId;
  label: string;
  effects: EffectInfo[];
}

function categoryOf(family: FamilyId): EffectCategoryId {
  for (const category of Object.keys(FAMILY_GROUPS) as EffectCategoryId[]) {
    if (Object.hasOwn(FAMILY_GROUPS[category], family)) return category;
  }
  // Une famille absente des groupes ne devrait pas exister : on la range par
  // défaut plutôt que de la faire disparaître de la galerie.
  return "ambiance";
}

const ALL_EFFECTS: EffectInfo[] = (Object.keys(FAMILIES) as FamilyId[]).map((id) => {
  const category = categoryOf(id);
  return {
    id,
    label: FAMILY_LABELS[id],
    category,
    categoryLabel: EFFECT_CATEGORY_LABELS[category],
  };
});

/** Effets découverts, rangés par catégorie puis par nom. */
export const EFFECT_CATEGORIES: EffectCategory[] = (Object.keys(FAMILY_GROUPS) as EffectCategoryId[]).map(
  (category) => ({
    id: category,
    label: EFFECT_CATEGORY_LABELS[category],
    effects: ALL_EFFECTS.filter((effect) => effect.category === category).sort((left, right) =>
      left.label.localeCompare(right.label, "fr"),
    ),
  }),
);

/** Tous les effets à plat, dans l'ordre de la galerie. */
export const EFFECTS: EffectInfo[] = EFFECT_CATEGORIES.flatMap((category) => category.effects);

/* ------------------------------------------------------------------ timeline */

/** Durée de la boucle de démonstration, en secondes. */
export const EFFECT_DURATION_SEC = 240;
/** Pas d'échantillonnage des courbes, en secondes. */
const CURVE_STEP_SEC = 0.1;
/** Un cycle de démonstration : calme, montée, impact, descente. */
const CYCLE_BEATS = 32;
const BUILD_START_BEAT = 16;
const BUILD_END_BEAT = 24;
const INTENSE_END_BEAT = 28;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** Forme du cycle : 0 calme, 1 plein impact. */
function cycleShape(beatInCycle: number): number {
  if (beatInCycle < BUILD_START_BEAT) return 0.52;
  if (beatInCycle < BUILD_END_BEAT) {
    const progress = (beatInCycle - BUILD_START_BEAT) / (BUILD_END_BEAT - BUILD_START_BEAT);
    return 0.52 + 0.48 * progress * progress;
  }
  if (beatInCycle < INTENSE_END_BEAT) return 1;
  const descent = (beatInCycle - INTENSE_END_BEAT) / (CYCLE_BEATS - INTENSE_END_BEAT);
  return 1 - 0.48 * descent;
}

/** Décroissance depuis le temps fort courant, pour les basses et l'énergie. */
function beatPulse(t: number, beatPeriod: number): number {
  if (beatPeriod <= 0) return 0;
  const phase = (t % beatPeriod) / beatPeriod;
  return Math.exp(-phase * 4.5);
}

export interface EffectTimelineParams {
  /** Tempo de la boucle, en BPM. */
  tempo: number;
  /** Énergie de base, 0..1. */
  energy: number;
  /** Niveau des basses, 0..1. */
  bass: number;
  /** Niveau des aigus, 0..1. */
  high: number;
  /** Faut-il jouer le cycle montée → impact, ou rester stable ? */
  impacts: boolean;
  seed: number;
}

export interface EffectLook {
  family: FamilyId;
  variant: FamilyId;
  role: SceneRole;
  mood: Mood;
  /** Teinte principale, 0..360. */
  hue: number;
  /** Écart entre la teinte principale et la complémentaire, en degrés. */
  spread: number;
  saturation: number;
  lightness: number;
}

export interface EffectTimeline {
  view: TrackView;
  plan: ShowPlan;
  duration: number;
  tempo: number;
}

function defaultDrop(seed: number): DropSignature {
  const plateaux: DropSignature["plateau"][] = [
    "pont",
    "cathedrale",
    "colisee",
    "arena",
    "rideau",
    "aurore",
    "helice",
    "tunnel",
    "cascade",
  ];
  const modes: DropSignature["lyres"][] = [
    "convergence",
    "croisee",
    "eventail",
    "croix",
    "helice",
    "tunnel",
    "diagonale",
    "zigzag",
    "respiration",
    "pluie",
  ];
  const barres: DropSignature["barres"][] = ["onde", "rideau", "alterne"];
  const blinders: DropSignature["blinders"][] = ["tous", "un-sur-deux", "un-sur-quatre", "chenillard"];
  const strobes: DropSignature["strobes"][] = ["aucun", "simple", "double", "cascade"];
  const hues: DropSignature["hue"][] = ["accent", "contraste", "blanc", "bicolore"];
  const pick = <T,>(values: readonly T[], offset: number): T =>
    values[(seed + offset) % values.length] ?? values[0]!;
  return {
    plateau: pick(plateaux, 4),
    lyres: pick(modes, 1),
    barres: pick(barres, 2),
    blinders: pick(blinders, 3),
    strobes: pick(strobes, 5),
    hue: pick(hues, 0),
  };
}

/**
 * Construit la timeline synthétique du studio.
 *
 * Les courbes ne sont pas du bruit : elles suivent le même cycle que la
 * démonstration (calme, montée, impact, descente) afin que les effets à
 * montée, les flashs et les impacts se déclenchent vraiment.
 */
export function buildEffectTimeline(params: EffectTimelineParams): EffectTimeline {
  const duration = EFFECT_DURATION_SEC;
  const tempo = clamp(params.tempo, 30, 220);
  const beatPeriod = 60 / tempo;
  const energyBase = clamp01(params.energy);
  const bassBase = clamp01(params.bass);
  const highBase = clamp01(params.high);

  const beats: number[] = [];
  for (let beat = 0; beat * beatPeriod <= duration; beat += 1) beats.push(beat * beatPeriod);

  const onsets: number[] = [];
  for (let half = 0; half * beatPeriod * 0.5 <= duration; half += 1) {
    onsets.push(half * beatPeriod * 0.5);
  }

  const curve = (sample: (t: number, shape: number, pulse: number) => number): Point[] => {
    const points: Point[] = [];
    for (let t = 0; t <= duration; t += CURVE_STEP_SEC) {
      const beatIndex = Math.floor(t / beatPeriod);
      const beatInCycle = params.impacts ? beatIndex % CYCLE_BEATS : 8;
      const shape = cycleShape(beatInCycle);
      points.push([Number(t.toFixed(3)), clamp01(sample(t, shape, beatPulse(t, beatPeriod)))]);
    }
    return points;
  };

  const energy = curve((_t, shape, pulse) => energyBase * (0.45 + 0.55 * shape) + pulse * 0.16 * energyBase);
  const bass = curve((_t, shape, pulse) => bassBase * (0.4 + 0.6 * shape) + pulse * 0.38);
  const mid = curve((t, shape, pulse) => 0.35 * energyBase + 0.3 * shape + 0.12 * Math.sin(t * 0.9) ** 2 + pulse * 0.1);
  const high = curve((t, shape, pulse) => highBase * (0.5 + 0.5 * shape) + pulse * 0.1 + 0.06 * Math.sin(t * 1.7) ** 2);

  const builds: Build[] = [];
  if (params.impacts) {
    const cycleSec = CYCLE_BEATS * beatPeriod;
    for (let start = 0; start < duration; start += cycleSec) {
      const buildStart = start + BUILD_START_BEAT * beatPeriod;
      const buildEnd = start + BUILD_END_BEAT * beatPeriod;
      if (buildEnd <= duration) {
        builds.push({ start: buildStart, end: buildEnd, strength: 0.82 });
      }
    }
  }

  const sections: Section[] = [];
  const cycleSec = CYCLE_BEATS * beatPeriod;
  const pushSection = (start: number, end: number, label: Section["label"], energyValue: number): void => {
    if (start >= duration) return;
    sections.push({ start, end: Math.min(end, duration), label, energy: clamp01(energyValue) });
  };
  for (let start = 0; start < duration; start += cycleSec) {
    pushSection(start, start + BUILD_START_BEAT * beatPeriod, "calme", energyBase * 0.55);
    pushSection(start + BUILD_START_BEAT * beatPeriod, start + BUILD_END_BEAT * beatPeriod, "montee", energyBase * 0.75);
    pushSection(start + BUILD_END_BEAT * beatPeriod, start + INTENSE_END_BEAT * beatPeriod, "intense", energyBase);
    pushSection(start + INTENSE_END_BEAT * beatPeriod, start + cycleSec, "descente", energyBase * 0.7);
  }

  const barStarts: number[] = [];
  for (let beat = 0; beat * beatPeriod <= duration; beat += 4) barStarts.push(beat * beatPeriod);

  const analysis: Analysis = {
    schema: ANALYSIS_SCHEMA,
    duration,
    tempo,
    meter: 4,
    beatCount: beats.length,
    beatPeriod,
    beats,
    onsets,
    energy,
    bass,
    mid,
    high,
    sections,
    builds,
  };

  const seed = Math.max(0, Math.round(params.seed));
  const track: TrackPalette = {
    name: "Studio",
    hue: 0,
    accent: 0,
    spread: 60,
  };

  const plan: ShowPlan = {
    duration,
    seed,
    scenes: [],
    profile: "standard",
    barStarts,
    track,
    backdrop: "particles",
  };

  // La scène unique couvre toute la boucle, sans fondu : le studio montre
  // l'effet nu, pas une entrée de scène.
  const videoScene: Scene = {
    index: 0,
    start: -1,
    end: duration + 1,
    family: "beams",
    variant: "beams",
    backdrop: "particles",
    palette: { name: "Studio", hue: 0, accent: 60, spread: 60, saturation: 0.8, lightness: 0.6 },
    intensity: 1,
    fadeIn: 0.001,
    fadeOut: 0.001,
    mood: "pulse",
    role: "refrain",
    reason: "ouverture",
    drop: defaultDrop(seed),
  };
  plan.scenes.push(videoScene);

  return { view: new TrackView(analysis), plan, duration, tempo };
}

/**
 * Applique l'apparence choisie (famille, rôle, palette) à une timeline existante.
 *
 * La timeline (courbes, temps forts) ne dépend pas de la couleur : on la garde
 * donc intacte pendant qu'on bouge les curseurs de teinte ou qu'on change de
 * famille, ce qui évite de recalculer l'analyse à chaque image.
 */
export function applyEffectLook(timeline: EffectTimeline, look: EffectLook): void {
  const scene = timeline.plan.scenes[0];
  if (scene === undefined) return;
  const hue = ((look.hue % 360) + 360) % 360;
  const spread = clamp(look.spread, 0, 180);
  const palette: Palette = {
    name: "Studio",
    hue,
    accent: (hue + spread) % 360,
    spread,
    saturation: clamp01(look.saturation),
    lightness: clamp01(look.lightness),
  };
  scene.family = look.family;
  scene.variant = look.variant;
  scene.role = look.role;
  scene.mood = look.mood;
  scene.palette = palette;
  timeline.plan.track.hue = hue;
  timeline.plan.track.accent = palette.accent;
  timeline.plan.track.spread = spread;
}

/** Clé des seuls réglages qui obligent à reconstruire la timeline. */
export function timelineKey(params: EffectTimelineParams): string {
  return [params.tempo, params.energy, params.bass, params.high, params.impacts, params.seed].join("|");
}
