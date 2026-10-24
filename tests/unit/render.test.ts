import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  beatDrive,
  beatStrength,
  clampHueToAnchor,
  drawTransition,
  ENERGY_FLOOR,
  flashAdmitted,
  flashAlphaAt,
  FLASH_CEILING,
  HUE_BUDGET_MARGIN_DEG,
  renderFrame,
  sceneAnchor,
  sceneHue,
  transitionAlpha,
  visibleEnergy,
} from "../../src/core/render";
import { buildShowPlan, FAMILY_LABELS, type FamilyId } from "../../src/core/show";
import {
  beamLayers,
  beatSwing,
  colorFlip,
  contrastHue,
  curvedBeam,
  drawFamily,
  elementEnvelope,
  elementEnvelopeForEnergy,
  type FrameState,
  GRAND_BALAYAGE_BEATS,
  hazeFineRadiusPixels,
  hazeRadiusPixels,
  type HazeLayer,
  type HazeTarget,
  lampHue,
  lyreWavePhase,
  PETIT_ELEMENT_BEATS,
  rowPositions,
  sceneChord,
  softBeam,
} from "../../src/core/families";
import { QUALITY_STEPS, hash01, quantizeQuality } from "../../src/core/series";
import { TrackView } from "../../src/core/view";
import { DEFAULT_SETTINGS } from "../../src/types";
import type { Analysis } from "../../src/types";

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
      operations.push(`alpha:${Number(value.toFixed(4))}`);
    },
    setTransform: () => operations.push("setTransform"),
    clearRect: () => operations.push("clearRect"),
    drawImage: () => operations.push("drawImage"),
    fillRect: (x: number, y: number, w: number, h: number) =>
      operations.push(`fillRect:${x.toFixed(1)},${y.toFixed(1)},${w.toFixed(1)},${h.toFixed(1)}`),
    beginPath: () => operations.push("beginPath"),
    closePath: () => operations.push("closePath"),
    moveTo: (x: number, y: number) => operations.push(`moveTo:${x.toFixed(1)},${y.toFixed(1)}`),
    lineTo: (x: number, y: number) => operations.push(`lineTo:${x.toFixed(1)},${y.toFixed(1)}`),
    arc: (x: number, y: number, r: number) => operations.push(`arc:${x.toFixed(1)},${y.toFixed(1)},${r.toFixed(1)}`),
    quadraticCurveTo: (x1: number, y1: number, x2: number, y2: number) =>
      operations.push(`quadraticCurveTo:${x1.toFixed(1)},${y1.toFixed(1)},${x2.toFixed(1)},${y2.toFixed(1)}`),
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
    schema: 2,
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

function renderAt(time: number, analysisData: Analysis = analysis(), settings = DEFAULT_SETTINGS, quality = 1) {  const { ctx, operations } = fakeContext();
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

/**
 * Surface de fumée de test : deux contextes enregistreurs, comme dans le
 * navigateur (dépôt des faisceaux, puis passe de flou).
 */
/** Ce qu'une nappe de test a reçu et ce qu'elle a flouté. */
interface FausseNappe {
  depot: string[];
  flou: string[];
}

/** Nombre de dessins réellement déposés dans une nappe : un faisceau droit est
 * rempli, un faisceau courbe est tracé. */
function dessins(nappe: FausseNappe): number {
  return nappe.depot.filter((operation) => operation === "fill" || operation === "stroke").length;
}

/**
 * Nappes de fumée de test : deux nappes, chacune avec son dépôt et sa passe de
 * flou, comme dans le navigateur.
 */
function fakeHaze(): { haze: HazeTarget; fine: FausseNappe; large: FausseNappe } {
  const cree = (): { layer: HazeLayer; vu: FausseNappe } => {
    const depot = fakeContext();
    const flou = fakeContext();
    return {
      layer: { ctx: depot.ctx, blurPass: flou.ctx, scale: 0.5, used: false },
      vu: { depot: depot.operations, flou: flou.operations },
    };
  };
  const fine = cree();
  const large = cree();
  return { haze: { fine: fine.layer, large: large.layer }, fine: fine.vu, large: large.vu };
}

describe("rendu déterministe", () => {
  /** Rend une image sur un contexte donné et renvoie les opérations produites. */
  function renderInto(
    ctx: CanvasRenderingContext2D,
    operations: string[],
    time: number,
    quality = 1,
    settings = DEFAULT_SETTINGS,
  ): string {
    const start = operations.length;
    const data = analysis();
    renderFrame({
      ctx,
      width: 1280,
      height: 720,
      dpr: 1,
      time,
      view: new TrackView(data),
      plan: buildShowPlan(data, settings.reduced),
      settings,
      reducedMotion: false,
      quality,
      frame: Math.round(time * 60),
    });
    // Les dégradés sont des objets : le contexte factice ne les compare pas.
    // La vignette, mémorisée par contexte, n'est créée qu'au premier rendu —
    // on ignore donc les opérations de construction des dégradés, identiques
    // par ailleurs d'une image à l'autre.
    return operations
      .slice(start)
      .filter((operation) => !operation.startsWith("stop:") && !operation.startsWith("radial:"))
      .join("|");
  }

  test("deux images au même temps musical sont identiques", () => {
    const first = renderAt(33.25);
    const second = renderAt(33.25);
    expect(second.join("|")).toBe(first.join("|"));
  });

  test("deux rendus successifs sur le MÊME contexte sont identiques", () => {
    // Couvre les caches de module : la vignette mémorisée par contexte ne doit
    // pas changer la seconde image.
    const { ctx, operations } = fakeContext();
    const first = renderInto(ctx, operations, 33.25);
    const second = renderInto(ctx, operations, 33.25);
    expect(second).toBe(first);
  });

  test("un seek arrière redonne exactement l'image d'avant", () => {
    const { ctx, operations } = fakeContext();
    renderInto(ctx, operations, 42.5);
    const afterSeek = renderInto(ctx, operations, 12.25);
    const { ctx: ctxNeuf, operations: operationsNeuve } = fakeContext();
    const reference = renderInto(ctxNeuf, operationsNeuve, 12.25);
    expect(afterSeek).toBe(reference);
  });

  test("à palier de qualité égal, deux rendus sont identiques", () => {
    const { ctx, operations } = fakeContext();
    const first = renderInto(ctx, operations, 27.5, 0.6);
    const second = renderInto(ctx, operations, 27.5, 0.6);
    expect(second).toBe(first);
  });

  test("le mode réduit est déterministe aussi", () => {
    const settings = { ...DEFAULT_SETTINGS, reduced: true };
    const { ctx, operations } = fakeContext();
    const first = renderInto(ctx, operations, 31.5, 1, settings);
    const second = renderInto(ctx, operations, 31.5, 1, settings);
    expect(second).toBe(first);
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

  test("les positions des éléments sont stables quand la qualité change", () => {
    // On rend la même famille à q = 1 et q = 0,6 : tout élément présent aux
    // deux paliers doit tomber exactement à la même position. On compare les
    // opérations qui portent des coordonnées ; celles du palier bas doivent
    // former un sous-ensemble de celles du palier haut.
    const trace = (family: FamilyId, quality: number) => {
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
        quality,
        frame: 0,
      });
      return new Set(
        operations.filter(
          (operation) =>
            operation.startsWith("moveTo:") ||
            operation.startsWith("lineTo:") ||
            operation.startsWith("arc:") ||
            operation.startsWith("quadraticCurveTo:"),
        ),
      );
    };

    for (const family of Object.keys(FAMILY_LABELS) as FamilyId[]) {
      const haut = trace(family, 1);
      const bas = trace(family, 0.6);
      for (const operation of bas) expect(haut.has(operation)).toBe(true);
    }
  });

  test("toutes les familles visuelles rendent sans erreur", () => {
    // La liste vient du barème des libellés : aucune famille ne peut être
    // oubliée quand on en ajoute une.
    for (const family of Object.keys(FAMILY_LABELS) as FamilyId[]) {
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
    // s'ajouter aux tracés, donc chaque dégradé vient bien de `mirror`.
    const data = analysis();
    const plan = buildShowPlan(data, false);
    plan.scenes = [
      { ...plan.scenes[0]!, family: "mirror", variant: "mirror", backdrop: "mirror", start: 0, end: 60 },
    ];
    const largeur = 800;
    const { ctx, operations } = fakeContext();
    renderFrame({
      ctx,
      width: largeur,
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

    // Chaque couche de faisceau pose un dégradé linéaire de l'origine vers le
    // bout. On compare donc les dégradés plutôt que les tracés — le nombre de
    // couches par faisceau peut changer, pas la symétrie. On ne garde que les
    // faisceaux longs : depuis le pulsage de secours, la surcouche d'impact
    // dessine aussi des barres verticales au même instant.
    const degrades = operations
      .filter((operation) => operation.startsWith("linear:"))
      .map((operation) => operation.slice("linear:".length).split(",").map(Number))
      .filter((g) => Math.abs(g[2]! - g[0]!) > 100);
    const gauche = degrades.filter((g) => g[0] === 0);
    const droite = degrades.filter((g) => g[0] === largeur);
    expect(gauche.length).toBeGreaterThanOrEqual(8);
    expect(droite.length).toBeGreaterThanOrEqual(8);

    // On compte les faisceaux qui ont réellement leur jumeau en miroir de
    // l'autre côté, puis on exige que les deux camps s'apparient autant : la
    // figure est symétrique, et un élément étranger (vignette, surcouche) ne
    // peut pas fausser la mesure.
    const cle = (g: number[]) => g.map((valeur) => valeur.toFixed(1)).join(",");
    const miroir = (g: number[]) => [largeur - g[0]!, g[1]!, largeur - g[2]!, g[3]!];
    const apparies = (liste: number[][], autres: number[][]) =>
      liste.filter((g) => autres.some((candidat) => cle(candidat) === cle(miroir(g)))).length;
    const gaucheApparies = apparies(gauche, droite);
    const droiteApparies = apparies(droite, gauche);
    expect(gaucheApparies).toBeGreaterThanOrEqual(8);
    expect(gaucheApparies).toBe(droiteApparies);
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

  test("s'efface progressivement quand les montées se multiplient", () => {
    const view = new TrackView(analysis());
    // Jusqu'à deux montées, le morceau reste jugé peu dynamique ; au-delà, les
    // vrais drops prennent le relais et l'impulsion s'efface sans rupture.
    expect(beatDrive(view, 8.02, 2)).toBeGreaterThan(0);
    const trois = beatDrive(view, 8.02, 3);
    const quatre = beatDrive(view, 8.02, 4);
    expect(trois).toBeGreaterThan(0);
    expect(trois).toBeLessThan(beatDrive(view, 8.02, 2));
    expect(quatre).toBeLessThan(trois);
    expect(beatDrive(view, 8.02, 6)).toBe(0);
    expect(beatDrive(view, 8.02, 9)).toBe(0);
  });

  test("est dosé par l'énergie locale", () => {
    const view = new TrackView(analysis());
    const pulse = view.beatPulse(8.02, 0.45);
    const attendu = pulse * (0.35 + 0.65 * view.energyAt(8.02));
    expect(beatDrive(view, 8.02, 1)).toBeCloseTo(attendu, 6);
  });

  test("le pulsage de secours ne fait plus clignoter la teinte", () => {
    // Piste sans aucune montée : `beatDrive` continue de porter l'intensité,
    // mais la couleur ne reçoit plus que le vrai drop. Deux images successives
    // ne doivent donc pas sauter de 12°.
    const data = analysis({ builds: [] });
    const plan = buildShowPlan(data, false);
    const view = new TrackView(data);
    const scene = plan.scenes[0]!;
    const anchor = sceneAnchor(scene, plan.track);
    let previous: number | undefined;
    const gap = (a: number, b: number) => Math.abs(((b - a + 540) % 360) - 180);
    for (let t = 0; t < scene.end - 0.1; t += 1 / 60) {
      const hue = sceneHue(scene, t, view.buildIntensity(t), 0, false, anchor);
      if (previous !== undefined) expect(gap(previous, hue)).toBeLessThan(2);
      previous = hue;
    }
  });

  test("une piste à trois montées n'a plus de rupture d'intensité", () => {
    // L'ancien seuil dur (`builds > 2 → 0`) faisait perdre d'un coup toute
    // l'impulsion à la troisième montée. L'atténuation est désormais continue :
    // la valeur décroît, sans marche.
    const view = new TrackView(analysis());
    const valeurs = [2, 3, 4, 5, 6].map((builds) => beatDrive(view, 8.02, builds));
    for (let i = 1; i < valeurs.length; i += 1) {
      expect(valeurs[i]!).toBeLessThanOrEqual(valeurs[i - 1]!);
      expect(valeurs[i - 1]! - valeurs[i]!).toBeLessThan(0.13);
    }
  });
});

describe("cadence musicale des flashs", () => {
  test("hors drop, un seul temps fort par phrase porte un flash", () => {
    // 0,5 s entre deux temps forts (120 BPM) : un flash par phrase de 8 temps,
    // soit un toutes les 4 s. On compte les évènements, pas les images.
    const view = new TrackView(analysis());
    const events: number[] = [];
    for (let t = 0; t < 20; t += 1 / 60) {
      const precedent = events[events.length - 1];
      if (flashAdmitted(view, t) && (precedent === undefined || t - precedent > 0.3)) events.push(t);
    }
    expect(events.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < events.length; i += 1) {
      expect(events[i]! - events[i - 1]!).toBeGreaterThanOrEqual(3.9);
    }
  });

  test("un flash ne naît jamais au milieu de la décroissance", () => {
    const view = new TrackView(analysis());
    expect(flashAdmitted(view, 8.25)).toBe(false);
    expect(flashAdmitted(view, 8.05)).toBe(true);
  });

  test("un drop flashe à chaque temps fort, sans attendre la phrase", () => {
    // La montée se termine à 22 s. Pendant le drop, chaque temps fort porte un
    // flash : la cadence suit la musique au lieu d'un métronome de 1,6 s.
    const view = new TrackView(analysis());
    expect(flashAdmitted(view, 22.02)).toBe(true);
    expect(flashAdmitted(view, 22.52)).toBe(true);
    expect(flashAdmitted(view, 23.02)).toBe(true);
    expect(flashAdmitted(view, 22.3)).toBe(false);
  });

  test("la cadence de phrase s'adapte au tempo", () => {
    // 180 BPM : une phrase (8 temps) dure 2,67 s ; 60 BPM : 8 s. Dans les deux
    // cas, un seul flash par phrase hors drop.
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
    expect(evenements(rapide).length).toBeGreaterThanOrEqual(6);
    expect(evenements(lente).length).toBeGreaterThanOrEqual(2);
    expect(evenements(rapide).length).toBeGreaterThan(evenements(lente).length);
  });

  test("le drop est plus lumineux qu'un temps fort ordinaire", () => {
    // settings.flashes = 1 : la hiérarchie doit rester lisible.
    const settings = { ...DEFAULT_SETTINGS, flashes: 1 };
    const ordinaire = flashAlphaAt(1, 0.9, 0, 0, 0.9, false, settings);
    const drop = flashAlphaAt(0, 0.9, 1, 1, 0.9, false, settings);
    expect(drop).toBeGreaterThan(ordinaire * 1.3);
    expect(drop).toBeLessThanOrEqual(FLASH_CEILING);
    expect(ordinaire).toBeGreaterThan(0);
  });

  test("le budget utilisateur et le mode réduit restent souverains", () => {
    const zero = { ...DEFAULT_SETTINGS, flashes: 0 };
    expect(flashAlphaAt(1, 1, 1, 1, 1, false, zero)).toBe(0);
    expect(flashAlphaAt(1, 1, 1, 1, 1, true, DEFAULT_SETTINGS)).toBe(0);
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
function renderFamily(famille: FamilyId, over: Partial<FrameState> = {}): string[] {
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
      ...over,
    },
    view,
    famille,
  );
  return operations;
}

describe("les effets remplissent la scene", () => {
  /** Teintes distinctes (par pas de 30°) présentes dans les couleurs enregistrées. */
  const teintes = (operations: string[]): number => {
    const buckets = new Set<number>();
    for (const operation of operations) {
      const match = /rgba?\((\d+),(\d+),(\d+)/.exec(operation);
      if (match === null) continue;
      const r = Number(match[1]) / 255;
      const g = Number(match[2]) / 255;
      const b = Number(match[3]) / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max - min < 0.05) continue;
      let hue: number;
      if (max === r) hue = 60 * (((g - b) / (max - min)) % 6);
      else if (max === g) hue = 60 * ((b - r) / (max - min) + 2);
      else hue = 60 * ((r - g) / (max - min) + 4);
      buckets.add(Math.floor((((hue % 360) + 360) % 360) / 30));
    }
    return buckets.size;
  };

  test("les figures à plusieurs têtes portent plusieurs teintes", () => {
    // Une rangée de lyres, un maillage ou une rosace ne doivent pas retomber
    // sur deux tons alternés : leur lumière vient de l'accord de la scène.
    for (const famille of ["lyre", "treillis", "mandala"] as FamilyId[]) {
      expect(teintes(renderFamily(famille))).toBeGreaterThanOrEqual(3);
    }
  });

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

  /** Origines `[x, y]` des faisceaux d'une famille (début des dégradés linéaires). */
  const origines = (operations: string[]): Array<[number, number]> =>
    operations
      .filter((operation) => operation.startsWith("linear:"))
      .map((operation) => operation.slice("linear:".length).split(",").map(Number))
      .filter((coords) => coords.length >= 2 && coords[0] !== undefined && coords[1] !== undefined)
      .map((coords) => [coords[0]!, coords[1]!] as [number, number]);

  test("l'éventail part d'une source visible, en bas comme en haut", () => {
    // Le défaut constaté : la source était posée à h×1,02, donc 2 % sous l'écran
    // — on ne la voyait jamais s'allumer, et les rayons des bords partaient déjà
    // hors cadre. La source doit maintenant tomber dans le cadre, près du bord.
    const bas: Array<[number, number]> = [];
    const haut: Array<[number, number]> = [];
    for (let beatIndex = 0; beatIndex < 32; beatIndex += 1) {
      for (const [x, y] of origines(renderFamily("beams", { beatIndex, beatPhase: 0, t: beatIndex * 0.5 }))) {
        (y > 360 ? bas : haut).push([x, y]);
      }
    }
    expect(bas.length).toBeGreaterThan(0);
    expect(haut.length).toBeGreaterThan(0);
    for (const [, y] of [...bas, ...haut]) {
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(720);
    }
    expect(Math.min(...bas.map(([, y]) => y))).toBeGreaterThan(720 * 0.9);
    expect(Math.max(...haut.map(([, y]) => y))).toBeLessThan(720 * 0.1);
  });

  test("aucun faisceau de l'éventail ne repart vers son propre bord", () => {
    // Un rayon qui vise vers le bas depuis le plancher quitte le cadre aussitôt :
    // c'est ce qui ne laissait voir qu'un faisceau. L'ouverture et le balayage
    // sont donc bornés pour que tous les rayons entrent dans le cadre.
    for (let beatIndex = 0; beatIndex < 32; beatIndex += 1) {
      const operations = renderFamily("beams", { beatIndex, beatPhase: 0, t: beatIndex * 0.5 });
      for (const operation of operations) {
        if (!operation.startsWith("linear:")) continue;
        const [, y0, , y1] = operation.slice("linear:".length).split(",").map(Number);
        if (y0 === undefined || y1 === undefined) continue;
        if (y0 > 360) expect(y1).toBeLessThanOrEqual(720);
        else expect(y1).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test("les deux éventails s'allument ensemble ou séparément", () => {
    let ensemble = 0;
    let seul = 0;
    for (let beatIndex = 0; beatIndex < 64; beatIndex += 1) {
      const rays = origines(renderFamily("beams", { beatIndex, beatPhase: 0, t: beatIndex * 0.5 }));
      const bas = rays.filter(([, y]) => y > 360).length;
      const haut = rays.length - bas;
      if (bas > 0 && haut > 0) ensemble += 1;
      else if (bas > 0 || haut > 0) seul += 1;
    }
    expect(ensemble).toBeGreaterThan(0);
    expect(seul).toBeGreaterThan(0);
  });
});

describe("vague des lyres", () => {
  test("reste lente en fin de morceau, meme quand l'energie bouge", () => {
    // Morceau long, énergie en dents de scie : avec une phase en `f.t ×
    // vitesse(énergie)`, le saut grandissait avec `t`, donc la rangée partait à
    // une vitesse de fou dès que le morceau avançait. L'intégrale de la vitesse
    // garde la vague lente du début à la fin.
    const energy: [number, number][] = [];
    for (let t = 0; t <= 360; t += 0.25) {
      energy.push([t, Math.sin(t * 1.3) > 0 ? 0.9 : 0.3]);
    }
    const data = analysis({ duration: 360, energy, beats: [] });
    const view = new TrackView(data);
    const plan = buildShowPlan(data, false);
    const scene = plan.scenes[0]!;

    const at = (t: number): FrameState => ({
      t,
      width: 1280,
      height: 720,
      dpr: 1,
      scene,
      palette: scene.palette,
      energy: visibleEnergy(view.energyAt(t)),
      bass: view.bassAt(t),
      mid: view.midAt(t),
      high: view.highAt(t),
      beat: 0,
      beatPhase: 0,
      beatIndex: 0,
      build: 0,
      buildStrength: 0,
      surge: 0,
      intensity: 0.8,
      alpha: 1,
      reduced: false,
      quality: 1,
      seed: plan.seed,
      frame: 0,
    });

    const vitesse = (t: number): number => {
      const dt = 0.02;
      return Math.abs(lyreWavePhase(at(t + dt), view, 0) - lyreWavePhase(at(t), view, 0)) / dt;
    };

    // Moins d'un tiers de tour par seconde, quelle que soit la position dans le
    // morceau : la lenteur ne doit jamais se perdre.
    for (const t of [1, 30, 120, 240, 359]) {
      expect(vitesse(t)).toBeLessThan((Math.PI * 2) / 3);
    }
  });
});

describe("double rideau en profondeur", () => {
  /** Faisceaux dessinés, sous forme de dégradés `[x0, y0, x1, y1]`. */
  const faisceaux = (operations: string[]): number[][] =>
    operations
      .filter((operation) => operation.startsWith("linear:"))
      .map((operation) => operation.slice("linear:".length).split(",").map(Number));

  const moyenne = (valeurs: number[]): number =>
    valeurs.reduce((total, valeur) => total + valeur, 0) / Math.max(valeurs.length, 1);

  test("les quinze lampes du plafond et les quinze du plancher dessinent", () => {
    // Deux rangées symétriques : des faisceaux dont le pied est dans la moitié
    // haute de l'écran, et d'autres dans la moitié basse. Sans le double rideau,
    // toute la lumière viendrait d'un seul côté.
    const debuts = faisceaux(renderFamily("rideaux")).map((g) => g[1] ?? 0);
    expect(debuts.length).toBeGreaterThanOrEqual(10);
    expect(debuts.some((y) => y < 720 * 0.35)).toBe(true);
    expect(debuts.some((y) => y > 720 * 0.65)).toBe(true);
  });

  test("le rideau s'ouvre quand l'énergie monte", () => {
    // Fermé, chaque faisceau plonge vers le bord opposé ; ouvert, il se relève et
    // s'écarte vers les côtés. Le bout s'éloigne donc du centre quand l'énergie
    // baisse, et s'en rapproche quand elle monte.
    const hauteurBout = (operations: string[]) =>
      moyenne(faisceaux(operations).map((g) => Math.abs((g[3] ?? 360) - 360)));
    const ferme = hauteurBout(renderFamily("rideaux", { energy: 0.1 }));
    const ouvert = hauteurBout(renderFamily("rideaux", { energy: 1 }));
    expect(ferme).toBeGreaterThan(ouvert);
  });

  test("le rendu ne produit ni NaN ni image différente au même temps", () => {
    // La projection divise par une profondeur : un point derrière la caméra
    // ferait fuiter un NaN dans une couleur, ou retournerait un faisceau.
    const premier = renderFamily("rideaux").join("|");
    expect(premier.includes("NaN")).toBe(false);
    expect(premier).toBe(renderFamily("rideaux").join("|"));
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

describe("mouvements cales sur le tempo", () => {
  const frame = (over: Partial<Parameters<typeof beatSwing>[0]> = {}) =>
    ({
      t: 12,
      width: 1280,
      height: 720,
      dpr: 1,
      scene: buildShowPlan(analysis(), false).scenes[0]!,
      palette: buildShowPlan(analysis(), false).scenes[0]!.palette,
      energy: 0.6,
      bass: 0.5,
      mid: 0.5,
      high: 0.4,
      beat: 0.7,
      beatPhase: 0,
      beatIndex: 8,
      build: 0,
      buildStrength: 0,
      surge: 0.2,
      intensity: 0.8,
      alpha: 1,
      reduced: false,
      quality: 1,
      seed: 42,
      frame: 0,
      ...over,
    }) as Parameters<typeof beatSwing>[0];

  const view = new TrackView(analysis());

  test("la cible change a chaque temps fort", () => {
    // Le balayage doit être décidé par la grille rythmique, pas par une vitesse
    // fixe : deux temps forts consécutifs visent des positions différentes.
    const positions = [8, 9, 10, 11, 12].map((beatIndex) => beatSwing(frame({ beatIndex, beatPhase: 0.6 }), view, 1, 1));
    expect(new Set(positions.map((p) => p.toFixed(3))).size).toBe(positions.length);
    for (const position of positions) expect(Math.abs(position)).toBeLessThanOrEqual(0.5);
  });

  test("le faisceau arrive juste apres le temps fort puis tient", () => {
    // Course sur les 70 % du pas : bien plus avancé à mi-pas qu'au départ, et
    // quasi immobile sur la fin.
    const depart = beatSwing(frame({ beatIndex: 8, beatPhase: 0 }), view, 2, 1);
    const milieu = beatSwing(frame({ beatIndex: 8, beatPhase: 0.35 }), view, 2, 1);
    const arrivee = beatSwing(frame({ beatIndex: 8, beatPhase: 0.7 }), view, 2, 1);
    const fin = beatSwing(frame({ beatIndex: 8, beatPhase: 0.99 }), view, 2, 1);
    expect(Math.abs(milieu - depart)).toBeGreaterThan(0.2);
    expect(Math.abs(arrivee - milieu)).toBeGreaterThan(0.05);
    expect(Math.abs(fin - arrivee)).toBeLessThan(0.15);
  });

  test("le balayage ne saute pas d'un pas a l'autre", () => {
    // Continuité : à la frontière entre deux pas, la position doit être celle
    // de l'arrivée puis repartir vers la suivante, sans discontinuité.
    let precedent = beatSwing(frame({ beatIndex: 8, beatPhase: 0 }), view, 2, 1);
    for (let phase = 0.1; phase <= 1; phase += 0.1) {
      const courant = beatSwing(frame({ beatIndex: 8, beatPhase: phase }), view, 2, 1);
      expect(Math.abs(courant - precedent)).toBeLessThan(1.2);
      precedent = courant;
    }
  });

  test("les grands balayages glissent bien plus lentement que les petits elements", () => {
    // La cible d'un grand balayage change une fois par phrase, et la course
    // dure toute la phrase : le mouvement est une longue glissade. Un petit
    // élément parcourt la sienne en deux temps. C'est cette lenteur qui fait la
    // beauté des éventails et des wash.
    const vitesse = (pas: number) => {
      let precedent = beatSwing(frame({ beatIndex: 32, beatPhase: 0 }), view, 1, pas);
      let max = 0;
      for (let beat = 32; beat < 32 + GRAND_BALAYAGE_BEATS * 2; beat += 1) {
        const courant = beatSwing(frame({ beatIndex: beat, beatPhase: 0 }), view, 1, pas);
        max = Math.max(max, Math.abs(courant - precedent));
        precedent = courant;
      }
      return max;
    };
    const lent = vitesse(GRAND_BALAYAGE_BEATS);
    const rapide = vitesse(PETIT_ELEMENT_BEATS);
    expect(lent).toBeLessThan(rapide / 4);
    expect(GRAND_BALAYAGE_BEATS).toBeGreaterThan(PETIT_ELEMENT_BEATS * 4);
  });

  test("un passage fort balaie plus large qu'un passage calme", () => {
    // L'ampleur suit l'énergie : la même famille ne bouge pas pareil dans un
    // couplet et dans un refrain.
    const amplitude = (energy: number) => {
      const valeurs: number[] = [];
      for (let beat = 8; beat < 24; beat += 1) {
        for (let phase = 0; phase < 1; phase += 0.25) {
          valeurs.push(beatSwing(frame({ beatIndex: beat, beatPhase: phase, energy }), view, 1, 1));
        }
      }
      return Math.max(...valeurs) - Math.min(...valeurs);
    };
    expect(amplitude(0.95)).toBeGreaterThan(amplitude(0.15) * 1.3);
  });

  test("un decalage par lampe les desynchronise", () => {
    const premiere = beatSwing(frame({ beatPhase: 0.4 }), view, 1, 1, 0);
    const seconde = beatSwing(frame({ beatPhase: 0.4 }), view, 1, 1, 0.31);
    expect(premiere).not.toBe(seconde);
  });

  test("sans grille rythmique, le balayage reste doux", () => {
    // Mode direct : aucune grille détectée, on ne doit pas figer les faisceaux.
    const vide = new TrackView(analysis({ beats: [] }));
    const a = beatSwing(frame({ beatIndex: 0, beatPhase: 0 }), vide, 1, 1);
    const b = beatSwing(frame({ beatIndex: 0, beatPhase: 0.5, t: 12.5 }), vide, 1, 1);
    expect(Number.isFinite(a)).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe("allumage et extinction des elements", () => {
  const view = new TrackView(analysis());

  const frame = (over: Partial<Parameters<typeof elementEnvelope>[0]> = {}) =>
    ({
      t: 12,
      width: 1280,
      height: 720,
      dpr: 1,
      scene: buildShowPlan(analysis(), false).scenes[0]!,
      palette: buildShowPlan(analysis(), false).scenes[0]!.palette,
      energy: 0.6,
      bass: 0.5,
      mid: 0.5,
      high: 0.4,
      beat: 0.7,
      beatPhase: 0,
      beatIndex: 8,
      build: 0,
      buildStrength: 0,
      surge: 0.2,
      intensity: 0.8,
      alpha: 1,
      reduced: false,
      quality: 1,
      seed: 42,
      frame: 0,
      ...over,
    }) as Parameters<typeof elementEnvelope>[0];

  test("un element eteint ne dessine rien", () => {
    // Sur un cycle de 4 temps, l'élément est éteint une partie du cycle.
    const phases = [0, 0.25, 0.5, 0.75].map((part) => {
      const position = 8 + part * 4;
      return elementEnvelope(frame({ beatIndex: Math.floor(position), beatPhase: position % 1 }), view, 0, 4, 0.5);
    });
    expect(phases.some((valeur) => valeur === 0)).toBe(true);
    expect(phases.some((valeur) => valeur > 0.5)).toBe(true);
    for (const valeur of phases) expect(valeur).toBeGreaterThanOrEqual(0);
  });

  test("l'allumage et l'extinction sont progressifs", () => {
    // Jamais de saut d'une image à l'autre : c'est ce qui évite l'élément qui
    // apparaît ou disparaît en pleine scène. On échantillonne au pas d'une image
    // (1/60 s) sur un morceau à 128 BPM, soit ~0,035 temps fort.
    const pas = 1 / (60 * (60 / 128));
    let precedent = elementEnvelope(frame({ beatIndex: 8, beatPhase: 0 }), view, 0, 4, 0.5);
    for (let position = 8; position < 12; position += pas) {
      const courant = elementEnvelope(
        frame({ beatIndex: Math.floor(position), beatPhase: position % 1 }),
        view,
        0,
        4,
        0.5,
      );
      expect(Math.abs(courant - precedent)).toBeLessThan(0.09);
      precedent = courant;
    }
  });

  test("le nombre d'elements allumes varie au cours du cycle", () => {
    // C'est le fond de l'effet : à tout instant quelques-uns sont allumés et
    // d'autres éteints, et cela change sans cesse. Un compteur constant
    // signifierait que tout le monde clignote ensemble.
    const compte = (beat: number, phase: number) =>
      [0, 1, 2, 3, 4, 5, 6, 7].filter((index) => elementEnvelope(frame({ beatIndex: beat, beatPhase: phase }), view, index, 8, 0.5) > 0.5).length;
    const valeurs: number[] = [];
    for (let beat = 8; beat < 16; beat += 1) {
      for (let phase = 0; phase < 1; phase += 0.1) valeurs.push(compte(beat, phase));
    }
    expect(Math.min(...valeurs)).toBeLessThan(Math.max(...valeurs));
    // Et il y a toujours de la lumière : le rideau ne s'éteint jamais en entier.
    expect(Math.max(...valeurs)).toBeGreaterThan(2);
  });

  test("la traverse du seuil d'energie n'eteint rien d'un coup", () => {
    // Les projecteurs choisissaient un cycle court des que l'energie depassait
    // 0,55. Deux cycles differents ne sont pas en phase : au franchissement,
    // une lampe passait de pleine lumiere a eteinte en une image. Le melange
    // doit rendre la traversee continue.
    const pas = 1 / (60 * (60 / 128));
    let position = 20;
    let precedent: number | undefined;
    let sautMax = 0;
    for (let etape = 0; etape < 240; etape += 1) {
      const energy = 0.45 + 0.25 * (etape / 239);
      position += pas;
      const courant = elementEnvelopeForEnergy(
        frame({ energy, beatIndex: Math.floor(position), beatPhase: position % 1 }),
        view,
        3,
        22,
        12,
        0.8,
      );
      if (precedent !== undefined) sautMax = Math.max(sautMax, Math.abs(courant - precedent));
      precedent = courant;
    }
    expect(sautMax).toBeLessThan(0.09);
  });

  test("un passage fort allume et eteint plus souvent", () => {
    // À durée égale, un cycle court bascule plus souvent : c'est ce qui fait
    // vivre la lumière plus vite dans un passage fort.
    const basculements = (cycle: number) => {
      let total = 0;
      let allume = elementEnvelope(frame({ beatIndex: 8, beatPhase: 0 }), view, 0, cycle, 0.5) > 0;
      const fin = 8 + 96;
      for (let position = 8; position < fin; position += 0.1) {
        const courant =
          elementEnvelope(frame({ beatIndex: Math.floor(position), beatPhase: position % 1 }), view, 0, cycle, 0.5) > 0;
        if (courant !== allume) total += 1;
        allume = courant;
      }
      return total;
    };
    expect(basculements(8)).toBeGreaterThan(basculements(24));
  });

  test("sans grille rythmique, le cycle se compte en secondes", () => {
    const vide = new TrackView(analysis({ beats: [] }));
    const a = elementEnvelope(frame({ t: 1 }), vide, 0, 8, 0.5);
    const b = elementEnvelope(frame({ t: 4 }), vide, 0, 8, 0.5);
    expect(Number.isFinite(a)).toBe(true);
    expect(Number.isFinite(b)).toBe(true);
  });
});

describe("bascule de couleur des formes", () => {
  const view = new TrackView(analysis());

  const frame = (over: Partial<Parameters<typeof colorFlip>[0]> = {}) =>
    ({
      t: 12,
      width: 1280,
      height: 720,
      dpr: 1,
      scene: buildShowPlan(analysis(), false).scenes[0]!,
      palette: buildShowPlan(analysis(), false).scenes[0]!.palette,
      energy: 0.6,
      bass: 0.5,
      mid: 0.5,
      high: 0.4,
      beat: 0.7,
      beatPhase: 0,
      beatIndex: 8,
      build: 0,
      buildStrength: 0,
      surge: 0.2,
      intensity: 0.8,
      alpha: 1,
      reduced: false,
      quality: 1,
      seed: 42,
      frame: 0,
      ...over,
    }) as Parameters<typeof colorFlip>[0];

  test("la couleur opposée est atteinte, puis quittée", () => {
    // Sans maintien, la forme resterait toujours entre deux teintes : on ne
    // lirait jamais franchement la complémentaire.
    let maximum = 0;
    let minimum = 1;
    for (let beat = 8; beat < 40; beat += 1) {
      for (let phase = 0; phase < 1; phase += 0.05) {
        for (let index = 0; index < 14; index += 1) {
          const valeur = colorFlip(frame({ beatIndex: beat, beatPhase: phase }), view, index, 6);
          maximum = Math.max(maximum, valeur);
          minimum = Math.min(minimum, valeur);
        }
      }
    }
    expect(maximum).toBeGreaterThan(0.99);
    expect(minimum).toBe(0);
  });

  test("la bascule est progressive, jamais un saut", () => {
    // Le passage à l'opposée est une rotation de la roue de couleurs : d'une
    // image à l'autre, elle avance, elle ne saute pas.
    const pas = 1 / (60 * (60 / 128));
    let precedent = colorFlip(frame({ beatIndex: 8, beatPhase: 0 }), view, 0, 6);
    for (let position = 8; position < 40; position += pas) {
      const courant = colorFlip(frame({ beatIndex: Math.floor(position), beatPhase: position % 1 }), view, 0, 6);
      expect(Math.abs(courant - precedent)).toBeLessThan(0.1);
      precedent = courant;
    }
  });

  test("une minorité de formes basculent à la fois", () => {
    // Le fond de l'idée : quand il y a beaucoup de gobos, une ou deux formes
    // seulement virent à la complémentaire — pas tout le cadre d'un bloc.
    let maximum = 0;
    let auMoinsUne = false;
    for (let beat = 8; beat < 40; beat += 1) {
      for (let phase = 0; phase < 1; phase += 0.05) {
        let compte = 0;
        for (let index = 0; index < 14; index += 1) {
          if (colorFlip(frame({ beatIndex: beat, beatPhase: phase }), view, index, 6) > 0.35) compte += 1;
        }
        maximum = Math.max(maximum, compte);
        if (compte >= 1) auMoinsUne = true;
      }
    }
    expect(maximum).toBeLessThanOrEqual(5);
    expect(auMoinsUne).toBe(true);
  });
});

describe("accords de couleurs", () => {
  const plan = buildShowPlan(analysis(), false);
  const scene = plan.scenes[0]!;

  const frame = (over: Partial<Parameters<typeof lampHue>[0]> = {}) =>
    ({
      t: 12,
      width: 1280,
      height: 720,
      dpr: 1,
      scene,
      palette: scene.palette,
      energy: 0.6,
      bass: 0.5,
      mid: 0.5,
      high: 0.4,
      beat: 0.7,
      beatPhase: 0,
      beatIndex: 8,
      build: 0,
      buildStrength: 0,
      surge: 0.2,
      intensity: 0.8,
      alpha: 1,
      reduced: false,
      quality: 1,
      seed: plan.seed,
      frame: 0,
      ...over,
    }) as Parameters<typeof lampHue>[0];

  const ecart = (a: number, b: number) => Math.abs((((a - b) % 360) + 540) % 360 - 180);

  test("l'accord reste dans la gamme du morceau", () => {
    const palette = scene.palette;
    const accord = sceneChord(palette, scene.index, plan.seed);
    // Une scène n'est jamais monochrome : au moins trois teintes.
    expect(accord.length).toBeGreaterThanOrEqual(3);
    for (const hue of accord) {
      // Toutes les teintes dérivent de celle de la scène : jamais à plus d'un
      // demi-cercle, sinon ce serait une autre couleur, pas la même gamme.
      expect(ecart(hue, palette.hue)).toBeLessThanOrEqual(200);
    }
    // L'accent du morceau fait partie de l'accord : la palette se reconnaît.
    expect(accord.some((hue) => ecart(hue, palette.accent) < 20)).toBe(true);
  });

  test("les lampes d'une même scène portent plusieurs teintes", () => {
    const f = frame();
    const hues = Array.from({ length: 15 }, (_, index) => lampHue(f, index));
    // Aucune lampe ne répète exactement sa voisine...
    for (let index = 0; index < hues.length - 1; index += 1) {
      expect(ecart(hues[index]!, hues[index + 1]!)).toBeGreaterThan(3);
    }
    // ...et la rangée déploie au moins trois couleurs distinctes.
    expect(new Set(hues.map((hue) => Math.round(hue / 12))).size).toBeGreaterThanOrEqual(3);
  });

  test("une scène garde ses couleurs, le morceau les renouvelle", () => {
    // Stable à l'intérieur d'une scène, quelle que soit la position...
    for (let index = 0; index < 8; index += 1) {
      expect(lampHue(frame({ t: 10 }), index)).toBe(lampHue(frame({ t: 40 }), index));
    }
    // ...et l'accord change d'une scène à l'autre : l'univers se déploie.
    const tirages = new Set<string>();
    for (let index = 0; index < 24; index += 1) {
      tirages.add(sceneChord(scene.palette, index, plan.seed).map((hue) => Math.round(hue)).join(","));
    }
    expect(tirages.size).toBeGreaterThanOrEqual(3);
  });

  test("l'accord s'ouvre avec l'humeur du passage", () => {
    const palette = scene.palette;
    const maxLongueur = (mood: "sombre" | "explosif") => {
      let max = 0;
      for (let index = 0; index < 24; index += 1) {
        max = Math.max(max, sceneChord(palette, index, plan.seed, mood).length);
      }
      return max;
    };
    // Même tirage, seule l'humeur change : un passage explosif déploie plus de
    // teintes qu'un passage sombre, volontairement serré.
    expect(maxLongueur("explosif")).toBeGreaterThan(maxLongueur("sombre"));
  });

  test("la teinte de contraste s'écarte de la dominante", () => {
    const f = frame();
    // Le fond et les foyers s'en servent : sans écart franc, l'image retombait
    // sur une seule couleur, quel que soit l'accord.
    expect(ecart(contrastHue(f), f.palette.hue)).toBeGreaterThanOrEqual(40);
  });
});

describe("faisceaux adoucis", () => {
  test("les couches vont de l'enveloppe large au coeur etroit", () => {
    // C'est la superposition qui fond le bord : sans décroissance de largeur et
    // croissance de densité, on retombe sur un triangle aux arêtes nettes.
    const couches = beamLayers(100, 0.5, 0.7, 4);
    expect(couches.length).toBe(4);
    for (let index = 1; index < couches.length; index += 1) {
      expect(couches[index]!.halfWidth).toBeLessThan(couches[index - 1]!.halfWidth);
      expect(couches[index]!.alpha).toBeGreaterThan(couches[index - 1]!.alpha);
      expect(couches[index]!.lightness).toBeGreaterThan(couches[index - 1]!.lightness);
    }
    // L'enveloppe reste discrète : elle ne doit pas dessiner un bord visible.
    expect(couches[0]!.alpha).toBeLessThan(0.5 * couches[couches.length - 1]!.alpha);
  });

  test("une seule couche reste un faisceau plein", () => {
    const couches = beamLayers(80, 0.4, 0.6, 1);
    expect(couches.length).toBe(1);
    expect(couches[0]!.halfWidth).toBe(80);
    expect(couches[0]!.alpha).toBe(0.4);
  });

  test("le pied suit la largeur demandee", () => {
    // Une lampe ponctuelle n'a pas de largeur à la source : le pied doit
    // pouvoir être quasi nul, sinon le faisceau devient un trapèze.
    const ponctuel = beamLayers(100, 0.5, 0.7, 3, 0.04);
    expect(ponctuel[0]!.footHalfWidth).toBeLessThan(6);
    const large = beamLayers(100, 0.5, 0.7, 3, 0.32);
    expect(large[0]!.footHalfWidth).toBeGreaterThan(30);
  });

  test("le rayon des nappes suit la taille de l'ecran", () => {
    // Les rayons doivent croître avec l'écran : le même spectacle doit être aussi
    // diffusé sur une télévision et sur un mur de projection.
    expect(hazeRadiusPixels(1920, 1080, 0.95)).toBeGreaterThan(hazeRadiusPixels(1280, 720, 0.95));
    expect(hazeRadiusPixels(1280, 720, 0.95)).toBeGreaterThanOrEqual(5);
    expect(hazeRadiusPixels(4000, 2000, 0.95)).toBeLessThanOrEqual(16);
    expect(hazeFineRadiusPixels(1280, 720, 0.95)).toBeGreaterThanOrEqual(2);
    expect(hazeFineRadiusPixels(4000, 2000, 0.95)).toBeLessThanOrEqual(8);
    // La nappe fine doit rester nettement plus discrète que la large : c'est
    // tout l'intérêt d'en avoir deux.
    expect(hazeFineRadiusPixels(1280, 720, 0.95)).toBeLessThan(hazeRadiusPixels(1280, 720, 0.95));
    // Sur une machine qui souffle, la diffusion est plus discrète — mais elle est
    // là quand même.
    expect(hazeRadiusPixels(1280, 720, 0.45)).toBeGreaterThan(0);
    expect(hazeRadiusPixels(1280, 720, 0.45)).toBeLessThan(hazeRadiusPixels(1280, 720, 0.95));
  });

  test("un trait ne diffuse pas comme un gros faisceau", () => {
    // C'est la leçon de la pluie de lumière : un rayon de flou unique broie tout
    // ce qui est plus étroit que lui, et les colonnes disparaissaient. Chaque
    // faisceau part donc dans la nappe qui lui convient.
    expect(hazeFineRadiusPixels(1280, 720, 1)).toBeLessThan(hazeRadiusPixels(1280, 720, 1));

    const { haze, fine, large } = fakeHaze();
    const ctx = fakeContext().ctx;
    const dessine = (width: number) =>
      softBeam(ctx, {
        x: 100,
        y: 100,
        angle: 0,
        length: 300,
        width,
        hue: 300,
        saturation: 0.8,
        lightness: 0.6,
        alpha: 0.4,
        quality: 1,
        fumee: haze,
      });

    dessine(6); // colonne de pluie, branche d'étoile
    expect(dessins(fine)).toBeGreaterThan(0);
    expect(large.depot.filter((operation) => operation === "fill")).toHaveLength(0);

    dessine(90); // projecteur de wash
    expect(dessins(large)).toBeGreaterThan(0);
  });

  test("la fumee ne s'eteint jamais, meme quand la machine souffle", () => {
    // C'est ce que l'on corrige ici : le flou disparaissait d'un coup dès que la
    // qualité descendait, et le spectacle passait « de tout à rien ». Le dépôt
    // dans une nappe et sa passe de flou doivent avoir lieu à tous les paliers :
    // seule la résolution des nappes change.
    const vue = new TrackView(analysis());
    const plan = buildShowPlan(analysis(), false);

    for (const qualite of [1, 0.75, 0.45, 0.3]) {
      let depose = 0;
      for (let temps = 0; temps < 60; temps += 0.5) {
        const { haze, fine, large } = fakeHaze();
        renderFrame({
          ctx: fakeContext().ctx,
          width: 1280,
          height: 720,
          dpr: 1,
          time: temps,
          view: vue,
          plan,
          settings: DEFAULT_SETTINGS,
          reducedMotion: false,
          quality: qualite,
          frame: Math.round(temps * 60),
          haze,
        });
        for (const nappe of [fine, large]) {
          const floutee = nappe.flou.filter((operation) => operation.startsWith("filter:blur(")).length;
          if (floutee === 0) {
            // Une nappe que rien n'a nourrie n'est pas floutée en vain.
            expect(dessins(nappe)).toBe(0);
            continue;
          }
          depose += 1;
          expect(dessins(nappe)).toBeGreaterThan(0);
          expect(floutee).toBe(1);
        }
      }
      expect(depose).toBeGreaterThan(0);
    }
  });

  test("chaque nappe est floutee une seule fois par image", () => {
    // C'est le cœur de l'optimisation : chaque faisceau est déposé dans une nappe,
    // et chaque nappe n'est floutée qu'une fois par image. Le flou direct — une
    // passe pleine toile PAR projecteur — faisait tomber le spectacle à 2 images
    // par seconde sur une scène chargée, contre 40 ici.
    const vue = new TrackView(analysis());
    const plan = buildShowPlan(analysis(), false);
    let vuLaFumee = false;

    for (let temps = 0; temps < 60; temps += 0.25) {
      const { ctx, operations } = fakeContext();
      const { haze, fine, large } = fakeHaze();
      renderFrame({
        ctx,
        width: 1280,
        height: 720,
        dpr: 1,
        time: temps,
        view: vue,
        plan,
        settings: DEFAULT_SETTINGS,
        reducedMotion: false,
        quality: 1,
        frame: Math.round(temps * 60),
        haze,
      });
      let remontees = 0;
      for (const nappe of [fine, large]) {
        const floutee = nappe.flou.filter((operation) => operation.startsWith("filter:blur(")).length;
        if (floutee === 0) {
          // Rien n'y a été dessiné : la nappe n'est pas floutée en vain.
          expect(dessins(nappe)).toBe(0);
          continue;
        }
        vuLaFumee = true;
        remontees += 1;
        // Les faisceaux y sont bien déposés — remplis s'ils sont droits, tracés
        // s'ils s'enroulent...
        expect(dessins(nappe)).toBeGreaterThan(0);
        // ...la nappe est floutée en UNE passe, et remontée en UNE fois.
        expect(floutee).toBe(1);
        expect(nappe.flou.filter((operation) => operation === "drawImage").length).toBe(1);
      }
      // Une remontée par nappe utilisée, et pas une de plus.
      expect(operations.filter((operation) => operation === "drawImage").length).toBe(remontees);
      // Aucun flou ne part directement sur la toile : c'est tout l'intérêt.
      expect(operations.filter((operation) => operation.startsWith("filter:blur(")).length).toBe(0);
    }

    // Le wash et les familles à faisceaux doivent finir par y passer.
    expect(vuLaFumee).toBe(true);
  });

  test("un faisceau courbe s'enroule au lieu de filer droit", () => {
    // C'est ce qui fait lire un vortex : un rayon droit ne tourne pas.
    const { ctx, operations } = fakeContext();
    curvedBeam(ctx, {
      x: 100,
      y: 100,
      angle: 0,
      length: 300,
      width: 8,
      courbure: Math.PI / 2,
      hue: 300,
      saturation: 0.8,
      lightness: 0.6,
      alpha: 0.4,
      quality: 1,
    });
    expect(operations.filter((operation) => operation.startsWith("quadraticCurveTo:")).length).toBeGreaterThan(0);
    expect(operations.filter((operation) => operation === "stroke").length).toBeGreaterThan(0);
    // La courbe s'arrête là où l'enroulement la mène, pas droit devant : avec un
    // quart de tour d'enroulement, le bout du rayon est à la verticale.
    const courbe = operations.find((operation) => operation.startsWith("quadraticCurveTo:"))!;
    const nombres = courbe.split(":")[1]!.split(",").map(Number);
    const [ex, ey] = [nombres[2], nombres[3]];
    expect(Number(ex)).toBeCloseTo(100, 0);
    expect(Number(ey)).toBeGreaterThan(350);
  });

  test("un faisceau souple dessine plusieurs passages", () => {
    // Preuve au rendu : un faisceau à trois couches remplit trois fois, un
    // faisceau à une couche une seule fois.
    const remplissages = (layers: number) => {
      const { ctx, operations } = fakeContext();
      softBeam(ctx as unknown as CanvasRenderingContext2D, {
        x: 0,
        y: 720,
        angle: -Math.PI / 2,
        length: 800,
        width: 60,
        hue: 200,
        saturation: 0.9,
        lightness: 0.7,
        alpha: 0.5,
        layers,
      });
      return operations.filter((operation) => operation === "fill").length;
    };
    expect(remplissages(3)).toBe(3);
    expect(remplissages(1)).toBe(1);
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

  test("l'impact n'ajoute plus de rangee de barres", () => {
    const data = analysis();
    // Scène imposée : on veut savoir ce qui est dessiné, et la famille « vagues »
    // ne ressemble en rien à une rangée de barres.
    const plan = buildShowPlan(data, false);
    const base = plan.scenes[0]!;
    plan.scenes = [
      { ...base, index: 0, family: "waves", variant: "waves", backdrop: "waves", start: 0, end: 1e6, fadeIn: 0 },
    ];
    // Même analyse des deux côtés : seule la POSITION de la montée change, donc
    // le pulsage de secours et la palette restent comparables.
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
      return operations;
    };
    const avecDrop = trace([{ start: 4, end: 8, strength: 1 }]);
    const sansDrop = trace([{ start: 40, end: 44, strength: 1 }]);
    // L'impact se voit toujours : le wash et le lavage partent bien.
    expect(avecDrop.join("|")).not.toBe(sansDrop.join("|"));

    // Une barre est un rectangle ÉTROIT. Aucune famille n'en dessine, sauf la
    // sur-couche que l'on vient de retirer : elle en alignait une vingtaine en
    // bas de l'écran, à chaque montée du morceau.
    const barres = (operations: string[]) =>
      operations.filter((operation) => {
        const m = /^fillRect:([\d.]+),([\d.]+),([\d.]+),([\d.]+)$/.exec(operation);
        return m !== null && Number(m[3]) < 320 * 0.5;
      });
    expect(barres(avecDrop)).toHaveLength(0);
    expect(barres(sansDrop)).toHaveLength(0);
  });

  test("le mode reduit supprime le lavage de l'impact", () => {
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
      if (operation === "fillRect:0.0,0.0,1280.0,720.0" && pending.startsWith("rgba(255,255,255,")) {
        total += 1;
      }
    }
    return total;
  }

  test("un flash part sur l'attaque du temps fort, jamais entre deux temps", () => {
    // Passage « intense » (40-60 s) : basse forte et énergie haute, donc les
    // temps forts portent un kick et méritent un flash. Le flash doit naître
    // juste après l'attaque, pas pendant la décroissance ni à contretemps.
    // Hors drop, la cadence de phrase allume les temps forts 44 s et 48 s.
    expect(flashFramesAt(44.25)).toBe(0);
    expect(flashFramesAt(44.05)).toBe(1);
    expect(flashFramesAt(48.25)).toBe(0);
  });

  test("aucun flash dans un passage calme", () => {
    // 0-20 s : basse faible et énergie basse, la musique ne demande rien. Le
    // show garde son mouvement mais ne flashe pas — c'est tout l'enjeu de
    // `beatStrength` : ne célébrer que les temps forts qui portent quelque chose.
    for (const t of [4.05, 8.05, 12.05, 16.05, 20.05]) {
      expect(flashFramesAt(t)).toBe(0);
    }
  });

  test("hors drop, les flashs restent espacés d'une phrase", () => {
    // Evenements = début de chaque salve de flashs.
    const events: number[] = [];
    let flashing = false;
    for (let t = 40; t < 60; t += 1 / 60) {
      const isFlash = flashFramesAt(t) > 0;
      if (isFlash && !flashing) events.push(t);
      flashing = isFlash;
    }
    expect(events.length).toBeGreaterThan(2);
    for (let i = 1; i < events.length; i += 1) {
      expect(events[i]! - events[i - 1]!).toBeGreaterThanOrEqual(3.9);
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

  test("la porte sur les basses est douce, sans marche d'une image à l'autre", () => {
    // La basse traverse le seuil pendant le morceau : le pulse doit monter
    // progressivement, pas sauter de 0 à sa valeur pleine.
    const data = analysis({ bass: [[0, 0.05], [8, 0.2], [60, 0.2]] });
    const view = new TrackView(data);
    let previous = beatStrength(view, 0);
    let maxStep = 0;
    for (let t = 1 / 60; t < 20; t += 1 / 60) {
      // Le saut d'attaque sur un temps fort est l'évènement musical lui-même :
      // on mesure la continuité ailleurs (franchissement du seuil de basses).
      if (data.beats.some((beat) => t - beat >= 0 && t - beat < 1 / 60)) continue;
      const value = beatStrength(view, t);
      maxStep = Math.max(maxStep, Math.abs(value - previous));
      previous = value;
    }
    expect(maxStep).toBeLessThan(0.25);
  });

  test("une piste sans basses ne déclenche aucun pulse", () => {
    const view = new TrackView(analysis({ bass: [[0, 0.02], [60, 0.02]] }));
    let max = 0;
    for (let t = 0; t < 60; t += 1 / 60) max = Math.max(max, beatStrength(view, t));
    expect(max).toBeLessThan(0.05);
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

describe("vérifications transverses", () => {
  /** Évènements de flash (début de salve) pour un pas d'échantillonnage donné. */
  function flashEvents(view: TrackView, step: number, until = 60): number[] {
    const events: number[] = [];
    let previous = false;
    for (let t = 0; t <= until; t += step) {
      const admitted = flashAdmitted(view, t);
      if (admitted && !previous) events.push(Number(t.toFixed(3)));
      previous = admitted;
    }
    return events;
  }

  test("les flashs admis sont les mêmes aux pas 1/60 et 1/30", () => {
    const view = new TrackView(analysis());
    const fin = flashEvents(view, 1 / 60);
    const grossier = flashEvents(view, 1 / 30);
    expect(grossier.length).toBe(fin.length);
    for (let i = 0; i < fin.length; i += 1) {
      expect(Math.abs(fin[i]! - grossier[i]!)).toBeLessThan(1 / 30 + 1e-9);
    }
  });

  test("aucune image noire sur 1 000 instants du corpus", () => {
    // Le plancher d'énergie (0,26) garantit une luminosité de fond minimale :
    // le dégradé de fond a une composante HSL d'au moins ~0,05, et le halo
    // central est toujours dessiné. On vérifie que chaque image produit bien
    // son fond, son halo et sa poussière.
    const data = analysis({ builds: [] });
    for (let index = 0; index < 1000; index += 1) {
      // Générateur déterministe : pas de Math.random dans le diagnostic.
      const t = (hash01(index * 7919 + 13) * 60 + 0.001) % 60;
      expect(visibleEnergy(new TrackView(data).energyAt(t))).toBeGreaterThanOrEqual(ENERGY_FLOOR);
      const operations = renderAt(t, data);
      expect(operations.some((operation) => operation.startsWith("fillRect:0.0,0.0,1280.0,720.0"))).toBe(true);
      expect(operations.filter((operation) => operation.startsWith("radial:")).length).toBeGreaterThan(0);
    }
  });

  test("ni render.ts ni les familles ne consultent l'horloge ou le hasard", () => {
    const sources = [readFileSync(new URL("../../src/core/render.ts", import.meta.url), "utf8")];
    const dossier = fileURLToPath(new URL("../../src/core/families/", import.meta.url));
    for (const fichier of readdirSync(dossier)) {
      if (fichier.endsWith(".ts")) sources.push(readFileSync(join(dossier, fichier), "utf8"));
    }
    for (const source of sources) {
      expect(source.includes("Math.random")).toBe(false);
      expect(source.includes("Date.now")).toBe(false);
      expect(source.includes("performance.now")).toBe(false);
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
      // Dérive périodique + respiration : aucun saut d'un pas à l'autre.
      expect(hueGap(previous, hue)).toBeLessThan(2);
      previous = hue;
    }
  });

  test("sur toute la durée, la teinte ne quitte jamais le budget d'ancre", () => {
    const data = analysis({ duration: 600 });
    const plan = buildShowPlan(data, false, 41);
    const view = new TrackView(data);
    for (let t = 0; t < 600; t += 0.5) {
      const scene =
        plan.scenes.find((candidate) => t >= candidate.start && t < candidate.end) ?? plan.scenes[plan.scenes.length - 1]!;
      const anchor = sceneAnchor(scene, plan.track);
      const hue = sceneHue(scene, t, view.buildIntensity(t), 0, false, anchor);
      const budget = scene.palette.spread + HUE_BUDGET_MARGIN_DEG;
      expect(hueGap(anchor, hue)).toBeLessThanOrEqual(budget);
    }
  });

  test("le plafonnement de teinte est doux : pas de palier au bord du budget", () => {
    const spread = 40;
    const limit = spread + HUE_BUDGET_MARGIN_DEG;
    // Juste sous la limite, la teinte est presque inchangée ; au-delà, elle se
    // rapproche sans jamais s'y coller exactement.
    expect(clampHueToAnchor(150 + spread, 150, spread)).toBeLessThan(150 + spread);
    const tresLoin = clampHueToAnchor(150 + 170, 150, spread);
    expect(hueGap(150, tresLoin)).toBeLessThan(limit);
    expect(hueGap(150, tresLoin)).toBeGreaterThan(limit * 0.95);
  });
});
