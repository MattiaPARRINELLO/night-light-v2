/**
 * Pureté du rendu : l'image à `t` ne dépend que de `t`, du plan et de l'analyse.
 *
 * Pour trois morceaux du corpus, on rend en continu `0 → t` sur un canvas, puis
 * on rend `t` seul sur un canvas neuf (seek), et on compare les pixels.
 *
 * Deux mesures :
 * - **à froid**, telle que la production la vit au premier rendu d'un canvas.
 *   Le premier usage du cache de dégradés de Skia décale 1 à 4 niveaux sur du
 *   fond sombre (146 à 148 pixels sur 57 600, soit 0,26 %, jamais dans les
 *   blancs). C'est un artefact du moteur de canvas, pas un état accumulé :
 *   tolérance documentée `CANVAS_TOLERANCE_RATIO` / `CANVAS_TOLERANCE_DELTA` ;
 * - **après chauffe identique** des deux canvas, la comparaison doit être
 *   **exactement** nulle : c'est le contrat de pureté strict.
 *
 * Le rendu passe par Chromium headless (vrai canvas 2D), pas par un faux
 * contexte : une différence au-delà de la tolérance serait une vraie régression.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { buildShowPlan } from "../../src/core/show";
import { DEFAULT_SETTINGS } from "../../src/types";
import { loadCorpusAnalyses, type PlanTrack } from "../support/plan_corpus";
import { createHeadlessRenderer, type HeadlessRenderer } from "../support/headless_render";

/**
 * Tolérance du premier rendu sur un canvas neuf : 0,5 % des pixels et
 * 4 niveaux par canal. Mesuré sur le corpus : 0,26 % et 4 niveaux.
 */
const CANVAS_TOLERANCE_RATIO = 0.005;
const CANVAS_TOLERANCE_DELTA = 4;
const WIDTH = 320;
const HEIGHT = 180;
const FPS = 10;

let renderer: HeadlessRenderer;
let tracks: PlanTrack[];
let selected: PlanTrack[];

function setupOf(track: PlanTrack) {
  return {
    analysis: track.analysis,
    reduced: false,
    width: WIDTH,
    height: HEIGHT,
    dpr: 1,
    quality: 1,
    settings: DEFAULT_SETTINGS,
    reducedMotion: false,
  };
}

function measureTimes(track: PlanTrack): number[] {
  const plan = buildShowPlan(track.analysis, false);
  const first = plan.scenes[0];
  const second = plan.scenes[1];
  const mid = first === undefined ? plan.duration / 2 : Math.max(1, first.end - 1);
  const boundary = second === undefined ? plan.duration * 0.6 : Math.min(plan.duration - 0.5, second.start + 0.25);
  return [mid, boundary];
}

beforeAll(async () => {
  tracks = loadCorpusAnalyses();
  const names = ["60bpm", "128bpm", "rich"];
  selected = names.map((name) => {
    const track = tracks.find((candidate) => candidate.name === name);
    if (track === undefined) throw new Error(`piste absente du corpus : ${name}`);
    return track;
  });
  renderer = await createHeadlessRenderer();
}, 120_000);

afterAll(async () => {
  await renderer?.close();
});

describe("pureté du rendu", () => {
  test(
    "rendu continu puis seek : écart dans la tolérance canvas à froid",
    async () => {
      for (const track of selected) {
        for (const time of measureTimes(track)) {
          const result = await renderer.compareContinuousSeek({
            ...setupOf(track),
            time,
            fps: FPS,
          });
          expect(result.totalPixels).toBe(WIDTH * HEIGHT * 1);
          expect(result.scenes).toBeGreaterThan(0);
          const ratio = result.diffPixels / result.totalPixels;
          expect({
            track: track.name,
            time: result.time,
            withinRatio: ratio <= CANVAS_TOLERANCE_RATIO,
            withinDelta: result.maxDelta <= CANVAS_TOLERANCE_DELTA,
          }).toEqual({
            track: track.name,
            time: result.time,
            withinRatio: true,
            withinDelta: true,
          });
        }
      }
    },
    240_000,
  );

  test(
    "après chauffe identique des canvas, continu et seek sont identiques au pixel",
    async () => {
      for (const track of selected) {
        for (const time of measureTimes(track)) {
          const result = await renderer.compareContinuousSeek({
            ...setupOf(track),
            time,
            fps: FPS,
            warmup: true,
          });
          expect({
            track: track.name,
            time: result.time,
            diffPixels: result.diffPixels,
            maxDelta: result.maxDelta,
            hashContinuous: result.hashContinuous,
            hashSeek: result.hashSeek,
            diffBBox: result.diffBBox,
          }).toEqual({
            track: track.name,
            time: result.time,
            diffPixels: 0,
            maxDelta: 0,
            hashContinuous: result.hashContinuous,
            hashSeek: result.hashContinuous,
            diffBBox: null,
          });
        }
      }
    },
    240_000,
  );

  test(
    "l'image n'est pas vide (garde-fou de mesure)",
    async () => {
      const track = selected[1]!;
      await renderer.setup(setupOf(track));
      const stats = await renderer.imageStats(10, 100);
      expect(stats.total).toBe(WIDTH * HEIGHT);
      expect(stats.hash).toMatch(/^[0-9a-f]{8}$/);
      expect(stats.whiteRatio).toBeGreaterThanOrEqual(0);
      expect(stats.whiteRatio).toBeLessThanOrEqual(1);
    },
    120_000,
  );
});
