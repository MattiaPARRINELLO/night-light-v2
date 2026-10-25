/**
 * Échantillonnage de la saturation pendant les drops, à 10 Hz.
 *
 * "Saturation" ici = part de pixels proches du blanc (voir `saturation.ts`).
 * Chaque scène d'impact est échantillonnée toutes les 100 ms ; le rendu est
 * celui de production (plan normal, qualité 1, réglages par défaut).
 *
 * La logique est séparée du CLI pour être testable avec un faux renderer.
 */

import { buildShowPlan, type ShowPlan } from "../../src/core/show";
import { DEFAULT_SETTINGS, type RenderSettings } from "../../src/types";
import type { HeadlessRenderer } from "./headless_render";
import type { PlanTrack } from "./plan_corpus";
import { stats, type Stats } from "./plan_report";

export interface DropWindow {
  track: string;
  index: number;
  start: number;
  end: number;
  family: string;
  mood: string;
  signature: string | null;
}

export interface DropSaturation {
  window: DropWindow;
  times: number[];
  ratios: number[];
  stats: Stats;
  /** Ratio maximal observé. */
  max: number;
}

export interface SaturationOptions {
  fps?: number;
  width?: number;
  height?: number;
  dpr?: number;
  quality?: number;
  settings?: RenderSettings;
  reducedMotion?: boolean;
}

export const SATURATION_FPS = 10;

/** Fenêtres des scènes d'impact d'un plan. */
export function dropWindows(track: string, plan: ShowPlan): DropWindow[] {
  return plan.scenes
    .filter((scene) => scene.role === "drop")
    .map((scene) => ({
      track,
      index: scene.index,
      start: scene.start,
      end: scene.end,
      family: scene.family,
      mood: scene.mood,
      signature:
        scene.drop === undefined
          ? null
          : `${scene.drop.lyres}/${scene.drop.barres}/${scene.drop.blinders}/${scene.drop.hue}`,
    }));
}

/** Instants échantillonnés dans `[start, end)`, à la cadence demandée. */
export function sampleTimes(start: number, end: number, fps = SATURATION_FPS): number[] {
  const step = 1 / fps;
  const times: number[] = [];
  for (let time = start; time < end - 1e-9; time += step) {
    times.push(Number(time.toFixed(6)));
  }
  if (times.length === 0) times.push(Number(start.toFixed(6)));
  return times;
}

export async function sampleDrops(
  renderer: Pick<HeadlessRenderer, "setup" | "whiteRatios">,
  track: PlanTrack,
  options: SaturationOptions = {},
): Promise<DropSaturation[]> {
  const fps = options.fps ?? SATURATION_FPS;
  const plan = buildShowPlan(track.analysis, false);
  const windows = dropWindows(track.name, plan);
  if (windows.length === 0) return [];

  await renderer.setup({
    analysis: track.analysis,
    reduced: false,
    width: options.width ?? 320,
    height: options.height ?? 180,
    dpr: options.dpr ?? 1,
    quality: options.quality ?? 1,
    settings: options.settings ?? DEFAULT_SETTINGS,
    reducedMotion: options.reducedMotion ?? false,
  });

  const out: DropSaturation[] = [];
  for (const window of windows) {
    const times = sampleTimes(window.start, window.end, fps);
    const ratios = await renderer.whiteRatios(times, fps);
    const values = ratios.map((value) => Number(value.toFixed(6)));
    out.push({
      window,
      times,
      ratios: values,
      stats: stats(values),
      max: values.length > 0 ? Math.max(...values) : 0,
    });
  }
  return out;
}

/** Agrégat sur tous les échantillons de drops d'un corpus. */
export function aggregateSaturation(drops: ReadonlyArray<DropSaturation>): {
  samples: number;
  drops: number;
  stats: Stats;
  max: number;
} {
  const ratios = drops.flatMap((drop) => drop.ratios);
  return {
    samples: ratios.length,
    drops: drops.length,
    stats: stats(ratios),
    max: ratios.length > 0 ? Math.max(...ratios) : 0,
  };
}
