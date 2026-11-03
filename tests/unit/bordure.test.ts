import { describe, expect, test } from "bun:test";

import {
  blinderBordure,
  couleurBordure,
  dessinerBordure,
  intensiteBordure,
  motifBordure,
  moyenneBordure,
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
    // Le ruban est collé au bord : les centres restent dans le cadre, seuls
    // les halos débordent.
    const marge = 0;
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
    const marge = 0;
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
      expect(valeur).toBeLessThan(0.35);
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
        expect(poidsMotif(f, view, index, motif)).toBeGreaterThanOrEqual(0.05);
        expect(intensiteBordure(f, view, index)).toBeGreaterThan(0.03);
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
    expect(operations.filter((op) => op === "fill").length).toBeGreaterThan(
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
  test("un petit blinder pulse sur chaque beat, avec une attaque douce", () => {
    const view = new TrackView(analysis());
    const surBeat = frame("couplet", 12, { energy: 0.5, bass: 0.8, beat: 0.9 });
    const horsBeat = frame("couplet", 12, { energy: 0.5, bass: 0.8, beat: 0 });
    const debut = frame("couplet", 12, { energy: 0.5, bass: 0.8, beat: 0.9, beatAge: 0 });
    expect(blinderBordure(surBeat, view, 0)).toBeGreaterThan(0.25);
    expect(blinderBordure(horsBeat, view, 0)).toBe(0);
    // Pas de saut d'une image : l'attaque part de zéro.
    expect(blinderBordure(debut, view, 0)).toBe(0);
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

describe("visibilité des motifs", () => {
  test("la respiration fait respirer le corps du ruban", () => {
    const view = new TrackView(analysis());
    const f = frame("couplet", 12, { energy: 0.8 });
    const moyenne = (t: number) => {
      const etat = { ...f, t };
      let total = 0;
      for (let index = 0; index < NOMBRE_DIODES_BORDURE; index += 30) {
        total += poidsMotif(etat, view, index, "respiration");
      }
      return total / 8;
    };
    const valeurs: number[] = [];
    for (let t = 0; t < 20; t += 0.5) valeurs.push(moyenne(t));
    expect(Math.max(...valeurs) - Math.min(...valeurs)).toBeGreaterThan(0.1);
  });

  test("le chenillard laisse des zones très sombres et très vives", () => {
    const view = new TrackView(analysis());
    const f = frame("refrain", 12, { energy: 0.8 });
    const poids = Array.from({ length: NOMBRE_DIODES_BORDURE }, (_, index) =>
      poidsMotif(f, view, index, "chenillard"),
    );
    expect(Math.max(...poids) - Math.min(...poids)).toBeGreaterThan(0.4);
  });

  test("le plein éclaire tout le corps", () => {
    const view = new TrackView(analysis());
    let f = frame("drop", 12, { energy: 0.9 });
    for (let t = 1; t < 400; t += 1) {
      f = frame("drop", t, { energy: 0.9 });
      const temps = f.beatIndex + f.beatPhase;
      const local = temps / 8 - Math.floor(temps / 8);
      if (motifBordure(f, view) === "plein" && local > 0.3) break;
    }
    expect(motifBordure(f, view)).toBe("plein");
    expect(moyenneBordure(f, view)).toBeCloseTo(1, 2);
  });
});

describe("stabilité du motif", () => {
  test("l'énergie qui oscille autour d'un seuil ne fait pas clignoter le motif", () => {
    const view = new TrackView(analysis());
    const base = frame("couplet", 12, { energy: 0.3 });
    const motifs = new Set<string>();
    for (let i = 0; i < 40; i += 1) {
      const energie = 0.28 + (i % 2) * 0.04;
      motifs.add(motifBordure({ ...base, energy: energie }, view));
    }
    expect(motifs.size).toBe(1);
    expect(moyenneBordure({ ...base, energy: 0.28 }, view)).toBe(
      moyenneBordure({ ...base, energy: 0.32 }, view),
    );
  });
});

describe("attaque du gros blinder", () => {
  test("l'éclat monte en ~50 ms au lieu de sauter d'une image", () => {
    const view = new TrackView(analysis());
    const base = frame("drop", 12, { energy: 0.9, bass: 0.9, beatAge: 0.05, dropAge: 0.05 });
    const debut = frame("drop", 12, { energy: 0.9, bass: 0.9, beatAge: 0, dropAge: 0 });
    expect(blinderBordure(base, view, 0)).toBeGreaterThan(0.4);
    expect(blinderBordure(debut, view, 0)).toBe(0);
  });
});

describe("coins du ruban", () => {
  test("les tronçons passent par le coin au lieu de le couper", () => {
    const view = new TrackView(analysis());
    const f = frame("couplet", 12, { energy: 0.6 });
    const { ctx, operations } = fakeContext();
    dessinerBordure(ctx, f, view, 1);
    const marge = Math.min(f.width, f.height) * 0.003;
    const coin = `${marge.toFixed(1)},${marge.toFixed(1)}`;
    // Le coin haut-gauche n'apparaît comme `lineTo` que si un tronçon y passe.
    expect(operations).toContain(`lineTo:${coin}`);
  });
});

describe("contraste allumé / éteint", () => {
  test("les motifs laissent de vraies zones sombres", () => {
    const view = new TrackView(analysis());
    const f = frame("refrain", 12, { energy: 0.8 });
    for (const motif of ["chenillard", "alternance", "haut", "cote"] as const) {
      const poids = Array.from({ length: NOMBRE_DIODES_BORDURE }, (_, index) =>
        poidsMotif(f, view, index, motif),
      );
      expect(Math.max(...poids) - Math.min(...poids)).toBeGreaterThan(0.6);
    }
    const respiration = Array.from({ length: NOMBRE_DIODES_BORDURE }, (_, index) =>
      poidsMotif(f, view, index, "respiration"),
    );
    // La respiration est globale : toutes les diodes ensemble, c'est le temps
    // qui fait le contraste, pas la position.
    expect(new Set(respiration).size).toBe(1);
  });
});

describe("moments forts", () => {
  test("un drop n'est pas un mur de lumière continu", () => {
    const view = new TrackView(analysis());
    const motifs = new Set<string>();
    for (let t = 0; t < 80; t += 4) {
      motifs.add(motifBordure(frame("drop", t, { energy: 0.9 }), view));
    }
    // Plusieurs motifs se succèdent : le bandeau s'éteint par endroits même au
    // plus fort du morceau.
    expect(motifs.size).toBeGreaterThan(1);
    expect([...motifs].some((motif) => motif !== "plein")).toBe(true);
  });
});

describe("remplissages progressifs", () => {
  const poids = (f: FrameState, view: TrackView, motif: MotifBordure) =>
    Array.from({ length: NOMBRE_DIODES_BORDURE }, (_, index) =>
      poidsMotif(f, view, index, motif),
    );

  test("la progression allume le pourtour petit à petit", () => {
    const view = new TrackView(analysis());
    const debut = poids(frame("couplet", 0.5, { energy: 0.8 }), view, "progression");
    const milieu = poids(frame("couplet", 6, { energy: 0.8 }), view, "progression");
    expect(debut.filter((valeur) => valeur > 0.5).length).toBeLessThan(
      milieu.filter((valeur) => valeur > 0.5).length,
    );
    expect(debut[0]).toBeGreaterThan(0.5);
    expect(debut[NOMBRE_DIODES_BORDURE - 1]).toBeLessThan(0.2);
  });

  test("le remplissage haut-bas commence par le haut", () => {
    const view = new TrackView(analysis());
    const f = frame("couplet", 1, { energy: 0.8 });
    const haut = Array.from({ length: NOMBRE_DIODES_BORDURE }, (_, index) => index).filter(
      (index) => positionBordure(index, 1280, 720).cote === "haut",
    );
    const bas = Array.from({ length: NOMBRE_DIODES_BORDURE }, (_, index) => index).filter(
      (index) => positionBordure(index, 1280, 720).cote === "bas",
    );
    expect(Math.max(...bas.map((index) => poidsMotif(f, view, index, "haut-bas")))).toBeLessThan(0.2);
    expect(Math.max(...haut.map((index) => poidsMotif(f, view, index, "haut-bas")))).toBeGreaterThan(0.5);
  });

  test("le motif milieu part du centre des bords", () => {
    const view = new TrackView(analysis());
    const f = frame("couplet", 2, { energy: 0.8 });
    const centre = Array.from({ length: NOMBRE_DIODES_BORDURE }, (_, index) => index).filter(
      (index) => positionBordure(index, 1280, 720).cote === "haut",
    );
    const valeurs = centre.map((index) => poidsMotif(f, view, index, "milieu"));
    // Le centre du bord haut est allumé, les extrémités non.
    expect(Math.max(...valeurs)).toBeGreaterThan(0.5);
    expect(Math.min(...valeurs)).toBeLessThan(0.2);
  });

  test("la vague ondule le long du pourtour", () => {
    const view = new TrackView(analysis());
    const f = frame("couplet", 3, { energy: 0.8 });
    const valeurs = poids(f, view, "vague");
    expect(Math.max(...valeurs) - Math.min(...valeurs)).toBeGreaterThan(0.5);
  });
});

describe("comète, vumètre, pluie, scintillement et strobe", () => {
  const poids = (f: FrameState, view: TrackView, motif: MotifBordure, budget = 1) =>
    Array.from({ length: NOMBRE_DIODES_BORDURE }, (_, index) =>
      poidsMotif(f, view, index, motif, budget),
    );

  test("la comète a une tête vive et une traînée", () => {
    const view = new TrackView(analysis());
    const f = frame("couplet", 12, { energy: 0.8 });
    const valeurs = poids(f, view, "comete");
    const tete = valeurs.indexOf(Math.max(...valeurs));
    expect(valeurs[tete]!).toBeGreaterThan(0.9);
    expect(valeurs[(tete + 40) % NOMBRE_DIODES_BORDURE]!).toBeLessThan(0.3);
    expect(valeurs[(tete - 30 + NOMBRE_DIODES_BORDURE) % NOMBRE_DIODES_BORDURE]!).toBeGreaterThan(
      valeurs[(tete + 30) % NOMBRE_DIODES_BORDURE]!,
    );
  });

  test("le vumètre lit les basses en bas et les aigus en haut", () => {
    const view = new TrackView(analysis());
    const f = frame("couplet", 12, { energy: 0.8, bass: 0.9, mid: 0.5, high: 0.1 });
    const bas = Array.from({ length: NOMBRE_DIODES_BORDURE }, (_, index) => index).filter(
      (index) => positionBordure(index, 1280, 720).cote === "bas",
    );
    const haut = Array.from({ length: NOMBRE_DIODES_BORDURE }, (_, index) => index).filter(
      (index) => positionBordure(index, 1280, 720).cote === "haut",
    );
    const moyenne = (indices: number[]) =>
      indices.reduce((total, index) => total + poidsMotif(f, view, index, "vumetre"), 0) /
      indices.length;
    expect(moyenne(bas)).toBeGreaterThan(moyenne(haut) + 0.2);
  });

  test("la pluie allume des gouttes qui changent", () => {
    const view = new TrackView(analysis());
    const a = poids(frame("couplet", 12, { energy: 0.8 }), view, "pluie");
    const b = poids(frame("couplet", 13, { energy: 0.8 }), view, "pluie");
    expect(Math.max(...a) - Math.min(...a)).toBeGreaterThan(0.4);
    expect(a).not.toEqual(b);
  });

  test("le scintillement suit les aigus", () => {
    const view = new TrackView(analysis());
    const eteint = poids(frame("couplet", 12, { energy: 0.8, high: 0 }), view, "scintillement");
    const allume = poids(frame("couplet", 12, { energy: 0.8, high: 0.9 }), view, "scintillement");
    expect(Math.max(...eteint)).toBeLessThan(0.1);
    expect(Math.max(...allume)).toBeGreaterThan(0.5);
  });

  test("le strobe bat vite et respecte le budget de flashs", () => {
    const view = new TrackView(analysis());
    const allume = poids(frame("couplet", 12, { energy: 0.8 }), view, "strobe", 1);
    const eteint = poids(
      frame("couplet", 12, { energy: 0.8, beatIndex: 24, beatPhase: 0.0625 }),
      view,
      "strobe",
      1,
    );
    expect(Math.max(...allume)).toBeGreaterThan(0.9);
    expect(Math.max(...eteint)).toBeLessThan(0.1);
    const coupe = poids(frame("couplet", 12, { energy: 0.8 }), view, "strobe", 0);
    expect(Math.max(...coupe)).toBeLessThan(0.1);
  });
});

describe("les beats reprennent le dessus", () => {
  test("à beat égal, tout le ruban monte vers l'allumé", () => {
    const view = new TrackView(analysis());
    const sans = moyenneBordure(frame("couplet", 12, { energy: 0.5, beat: 0 }), view);
    const avec = moyenneBordure(frame("couplet", 12, { energy: 0.5, beat: 0.9 }), view);
    expect(avec).toBeGreaterThan(sans + 0.1);
  });

  test("le mode réduit plafonne la reprise du beat", () => {
    const view = new TrackView(analysis());
    const sans = moyenneBordure(frame("couplet", 12, { energy: 0.5, beat: 0, reduced: true }), view);
    const avec = moyenneBordure(frame("couplet", 12, { energy: 0.5, beat: 0.9, reduced: true }), view);
    expect(avec - sans).toBeLessThan(0.3);
  });
});

describe("strobe réservé aux gros drops", () => {
  const motifDrop = (buildStrength: number) => {
    const view = new TrackView(analysis());
    const motifs = new Set<string>();
    for (let t = 0; t < 120; t += 2) {
      motifs.add(
        motifBordure(frame("drop", t, { energy: 0.9, buildStrength }), view),
      );
    }
    return motifs;
  };

  test("un gros drop peut strober", () => {
    expect(motifDrop(1).has("strobe")).toBe(true);
  });

  test("un drop moyen ne strobe jamais", () => {
    expect(motifDrop(0.3).has("strobe")).toBe(false);
  });
});

describe("strobe et grosses basses continues", () => {
  const vueGrosseBasse = () =>
    new TrackView(
      analysis({
        bass: [
          [0, 0.95],
          [120, 0.95],
        ],
      }),
    );

  test("des basses continues fortes autorisent le strobe sur un drop moyen", () => {
    const view = vueGrosseBasse();
    const motifs = new Set<string>();
    for (let t = 0; t < 120; t += 2) {
      motifs.add(motifBordure(frame("drop", t, { energy: 0.8, buildStrength: 0.3 }), view));
    }
    expect(motifs.has("strobe")).toBe(true);
  });

  test("des basses continues fortes autorisent le strobe en refrain", () => {
    const view = vueGrosseBasse();
    const motifs = new Set<string>();
    for (let t = 0; t < 120; t += 2) {
      motifs.add(motifBordure(frame("refrain", t, { energy: 0.8 }), view));
    }
    expect(motifs.has("strobe")).toBe(true);
  });

  test("des basses faibles ne déclenchent pas le strobe", () => {
    const view = new TrackView(
      analysis({
        bass: [
          [0, 0.2],
          [120, 0.2],
        ],
      }),
    );
    const motifs = new Set<string>();
    for (let t = 0; t < 120; t += 2) {
      motifs.add(motifBordure(frame("drop", t, { energy: 0.8, buildStrength: 0.3 }), view));
    }
    expect(motifs.has("strobe")).toBe(false);
  });
});
