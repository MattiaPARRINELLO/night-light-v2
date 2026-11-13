import { describe, expect, test } from "bun:test";

import {
  angleBatten,
  CONCERT_FAMILIES,
  couleurBlinder,
  decroissanceFilament,
  drawFamily,
  intensiteBlinder,
  motifBlinder,
  motifBlinderFacade,
  NOMBRE_BATTENS,
  NOMBRE_BLINDERS,
  NOMBRE_BLINDERS_FACADE,
  NOMBRE_LYRES,
  orientationLyre,
  poidsBlinder,
  poidsBlinderFacade,
  positionBatten,
  positionBlinder,
  positionBlinderFacade,
  positionLyre,
  TAU_FILAMENT,
} from "../../src/core/families";
import { fakeContext } from "../support/fake_canvas";
import type { FrameState } from "../../src/core/families";
import { buildShowPlan, type DropSignature, type SceneRole } from "../../src/core/show";
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
    drop: 0,
    beatAge: Infinity,
    dropAge: Infinity,
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
    expect(NOMBRE_BLINDERS).toBe(12);
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

  test("la couleur de la barre ne sort jamais du budget du morceau", () => {
    const f = frame("refrain", 12, { dynamic: true });
    const palette = { ...f.palette, hue: 186, accent: 52, tertiary: 352 };
    const avecTrois = { ...f, palette };
    const teintes = Array.from({ length: NOMBRE_BLINDERS }, (_, index) =>
      couleurBlinder(avecTrois, index, 0.6, 1),
    );
    // Chaque cellule joue exactement une des trois couleurs du morceau.
    for (const couleur of teintes) {
      expect([186, 52, 352]).toContain(couleur.hue);
    }
    // La principale domine : aucune autre teinte ne prend la majorité.
    const principale = teintes.filter((couleur) => couleur.hue === 186).length;
    expect(principale).toBeGreaterThan(NOMBRE_BLINDERS / 2);

    // À pleine puissance, la diode se délave légèrement mais ne vire jamais à
    // l'ambre : la teinte reste celle de la palette.
    const impact = couleurBlinder(avecTrois, 0, 1, 1);
    expect(impact.hue).toBe(186);
    expect(impact.saturation).toBeGreaterThan(0.6);
    expect(impact.lightness).toBeGreaterThan(0.7);
    expect(impact.lightness).toBeLessThan(0.9);

    // Un morceau monochrome garde une seule couleur, même à pleine puissance.
    const mono = { ...f, palette: { ...f.palette, hue: 210, accent: 210 } };
    for (let index = 0; index < NOMBRE_BLINDERS; index += 1) {
      expect(couleurBlinder(mono, index, 1, 1).hue).toBe(210);
    }
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

describe("barre de blinders", () => {
  test("le motif suit le rôle de la scène", () => {
    expect(motifBlinder("drop")).toBe("tous");
    expect(motifBlinder("refrain")).toBe("un-sur-deux");
    expect(motifBlinder("montee")).toBe("chenillard");
    expect(motifBlinder("couplet")).toBe("un-sur-quatre");
  });

  test("un drop allume toute la barre", () => {
    const f = frame("drop", 12);
    for (let index = 0; index < NOMBRE_BLINDERS; index += 1) {
      expect(poidsBlinder(f, index)).toBeGreaterThan(0.99);
    }
  });

  test("un refrain allume une cellule sur deux", () => {
    const f = frame("refrain", 12);
    const allumes = Array.from({ length: NOMBRE_BLINDERS }, (_, index) => poidsBlinder(f, index));
    expect(allumes.filter((poids) => poids > 0.6)).toHaveLength(NOMBRE_BLINDERS / 2);
  });

  test("un couplet n'allume qu'une cellule sur quatre", () => {
    const f = frame("couplet", 12);
    const allumes = Array.from({ length: NOMBRE_BLINDERS }, (_, index) => poidsBlinder(f, index));
    expect(allumes.filter((poids) => poids > 0.6)).toHaveLength(NOMBRE_BLINDERS / 4);
  });

  test("le chenillard déplace la zone allumée", () => {
    const premier = frame("montee", 12);
    const second = frame("montee", 12.5);
    const zone = (f: FrameState) =>
      Array.from({ length: NOMBRE_BLINDERS }, (_, index) => poidsBlinder(f, index))
        .map((poids, index) => (poids > 0.6 ? index : -1))
        .filter((index) => index >= 0);
    expect(zone(premier).length).toBeGreaterThan(0);
    expect(zone(premier)).not.toEqual(zone(second));
  });

  test("la barre s'allume entière avant que le motif se mette en place", () => {
    const debut = frame("refrain", 0);
    for (let index = 0; index < NOMBRE_BLINDERS; index += 1) {
      expect(poidsBlinder(debut, index)).toBeGreaterThan(0.99);
    }
  });

  test("la façade du concert complète le motif du pont", () => {
    expect(NOMBRE_BLINDERS_FACADE).toBe(8);
    for (let index = 0; index < NOMBRE_BLINDERS_FACADE; index += 1) {
      const point = positionBlinderFacade(index, 1280, 720);
      expect(point.y).toBeCloseTo(720 * 0.455, 6);
      expect(point.x).toBeGreaterThanOrEqual(1280 * 0.2 - 1e-6);
      expect(point.x).toBeLessThanOrEqual(1280 * 0.8 + 1e-6);
    }
    // Le pont allume tout sur un drop : la façade alterne au lieu de répéter.
    const signature = (blinders: "tous" | "un-sur-deux"): DropSignature => ({
      plateau: "pont",
      lyres: "convergence",
      barres: "rideau",
      blinders,
      strobes: "simple",
      hue: "accent",
    });
    expect(motifBlinderFacade("drop", signature("tous"))).toBe("un-sur-deux");
    expect(motifBlinderFacade("drop", signature("un-sur-deux"))).toBe("tous");
    expect(motifBlinderFacade("refrain")).toBe("un-sur-quatre");
    expect(motifBlinderFacade("montee")).toBe("chenillard");
  });

  test("la façade ne s'allume que sur les cellules projetées", () => {
    const f = frame("refrain", 12);
    const poids = Array.from({ length: NOMBRE_BLINDERS_FACADE }, (_, index) =>
      poidsBlinderFacade(f, index),
    );
    // Projection sur douze positions : le motif « un sur quatre » garde un quart
    // des cellules, sans jamais s'éteindre complètement.
    const allumes = poids.filter((valeur) => valeur > 0.6);
    expect(allumes.length).toBeGreaterThan(0);
    expect(allumes.length).toBeLessThan(NOMBRE_BLINDERS_FACADE);
  });

  test("la barre de concert puise dans la palette, principale en tête", () => {
    const f = frame("refrain", 12, { dynamic: true });
    const dansPalette = { ...f, palette: { ...f.palette, hue: 186, accent: 52, tertiary: 352 } };
    const teintes = Array.from({ length: NOMBRE_BLINDERS_FACADE }, (_, index) =>
      couleurBlinder(dansPalette, index + 1, 0.4, 1),
    );
    expect(new Set(teintes.map((couleur) => couleur.hue)).size).toBeGreaterThan(1);
    expect(teintes.filter((couleur) => couleur.hue === 186).length).toBeGreaterThan(
      teintes.length / 2,
    );
    for (const couleur of teintes) {
      expect([186, 52, 352]).toContain(couleur.hue);
      expect(couleur.saturation).toBeGreaterThan(0.8);
    }
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

  test("le geste auto reproduit le comportement historique", () => {
    const view = new TrackView(analysis());
    const f = frame("refrain", 12);
    for (let index = 0; index < NOMBRE_LYRES; index += 1) {
      expect(orientationLyre(f, view, index, "refrain", "auto")).toEqual(
        orientationLyre(f, view, index, "refrain"),
      );
    }
  });

  test("la poursuite n'allume qu'une tête à la fois et avance", () => {
    const view = new TrackView(analysis());
    const f = frame("refrain", 12);
    const teteActive = (t: number) =>
      Array.from({ length: NOMBRE_LYRES }, (_, index) =>
        orientationLyre(
          { ...f, t, beatIndex: Math.floor(t / 0.5), beatPhase: view.beatPhase(t) },
          view,
          index,
          "refrain",
          "poursuite",
        ).intensite,
      )
        .map((valeur, index) => (valeur > 0.5 ? index : -1))
        .filter((index) => index >= 0);
    expect(teteActive(12).length).toBeGreaterThan(0);
    expect(teteActive(12).length).toBeLessThanOrEqual(2);
    expect(teteActive(12)).not.toEqual(teteActive(13));
  });

  test("chaque geste reste continu d'une image à l'autre", () => {
    const view = new TrackView(analysis());
    const gestes = ["poursuite", "eventail", "croisement", "vague"] as const;
    for (const geste of gestes) {
      const base = frame("refrain", 10);
      let precedent = orientationLyre(base, view, 0, "refrain", geste);
      let angleMax = 0;
      let intensiteMax = 0;
      for (let t = 10 + 1 / 60; t < 20; t += 1 / 60) {
        const courant = orientationLyre(
          { ...base, t, beatIndex: Math.floor(t / 0.5), beatPhase: view.beatPhase(t) },
          view,
          0,
          "refrain",
          geste,
        );
        angleMax = Math.max(angleMax, Math.abs(courant.angle - precedent.angle));
        intensiteMax = Math.max(intensiteMax, Math.abs(courant.intensite - precedent.intensite));
        precedent = courant;
      }
      expect(angleMax).toBeLessThan(0.02);
      // La poursuite déplace volontairement le point chaud plus vite que les
      // autres gestes : 0,0236 par image à 60 Hz reste une course lente, pas un
      // clignotement.
      expect(intensiteMax).toBeLessThan(geste === "poursuite" ? 0.04 : 0.02);
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
    const plan = buildShowPlan(data, false, undefined, { dramaturgy: true });
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

  test("en concert, chaque impact déploie un plateau et une signature différents", () => {
    const data = analysis({
      duration: 120,
      sections: [{ start: 0, end: 120, label: "intense", energy: 0.9, kind: "refrain", group: "B" }],
      builds: [
        { start: 15, end: 20, strength: 1 },
        { start: 40, end: 45, strength: 1 },
        { start: 65, end: 70, strength: 1 },
        { start: 90, end: 95, strength: 1 },
      ],
    });
    const plan = buildShowPlan(data, false, undefined, { hard: "dynamic" });
    const drops = plan.scenes.filter((scene) => scene.role === "drop");
    expect(drops.length).toBeGreaterThanOrEqual(3);

    const families = drops.map((scene) => scene.family);
    const plateaux = drops.map((scene) => scene.drop?.plateau);
    const signatures = drops.map((scene) => {
      const drop = scene.drop!;
      return [drop.plateau, drop.lyres, drop.barres, drop.blinders, drop.strobes, drop.hue].join("/");
    });

    // Deux impacts voisins ne rejouent ni la scène, ni la combinaison.
    expect(new Set(families).size).toBe(families.length);
    expect(new Set(plateaux).size).toBe(plateaux.length);
    expect(new Set(signatures).size).toBe(signatures.length);
    // Aucun impact ne reprend la famille de la scène qui le précède.
    for (let index = 1; index < plan.scenes.length; index += 1) {
      expect(plan.scenes[index]!.family).not.toBe(plan.scenes[index - 1]!.family);
    }
  });
});

describe("familles de lyres", () => {
  test("les trois nouvelles familles de lyres sont déclarées", () => {
    expect(Object.keys(CONCERT_FAMILIES)).toEqual(
      expect.arrayContaining(["lyres-poursuite", "lyres-duo", "lyres-eventail"]),
    );
  });

  test("les familles de lyres se dessinent sans erreur", () => {
    const view = new TrackView(analysis());
    const f = frame("refrain", 12);
    for (const family of ["lyres-poursuite", "lyres-duo", "lyres-eventail"] as const) {
      const { ctx } = fakeContext();
      expect(() => drawFamily(ctx, f, view, family)).not.toThrow();
    }
  });
});
