import { describe, expect, test } from "bun:test";

import {
  blinderBordure,
  couleurBordure,
  dessinerBordure,
  intensiteBordure,
  motifBordure,
  NOMBRE_DIODES_BORDURE,
  poidsMotif,
  positionBordure,
  teinteBordure,
  type MotifBordure,
} from "../../src/core/families";
import { fakeContext } from "../support/fake_canvas";
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

describe("géométrie de la bordure", () => {
  test("les diodes font le tour du cadre, rentrées du petit côté", () => {
    const largeur = 1280;
    const hauteur = 720;
    const marge = Math.min(largeur, hauteur) * 0.012;
    const points = Array.from({ length: NOMBRE_DIODES_BORDURE }, (_, i) =>
      positionBordure(i, largeur, hauteur),
    );
    for (const p of points) {
      expect(p.x).toBeGreaterThanOrEqual(marge - 1e-6);
      expect(p.x).toBeLessThanOrEqual(largeur - marge + 1e-6);
      expect(p.y).toBeGreaterThanOrEqual(marge - 1e-6);
      expect(p.y).toBeLessThanOrEqual(hauteur - marge + 1e-6);
    }
    expect(points[0]!.cote).toBe("haut");
    expect(points.some((p) => p.cote === "bas")).toBe(true);
    expect(points.some((p) => p.cote === "gauche")).toBe(true);
    expect(points.some((p) => p.cote === "droite")).toBe(true);
  });

  test("le pourtour tient aussi en portrait", () => {
    const largeur = 400;
    const hauteur = 900;
    const marge = Math.min(largeur, hauteur) * 0.012;
    for (let index = 0; index < NOMBRE_DIODES_BORDURE; index += 1) {
      const p = positionBordure(index, largeur, hauteur);
      expect(p.x).toBeGreaterThanOrEqual(marge - 1e-6);
      expect(p.x).toBeLessThanOrEqual(largeur - marge + 1e-6);
      expect(p.y).toBeGreaterThanOrEqual(marge - 1e-6);
      expect(p.y).toBeLessThanOrEqual(hauteur - marge + 1e-6);
    }
  });
});

describe("intensité de la bordure", () => {
  test("la bordure reste une veilleuse au calme et s'allume sur un impact", () => {
    const view = new TrackView(analysis());
    const calme = frame("couplet", 12, { energy: 0.1, drop: 0, beat: 0 });
    const impact = frame("drop", 12, { energy: 0.95, drop: 1, beat: 1 });
    for (let index = 0; index < NOMBRE_DIODES_BORDURE; index += 1) {
      const valeur = intensiteBordure(calme, view, index);
      expect(valeur).toBeGreaterThan(0.05);
      expect(valeur).toBeLessThan(0.15);
    }
    expect(intensiteBordure(impact, view, 0)).toBeGreaterThan(intensiteBordure(calme, view, 0));
  });

  test("le mode réduit et un budget nul plafonnent la bordure", () => {
    const view = new TrackView(analysis());
    const impact = frame("drop", 12, { energy: 1, drop: 1, beat: 1 });
    expect(intensiteBordure({ ...impact, reduced: true }, view, 0, 1)).toBeLessThanOrEqual(0.31);
    expect(intensiteBordure(impact, view, 0, 0)).toBeLessThanOrEqual(
      intensiteBordure(impact, view, 0, 1),
    );
  });

  test("l'intensité est pure et finie", () => {
    const view = new TrackView(analysis());
    const f = frame("refrain", 12, { energy: 0.8 });
    for (let index = 0; index < NOMBRE_DIODES_BORDURE; index += 1) {
      const valeur = intensiteBordure(f, view, index);
      expect(Number.isFinite(valeur)).toBe(true);
      expect(valeur).toBeGreaterThanOrEqual(0);
      expect(valeur).toBeLessThanOrEqual(1);
      expect(intensiteBordure(f, view, index)).toBe(valeur);
    }
  });
});

describe("motifs de la bordure", () => {
  const largeur = 1280;
  const hauteur = 720;
  const poidsParCote = (
    f: FrameState,
    view: TrackView,
    motif: MotifBordure,
    cote: "haut" | "bas" | "gauche" | "droite",
  ) =>
    Array.from({ length: NOMBRE_DIODES_BORDURE }, (_, index) => index)
      .filter((index) => positionBordure(index, largeur, hauteur).cote === cote)
      .map((index) => poidsMotif(f, view, index, motif));

  test("le motif change au fil du morceau et n'allume pas toujours tout", () => {
    const view = new TrackView(analysis());
    const motifs = new Set<MotifBordure>();
    for (let t = 0; t < 60; t += 0.5) {
      motifs.add(motifBordure(frame("refrain", t, { energy: 0.8 }), view));
    }
    expect(motifs.size).toBeGreaterThan(1);
  });

  test("le motif haut n'allume que le bord supérieur", () => {
    const view = new TrackView(analysis());
    const f = frame("montee", 12, { energy: 0.5, build: 0.2 });
    expect(Math.min(...poidsParCote(f, view, "haut", "haut"))).toBeGreaterThan(0.9);
    expect(Math.max(...poidsParCote(f, view, "haut", "bas"))).toBeLessThan(0.35);
  });

  test("le chenillard déplace le point lumineux", () => {
    const view = new TrackView(analysis());
    const pointChaud = (t: number) => {
      const f = frame("refrain", t, { energy: 0.8 });
      let meilleur = 0;
      let indexMeilleur = 0;
      for (let index = 0; index < NOMBRE_DIODES_BORDURE; index += 1) {
        const poids = poidsMotif(f, view, index, "chenillard");
        if (poids > meilleur) {
          meilleur = poids;
          indexMeilleur = index;
        }
      }
      return indexMeilleur;
    };
    expect(pointChaud(12)).not.toEqual(pointChaud(13));
  });

  test("l'alternance allume un côté puis l'autre", () => {
    const view = new TrackView(analysis());
    const moyenne = (t: number) => {
      const f = frame("refrain", t, { energy: 0.8, beatIndex: Math.floor(t / 0.5), beatPhase: 0 });
      const gauche = poidsParCote(f, view, "alternance", "gauche");
      const droite = poidsParCote(f, view, "alternance", "droite");
      return {
        gauche: gauche.reduce((a, b) => a + b, 0) / gauche.length,
        droite: droite.reduce((a, b) => a + b, 0) / droite.length,
      };
    };
    const a = moyenne(12);
    const b = moyenne(14);
    expect(a.gauche + a.droite).toBeGreaterThan(0);
    expect((a.gauche > a.droite) !== (b.gauche > b.droite)).toBe(true);
  });

  test("la respiration garde toutes les diodes ensemble", () => {
    const view = new TrackView(analysis());
    const f = frame("couplet", 12, { energy: 0.8 });
    const poids = Array.from({ length: NOMBRE_DIODES_BORDURE }, (_, index) =>
      poidsMotif(f, view, index, "respiration"),
    );
    expect(new Set(poids.map((valeur) => valeur.toFixed(6))).size).toBe(1);
  });

  test("le plein allume tout et le rail reste discret", () => {
    const view = new TrackView(analysis());
    const f = frame("drop", 12, { energy: 0.9 });
    for (let index = 0; index < NOMBRE_DIODES_BORDURE; index += 1) {
      expect(poidsMotif(f, view, index, "plein")).toBe(1);
      expect(poidsMotif(f, view, index, "rail")).toBeLessThan(0.5);
    }
  });

  test("la bande est dense et toujours visible, même au calme", () => {
    expect(NOMBRE_DIODES_BORDURE).toBeGreaterThanOrEqual(200);
    const view = new TrackView(analysis());
    const f = frame("couplet", 12, { energy: 0.05 });
    const motifs = [
      "rail",
      "haut",
      "cote",
      "alternance",
      "chenillard",
      "respiration",
      "plein",
    ] as const;
    for (const motif of motifs) {
      for (let index = 0; index < NOMBRE_DIODES_BORDURE; index += 11) {
        expect(poidsMotif(f, view, index, motif)).toBeGreaterThan(0.2);
        expect(intensiteBordure(f, view, index)).toBeGreaterThan(0.05);
      }
    }
  });

  test("les diodes voisines gardent une seule famille de couleur", () => {
    const f = frame("refrain", 12, { energy: 0.8 });
    const teintes = Array.from({ length: NOMBRE_DIODES_BORDURE }, (_, index) =>
      couleurBordure(f, index),
    );
    expect(teintes.some((teinte) => teinte !== teintes[0])).toBe(true);
    expect(Math.max(...teintes) - Math.min(...teintes)).toBeLessThan(40);
    // Pas de raccord visible au bouclage du pourtour.
    expect(Math.abs(teintes[0]! - teintes[teintes.length - 1]!)).toBeLessThan(1);
  });
});

describe("dessin de la bordure", () => {
  test("dessinerBordure dépose des diodes et reste pure", () => {
    const view = new TrackView(analysis());
    const f = frame("drop", 12, { energy: 1, drop: 1, beat: 1 });
    const premier = fakeContext();
    dessinerBordure(premier.ctx, f, view, 1);
    const second = fakeContext();
    dessinerBordure(second.ctx, f, view, 1);
    expect(premier.operations.filter((op) => op === "stroke").length).toBeGreaterThan(0);
    expect(second.operations).toEqual(premier.operations);
  });

  test("en mode réduit, la bordure reste discrète", () => {
    const view = new TrackView(analysis());
    const f = frame("drop", 12, { energy: 1, drop: 1, beat: 1, reduced: true });
    const { ctx, operations } = fakeContext();
    dessinerBordure(ctx, f, view, 1);
    expect(operations.filter((op) => op === "stroke").length).toBeGreaterThan(0);
  });
});

describe("transitions et mode réduit de la bordure", () => {
  test("les changements de motif et de côté sont fondus", () => {
    const view = new TrackView(analysis());
    for (const role of ["refrain", "couplet", "montee"] as const) {
      const base = frame(role, 10, { energy: 0.8 });
      // Budget 0 : on teste la continuité du ruban seul, pas les éclats de blinder.
      let precedent = intensiteBordure(base, view, 0, 0);
      let sautMax = 0;
      for (let t = 10 + 1 / 60; t < 30; t += 1 / 60) {
        const courant = intensiteBordure(
          { ...base, t, beatIndex: Math.floor(t / 0.5), beatPhase: view.beatPhase(t) },
          view,
          0,
          0,
        );
        sautMax = Math.max(sautMax, Math.abs(courant - precedent));
        precedent = courant;
      }
      expect(sautMax).toBeLessThan(0.06);
    }
  });

  test("le mode réduit n'utilise ni chenillard ni éclat", () => {
    const view = new TrackView(analysis());
    const f = frame("refrain", 12, { energy: 0.9, reduced: true });
    for (let t = 0; t < 40; t += 0.5) {
      const motif = motifBordure({ ...f, t, beatIndex: Math.floor(t / 0.5) }, view);
      expect(["rail", "respiration"]).toContain(motif);
    }
    const impact = frame("drop", 12, { energy: 1, drop: 1, reduced: true });
    expect(intensiteBordure(impact, view, 0, 0)).toBe(intensiteBordure(impact, view, 0, 1));
  });

  test("le budget de flash dose l'éclat, pas le motif", () => {
    const view = new TrackView(analysis());
    const f = frame("couplet", 12, { energy: 0.2, drop: 1 });
    expect(intensiteBordure(f, view, 0, 1)).toBeGreaterThan(intensiteBordure(f, view, 0, 0));
  });
});

describe("densité du ruban", () => {
  test("le ruban reste dessiné même au calme", () => {
    const view = new TrackView(analysis());
    const f = frame("couplet", 12, { energy: 0.05 });
    const { ctx, operations } = fakeContext();
    dessinerBordure(ctx, f, view, 1);
    expect(operations.filter((op) => op === "stroke").length).toBeGreaterThan(
      NOMBRE_DIODES_BORDURE * 0.5,
    );
  });
});

describe("le ruban sert aussi de blinders", () => {
  test("un impact allume le ruban comme un filament, avec inertie", () => {
    const vue = new TrackView(
      analysis({
        beats: [],
        bass: [
          [0, 0.1],
          [120, 0.1],
        ],
        builds: [{ start: 10, end: 12, strength: 1 }],
      }),
    );
    const impact = frame("drop", 12, { energy: 0.9, beat: 0, bass: 0 });
    const debut = blinderBordure(impact, vue, 0);
    const milieu = blinderBordure({ ...impact, t: 12.11 }, vue, 0);
    const fin = blinderBordure({ ...impact, t: 14.5 }, vue, 0);
    expect(debut).toBeGreaterThan(0.5);
    expect(milieu).toBeLessThan(debut);
    expect(fin).toBeLessThan(0.01);
  });

  test("budget de flash nul et mode réduit éteignent le blinder", () => {
    const view = new TrackView(analysis());
    const impact = frame("drop", 12, { energy: 0.9, bass: 0.9 });
    expect(blinderBordure(impact, view, 0, 0)).toBe(0);
    expect(blinderBordure({ ...impact, reduced: true }, view, 0)).toBe(0);
  });

  test("le blinder du ruban est de couleur, pas tungstène", () => {
    const view = new TrackView(analysis());
    const impact = frame("drop", 12, { energy: 0.9, bass: 0.9 });
    const eclat = teinteBordure(impact, view, 0);
    const calme = teinteBordure(
      frame("couplet", 12, { energy: 0.1, bass: 0, drop: 0 }),
      view,
      0,
    );
    // Même teinte de scène, seulement plus saturée et plus lumineuse.
    expect(Math.abs(eclat.hue - calme.hue)).toBeLessThan(2);
    expect(eclat.saturation).toBeGreaterThan(calme.saturation);
    expect(eclat.lightness).toBeGreaterThan(calme.lightness);
  });
});

describe("sensibilité du blinder de ruban", () => {
  test("un petit blinder pulse sur chaque beat", () => {
    const view = new TrackView(analysis());
    const surBeat = frame("couplet", 12, { energy: 0.5, bass: 0.8, beat: 0.9 });
    const horsBeat = frame("couplet", 12, { energy: 0.5, bass: 0.8, beat: 0 });
    expect(blinderBordure(surBeat, view, 0)).toBeGreaterThan(0.25);
    expect(blinderBordure(horsBeat, view, 0)).toBe(0);
  });

  test("un couplet énergique déclenche aussi le gros blinder", () => {
    const view = new TrackView(analysis());
    const fort = frame("couplet", 12, { energy: 0.8, bass: 0.9 });
    expect(blinderBordure(fort, view, 0)).toBeGreaterThan(0.4);
  });

  test("une montée déclenche plus tôt", () => {
    const view = new TrackView(analysis());
    const montee = frame("montee", 12, { energy: 0.8, build: 0.35 });
    expect(blinderBordure(montee, view, 0)).toBeGreaterThan(0.4);
  });
});
