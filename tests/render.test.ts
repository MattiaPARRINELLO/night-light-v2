import { describe, expect, test } from "bun:test";

import { renderFrame, sceneHue } from "../src/core/render";
import { buildShowPlan } from "../src/core/show";
import { QUALITY_STEPS, hash01, quantizeQuality } from "../src/core/series";
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

function renderAt(time: number, analysisData: Analysis = analysis(), settings = DEFAULT_SETTINGS, quality = 1) {
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
    quality,
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
    for (const family of [
      "beams",
      "tunnel",
      "particles",
      "waves",
      "grid",
      "rings",
      "shutters",
      "bars",
      "spiral",
      "spots",
      "mirror",
      "parade",
      "crossfire",
    ] as const) {
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

  test("les faisceaux en miroir sont reellement symetriques", () => {
    // Une scène unique couvrant tout le morceau, et un temps au tout début de
    // la phrase : aucune autre couche (fond, variation, wash, impact) ne vient
    // s'ajouter aux tracés, donc chaque tracé vient bien de `mirror`.
    const data = analysis();
    const plan = buildShowPlan(data, false);
    plan.scenes = [
      { ...plan.scenes[0]!, family: "mirror", variant: "mirror", backdrop: "mirror", start: 0, end: 60 },
    ];
    const { ctx, operations } = fakeContext();
    renderFrame({
      ctx,
      width: 800,
      height: 600,
      dpr: 1,
      time: 2,
      view: new TrackView(data),
      plan,
      settings: DEFAULT_SETTINGS,
      reducedMotion: false,
      quality: 1,
      frame: 0,
    });

    // Chaque lampe dessine deux tracés par côté : son faisceau (triangle) puis
    // son point lumineux. `mirror` boucle donc sur [gauche, droite], ce qui
    // donne par paire : faisceau_g, lampe_g, faisceau_d, lampe_d.
    // `mirror` dessine 8 paires, soit 32 tracés (faisceau + lampe, gauche +
    // droite). Les couches suivantes (scène sortante, poussière) dessinent
    // aussi des arcs : le test ne regarde que la couche `mirror`, au début.
    const paths: string[][] = [];
    let mirrorPaths = 0;
    for (let i = 0; i < operations.length && mirrorPaths < 32; i += 1) {
      if (operations[i] !== "beginPath") continue;
      const end = operations.indexOf("fill", i + 1);
      if (end === -1) continue;
      paths.push(operations.slice(i + 1, end));
      mirrorPaths += 1;
    }
    expect(paths.length).toBe(32);

    const width = 800;
    const mirrorOp = (op: string) => {
      if (!op.includes(":")) return op;
      const [kind, rest] = op.split(":");
      const numbers = rest!.split(",").map(Number);
      // Quels indices portent un x : les deux extrémités du dégradé linéaire,
      // l'origine unique des points et des arcs. Jamais un rayon, qui devrait
      // rester positif.
      const xIndices = kind === "linear" ? [0, 2, 4] : [0];
      const flipped = numbers.map((value, index) => (xIndices.includes(index) ? width - value : value));
      return `${kind}:${flipped.map((v) => v.toFixed(1)).join(",")}`;
    };

    // Le miroir échange les deux bords d'ouverture du faisceau : les bords
    // dessinés en deuxième à gauche sont tirés en premier à droite. Seuls ces
    // tracés du milieu s'inversent, l'origine et la fermeture gardent leur ordre.
    const mirrorPair = (left: string[], right: string[]) => {
      const head = left[0]!;
      const tail = left[left.length - 1]!;
      const middle = left.slice(1, -1).map(mirrorOp).reverse();
      expect(right[0]).toBe(mirrorOp(head));
      expect(right[right.length - 1]).toBe(mirrorOp(tail));
      expect(right.slice(1, -1)).toEqual(middle);
    };

    for (let lamp = 0; lamp < paths.length; lamp += 4) {
      const beamLeft = paths[lamp]!;
      const lampLeft = paths[lamp + 1]!;
      const beamRight = paths[lamp + 2]!;
      const lampRight = paths[lamp + 3]!;
      expect(beamRight.length).toBe(beamLeft.length);
      expect(lampRight.length).toBe(lampLeft.length);
      mirrorPair(beamLeft, beamRight);
      mirrorPair(lampLeft, lampRight);
    }
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

describe("flashs", () => {
  /** Remplissages plein écran au format exact du fond (1280×720). */
  function flashFramesAt(time: number): number {
    const trace = renderAt(time).join("|").split("|");
    return trace.filter((operation) => operation === "fillRect:0.0,0.0,1280.0,720.0").length;
  }

  test("un flash part sur l'attaque du temps fort, jamais entre deux temps", () => {
    // Fond + vignette en permanence, + 1 quand le flash part. Les temps forts
    // tombent sur 8,0 / 8,5 / 9,0… : le flash doit naître juste après
    // l'attaque, pas pendant la décroissance ni à contretemps.
    expect(flashFramesAt(12.25)).toBe(2);
    expect(flashFramesAt(8.05)).toBe(3);
    expect(flashFramesAt(8.25)).toBe(2);
  });

  test("deux flashs restent toujours espacés d'au moins FLASH_MIN_GAP", () => {
    // Evenements = début de chaque salve de flashs.
    const events: number[] = [];
    let flashing = false;
    for (let t = 0; t < 20; t += 1 / 60) {
      const isFlash = flashFramesAt(t) > 2;
      if (isFlash && !flashing) events.push(t);
      flashing = isFlash;
    }
    expect(events.length).toBeGreaterThan(0);
    for (let i = 1; i < events.length; i += 1) {
      expect(events[i]! - events[i - 1]!).toBeGreaterThanOrEqual(0.14);
    }
  });
});

describe("stabilite de la qualite", () => {
  test("quantizeQuality ne renvoie que des paliers connus", () => {
    const steps: readonly number[] = QUALITY_STEPS;
    for (let quality = 0; quality <= 1.0001; quality += 0.001) {
      expect(steps).toContain(quantizeQuality(quality));
    }
    expect(quantizeQuality(0)).toBe(0.3);
    expect(quantizeQuality(1)).toBe(1);
    expect(quantizeQuality(0.5)).toBe(0.45);
  });

  test("deux qualites dans le meme palier dessinent exactement la meme image", () => {
    // Sans paliers, un écart de fps de 0,02 changeait le nombre d'éléments de
    // 1 à 3 unités : toutes les positions de famille étaient recalculées et
    // l'animation « sautait » d'une image à l'autre.
    const times = [3, 8.05, 20, 33.25, 47, 58];
    for (const t of times) {
      const reference = renderAt(t, analysis(), DEFAULT_SETTINGS, 0.9);
      for (const quality of [0.86, 0.89, 0.9, 0.93, 0.94]) {
        expect(renderAt(t, analysis(), DEFAULT_SETTINGS, quality).join("|")).toBe(reference.join("|"));
      }
    }
  });

  test("changer de palier change la charge, et un palier voisin ne la change plus", () => {
    const countOperations = (quality: number) => renderAt(45, analysis(), DEFAULT_SETTINGS, quality).length;
    // Paliers distincts => charge différente (la qualité sert à quelque chose).
    expect(countOperations(0.45)).not.toBe(countOperations(1));
    // A l'intérieur d'un palier, la charge ne bouge pas d'une image à l'autre.
    expect(countOperations(0.61)).toBe(countOperations(0.66));
    expect(countOperations(0.66)).toBe(countOperations(0.67));
    // Et un palier plus loin la change.
    expect(countOperations(0.8)).not.toBe(countOperations(0.45));
  });

  test("toute qualite d'un meme palier donne l'image du palier, sur tous les temps", () => {
    // La propriété qui compte : deux fps voisins (donc deux qualités voisines)
    // ne doivent jamais changer ce qui est dessiné. C'est ce qui causait les
    // animations qui « sautent ».
    for (let i = 0; i < 40; i += 1) {
      const step = QUALITY_STEPS[i % QUALITY_STEPS.length] ?? 1;
      const low = Math.max(0, Math.min(1, step + (hash01(i) - 0.5) * 0.12));
      const high = Math.max(0, Math.min(1, step + (hash01(i + 997) - 0.5) * 0.12));
      if (quantizeQuality(low) !== step || quantizeQuality(high) !== step) continue;
      const time = 2 + (i % 55);
      const first = renderAt(time, analysis(), DEFAULT_SETTINGS, low);
      const second = renderAt(time, analysis(), DEFAULT_SETTINGS, high);
      expect(second.join("|")).toBe(first.join("|"));
    }
  });
});

describe("couleur", () => {
  /** Écart angulaire entre deux teintes, 0..180. */
  function hueGap(a: number, b: number): number {
    return Math.abs(((b - a + 540) % 360) - 180);
  }

  test("la dérive de teinte porte sur le temps du morceau, pas sur la scène", () => {
    const scene = buildShowPlan(analysis(), false).scenes[0]!;
    // La teinte ne doit aucune dépendance à `scene.start` : sinon elle repartait
    // de zéro à chaque changement de scène et la couleur faisait un bond.
    const early = sceneHue({ ...scene, start: 0 }, 30, 0, 0, false);
    const late = sceneHue({ ...scene, start: 22 }, 30, 0, 0, false);
    expect(early).toBe(late);
  });

  test("la teinte glisse continûment, sans saut, dans le temps", () => {
    const scene = buildShowPlan(analysis(), false).scenes[0]!;
    let previous = sceneHue(scene, 0, 0, 0, false);
    for (let t = 0.1; t < 60; t += 0.1) {
      const hue = sceneHue(scene, t, 0, 0, false);
      // 14 degrés par seconde => 1,4 degré par pas de 0,1 s.
      expect(hueGap(previous, hue)).toBeLessThan(2);
      previous = hue;
    }
  });
});
