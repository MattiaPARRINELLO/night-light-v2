import { describe, expect, test } from "bun:test";

import { renderFrame } from "../src/core/render";
import { buildShowPlan } from "../src/core/show";
import { TrackView } from "../src/core/view";
import { DEFAULT_SETTINGS } from "../src/types";
import type { Analysis } from "../src/types";

/**
 * Faux contexte 2D : enregistre chaque opération pour vérifier que le rendu est
 * une fonction du temps musical (indispensable pour rester synchronisé après
 * une pause ou un retour en arrière).
 */
function fakeContext() {
  const operations: string[] = [];
  const gradient = {
    addColorStop: (offset: number, color: string) => operations.push(`stop:${offset}:${color}`),
  };
  const ctx = {
    canvas: { width: 0, height: 0 },
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    strokeStyle: "",
    fillStyle: "",
    setTransform: () => operations.push("setTransform"),
    clearRect: () => operations.push("clearRect"),
    fillRect: (x: number, y: number, w: number, h: number) =>
      operations.push(`fillRect:${x.toFixed(1)},${y.toFixed(1)},${w.toFixed(1)},${h.toFixed(1)}`),
    beginPath: () => operations.push("beginPath"),
    closePath: () => operations.push("closePath"),
    moveTo: (x: number, y: number) => operations.push(`moveTo:${x.toFixed(1)},${y.toFixed(1)}`),
    lineTo: (x: number, y: number) => operations.push(`lineTo:${x.toFixed(1)},${y.toFixed(1)}`),
    arc: (x: number, y: number, r: number) => operations.push(`arc:${x.toFixed(1)},${y.toFixed(1)},${r.toFixed(1)}`),
    fill: () => operations.push("fill"),
    stroke: () => operations.push("stroke"),
    createLinearGradient: (...args: number[]) => {
      operations.push(`linear:${args.map((value) => value.toFixed(1)).join(",")}`);
      return gradient;
    },
    createRadialGradient: (...args: number[]) => {
      operations.push(`radial:${args.map((value) => value.toFixed(1)).join(",")}`);
      return gradient;
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, operations };
}

function analysis(overrides: Partial<Analysis> = {}): Analysis {
  const beats: number[] = [];
  for (let t = 0; t <= 60; t += 0.5) beats.push(Number(t.toFixed(3)));
  return {
    schema: 1,
    duration: 60,
    tempo: 120,
    beatCount: beats.length,
    beatPeriod: 0.5,
    beats,
    onsets: beats.map((beat) => beat + 0.25),
    energy: [
      [0, 0.2],
      [20, 0.5],
      [40, 0.95],
      [60, 0.3],
    ],
    bass: [
      [0, 0.3],
      [30, 0.6],
      [60, 0.9],
    ],
    mid: [
      [0, 0.4],
      [30, 0.5],
      [60, 0.6],
    ],
    high: [
      [0, 0.2],
      [30, 0.5],
      [60, 0.8],
    ],
    sections: [
      { start: 0, end: 20, label: "calme", energy: 0.3 },
      { start: 20, end: 40, label: "montee", energy: 0.6 },
      { start: 40, end: 60, label: "intense", energy: 0.9 },
    ],
    builds: [{ start: 18, end: 22, strength: 0.8 }],
    ...overrides,
  };
}

function renderAt(time: number, analysisData: Analysis = analysis(), settings = DEFAULT_SETTINGS) {
  const { ctx, operations } = fakeContext();
  const view = new TrackView(analysisData);
  const plan = buildShowPlan(analysisData, settings.reduced);
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
    quality: 1,
    frame: Math.round(time * 60),
  });
  return operations;
}

describe("rendu déterministe", () => {
  test("deux images au même temps musical sont identiques", () => {
    const first = renderAt(33.25);
    const second = renderAt(33.25);
    expect(second.join("|")).toBe(first.join("|"));
  });

  test("deux temps différents donnent des images différentes", () => {
    expect(renderAt(33.25).join("|")).not.toBe(renderAt(34.25).join("|"));
  });

  test("aucune couleur NaN ne fuite dans le rendu", () => {
    for (const time of [0.5, 5, 12.5, 22, 33.25, 47, 59]) {
      const trace = renderAt(time).join("|");
      expect(trace.includes("NaN")).toBe(false);
    }
  });

  test("chaque image dessine bien quelque chose", () => {
    const operations = renderAt(12);
    expect(operations.length).toBeGreaterThan(20);
    expect(operations.some((operation) => operation.startsWith("fillRect:"))).toBe(true);
    expect(operations).toContain("fill");
  });

  test("toutes les familles visuelles rendent sans erreur", () => {
    for (const family of ["beams", "tunnel", "particles", "waves", "grid", "rings"] as const) {
      const data = analysis();
      const plan = buildShowPlan(data, false);
      plan.scenes = plan.scenes.map((scene) => ({ ...scene, family }));
      const { ctx, operations } = fakeContext();
      renderFrame({
        ctx,
        width: 800,
        height: 600,
        dpr: 1,
        time: 25,
        view: new TrackView(data),
        plan,
        settings: DEFAULT_SETTINGS,
        reducedMotion: false,
        quality: 1,
        frame: 0,
      });
      expect(operations.length).toBeGreaterThan(5);
    }
  });

  test("un temps hors bornes reste rendable", () => {
    expect(() => renderAt(-5)).not.toThrow();
    expect(() => renderAt(999)).not.toThrow();
  });

  test("une analyse sans sections ni temps forts rend quand même", () => {
    expect(() => renderAt(10, analysis({ sections: [], beats: [], onsets: [], builds: [] }))).not.toThrow();
  });
});

describe("diversite a l'ecran", () => {
  test("la teinte glisse en continu dans une phrase", () => {
    const data = analysis();
    const view = new TrackView(data);
    const plan = buildShowPlan(data, false);
    const seen = new Set<string>();
    for (const t of [10, 10.4, 10.8, 11.2]) {
      const { ctx, operations } = fakeContext();
      renderFrame({
        ctx,
        width: 320,
        height: 200,
        dpr: 1,
        time: t,
        view,
        plan,
        settings: DEFAULT_SETTINGS,
        reducedMotion: false,
        quality: 1,
        frame: 0,
      });
      const hueStops = operations.filter((operation) => operation.startsWith("stop:"));
      seen.add(hueStops.join("|"));
    }
    expect(seen.size).toBe(4);
  });

  test("un drop ajoute une sur-couche visible à l'impact", () => {
    const data = analysis();
    const plan = buildShowPlan(data, false);
    const trace = (builds: Analysis["builds"]) => {
      const view = new TrackView({ ...data, builds });
      const { ctx, operations } = fakeContext();
      renderFrame({
        ctx,
        width: 320,
        height: 200,
        dpr: 1,
        time: 8.05,
        view,
        plan,
        settings: DEFAULT_SETTINGS,
        reducedMotion: false,
        quality: 1,
        frame: 0,
      });
      return operations.join("|");
    };
    const withDrop = trace([{ start: 4, end: 8, strength: 1 }]);
    const withoutDrop = trace([]);
    expect(withDrop).not.toBe(withoutDrop);
    expect(withDrop.length).toBeGreaterThan(withoutDrop.length);
  });

  test("le mode reduit supprime la sur-couche de drop", () => {
    const data = analysis({ builds: [{ start: 4, end: 8, strength: 1 }] });
    const view = new TrackView(data);
    const plan = buildShowPlan(data, true);
    const countAt = (time: number, settings = DEFAULT_SETTINGS) => {
      const { ctx, operations } = fakeContext();
      renderFrame({
        ctx,
        width: 320,
        height: 200,
        dpr: 1,
        time,
        view,
        plan,
        settings,
        reducedMotion: false,
        quality: 1,
        frame: 0,
      });
      return operations.length;
    };
    const dropMoment = countAt(8.05, { ...DEFAULT_SETTINGS, reduced: true });
    const quietMoment = countAt(20, { ...DEFAULT_SETTINGS, reduced: true });
    expect(dropMoment).toBeLessThanOrEqual(quietMoment * 1.6);
  });
});
