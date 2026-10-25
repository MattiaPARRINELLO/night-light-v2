/**
 * Robustesse de l'analyse DÉGÉNÉRÉE jusqu'au rendu.
 *
 * Ces tests fabriquent des analyses que le serveur ne devrait jamais produire
 * (tempo 0/NaN, courbes NaN, temps forts vides, couverture partielle) et
 * vérifient le contrat : le plan se construit, cinq images se rendent, et
 * aucune valeur non finie ne fuit. Un échec ici est un bug de production :
 * il est marqué `test.failing` et référence le fichier:ligne fautif.
 */

import { describe, expect, test } from "bun:test";

import { buildShowPlan, sceneAt } from "../../src/core/show";
import { renderFrame } from "../../src/core/render";
import { TrackView } from "../../src/core/view";
import { DEFAULT_SETTINGS, type Analysis } from "../../src/types";

/** Contexte factice qui enregistre les opérations sous forme de texte. */
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
    moveTo: () => operations.push("moveTo"),
    lineTo: () => operations.push("lineTo"),
    arc: () => operations.push("arc"),
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

function analysis(overrides: Partial<Analysis> = {}): Analysis {
  const beats = Array.from({ length: 21 }, (_, index) => index * 0.5);
  return {
    schema: 2,
    duration: 10,
    tempo: 120,
    beatCount: beats.length,
    beatPeriod: 0.5,
    beats,
    onsets: beats.map((beat) => beat + 0.1),
    energy: [
      [0, 0.4],
      [5, 0.8],
      [10, 0.5],
    ],
    bass: [
      [0, 0.6],
      [10, 0.6],
    ],
    mid: [
      [0, 0.5],
      [10, 0.5],
    ],
    high: [
      [0, 0.4],
      [10, 0.4],
    ],
    sections: [],
    builds: [],
    ...overrides,
  };
}

/** Toutes les feuilles numériques du plan sont finies ; renvoie le chemin fautif. */
function firstNonFinite(value: unknown, path = "plan"): string | null {
  if (typeof value === "number") return Number.isFinite(value) ? null : path;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = firstNonFinite(value[index], `${path}[${index}]`);
      if (found !== null) return found;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const found = firstNonFinite(child, `${path}.${key}`);
      if (found !== null) return found;
    }
  }
  return null;
}

function renderFive(data: Analysis): string[] {
  const plan = buildShowPlan(data, false);
  const view = new TrackView(data);
  const { ctx, operations } = fakeContext();
  for (let index = 0; index < 5; index += 1) {
    const time = data.duration * (index / 5);
    renderFrame({
      ctx,
      width: 640,
      height: 360,
      dpr: 1,
      time,
      view,
      plan,
      settings: DEFAULT_SETTINGS,
      reducedMotion: false,
      quality: 1,
      frame: index,
    });
  }
  return operations;
}

describe("entrées dégénérées : plan et rendu survivent", () => {
  test("un tempo non détecté (0) laisse construire un plan fini", () => {
    const data = analysis({ tempo: 0, beatPeriod: 0, beats: [] });
    const plan = buildShowPlan(data, false);
    expect(firstNonFinite(plan)).toBeNull();
    expect(plan.scenes.length).toBeGreaterThan(0);
    expect(plan.barStarts.every((value) => Number.isFinite(value))).toBe(true);
    expect(() => renderFive(data)).not.toThrow();
  });

  test("onsets, montées et sections vides : aucune exception, aucune valeur non finie", () => {
    const data = analysis({ onsets: [], builds: [], sections: [] });
    const plan = buildShowPlan(data, false);
    expect(firstNonFinite(plan)).toBeNull();
    const trace = renderFive(data).join("|");
    expect(trace.includes("NaN")).toBe(false);
    expect(trace.includes("Infinity")).toBe(false);
  });

  test("5 images se rendent sur toute durée autour du seuil de scène", () => {
    for (const duration of [4.9, 5.0, 5.1]) {
      const data = analysis({
        duration,
        beats: [0, 1, 2, 3, 4].filter((beat) => beat <= duration),
        onsets: [0.1, 1.1, 2.1].filter((onset) => onset <= duration),
        energy: [
          [0, 0.4],
          [duration, 0.8],
        ],
      });
      const plan = buildShowPlan(data, false);
      expect(firstNonFinite(plan)).toBeNull();
      expect(plan.scenes[0]?.start).toBe(0);
      expect(plan.scenes[plan.scenes.length - 1]?.end).toBeCloseTo(duration, 3);
      expect(() => renderFive({ ...data, duration })).not.toThrow();
    }
  });

  test("la couverture partielle est signalée dans le plan", () => {
    // Une analyse fenêtrée met les courbes à 0 hors de [2, 6]. Le plan ne doit
    // pas se contenter d'en déduire « calme » : il doit exposer la fenêtre.
    const data = analysis({
      duration: 10,
      coverage: [2, 6],
      energy: [
        [0, 0],
        [2, 0.5],
        [6, 0.7],
        [10, 0],
      ],
    });
    const plan = buildShowPlan(data, false);
    expect(plan.coverage).toEqual([2, 6]);
    // Le plan est construit sur toute la durée, mais la fenêtre est le signal
    // explicite de ce qui a réellement été analysé.
    expect(plan.duration).toBe(10);
    expect(() => renderFive(data)).not.toThrow();
  });

  // Le NaN traverse `caractereAt` (src/core/show.ts:301-304) puis
  // `moodIntensity` (src/core/show.ts:432-444), mais `clamp01`
  // (src/core/series.ts:57-66) le ramène à 0 avant qu'il n'atteigne le plan.
  test("des courbes NaN ne contaminent pas le plan", () => {
    const data = analysis({
      energy: [
        [0, Number.NaN],
        [5, 0.8],
        [10, 0.5],
      ],
    });
    const plan = buildShowPlan(data, false);
    expect(firstNonFinite(plan)).toBeNull();
  });

  test("des courbes NaN ne contaminent pas le rendu", () => {
    const data = analysis({
      energy: [
        [0, Number.NaN],
        [5, 0.8],
        [10, 0.5],
      ],
    });
    const trace = renderFive(data).join("|");
    expect(trace.includes("NaN")).toBe(false);
  });

  // `beatPhase` divise par `beatPeriod` sans garde de finitude
  // (src/core/view.ts:187-188) : `NaN <= 0` est faux, le repli n'est pas pris
  // et la phase vaut NaN — mais `clamp01` (src/core/series.ts:64) l'annule.
  test("un beatPeriod NaN ne fait pas fuiter de NaN dans le rendu", () => {
    const data = analysis({ tempo: Number.NaN, beatPeriod: Number.NaN, beats: [] });
    const trace = renderFive(data).join("|");
    expect(trace.includes("NaN")).toBe(false);
  });
});

describe("contrat minimal du rendu sur entrées dégénérées", () => {
  test("le plan reste consommable par sceneAt à tous les instants", () => {
    const data = analysis({ tempo: 0, beatPeriod: 0, beats: [], builds: [] });
    const plan = buildShowPlan(data, false);
    for (const time of [-1, 0, 2.5, 5, 9.999, 10, 20]) {
      const scene = sceneAt(plan, time);
      expect(Number.isFinite(scene.intensity)).toBe(true);
      expect(Number.isFinite(scene.palette.hue)).toBe(true);
      expect(Number.isFinite(scene.palette.saturation)).toBe(true);
      expect(Number.isFinite(scene.palette.lightness)).toBe(true);
    }
  });
});
