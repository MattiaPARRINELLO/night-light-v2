import { describe, expect, test } from "bun:test";

import {
  angleBatten,
  couleurBlinder,
  decroissanceFilament,
  intensiteBlinder,
  NOMBRE_BATTENS,
  NOMBRE_BLINDERS,
  NOMBRE_LYRES,
  orientationLyre,
  positionBatten,
  positionBlinder,
  positionLyre,
  TAU_FILAMENT,
} from "../../src/core/families";
import type { FrameState } from "../../src/core/families";
import { buildShowPlan, type SceneRole } from "../../src/core/show";
import { TrackView } from "../../src/core/view";
import type { Analysis } from "../../src/types";

function analysis(overrides: Partial<Analysis> = {}): Analysis {
  const beats: number[] = [];
  for (let t = 0; t <= 120; t += 0.5) beats.push(Number(t.toFixed(3)));
  return {
    schema: 2,
    duration: 120,
    tempo: 120,
    beatCount: beats.length,
    beatPeriod: 0.5,
    beats,
    onsets: [],
    energy: [
      [0, 0.8],
      [120, 0.8],
    ],
    bass: [
      [0, 0.8],
      [120, 0.8],
    ],
    mid: [
      [0, 0.5],
      [120, 0.5],
    ],
    high: [
      [0, 0.3],
      [120, 0.3],
    ],
    sections: [{ start: 0, end: 120, label: "intense", energy: 0.8 }],
    builds: [],
    ...overrides,
  };
}

function frame(role: SceneRole, t = 12, overrides: Partial<FrameState> = {}): FrameState {
  const data = analysis();
  const plan = buildShowPlan(data, false);
  const scene = { ...plan.scenes[0]!, role };
  return {
    t,
    width: 1280,
    height: 720,
    dpr: 1,
    scene,
    palette: scene.palette,
    energy: 0.8,
    bass: 0.8,
    mid: 0.5,
    high: 0.3,
    beat: 0.6,
    beatPhase: 0,
    beatIndex: Math.floor(t / 0.5),
    build: 0,
    buildStrength: 0,
    surge: 0,
    intensity: 1,
    alpha: 1,
    reduced: false,
    quality: 1,
    seed: plan.seed,
    frame: 0,
    ...overrides,
  };
}

describe("géométrie du plateau", () => {
  test("les huit lyres suivent exactement la formule du pont", () => {
    const largeur = 1280;
    const hauteur = 720;
    expect(NOMBRE_LYRES).toBe(8);
    for (let index = 0; index < NOMBRE_LYRES; index += 1) {
      const point = positionLyre(index, largeur, hauteur);
      expect(point.x).toBeCloseTo(largeur * (0.15 + 0.7 * (index / 7)), 6);
      expect(point.y).toBeCloseTo(hauteur * 0.14, 6);
    }
  });

  test("les barres LED et les blinders restent sur leurs traverses", () => {
    const largeur = 1280;
    const hauteur = 720;
    expect(NOMBRE_BATTENS).toBe(16);
    expect(NOMBRE_BLINDERS).toBe(4);
    for (let index = 0; index < NOMBRE_BATTENS; index += 1) {
      const point = positionBatten(index, largeur, hauteur);
      expect(point.y).toBeCloseTo(hauteur * 0.3, 6);
      expect(point.x).toBeGreaterThanOrEqual(largeur * 0.3 - 1e-6);
      expect(point.x).toBeLessThanOrEqual(largeur * 0.7 + 1e-6);
    }
    for (let index = 0; index < NOMBRE_BLINDERS; index += 1) {
      expect(positionBlinder(index, largeur, hauteur).y).toBeCloseTo(hauteur * 0.132, 6);
    }
  });
});

describe("inertie thermique des blinders", () => {
  test("la décroissance suit exp(-Δt / τ)", () => {
    expect(decroissanceFilament(0)).toBe(1);
    expect(decroissanceFilament(TAU_FILAMENT)).toBeCloseTo(Math.exp(-1), 6);
    expect(decroissanceFilament(TAU_FILAMENT * 2)).toBeCloseTo(Math.exp(-2), 6);
    expect(decroissanceFilament(-0.1)).toBe(0);
    expect(decroissanceFilament(5)).toBeLessThan(1e-9);
  });

  test("un impact allume puis éteint le filament sans état accumulé", () => {
    const data = analysis({
      bass: [
        [0, 0.1],
        [120, 0.1],
      ],
      builds: [{ start: 8, end: 10, strength: 1 }],
    });
    const view = new TrackView(data);
    const debut = intensiteBlinder(frame("drop", 10, { energy: 0.8 }), view, 0);
    const milieu = intensiteBlinder(frame("drop", 10 + TAU_FILAMENT, { energy: 0.8 }), view, 0);
    const fin = intensiteBlinder(frame("drop", 12.5, { energy: 0.8 }), view, 0);
    expect(debut).toBeGreaterThan(0.8);
    expect(milieu).toBeLessThan(debut * 0.45);
    expect(fin).toBeLessThan(0.002);
    // Deux appels au même instant donnent rigoureusement la même valeur.
    expect(intensiteBlinder(frame("drop", 10.22, { energy: 0.8 }), view, 0)).toBe(
      intensiteBlinder(frame("drop", 10.22, { energy: 0.8 }), view, 0),
    );
  });

  test("le filament passe du blanc chaud à l'ambre puis au rouge", () => {
    const blanc = couleurBlinder(1);
    const ambre = couleurBlinder(0.6);
    const rouge = couleurBlinder(0.1);
    expect(blanc.lightness).toBeGreaterThan(0.9);
    expect(blanc.saturation).toBeLessThan(0.3);
    expect(ambre.hue).toBeGreaterThan(25);
    expect(ambre.hue).toBeLessThan(45);
    expect(ambre.saturation).toBeGreaterThan(0.8);
    expect(rouge.hue).toBeLessThan(15);
    expect(rouge.lightness).toBeLessThan(0.45);
  });

  test("en mode direct, le transient live remplace la grille d'impacts", () => {
    const view = new TrackView(analysis({ beats: [], builds: [] }));
    const allume = intensiteBlinder(frame("drop", 12, { beat: 0.9, bass: 0.8 }), view, 0);
    const eteint = intensiteBlinder(frame("drop", 12, { beat: 0 }), view, 0);
    expect(allume).toBeGreaterThan(0.3);
    expect(eteint).toBe(0);
  });

  test("le mode réduit garde une lueur douce, jamais un éclat", () => {
    const data = analysis({
      bass: [
        [0, 0.1],
        [120, 0.1],
      ],
      builds: [{ start: 8, end: 10, strength: 1 }],
    });
    const view = new TrackView(data);
    const normal = intensiteBlinder(frame("drop", 10.02), view, 0);
    const reduit = intensiteBlinder(frame("drop", 10.02, { reduced: true }), view, 0);
    expect(reduit).toBeLessThan(normal);
    expect(reduit).toBeLessThan(0.35);
  });
});

describe("cinématiques des lyres et des barres", () => {
  test("le ballyhoo déphase les têtes et reste borné", () => {
    const view = new TrackView(analysis());
    const f = frame("refrain", 12);
    const angles = Array.from({ length: NOMBRE_LYRES }, (_, index) =>
      orientationLyre(f, view, index).angle,
    );
    expect(new Set(angles.map((angle) => angle.toFixed(4))).size).toBeGreaterThan(1);
    for (const angle of angles) {
      expect(Number.isFinite(angle)).toBe(true);
      expect(angle).toBeGreaterThan(0.5);
      expect(angle).toBeLessThan(Math.PI - 0.5);
    }
  });

  test("le drop fait converger toutes les lyres vers le sol", () => {
    const view = new TrackView(analysis());
    const f = frame("drop", 12);
    const gauche = orientationLyre(f, view, 0).angle;
    const droite = orientationLyre(f, view, NOMBRE_LYRES - 1).angle;
    expect(gauche).toBeLessThan(Math.PI / 2);
    expect(droite).toBeGreaterThan(Math.PI / 2);
    // La convergence est instantanée : elle ne dépend que de l'image courante.
    expect(orientationLyre(f, view, 0).angle).toBe(orientationLyre(f, view, 0).angle);
  });

  test("l'éventail de montée s'ouvre symétriquement", () => {
    const view = new TrackView(analysis());
    const f = frame("montee", 12);
    const gauche = orientationLyre(f, view, 0).angle;
    const droite = orientationLyre(f, view, NOMBRE_LYRES - 1).angle;
    expect(gauche).toBeLessThan(Math.PI / 2);
    expect(droite).toBeGreaterThan(Math.PI / 2);
    expect(Math.abs(gauche - Math.PI / 2)).toBeCloseTo(Math.abs(droite - Math.PI / 2), 6);
  });

  test("les mouvements restent continus d'une image à l'autre", () => {
    const view = new TrackView(analysis());
    const pas = 1 / 60;
    for (const role of ["intro", "couplet", "refrain", "montee", "finale", "drop"] as SceneRole[]) {
      const base = frame(role, role === "drop" ? 0 : 10);
      let precedent = orientationLyre(base, view, 0);
      let angleMax = 0;
      let intensiteMax = 0;
      for (let t = (role === "drop" ? 0 : 10) + pas; t < (role === "drop" ? 2 : 20); t += pas) {
        const courant = orientationLyre(
          { ...base, t, beatIndex: Math.floor(t / 0.5), beatPhase: view.beatPhase(t) },
          view,
          0,
        );
        angleMax = Math.max(angleMax, Math.abs(courant.angle - precedent.angle));
        intensiteMax = Math.max(intensiteMax, Math.abs(courant.intensite - precedent.intensite));
        precedent = courant;
      }
      // Aucun saut d'angle ni clignotement : à 60 images/s, une lyre bouge
      // lentement et garde une intensité stable.
      expect(angleMax).toBeLessThan(0.02);
      expect(intensiteMax).toBeLessThan(0.02);
    }
  });

  test("le prisme s'ouvre progressivement avec l'énergie", () => {
    const view = new TrackView(analysis());
    const base = frame("refrain", 12);
    let precedent = orientationLyre({ ...base, energy: 0.45 }, view, 0).prisme;
    for (let energy = 0.47; energy <= 1; energy += 0.02) {
      const courant = orientationLyre({ ...base, energy }, view, 0).prisme;
      expect(courant).toBeGreaterThanOrEqual(precedent - 1e-9);
      expect(Math.abs(courant - precedent)).toBeLessThan(0.06);
      precedent = courant;
    }
  });

  test("la vague des barres LED court le long de la rampe", () => {
    const view = new TrackView(analysis());
    const f = frame("couplet", 12);
    const premiere = angleBatten(f, view, 0);
    const voisine = angleBatten(f, view, 1);
    expect(premiere).not.toBe(voisine);
    expect(angleBatten(frame("couplet", 12.25), view, 0)).not.toBe(premiere);
    // En rideau, toutes les lames tombent exactement à la verticale.
    for (const role of ["refrain", "drop"] as SceneRole[]) {
      for (let index = 0; index < NOMBRE_BATTENS; index += 1) {
        expect(angleBatten(frame(role, 12), view, index)).toBeCloseTo(Math.PI / 2, 6);
      }
    }
  });
});

describe("rôles du plan de spectacle", () => {
  test("intro, couplet, refrain, drop et finale sont attribués", () => {
    const data = analysis({
      duration: 120,
      sections: [
        { start: 0, end: 15, label: "calme", energy: 0.2, kind: "intro", group: "I" },
        { start: 15, end: 45, label: "calme", energy: 0.3, kind: "couplet", group: "A" },
        { start: 45, end: 75, label: "intense", energy: 0.9, kind: "refrain", group: "B" },
        { start: 75, end: 105, label: "montee", energy: 0.7, kind: "pont", group: "C" },
        { start: 105, end: 120, label: "descente", energy: 0.3, kind: "outro", group: "O" },
      ],
      builds: [{ start: 95, end: 100, strength: 1 }],
    });
    const plan = buildShowPlan(data, false);
    const roles = new Set(plan.scenes.map((scene) => scene.role));
    expect(roles.has("intro")).toBe(true);
    expect(roles.has("couplet")).toBe(true);
    expect(roles.has("refrain")).toBe(true);
    expect(roles.has("montee")).toBe(true);
    expect(roles.has("drop")).toBe(true);
    expect(roles.has("finale")).toBe(true);

    // L'impact déploie le plateau complet, même au milieu d'un autre groupe.
    const impact = plan.scenes.find((scene) => Math.abs(scene.start - 100) < 0.6);
    expect(impact?.role).toBe("drop");
    expect(impact?.family).toBe("pont-concert");
  });
});
