/**
 * Propriétés du rendu (`renderFrame`), sur les analyses RÉELLES du corpus.
 *
 * Le rendu doit rester une fonction PURE du temps musical : même t sur un
 * contexte partagé ⇒ même trace d'opérations, quel que soit l'ordre des appels
 * ou le pas d'échantillonnage. Les tests existants (`render.test.ts`) couvrent
 * un contexte neuf et quality=1 ; ici on couvre le cache de vignette, la
 * qualité adaptative, la continuité et la lisibilité des flashs.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  beatStrength,
  ENERGY_FLOOR,
  flashAdmitted,
  flashAlpha,
  renderFrame,
  sceneHue,
  surgeAlpha,
  visibleEnergy,
} from "../../src/core/render";
import { buildShowPlan, sceneAt } from "../../src/core/show";
import { createTrackView } from "../../src/core/view";
import { count } from "../../src/core/families/util";
import { QUALITY_STEPS, quantizeQuality } from "../../src/core/series";
import { DEFAULT_SETTINGS, type Analysis, type RenderSettings } from "../../src/types";
import { corpusAnalyses } from "../support/corpus";
import type { FrameState } from "../../src/core/families";

const tracks = corpusAnalyses();

function fakeContext(): { ctx: CanvasRenderingContext2D; operations: string[] } {
  const operations: string[] = [];
  const gradient = {
    addColorStop: (offset: number, color: string) => operations.push(`stop:${offset}:${color}`),
  };
  const ctx = {
    canvas: { width: 0, height: 0 },
    globalCompositeOperation: "source-over",
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    strokeStyle: "",
    _alpha: 1,
    _fill: "",
    _filter: "none",
    get filter() {
      return this._filter;
    },
    set filter(value: string) {
      this._filter = value;
      operations.push(`filter:${value}`);
    },
    get fillStyle() {
      return this._fill;
    },
    set fillStyle(value: string) {
      this._fill = value;
      operations.push(`fillStyle:${value}`);
    },
    get globalAlpha() {
      return this._alpha;
    },
    set globalAlpha(value: number) {
      this._alpha = value;
      operations.push(`alpha:${value}`);
    },
    setTransform: () => operations.push("setTransform"),
    clearRect: () => operations.push("clearRect"),
    drawImage: () => operations.push("drawImage"),
    fillRect: (x: number, y: number, w: number, h: number) =>
      operations.push(`fillRect:${x},${y},${w},${h}`),
    beginPath: () => operations.push("beginPath"),
    closePath: () => operations.push("closePath"),
    moveTo: (x: number, y: number) => operations.push(`moveTo:${x},${y}`),
    lineTo: (x: number, y: number) => operations.push(`lineTo:${x},${y}`),
    arc: (x: number, y: number, r: number) => operations.push(`arc:${x},${y},${r}`),
    quadraticCurveTo: () => operations.push("quadraticCurveTo"),
    fill: () => operations.push("fill"),
    stroke: () => operations.push("stroke"),
    createLinearGradient: () => {
      operations.push("linear");
      return gradient;
    },
    createRadialGradient: () => {
      operations.push("radial");
      return gradient;
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, operations };
}

/** Le rendu n'accepte pas un contexte incomplet : on l'utilise tel quel. */
function renderOnce(
  ctx: CanvasRenderingContext2D,
  analysis: Analysis,
  time: number,
  quality = 1,
  settings: RenderSettings = DEFAULT_SETTINGS,
): void {
  const view = createTrackView(analysis);
  const plan = buildShowPlan(analysis, settings.reduced);
  renderFrame({
    ctx,
    width: 1280,
    height: 720,
    dpr: 1,
    time,
    view,
    plan,
    settings,
    reducedMotion: false,
    quality,
    frame: Math.round(time * 60),
  });
}

/**
 * Normalise la trace : l'identité des dégradés mis en cache n'est pas
 * sémantique. On garde les arrêts de couleur (le visuel) et on retire les
 * marqueurs de création, qui ne sont émis qu'au premier passage.
 */
function semantic(operations: string[]): string[] {
  return operations.filter(
    (operation) => operation !== "linear" && operation !== "radial",
  );
}

function analyseFlashes(analysis: Analysis, settings: RenderSettings = DEFAULT_SETTINGS) {
  const view = createTrackView(analysis);
  const events: Array<{ drop: boolean; alpha: number; at: number }> = [];
  let inEvent = false;
  let peak = 0;
  let drop = false;
  let start = 0;
  let last = -Infinity;
  const flush = () => {
    if (inEvent) events.push({ drop, alpha: peak, at: start });
    inEvent = false;
    peak = 0;
    drop = false;
  };
  for (let t = 0; t < analysis.duration; t += 1 / 30) {
    const energy = visibleEnergy(view.energyAt(t));
    const state = {
      reduced: false,
      beat: beatStrength(view, t),
      bass: view.bassAt(t),
      build: view.buildProgress(t),
      buildStrength: view.buildAt(t)?.strength ?? 0,
      energy,
      surge: view.energyTrend(t, 1.2),
    } as unknown as FrameState;
    const alpha = Math.max(flashAlpha(state, settings), surgeAlpha(state, settings));
    const admitted = alpha > 0.002 && flashAdmitted(view, t);
    if (admitted) {
      if (!inEvent || t - last > 0.3) {
        flush();
        inEvent = true;
        start = t;
        drop = view.buildsEndingIn(t - 0.2, t).length > 0;
        last = t;
      }
      peak = Math.max(peak, alpha);
    } else if (inEvent && t - last > 0.3) {
      flush();
    }
  }
  flush();
  return events;
}

describe("R1 — pureté sur contexte partagé (cache de vignette compris)", () => {
  for (const { name, analysis } of tracks.slice(0, 3)) {
    test(`deux rendus au même t sur le même contexte sont identiques : ${name}`, () => {
      const { ctx, operations } = fakeContext();
      renderOnce(ctx, analysis, 1); // amorce le cache de vignette
      const length = operations.length;
      renderOnce(ctx, analysis, 12.5);
      const first = semantic(operations.slice(length));
      const start = operations.length;
      renderOnce(ctx, analysis, 12.5);
      const second = semantic(operations.slice(start));
      expect(second.join("|")).toBe(first.join("|"));
    });
  }
});

describe("R2 — pureté vis-à-vis de l'ordre (seek arrière, pause, reprise)", () => {
  for (const { name, analysis } of tracks.slice(0, 3)) {
    test(`rendre 10, puis 3, puis 10 redonne la même image : ${name}`, () => {
      const { ctx, operations } = fakeContext();
      renderOnce(ctx, analysis, 1); // amorce le cache
      const startFirst = operations.length;
      renderOnce(ctx, analysis, 10);
      const first = semantic(operations.slice(startFirst));

      renderOnce(ctx, analysis, 3);
      const startSecond = operations.length;
      renderOnce(ctx, analysis, 10);
      const second = semantic(operations.slice(startSecond));
      expect(second.join("|")).toBe(first.join("|"));
    });
  }
});

describe("R3 — pureté vis-à-vis du pas et du point de départ", () => {
  const { analysis } = tracks[0]!;

  test("la décision de flash à un t partagé ne dépend pas du pas (1/60 vs 1/30)", () => {
    const view = createTrackView(analysis);
    const fast = new Map<number, boolean>();
    for (let t = 0; t < analysis.duration; t += 1 / 60) fast.set(Number(t.toFixed(6)), flashAdmitted(view, t));
    for (let t = 0; t < analysis.duration; t += 1 / 30) {
      const key = Number(t.toFixed(6));
      if (fast.has(key)) expect(flashAdmitted(view, t)).toBe(fast.get(key)!);
    }
  });

  test("un départ décalé ne change pas les décisions sur les instants communs", () => {
    const view = createTrackView(analysis);
    const reference = new Map<number, boolean>();
    for (let step = 0; step < analysis.duration * 30; step += 1) {
      const t = step / 30;
      reference.set(Number(t.toFixed(6)), flashAdmitted(view, t));
    }
    for (let step = 1; step < analysis.duration * 30; step += 7) {
      const t = step / 30;
      expect(flashAdmitted(view, t)).toBe(reference.get(Number(t.toFixed(6)))!);
    }
  });
});

describe("R4 — qualité adaptative", () => {
  test("deux qualités brutes du même palier donnent exactement la même image", () => {
    const { analysis } = tracks[0]!;
    const first = fakeContext();
    const second = fakeContext();
    renderOnce(first.ctx, analysis, 8, 0.951);
    renderOnce(second.ctx, analysis, 8, 1);
    expect(quantizeQuality(0.951)).toBe(quantizeQuality(1));
    expect(semantic(second.operations).join("|")).toBe(semantic(first.operations).join("|"));
  });

  test("le nombre d'éléments suit la formule de count() et ne descend jamais sous 3", () => {
    for (const quality of QUALITY_STEPS) {
      for (const base of [5, 8, 16, 28]) {
        for (const reduced of [false, true]) {
          // src/core/families/util.ts:9-12
          const expected = Math.max(
            3,
            Math.round(base * (reduced ? 0.55 : 1) * (0.45 + 0.55 * quantizeQuality(quality))),
          );
          expect(count(base, quality, reduced)).toBe(expected);
          expect(count(base, quality, reduced)).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  test("entre deux paliers, le nombre d'éléments augmente avec la qualité", () => {
    const low = count(16, 0.3, false);
    const high = count(16, 1, false);
    expect(high).toBeGreaterThan(low);
  });
});

describe("R5 — aucun état caché : ni hasard, ni horloge dans le cœur du rendu", () => {
  const ROOT = resolve(import.meta.dir, "../..");
  const CORE = join(ROOT, "src/core");
  // Fichiers explicitement autorisés à lire l'horloge ou le hasard : ils
  // parlent au monde extérieur (API, debug, audio live, lecture), pas au rendu.
  const allowed = new Set([
    "api.ts",
    "debug.ts",
    "liveAudio.ts",
    "playback.ts",
    "nowPlaying.ts",
  ]);

  test("render.ts, show.ts et families/ n'utilisent ni Math.random, ni Date.now, ni performance.now", () => {
    const offenders: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        if (allowed.has(entry.name)) continue;
        const source = readFileSync(path, "utf8");
        for (const forbidden of ["Math.random", "Date.now", "performance.now"]) {
          if (source.includes(forbidden)) offenders.push(`${path} → ${forbidden}`);
        }
      }
    };
    walk(CORE);
    expect(offenders).toEqual([]);
  });
});

describe("R6 — continuité de la teinte hors événement", () => {
  // Seuil « raisonnable » : bien au-dessus du glissement normal (0,4°/s + 14°
  // de respiration), très en dessous d'un saut de palette (~180°).
  const THRESHOLD = 8;

  test.failing(`|Δ teinte| image à image < ${THRESHOLD}° hors drop/variation (render.ts:350-361)`, () => {
    const worst: string[] = [];
    for (const { name, analysis } of tracks) {
      const plan = buildShowPlan(analysis, false);
      const view = createTrackView(analysis);
      let previous: number | null = null;
      let maximum = 0;
      let at = 0;
      for (let t = 0; t < analysis.duration; t += 1 / 30) {
        const scene = sceneAt(plan, t);
        const drop = Math.max(view.buildIntensity(t), 0);
        const variation = 0; // la variation est un événement, exclue
        const hue = sceneHue(scene, t, drop, variation, false);
        const event = view.buildsEndingIn(t - 0.4, t + 0.4).length > 0;
        if (previous !== null && !event) {
          const delta = Math.abs((((hue - previous) % 360) + 540) % 360 - 180);
          if (delta > maximum) {
            maximum = delta;
            at = t;
          }
        }
        previous = hue;
      }
      worst.push(`${name}: ${maximum.toFixed(1)}° à ${at.toFixed(2)} s`);
    }
    const offenders = worst
      .map((entry) => ({ entry, value: Number(entry.split(": ")[1]!.split("°")[0]) }))
      .filter(({ value }) => value >= THRESHOLD)
      .map(({ entry }) => entry);
    expect(offenders, `pires écarts hors événement : ${worst.join(" | ")}`).toEqual([]);
  });
});

describe("R7 — l'écran n'est jamais mort", () => {
  for (const { name, analysis } of tracks) {
    test(`énergie visible ≥ ${ENERGY_FLOOR} sur toute la durée : ${name}`, () => {
      const view = createTrackView(analysis);
      let below = 0;
      for (let t = 0; t < analysis.duration; t += 1 / 30) {
        if (visibleEnergy(view.energyAt(t)) < ENERGY_FLOOR) below += 1;
      }
      expect(below, `${below} images sous le plancher`).toBe(0);
    });
  }

  test("la piste f (silence réel au milieu) continue de dessiner", () => {
    const { analysis } = tracks.find((track) => track.name === "f_silence_milieu")!;
    const { ctx, operations } = fakeContext();
    renderOnce(ctx, analysis, 20); // dans le silence (15 s → 25 s)
    expect(operations.length).toBeGreaterThan(20);
    expect(operations.some((operation) => operation.startsWith("fillRect:"))).toBe(true);
  });
});

describe("F1 — un flash naît sur un temps fort ou un build, jamais dans le vide", () => {
  for (const { name, analysis } of tracks.slice(0, 5)) {
    test(`premier instant d'un flash ≤ 1 image d'un déclencheur : ${name}`, () => {
      const events = analyseFlashes(analysis);
      if (events.length === 0) return;
      const view = createTrackView(analysis);
      const step = 1 / 30;
      for (const event of events) {
        const beats = view.beatsIn(event.at - step - 1e-6, event.at + 1e-6);
        const lastBuild = view.lastBuildEnd(event.at);
        const nearBeat = beats.some((beat) => Math.abs(event.at - beat) <= step + 1e-6);
        const nearDrop = Number.isFinite(lastBuild) && event.at - lastBuild >= -1e-6 && event.at - lastBuild <= step + 1e-6;
        expect(
          nearBeat || nearDrop,
          `flash à ${event.at.toFixed(3)} s sans temps fort ni build à ±${step.toFixed(3)} s (${name})`,
        ).toBe(true);
      }
    });
  }
});

describe("F2 — les flashs de drop sont plus forts que les flashs ordinaires", () => {
  test.failing("alpha médian d'un flash de drop ≥ 2 × alpha médian ordinaire (render.ts:145-155)", () => {
    const ratios: string[] = [];
    for (const { name, analysis } of tracks) {
      const events = analyseFlashes(analysis);
      const drops = events.filter((event) => event.drop).map((event) => event.alpha);
      const ordinary = events.filter((event) => !event.drop).map((event) => event.alpha);
      if (drops.length === 0 || ordinary.length === 0) continue;
      const median = (values: number[]) => {
        const sorted = [...values].sort((left, right) => left - right);
        const middle = Math.floor(sorted.length / 2);
        return sorted.length % 2 === 1
          ? sorted[middle]!
          : (sorted[middle - 1]! + sorted[middle]!) / 2;
      };
      const ratio = median(drops) / median(ordinary);
      ratios.push(`${name}: ${ratio.toFixed(2)}× (drop ${median(drops).toFixed(3)}, ordinaire ${median(ordinary).toFixed(3)})`);
      expect(ratio, `${name}: ${ratio.toFixed(2)}×`).toBeGreaterThanOrEqual(2);
    }
    // Les paires observées sont dans le message ci-dessus.
    expect(ratios.length).toBeGreaterThan(0);
  });
});

describe("F3 — cadence de flash mesurée, sans plafond", () => {
  for (const { name, analysis } of tracks) {
    test(`cadence consignée : ${name}`, () => {
      const events = analyseFlashes(analysis);
      const perMinute = events.length / Math.max(analysis.duration / 60, 1e-9);
      // C'est une donnée de direction artistique : on la consigne, on ne la
      // contraint pas. La valeur exacte est dans le message du test.
      expect(
        Number.isFinite(perMinute) && perMinute >= 0,
        `${name}: ${perMinute.toFixed(1)} flashs/min (${events.length} événements sur ${analysis.duration.toFixed(0)} s)`,
      ).toBe(true);
    });
  }
});
