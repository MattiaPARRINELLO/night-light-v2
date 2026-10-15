import { describe, expect, test } from "bun:test";

import {
  beatDrive,
  beatStrength,
  drawTransition,
  ENERGY_FLOOR,
  flashAdmitted,
  renderFrame,
  sceneHue,
  transitionAlpha,
  visibleEnergy,
} from "../src/core/render";
import { buildShowPlan, type FamilyId } from "../src/core/show";
import { drawFamily, rowPositions } from "../src/core/families";
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
    globalCompositeOperation: "source-over",
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    strokeStyle: "",
    // Les styles et l'alpha sont enregistrés à l'affectation : sans ça, on ne
    // peut pas vérifier qu'un élément est réellement visible.
    _alpha: 1,
    _fill: "",
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
      operations.push(`alpha:${Number(value.toFixed(4))}`);
    },
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

function buildBeats(step: number, until: number): number[] {
  const out: number[] = [];
  for (let t = 0; t <= until; t += step) out.push(Number(t.toFixed(3)));
  return out;
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
    // Basse forte et continue : les temps forts de ce fixture portent un kick,
    // ce qui est la condition pour qu'un flash parte.
    bass: [
      [0, 0.9],
      [30, 0.9],
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

describe("pulsage de secours sur les temps forts", () => {
  // Un morceau sans montée (rap fort d'un bout à l'autre) ne montre aucun drop :
  // le spectacle paraît mort entre deux scènes. `beatDrive` pulse alors sur les
  // temps forts, à une intensité inférieure à un vrai drop.

  test("pulse juste après un temps fort quand l'analyse trouve peu de montées", () => {
    const view = new TrackView(analysis()); // 1 seule montée (18→22 s)
    // Les temps forts tombent sur 8,0 / 8,5 / 9,0…
    expect(beatDrive(view, 8.02, 1)).toBeGreaterThan(0.4);
    expect(beatDrive(view, 8.25, 1)).toBeLessThan(0.2);
  });

  test("reste muet entre deux temps forts", () => {
    const view = new TrackView(analysis());
    expect(beatDrive(view, 8.4, 1)).toBe(0);
  });

  test("se taît dès que le morceau a assez de montées", () => {
    const view = new TrackView(analysis());
    // Jusqu'à deux montées, le morceau reste jugé peu dynamique ; à trois, les
    // vrais drops suffisent à porter le spectacle.
    expect(beatDrive(view, 8.02, 2)).toBeGreaterThan(0);
    expect(beatDrive(view, 8.02, 3)).toBe(0);
    expect(beatDrive(view, 8.02, 9)).toBe(0);
  });

  test("est dosé par l'énergie locale", () => {
    const view = new TrackView(analysis());
    const pulse = view.beatPulse(8.02, 0.45);
    const attendu = pulse * (0.35 + 0.65 * view.energyAt(8.02));
    expect(beatDrive(view, 8.02, 1)).toBeCloseTo(attendu, 6);
  });

  test("le rendu s'allume davantage sur un morceau sans montée", () => {
    // Même analyse, sauf les montées : sans le pulsage de secours, un morceau
    // sans montée ne dessine pas la surcouche d'impact à cet instant. Les
    // montées de comparaison sont loin de 8,02 s, donc inactives : la seule
    // différence d'image vient du pulsage.
    const operations = (data: Analysis) => renderAt(8.02, data).length;
    const sansMontee = operations(analysis({ builds: [] }));
    const monteesLointaines = operations(
      analysis({
        builds: [
          { start: 20, end: 24, strength: 0.9 },
          { start: 40, end: 44, strength: 0.9 },
          { start: 50, end: 54, strength: 0.9 },
        ],
      }),
    );
    expect(sansMontee).toBeGreaterThan(monteesLointaines);
  });
});

describe("moderation des flashs", () => {
  test("les flashs de temps fort restent espacés d'au moins FLASH_MIN_GAP", () => {
    // 0,5 s entre deux temps forts (120 BPM) : sans modération, deux flashs par
    // seconde. La cadence doit retomber à un toutes les ~1,6 s au minimum. On
    // compte les évènements, pas les images : un flash dure plusieurs images.
    const view = new TrackView(analysis());
    const events: number[] = [];
    for (let t = 0; t < 20; t += 1 / 60) {
      const precedent = events[events.length - 1];
      if (flashAdmitted(view, t) && (precedent === undefined || t - precedent > 0.3)) events.push(t);
    }
    expect(events.length).toBeGreaterThanOrEqual(4);
    expect(events.length).toBeLessThanOrEqual(13);
    for (let i = 1; i < events.length; i += 1) {
      expect(events[i]! - events[i - 1]!).toBeGreaterThanOrEqual(1.6);
    }
  });

  test("un flash ne naît jamais au milieu de la décroissance", () => {
    const view = new TrackView(analysis());
    expect(flashAdmitted(view, 8.25)).toBe(false);
    expect(flashAdmitted(view, 8.05)).toBe(true);
  });

  test("un drop garde sa priorité, même juste après un flash de temps fort", () => {
    // La montée de l'analyse se termine à 22 s, pile sur un temps fort : le drop
    // doit flasher malgré la modération des temps forts.
    const view = new TrackView(analysis());
    expect(flashAdmitted(view, 22.02)).toBe(true);
    expect(flashAdmitted(view, 22.3)).toBe(false);
  });

  test("la cadence s'espace toute seule sur un morceau rapide", () => {
    // 180 BPM contre 60 BPM : dans les deux cas l'intervalle minimum est
    // respecté, et le morceau rapide ne martèle pas davantage.
    const rapide = new TrackView(analysis({ tempo: 180, beatPeriod: 1 / 3, beats: buildBeats(1 / 3, 60) }));
    const lente = new TrackView(analysis({ tempo: 60, beatPeriod: 1.0, beats: buildBeats(1.0, 60) }));
    const evenements = (view: TrackView) => {
      const out: number[] = [];
      for (let t = 0; t < 20; t += 1 / 60) {
        const precedent = out[out.length - 1];
        if (flashAdmitted(view, t) && (precedent === undefined || t - precedent > 0.3)) out.push(t);
      }
      return out;
    };
    for (const view of [rapide, lente]) {
      const events = evenements(view);
      expect(events.length).toBeGreaterThan(3);
      for (let i = 1; i < events.length; i += 1) {
        expect(events[i]! - events[i - 1]!).toBeGreaterThanOrEqual(1.6);
      }
    }
    // 20 s de morceau : jamais plus d'un flash toutes les 1,6 s.
    expect(evenements(rapide).length).toBeLessThanOrEqual(13);
    expect(evenements(lente).length).toBeLessThanOrEqual(13);
  });

  test("le lavage blanc ne vient jamais du pulsage de secours", () => {
    // Morceau sans aucune montée : le pulsage éclaire la scène (surcouche
    // d'impact) mais ne blanchit jamais l'écran.
    const flashs = (builds: Analysis["builds"]) =>
      renderAt(8.02, analysis({ builds })).filter((operation) => operation === "fillRect:0.0,0.0,1280.0,720.0").length;
    const sansMontee = flashs([]);
    expect(sansMontee).toBeLessThanOrEqual(3); // fond + flash éventuel + vignette
  });
});

describe("plancher visuel de l'energie", () => {
  /** Moyenne des alpha réellement posés pendant une image. */
  function alphaMoyen(time: number, data: Analysis): number {
    const trace = renderAt(time, data);
    const alphas: number[] = [];
    for (const operation of trace) {
      const match = /^alpha:([\d.]+)$/.exec(operation);
      if (match !== null) alphas.push(Number(match[1]));
    }
    return alphas.reduce((total, value) => total + value, 0) / Math.max(alphas.length, 1);
  }

  test("un couplet audible reste visible", () => {
    // Énergie écrasée par la normalisation logarithmique : c'est exactement le
    // cas d'un couplet, et sans plancher l'écran est noir en pleine musique.
    const calme = (energie: number) =>
      analysis({
        energy: [
          [0, energie],
          [30, energie],
          [60, energie],
        ],
        bass: [[0, 0.4], [60, 0.4]],
        mid: [[0, 0.4], [60, 0.4]],
        high: [[0, 0.4], [60, 0.4]],
      });

    // Tout ce qui est sous le plancher donne la même image : le plancher agit.
    expect(alphaMoyen(42.02, calme(0.02))).toBeCloseTo(alphaMoyen(42.02, calme(0.05)), 6);

    // Et cette image n'est pas noire : sans plancher, l'alpha des familles
    // vaudrait `0,05 + 0,32 × 0,05` soit ~0,066, contre ~0,13 avec le plancher.
    const moyen = alphaMoyen(42.02, calme(0.05));
    expect(moyen).toBeGreaterThan(0.09);
    // Un refrain reste nettement plus lumineux qu'un couplet : les termes fixes
    // des alpha (fond, poussière) amortissent le rapport, mais la dynamique est
    // bien là — 0,95 d'énergie contre un plancher à 0,26.
    expect(alphaMoyen(42.02, analysis({ energy: [[0, 0.95], [30, 0.95], [60, 0.95]] }))).toBeGreaterThan(moyen * 1.4);
  });

  test("le plancher n'ecrase pas la dynamique", () => {
    const fort = analysis({ energy: [[0, 0.95], [30, 0.95], [60, 0.95]] });
    const calme = analysis({
      energy: [[0, 0.05], [30, 0.05], [60, 0.05]],
      bass: [[0, 0.4], [60, 0.4]],
      mid: [[0, 0.4], [60, 0.4]],
      high: [[0, 0.4], [60, 0.4]],
    });
    const moyenFort = alphaMoyen(42.02, fort);
    const moyenCalme = alphaMoyen(42.02, calme);
    // Un refrain reste nettement plus lumineux qu'un couplet.
    expect(moyenFort).toBeGreaterThan(moyenCalme * 1.4);
  });

  test("visibleEnergy applique le plancher sans dépasser 1", () => {
    expect(visibleEnergy(0)).toBe(ENERGY_FLOOR);
    expect(visibleEnergy(0.05)).toBe(ENERGY_FLOOR);
    expect(visibleEnergy(0.6)).toBe(0.6);
    expect(visibleEnergy(2)).toBe(1);
  });
});

/** Dessine une seule famille, pour vérifier sa géométrie. */
function renderFamily(famille: FamilyId): string[] {
  const { ctx, operations } = fakeContext();
  const data = analysis();
  const view = new TrackView(data);
  const plan = buildShowPlan(data, false);
  const scene = plan.scenes[0]!;
  drawFamily(
    ctx,
    {
      t: 12.0,
      width: 1280,
      height: 720,
      dpr: 1,
      scene,
      palette: scene.palette,
      energy: 0.7,
      bass: 0.6,
      mid: 0.5,
      high: 0.4,
      beat: 0.8,
      beatPhase: 0.3,
      beatIndex: 24,
      build: 0.5,
      buildStrength: 0.7,
      surge: 0.4,
      intensity: 0.8,
      alpha: 1,
      reduced: false,
      quality: 1,
      seed: plan.seed,
      frame: 720,
    },
    view,
    famille,
  );
  return operations;
}

describe("les effets remplissent la scene", () => {
  test("une rangee de projecteurs deborde des deux bords", () => {
    // Le défaut constaté : la rangée s'arrêtait aux bords, donc dès qu'elle
    // s'inclinait, le côté vers lequel elle se penche restait noir.
    const positions = rowPositions(9, 1280, 1280 * 0.14);
    expect(positions[0]).toBeLessThan(0);
    expect(positions[positions.length - 1]).toBeGreaterThan(1280);
    // Et les lampes restent régulièrement espacées.
    const ecarts = positions.slice(1).map((x, index) => x - (positions[index] ?? 0));
    for (const ecart of ecarts) expect(ecart).toBeCloseTo(ecarts[0] ?? 0, 6);
  });

  test("une seule lampe reste au centre", () => {
    expect(rowPositions(1, 1280, 100)).toEqual([640]);
    expect(rowPositions(0, 1280, 100)).toEqual([]);
  });

  test("le rideau et le rayonnement dessinent hors cadre", () => {
    // Preuve visuelle : les deux nouveaux effets tracent au-delà des bords, donc
    // aucune zone de l'écran ne peut rester vide quand ils s'inclinent.
    for (const famille of ["curtain", "burst", "parade"] as const) {
      const operations = renderFamily(famille);
      const deborde = operations.some((operation) => {
        const coordonnees = [...operation.matchAll(/(-?\d+\.\d+)/g)].map((match) => Number(match[1]));
        return coordonnees.some((valeur) => valeur < -20 || valeur > 1300);
      });
      expect(deborde).toBe(true);
    }
  });
});

describe("transition entre les moments du spectacle", () => {
  /** Remplissages plein écran avec leur alpha, pour juger le voile. */
  function voile(progress: number) {
    const { ctx, operations } = fakeContext();
    drawTransition(ctx, 1280, 720, progress, 210);
    return operations;
  }

  test("le voile s'ouvre progressivement jusqu'au spectacle nu", () => {
    // De l'opacité forte au départ jusqu'à plus rien : c'est ce qui distingue
    // une transition d'une coupure sèche.
    expect(transitionAlpha(0)).toBeCloseTo(0.95, 2);
    expect(transitionAlpha(0.5)).toBeLessThan(transitionAlpha(0.25));
    expect(transitionAlpha(1)).toBe(0);
    // Au bout, plus aucune opération : le rendu n'est pas alourdi.
    expect(voile(1)).toEqual([]);
  });

  test("le front lumineux balaie l'ecran puis sort", () => {
    const pleinEcrans = (ops: string[]) => ops.filter((op) => op.startsWith("fillRect:0.0,0.0,1280.0,720.0")).length;
    /** Abscisse de la bande lumineuse (le remplissage qui n'est pas le voile). */
    const front = (progress: number) => {
      const rect = voile(progress).find(
        (op) => op.startsWith("fillRect:") && !op.startsWith("fillRect:0.0,0.0,1280.0,720.0"),
      );
      return rect === undefined ? null : Number(rect.slice("fillRect:".length).split(",")[0]);
    };

    // Aux extrêmes, le front est hors cadre : seul le voile est dessiné.
    expect(pleinEcrans(voile(0.02))).toBe(1);
    expect(front(0.02)).toBeNull();
    expect(front(0.99)).toBeNull();

    // Au milieu, il balaie : la bande existe et avance avec la progression.
    expect(front(0.3)).not.toBeNull();
    expect(front(0.7)).not.toBeNull();
    expect(front(0.7)!).toBeGreaterThan(front(0.3)!);
  });

  test("rien n'est dessine une fois la transition finie", () => {
    expect(voile(1.4)).toEqual([]);
    expect(voile(2)).toEqual([]);
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
  /**
   * Nombre de flashs blancs plein écran à l'instant `t`.
   *
   * On compte les `fillRect` pleins précédés d'un style blanc : un remplissage
   * plein écran peut aussi venir d'une famille de la scène, et ce n'est pas un
   * flash.
   */
  function flashFramesAt(time: number): number {
    const trace = renderAt(time);
    let total = 0;
    let pending = "";
    for (const operation of trace) {
      if (operation.startsWith("fillStyle:")) {
        pending = operation.slice("fillStyle:".length);
        continue;
      }
      if (operation === "fillRect:0.0,0.0,1280.0,720.0" && /^rgba\(255,255,255,/.test(pending)) {
        total += 1;
      }
    }
    return total;
  }

  test("un flash part sur l'attaque du temps fort, jamais entre deux temps", () => {
    // Passage « intense » (40-60 s) : basse forte et énergie haute, donc les
    // temps forts portent un kick et méritent un flash. Le flash doit naître
    // juste après l'attaque, pas pendant la décroissance ni à contretemps.
    expect(flashFramesAt(42.25)).toBe(0);
    expect(flashFramesAt(42.05)).toBe(1);
    expect(flashFramesAt(44.05)).toBe(1);
  });

  test("aucun flash dans un passage calme", () => {
    // 0-20 s : basse faible et énergie basse, la musique ne demande rien. Le
    // show garde son mouvement mais ne flashe pas — c'est tout l'enjeu de
    // `beatStrength` : ne célébrer que les temps forts qui portent quelque chose.
    for (const t of [4.05, 8.05, 12.05, 16.05, 20.05]) {
      expect(flashFramesAt(t)).toBe(0);
    }
  });

  test("deux flashs restent toujours espacés d'au moins FLASH_MIN_GAP", () => {
    // Evenements = début de chaque salve de flashs.
    const events: number[] = [];
    let flashing = false;
    for (let t = 40; t < 60; t += 1 / 60) {
      const isFlash = flashFramesAt(t) > 0;
      if (isFlash && !flashing) events.push(t);
      flashing = isFlash;
    }
    expect(events.length).toBeGreaterThan(3);
    expect(events.length).toBeLessThanOrEqual(14);
    for (let i = 1; i < events.length; i += 1) {
      expect(events[i]! - events[i - 1]!).toBeGreaterThanOrEqual(1.6);
    }
  });
});

describe("pulse en accord avec la musique", () => {
  test("un temps fort sans basse ne pulse pas", () => {
    // Même analyse, basse coupée : plus rien à célébrer.
    const view = new TrackView(analysis({ bass: [[0, 0.05], [30, 0.05], [60, 0.05]] }));
    expect(beatStrength(view, 8.02)).toBe(0);
    expect(beatStrength(view, 42.02)).toBe(0);
  });

  test("un kick dans un passage intense pulse plus fort qu'en passage calme", () => {
    const view = new TrackView(analysis());
    const intense = beatStrength(view, 42.02);
    const calme = beatStrength(view, 8.02);
    expect(intense).toBeGreaterThan(0.5);
    expect(calme).toBeLessThan(intense * 0.6);
    // Le passage calme pulse encore, mais faiblement : le show respire.
    expect(calme).toBeGreaterThan(0.1);
  });

  test("l'intensité du pulse suit l'énergie du morceau", () => {
    const fort = new TrackView(analysis({ energy: [[0, 1], [60, 1]] }));
    const faible = new TrackView(analysis({ energy: [[0, 0.2], [60, 0.2]] }));
    expect(beatStrength(fort, 42.02)).toBeGreaterThan(beatStrength(faible, 42.02) * 1.4);
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

  test("un impact change la lumiere sans sortir de la palette", () => {
    const scene = buildShowPlan(analysis(), false).scenes[0]!;
    const ecart = (a: number, b: number) => Math.abs(((b - a + 540) % 360) - 180);
    // Impact et variation au maximum : le saut doit se voir…
    const hue = sceneHue(scene, 12, 1, 1, false);
    expect(ecart(hue, scene.palette.hue)).toBeGreaterThan(10);
    // …sans faire apparaître une troisième couleur étrangère au morceau. La
    // borne couvre l'impact (32°), la respiration (14°) et la dérive lente.
    expect(ecart(hue, scene.palette.hue)).toBeLessThan(55);
  });

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
      // Dérive lente (0,4 °/s) + respiration : aucun saut d'un pas à l'autre.
      expect(hueGap(previous, hue)).toBeLessThan(2);
      previous = hue;
    }
  });
});
