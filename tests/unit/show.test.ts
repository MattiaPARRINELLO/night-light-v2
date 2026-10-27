import { describe, expect, test } from "bun:test";

import { barStarts, buildShowPlan, caractereAt, FAMILY_LABELS, minHueStepEff, RHYTHMIC_FAMILIES, sceneAt, sceneCadence, sceneWeight, type FamilyId, type ShowPlan } from "../../src/core/show";
import { hslToRgb, shiftHue, shorthand } from "../../src/core/color";
import { flashAlpha } from "../../src/core/render";
import type { FrameState } from "../../src/core/render";
import type { Analysis } from "../../src/types";
import { DEFAULT_SETTINGS } from "../../src/types";

function analysis(overrides: Partial<Analysis> = {}): Analysis {
  return {
    schema: 2,
    duration: 120,
    tempo: 128,
    beatCount: 200,
    beatPeriod: 60 / 128,
    beats: [],
    onsets: [],
    energy: [
      [0, 0.2],
      [120, 0.8],
    ],
    bass: [
      [0, 0.3],
      [120, 0.9],
    ],
    mid: [
      [0, 0.4],
      [120, 0.6],
    ],
    high: [
      [0, 0.2],
      [120, 0.7],
    ],
    sections: [
      { start: 0, end: 40, label: "calme", energy: 0.2 },
      { start: 40, end: 80, label: "intense", energy: 0.9 },
      { start: 80, end: 120, label: "montee", energy: 0.5 },
    ],
    builds: [],
    ...overrides,
  };
}

describe("show plan", () => {
  test("découpe le morceau en phrases et reste stable", () => {
    const first = buildShowPlan(analysis(), false);
    const second = buildShowPlan(analysis(), false);
    expect(first.scenes.length).toBeGreaterThan(3);
    expect(first.seed).toBe(second.seed);
    expect(first.scenes.map((scene) => [scene.family, scene.palette.hue, scene.mood])).toEqual(
      second.scenes.map((scene) => [scene.family, scene.palette.hue, scene.mood]),
    );
  });

  test("des teintes voisines restent éloignées (pas d'alternance agressive)", () => {
    const plan = buildShowPlan(analysis(), false);
    for (let index = 1; index < plan.scenes.length; index += 1) {
      const previous = plan.scenes[index - 1];
      const current = plan.scenes[index];
      if (previous === undefined || current === undefined) continue;
      let delta = Math.abs(current.palette.hue - previous.palette.hue) % 360;
      if (delta > 180) delta = 360 - delta;
      expect(delta).toBeGreaterThanOrEqual(30);
    }
  });

  test("le mode réduit retire les familles agitées", () => {
    const plan = buildShowPlan(analysis(), true);
    const families = new Set(plan.scenes.map((scene) => scene.family));
    const allowed = ["waves", "tunnel", "particles", "rings", "spiral"];
    for (const family of families) {
      expect(allowed).toContain(family);
    }
    // … et le mode normal, lui, peut sortir de cette liste.
    const full = new Set(buildShowPlan(analysis(), false).scenes.map((scene) => scene.family));
    expect(full.size).toBeGreaterThan(families.size);
  });

  test("sceneAt retourne la scène courante", () => {
    const plan = buildShowPlan(analysis(), false);
    for (const time of [0, 7, 24, 55, 90, 119.9]) {
      const scene = sceneAt(plan, time);
      expect(scene.start).toBeLessThanOrEqual(time);
      expect(scene.end).toBeGreaterThanOrEqual(time);
    }
    expect(sceneAt(plan, 0).index).toBe(0);
    expect(sceneAt(plan, 119.9).index).toBe(plan.scenes.length - 1);
  });

  test("le croisement de deux scenes ne creuse pas de trou", () => {
    // Pendant le fondu, la somme des poids (scène sortante + entrante) doit
    // rester à 1 : sans ça, l'écran s'assombrissait à chaque changement.
    const plan = buildShowPlan(analysis(), false);
    for (const scene of plan.scenes.slice(1)) {
      const previous = plan.scenes[scene.index - 1];
      if (previous === undefined) continue;
      for (let dt = 0; dt <= scene.fadeIn; dt += 0.05) {
        const entrante = sceneWeight(scene, scene.start + dt);
        const sortante = 1 - dt / scene.fadeIn;
        expect(entrante + sortante).toBeCloseTo(1, 6);
      }
    }
  });

  test("sceneWeight monte, tient jusqu'au bout, puis s'éteint après la frontière", () => {
    const first = buildShowPlan(analysis(), false).scenes[0];
    if (first === undefined) throw new Error("scène manquante");
    expect(sceneWeight(first, -1)).toBe(0);
    expect(sceneWeight(first, first.start + first.fadeIn / 2)).toBeCloseTo(0.5, 6);
    expect(sceneWeight(first, first.start + first.fadeIn * 2)).toBe(1);
    // Plein poids jusqu'à la fin : c'est ce qui évite le trou noir entre deux
    // scènes, le fond restant visible pendant tout le changement.
    expect(sceneWeight(first, first.end - 0.0001)).toBe(1);
    // L'extinction se joue après la frontière, en même temps que l'entrée de la
    // scène suivante : les deux se croisent.
    expect(sceneWeight(first, first.end + first.fadeOut / 2)).toBeCloseTo(0.5, 6);
    expect(sceneWeight(first, first.end + first.fadeOut * 2)).toBe(0);
  });



  test("une étiquette globale ne pilote ni le rôle ni l'humeur locale", () => {
    // Le serveur ne produit qu'une section de 0 à la fin, étiquetée d'après
    // l'énergie moyenne. Si ce label pilotait les scènes, tout le morceau
    // serait « montée » et pulsé du début à la fin.
    const global = analysis({
      sections: [{ start: 0, end: 120, label: "montee", energy: 0.5 }],
    });
    const plan = buildShowPlan(global, false);
    expect(plan.scenes.some((scene) => scene.role === "montee")).toBe(false);
    expect(plan.scenes.filter((scene) => scene.mood === "pulse").length).toBeLessThan(plan.scenes.length);
    // Même chose pour un label « silence » : les scènes gardent leur caractère.
    const silence = buildShowPlan(
      analysis({ sections: [{ start: 0, end: 120, label: "silence", energy: 0.5 }] }),
      false,
    );
    expect(silence.scenes.some((scene) => scene.mood === "explosif" || scene.mood === "pulse")).toBe(true);

    // Une section réellement locale, elle, garde son rôle.
    const local = analysis({
      sections: [
        { start: 0, end: 40, label: "calme", energy: 0.2, kind: "couplet", group: "A" },
        { start: 40, end: 80, label: "intense", energy: 0.9, kind: "refrain", group: "B" },
        { start: 80, end: 120, label: "calme", energy: 0.2, kind: "couplet", group: "A" },
      ],
    });
    expect(
      buildShowPlan(local, false, undefined, { dramaturgy: true }).scenes.some(
        (scene) => scene.role === "refrain",
      ),
    ).toBe(true);
  });

  test("un plan sans section reste utilisable", () => {
    const plan = buildShowPlan(analysis({ sections: [] }), false) as ShowPlan;
    expect(plan.scenes.length).toBeGreaterThan(1);
    const first = plan.scenes[0]!;
    expect(first.start).toBe(0);
    expect(sceneAt(plan, 5).end).toBeGreaterThan(0);
    expect(plan.scenes.at(-1)!.end).toBeCloseTo(120, 1);
  });
});

describe("bords et entrées dégénérées", () => {
  test("un morceau plus court que 5 s produit une seule scène", () => {
    const plan = buildShowPlan(analysis({ duration: 3, beats: [], sections: [], builds: [] }), false);
    expect(plan.scenes).toHaveLength(1);
    expect(plan.scenes[0]!.start).toBe(0);
    expect(plan.scenes[0]!.end).toBeCloseTo(3, 3);
  });

  test("tempo = 0 et aucune courbe restent utilisables", () => {
    const plan = buildShowPlan(
      analysis({
        tempo: 0,
        beatPeriod: 0,
        beats: [],
        onsets: [],
        energy: [],
        high: [],
        sections: [],
        builds: [],
      }),
      false,
    );
    expect(plan.scenes.length).toBeGreaterThan(0);
    for (const scene of plan.scenes) {
      expect(Number.isFinite(scene.palette.hue)).toBe(true);
      expect(scene.end).toBeGreaterThan(scene.start);
    }
  });

  test("sans aucun événement, la grille de secours garde des scènes", () => {
    const plan = buildShowPlan(
      analysis({ duration: 61, tempo: 0, beatPeriod: 0, beats: [], onsets: [], sections: [], builds: [] }),
      false,
    );
    expect(plan.scenes.length).toBeGreaterThanOrEqual(6);
    expect(plan.scenes.at(-1)!.end).toBeCloseTo(61, 1);
  });

  test("une couverture partielle (courbes à 0 hors fenêtre) ne casse rien", () => {
    // Analyse rapide : les courbes valent 0 hors de la fenêtre analysée, et
    // `coverage` dit au rendu où se trouve la partie fiable.
    const plan = buildShowPlan(
      analysis({
        duration: 60,
        coverage: [20, 40],
        energy: [
          [0, 0],
          [20, 0.4],
          [40, 0.9],
          [60, 0],
        ],
        high: [
          [0, 0],
          [20, 0.1],
          [40, 0.2],
          [60, 0],
        ],
        sections: [],
        builds: [],
      }),
      false,
    );
    expect(plan.coverage).toEqual([20, 40]);
    for (const scene of plan.scenes) {
      expect(scene.end).toBeGreaterThan(scene.start);
      expect(Number.isFinite(scene.palette.hue)).toBe(true);
    }
  });

  test("les quatre branches de l'arbre de famille sont atteignables", () => {
    const base = {
      duration: 64,
      beats: Array.from({ length: 128 }, (_, index) => index * 0.5),
      sections: [],
      builds: [],
    };
    // Courbes échantillonnées à 1 Hz : une courbe réduite à deux points laisse
    // des fenêtres vides, qui retombent volontairement sur 0,3 / 0,5.
    const plat = (value: number): Array<[number, number]> =>
      Array.from({ length: 65 }, (_, index) => [index, value] as [number, number]);
    const energeticFamilies = new Set([
      "beams", "spots", "spiral", "shutters", "bars", "grid", "mirror", "parade",
      "crossfire", "curtain", "burst", "gobos", "pendule", "couronne", "pluie",
      "portique", "etoile", "vortex", "lyre", "mandala", "treillis", "rideaux",
      "lyres-suspendues", "barres-led", "pont-concert",
    ]);
    const calm = buildShowPlan(
      analysis({ ...base, energy: plat(0.1), high: plat(0.05) }),
      false,
    );
    const bright = buildShowPlan(
      analysis({ ...base, energy: plat(0.5), high: plat(0.45), onsets: [] }),
      false,
    );
    const dense = buildShowPlan(
      analysis({
        ...base,
        // Contour d'énergie réel (et non deux points isolés) : la seconde
        // moitié dépasse le quantile calme du morceau.
        energy: Array.from({ length: 65 }, (_, index) => [index, 0.2 + (0.7 * index) / 64] as [number, number]),
        high: plat(0.05),
        // 700 attaques sur 64 s ≈ 10,9/s, franchement au-dessus du seuil de
        // densité : le cas teste bien la branche rythmique.
        onsets: Array.from({ length: 700 }, (_, index) => index * 0.09),
      }),
      false,
    );
    const energetic = buildShowPlan(
      analysis({ ...base, energy: plat(0.85), high: plat(0.05), onsets: [] }),
      false,
    );
    for (const scene of calm.scenes) {
      expect(["waves", "tunnel", "particles", "rings", "spiral", "pluie"]).toContain(scene.family);
    }
    expect(
      bright.scenes.some((scene) =>
        ["particles", "spots", "spiral", "rings", "beams", "mirror", "parade"].includes(scene.family),
      ),
    ).toBe(true);
    expect(dense.scenes.some((scene) => energeticFamilies.has(scene.family))).toBe(true);
    expect(energetic.scenes.some((scene) => energeticFamilies.has(scene.family))).toBe(true);
  });
});

describe("couleurs", () => {
  test("hsl vers rgb", () => {
    expect(hslToRgb({ h: 0, s: 1, l: 0.5 })).toEqual({ r: 255, g: 0, b: 0 });
    expect(hslToRgb({ h: 120, s: 1, l: 0.5 })).toEqual({ r: 0, g: 255, b: 0 });
    expect(hslToRgb({ h: 240, s: 1, l: 0.5 })).toEqual({ r: 0, g: 0, b: 255 });
  });

  test("shiftHue enroule", () => {
    expect(shiftHue(350, 20)).toBe(10);
    expect(shiftHue(10, -20)).toBe(350);
  });

  test("shorthand produit du rgb ou du rgba", () => {
    expect(shorthand({ r: 1, g: 2, b: 3 })).toBe("rgb(1,2,3)");
    expect(shorthand({ r: 1, g: 2, b: 3 }, 0.5)).toBe("rgba(1,2,3,0.500)");
  });
});

describe("flashs", () => {
  function frame(overrides: Partial<FrameState> = {}): FrameState {
    return {
      t: 10,
      width: 100,
      height: 100,
      dpr: 1,
      scene: {
        index: 0,
        start: 0,
        end: 20,
        family: "beams",
        variant: "tunnel",
        backdrop: "waves",
        palette: { name: "test", hue: 200, accent: 20, spread: 40, saturation: 0.8, lightness: 0.6 },
        intensity: 0.8,
        fadeIn: 1,
        fadeOut: 1,
        mood: "pulse",
        role: "couplet",
        reason: "ouverture",
      },
      palette: { name: "test", hue: 200, accent: 20, spread: 40, saturation: 0.8, lightness: 0.6 },
      energy: 0.8,
      bass: 0.8,
      mid: 0.5,
      high: 0.5,
      beat: 0.9,
      beatPhase: 0,
      beatIndex: 3,
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
      seed: 1,
      frame: 0,
      ...overrides,
    };
  }

  test("un temps fort éclaire modérément", () => {
    const value = flashAlpha(frame(), DEFAULT_SETTINGS);
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThanOrEqual(0.4);
  });

  test("le mode réduit annule tout flash", () => {
    expect(flashAlpha(frame({ reduced: true }), DEFAULT_SETTINGS)).toBe(0);
  });

  test("flashs à 0 = aucun flash", () => {
    expect(flashAlpha(frame(), { ...DEFAULT_SETTINGS, flashes: 0 })).toBe(0);
  });

  test("un silence ne produit pas de flash", () => {
    expect(flashAlpha(frame({ energy: 0.02, beat: 0.1, bass: 0.05 }), DEFAULT_SETTINGS)).toBe(0);
  });

  test("un battement faible ne flash pas", () => {
    expect(flashAlpha(frame({ beat: 0.05 }), DEFAULT_SETTINGS)).toBe(0);
  });

  test("le plafond n'est jamais dépassé, même à fond", () => {
    const value = flashAlpha(frame(), { ...DEFAULT_SETTINGS, flashes: 1.5 });
    expect(value).toBeLessThanOrEqual(0.4 * 1.5);
  });
});

describe("palette du morceau", () => {
  const morceau = (overrides: Partial<Analysis> = {}) =>
    analysis({
      duration: 240,
      sections: [
        { start: 0, end: 60, label: "calme", energy: 0.2 },
        { start: 60, end: 120, label: "montee", energy: 0.5 },
        { start: 120, end: 200, label: "intense", energy: 0.9 },
        { start: 200, end: 240, label: "descente", energy: 0.3 },
      ],
      builds: [{ start: 176, end: 180, strength: 0.95 }],
      ...overrides,
    });

  test("un morceau garde la meme identite du debut a la fin", () => {
    const plan = buildShowPlan(morceau(), false);
    // Toutes les scènes portent le nom de la palette du morceau : c'est ce qui
    // donne une identité à la soirée au lieu d'un arc-en-ciel qui défile.
    for (const scene of plan.scenes) expect(scene.palette.name).toBe(plan.track.name);
  });

  test("chaque scene reste dans la teinte du morceau ou sa complementaire", () => {
    const plan = buildShowPlan(morceau(), false);
    const ecart = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
    for (const scene of plan.scenes) {
      const presDeLaBase = ecart(scene.palette.hue, plan.track.hue) <= plan.track.spread;
      const presDuComplement = ecart(scene.palette.hue, plan.track.accent) <= plan.track.spread;
      expect(presDeLaBase || presDuComplement).toBe(true);
    }
  });

  test("les moments forts basculent sur la complementaire", () => {
    const plan = buildShowPlan(morceau(), false);
    const forts = plan.scenes.filter((scene) => scene.mood === "explosif");
    expect(forts.length).toBeGreaterThan(0);
    const ecart = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
    for (const scene of forts) {
      expect(ecart(scene.palette.hue, plan.track.accent)).toBeLessThanOrEqual(plan.track.spread);
    }
  });

  test("les moments forts sont vifs et clairs, les calmes sombres", () => {
    const plan = buildShowPlan(morceau(), false);
    const explosif = plan.scenes.find((scene) => scene.mood === "explosif");
    const sombre = plan.scenes.find((scene) => scene.mood === "sombre" || scene.mood === "calme");
    expect(explosif).toBeDefined();
    expect(sombre).toBeDefined();
    // Vif : saturation franche et luminosité haute (on s'approche du blanc),
    // contre une teinte retenue et sombre pour les passages calmes.
    expect(explosif!.palette.saturation).toBeGreaterThan(0.9);
    expect(explosif!.palette.lightness).toBeGreaterThan(0.7);
    expect(explosif!.palette.saturation).toBeGreaterThan(sombre!.palette.saturation);
    expect(explosif!.palette.lightness).toBeGreaterThan(sombre!.palette.lightness + 0.2);
  });

  test("deux morceaux differents peuvent avoir des identites differentes", () => {
    // Le choix vient du morceau lui-même (durée, tempo, nombre de temps) : deux
    // morceaux distincts n'ont pas forcément la même salle.
    const identites = new Set(
      [0, 1, 2, 3, 4, 5, 6, 7].map(
        (index) => buildShowPlan(morceau({ duration: 200 + index * 7, tempo: 100 + index * 9 }), false).track.name,
      ),
    );
    expect(identites.size).toBeGreaterThan(1);
  });
});

describe("continuite entre les scenes", () => {
  /** Morceau long à quatre caractères : les scènes y sont nombreuses. */
  const morceau = () =>
    analysis({
      duration: 240,
      sections: [
        { start: 0, end: 60, label: "calme", energy: 0.2 },
        { start: 60, end: 120, label: "montee", energy: 0.5 },
        { start: 120, end: 200, label: "intense", energy: 0.9 },
        { start: 200, end: 240, label: "descente", energy: 0.3 },
      ],
      builds: [{ start: 176, end: 180, strength: 0.95 }],
    });

  test("toutes les scenes partagent la meme couche de fond", () => {
    // C'est l'élément commun qui rend les changements de scène presque
    // imperceptibles : il est à l'écran du début à la fin du morceau.
    const plan = buildShowPlan(morceau(), false);
    expect(plan.backdrop.length).toBeGreaterThan(0);
    for (const scene of plan.scenes) expect(scene.backdrop).toBe(plan.backdrop);
  });

  test("aucune scene ne prend la place de la couche commune", () => {
    // Sans cette garde, la scène dont la famille est la couche de fond la
    // remplacerait et il ne resterait aucun élément partagé — donc un trou de
    // continuité au milieu du morceau.
    const plan = buildShowPlan(morceau(), false);
    for (const scene of plan.scenes) expect(scene.family).not.toBe(plan.backdrop);
  });

  test("la couche commune est la meme d'un morceau a l'autre quand il est identique", () => {
    // Déterminisme : même analyse, même spectacle.
    const a = buildShowPlan(morceau(), false);
    const b = buildShowPlan(morceau(), false);
    expect(a.backdrop).toBe(b.backdrop);
    expect(a.track.name).toBe(b.track.name);
  });
});

describe("diversite du spectacle", () => {
  test("les phrases renouvellent regulierement l'ambiance", () => {
    const long = analysis({ duration: 90, sections: [{ start: 0, end: 90, label: "intense", energy: 0.8 }] });
    const plan = buildShowPlan(long, false);
    expect(plan.scenes.length).toBeGreaterThanOrEqual(6);

    const families = new Set(plan.scenes.map((scene) => scene.family));
    expect(families.size).toBeGreaterThanOrEqual(5);

    const hueBuckets = new Set(plan.scenes.map((scene) => Math.floor(scene.palette.hue / 30)));
    expect(hueBuckets.size).toBeGreaterThanOrEqual(4);
  });

  test("un long morceau exploite toutes les familles visuelles", () => {
    const long = analysis({
      duration: 600,
      // Grille régulière à 120 BPM : les scènes durent 8 s, donc elles portent
      // une variation (le seuil est de 8 s).
      tempo: 120,
      beatPeriod: 0.5,
      beats: Array.from({ length: 1200 }, (_, index) => index * 0.5),
      sections: [
        { start: 0, end: 200, label: "calme", energy: 0.25 },
        { start: 200, end: 400, label: "intense", energy: 0.8 },
        { start: 400, end: 600, label: "montee", energy: 0.6 },
      ],
    });
    const plan = buildShowPlan(long, false);
    expect(plan.scenes.length).toBeGreaterThan(15);
    // Compte toutes les familles réellement dessinées : la famille principale,
    // la variation, et la couche de fond commune — qui n'apparaît jamais comme
    // famille principale, justement parce qu'elle est partagée par tout le
    // morceau. L'arbre de décision restreint chaque scène à un réservoir :
    // l'atteignabilité se mesure donc sur plusieurs tirages, pas sur un seul.
    const dessinees = new Set<FamilyId>();
    for (let seed = 1; seed <= 20; seed += 1) {
      for (const scene of buildShowPlan(long, false, seed).scenes) {
        dessinees.add(scene.family);
        dessinees.add(scene.variant);
        dessinees.add(scene.backdrop);
      }
    }
    // Le compte vient des libellés : ajouter une famille sans la rendre
    // atteignable par le plan fait échouer ce test, et c'est voulu.
    expect(dessinees.size).toBe(Object.keys(FAMILY_LABELS).length);
  });

  test("la cadence depend du nombre d'evenements du morceau", () => {
    const riche = analysis({
      duration: 180,
      beats: Array.from({ length: 400 }, (_, i) => i * 0.45),
      sections: [
        { start: 0, end: 60, label: "calme", energy: 0.2 },
        { start: 60, end: 120, label: "intense", energy: 0.8 },
        { start: 120, end: 180, label: "descente", energy: 0.4 },
      ],
      builds: [
        { start: 40, end: 55, strength: 0.9 },
        { start: 100, end: 115, strength: 0.8 },
      ],
    });
    const nu = analysis({ duration: 180, beats: [], onsets: [], sections: [], builds: [] });
    expect(sceneCadence(buildShowPlan(riche, false))).toBeLessThan(sceneCadence(buildShowPlan(nu, false)));
  });

  test("le contrat de couleur tient sur 6 morceaux × 400 graines", () => {
    const ecart = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
    const morceaux = [58, 74, 96, 118, 142, 170].map((tempo, index) =>
      analysis({
        duration: 64 + index * 8,
        tempo,
        meter: index % 2 === 0 ? 4 : 3,
        beatPeriod: 60 / tempo,
        beats: Array.from({ length: Math.floor((64 + index * 8) / (60 / tempo)) }, (_, beat) =>
          Number((beat * (60 / tempo)).toFixed(3)),
        ),
        sections: [],
        builds: index % 3 === 0 ? [{ start: 30, end: 34, strength: 0.8 }] : [],
      }),
    );
    let paires = 0;
    for (const morceau of morceaux) {
      for (let seed = 1; seed <= 400; seed += 1) {
        const plan = buildShowPlan(morceau, false, seed);
        let precedent: number | undefined;
        for (const scene of plan.scenes) {
          const presDeLaBase = ecart(scene.palette.hue, plan.track.hue);
          const presDuComplement = ecart(scene.palette.hue, plan.track.accent);
          // Toutes les teintes restent dans le budget de l'un des deux pôles.
          expect(Math.min(presDeLaBase, presDuComplement)).toBeLessThanOrEqual(plan.track.spread + 1e-6);
          if (precedent !== undefined) {
            paires += 1;
            expect(ecart(scene.palette.hue, precedent)).toBeGreaterThanOrEqual(
              minHueStepEff(plan.track.spread) - 1e-6,
            );
          }
          precedent = scene.palette.hue;
        }
      }
    }
    // 6 pistes × 400 graines, plusieurs scènes chacune.
    expect(paires).toBeGreaterThan(13_200);
  });

  test("à 170 BPM en 3/4, les scènes restent dans la fenêtre 5–9 s", () => {
    const beatPeriod = 60 / 170;
    const data = analysis({
      duration: 60,
      tempo: 170,
      meter: 3,
      beatPeriod,
      beats: Array.from({ length: Math.floor(60 / beatPeriod) }, (_, index) =>
        Number((index * beatPeriod).toFixed(3)),
      ),
      onsets: [],
      sections: [],
      builds: [],
    });
    const plan = buildShowPlan(data, false);
    const spans = plan.scenes.map((scene) => scene.end - scene.start);
    // Le cycle de 12 temps vaut 4,24 s, sous le plancher de 5 s : la fusion
    // garde une frontière de cycle sur deux, soit ~8,48 s, jamais 12,7 s.
    expect(Math.min(...spans)).toBeGreaterThanOrEqual(5);
    expect(sceneCadence(plan)).toBeGreaterThanOrEqual(5);
    expect(sceneCadence(plan)).toBeLessThanOrEqual(9);
    expect(Math.max(...spans)).toBeLessThanOrEqual(12);
    // Chaque frontière conservée est un vrai cycle : aucun changement inventé.
    const boundaries = new Set(plan.barStarts.map((time) => Number(time.toFixed(2))));
    for (const scene of plan.scenes.slice(1)) {
      expect(
        boundaries.has(Number(scene.start.toFixed(2))) ||
          Math.abs(scene.start - data.duration) < 0.01,
      ).toBe(true);
    }
  });

  test("aucune variation sur une scène de moins de 8 s", () => {
    const plan = buildShowPlan(
      analysis({
        duration: 120,
        beats: Array.from({ length: 300 }, (_, index) => index * 0.4),
        builds: [{ start: 30, end: 40, strength: 0.9 }],
      }),
      false,
    );
    let courtes = 0;
    for (const scene of plan.scenes) {
      if (scene.end - scene.start < 8) {
        courtes += 1;
        expect(scene.variant).toBe(scene.family);
      }
    }
    expect(courtes).toBeGreaterThan(0);
  });

  test("le tirage de famille ne répète jamais et dépend de la graine", () => {
    // Caractère volontairement moyen : toutes les scènes tombent dans le
    // réservoir général, donc la suite de familles ne dépend que du tirage.
    const data = analysis({
      duration: 64,
      beats: Array.from({ length: 128 }, (_, index) => index * 0.5),
      onsets: Array.from({ length: 64 }, (_, index) => index * 1),
      energy: [
        [0, 0.5],
        [64, 0.5],
      ],
      high: [
        [0, 0.1],
        [64, 0.1],
      ],
      sections: [],
      builds: [],
    });
    const sequences = new Set<string>();
    const familles = new Set<FamilyId>();
    for (let seed = 1; seed <= 10_000; seed += 1) {
      const plan = buildShowPlan(data, false, seed);
      const suite = plan.scenes.map((scene) => scene.family);
      for (let index = 1; index < suite.length; index += 1) {
        expect(suite[index]).not.toBe(suite[index - 1]);
      }
      for (let start = 0; start + 6 <= suite.length; start += 1) {
        sequences.add(suite.slice(start, start + 6).join(">"));
      }
      for (const family of suite) familles.add(family);
    }
    expect(sequences.size).toBeGreaterThanOrEqual(20);
    // Toutes les familles du réservoir général apparaissent : la couche de fond
    // change avec la graine, donc aucune famille n'est structurellement exclue
    // sur l'ensemble des tirages.
    expect(familles.size).toBe(Object.keys(FAMILY_LABELS).length);
  });

  test("les drops d'un morceau ne partagent jamais leur signature", () => {
    const data = analysis({
      duration: 100,
      beats: Array.from({ length: 200 }, (_, index) => index * 0.5),
      sections: [],
      builds: [
        { start: 18, end: 20, strength: 0.9 },
        { start: 48, end: 50, strength: 0.45 },
        { start: 78, end: 80, strength: 0.75 },
      ],
    });
    for (let seed = 1; seed <= 5; seed += 1) {
      const plan = buildShowPlan(data, false, seed * 97);
      const drops = plan.scenes.filter((scene) => scene.role === "drop");
      expect(drops.length).toBeGreaterThanOrEqual(3);
      // La signature est complète sur chaque drop.
      for (const drop of drops) expect(drop.drop).toBeDefined();
      const signatures = drops.map(
        (drop) =>
          `${drop.drop!.lyres}/${drop.drop!.barres}/${drop.drop!.blinders}/${drop.drop!.hue}`,
      );
      expect(new Set(signatures).size).toBe(signatures.length);
      // Deux drops consécutifs diffèrent sur au moins deux composantes : on ne
      // rejoue pas le même geste en changeant un seul paramètre.
      for (let index = 1; index < drops.length; index += 1) {
        const previous = drops[index - 1]!.drop!;
        const current = drops[index]!.drop!;
        const distance =
          (previous.lyres !== current.lyres ? 1 : 0) +
          (previous.barres !== current.barres ? 1 : 0) +
          (previous.blinders !== current.blinders ? 1 : 0) +
          (previous.hue !== current.hue ? 1 : 0);
        expect(distance).toBeGreaterThanOrEqual(2);
      }
      // Le pont concert est réservé au climax du morceau (dernier drop à la
      // force maximale) ; les autres impacts alternent lyres et barres LED.
      expect(drops.filter((scene) => scene.family === "pont-concert").length).toBe(1);
      expect(
        drops.some((scene) => scene.family === "lyres-suspendues" || scene.family === "barres-led"),
      ).toBe(true);
    }
    // Le mode réduit ne force ni pont ni signature.
    const reduced = buildShowPlan(data, true);
    for (const scene of reduced.scenes) expect(scene.drop).toBeUndefined();
  });

  test("chaque phrase porte une humeur et une intensite coherente", () => {
    const plan = buildShowPlan(analysis({ duration: 120 }), false);
    for (const scene of plan.scenes) {
      expect(["calme", "pulse", "explosif", "aerien", "sombre"]).toContain(scene.mood);
      expect(scene.intensity).toBeGreaterThan(0);
      expect(scene.intensity).toBeLessThanOrEqual(1);
      expect(scene.end).toBeGreaterThan(scene.start);
    }
  });
});

describe("changements justifies par la musique", () => {
  test("chaque scene commence sur un evenement et se termine sur le suivant", () => {
    const data = analysis({
      duration: 120,
      sections: [
        { start: 0, end: 30, label: "calme", energy: 0.2 },
        { start: 30, end: 70, label: "intense", energy: 0.85 },
        { start: 70, end: 120, label: "descente", energy: 0.4 },
      ],
      builds: [{ start: 40, end: 52, strength: 0.9 }],
      beats: Array.from({ length: 300 }, (_, i) => i * 0.4),
    });
    const plan = buildShowPlan(data, false);
    // Une scène ne peut démarrer que sur : ouverture, finale, frontière de
    // section, impact de montée, ou un cycle de 16 temps forts.
    const justifications = new Set<number>([
      0,
      data.duration,
      ...data.sections.map((section) => section.start),
      ...data.builds.map((build) => build.end),
      ...plan.barStarts,
    ]);
    for (const scene of plan.scenes) {
      const justifiee = [...justifications].some((time) => Math.abs(time - scene.start) < 0.6);
      expect(justifiee).toBe(true);
    }
  });

  test("la grille suit la métrique détectée (pas de biais 4/4)", () => {
    const beats = Array.from({ length: 48 }, (_, index) => index * 0.5);
    const binaire = analysis({ meter: 4, beats });
    const ternaire = analysis({ meter: 3, beats });
    const sansMetrique = analysis({ beats });
    expect(barStarts(binaire)).toEqual(beats.filter((_, index) => index % 16 === 0));
    expect(barStarts(ternaire)).toEqual(beats.filter((_, index) => index % 12 === 0));
    // Un serveur antérieur (pas de `meter`) garde le cycle 4/4 historique.
    expect(barStarts(sansMetrique)).toEqual(barStarts(binaire));
  });

  test("les frontières de section forcent un changement complet", () => {
    const data = analysis({
      duration: 90,
      sections: [
        { start: 0, end: 30, label: "calme", energy: 0.15 },
        { start: 30, end: 90, label: "intense", energy: 0.9 },
      ],
    });
    const plan = buildShowPlan(data, false);
    const first = plan.scenes[0]!;
    const after = plan.scenes.find((scene) => scene.start >= 29.5);
    expect(after).toBeDefined();
    const changed = after!.family !== first.family || after!.mood !== first.mood;
    expect(changed).toBe(true);
    expect(after!.reason).toBe("section");
  });

  test("la fin d'une montee est un changement d'ambiance a part entiere", () => {
    const data = analysis({
      duration: 100,
      builds: [{ start: 10, end: 20, strength: 1 }],
      sections: [{ start: 0, end: 100, label: "intense", energy: 0.8 }],
      beats: Array.from({ length: 250 }, (_, i) => i * 0.4),
    });
    const plan = buildShowPlan(data, false);
    const drop = plan.scenes.find((scene) => Math.abs(scene.start - 20) < 0.6);
    expect(drop).toBeDefined();
    expect(drop!.reason).toBe("build");
    expect(drop!.mood).toBe("explosif");
  });

  test("la famille decoule du caractere musical, pas du hasard", () => {
    const calme = analysis({
      duration: 120,
      beats: Array.from({ length: 60 }, (_, i) => i * 2),
      onsets: [],
      sections: [{ start: 0, end: 120, label: "calme", energy: 0.12 }],
    });
    const dense = analysis({
      duration: 120,
      beats: Array.from({ length: 300 }, (_, i) => i * 0.4),
      // Contour d'énergie réel : la fin dépasse le quantile calme du morceau.
      energy: Array.from({ length: 121 }, (_, index) => [index, 0.2 + (0.7 * index) / 120] as [number, number]),
      high: Array.from({ length: 121 }, (_, index) => [index, 0.05] as [number, number]),
      // 800 attaques sur 120 s ≈ 6,7/s, au-dessus du seuil de densité.
      onsets: Array.from({ length: 800 }, (_, i) => i * 0.15),
      sections: [{ start: 0, end: 120, label: "intense", energy: 0.9 }],
    });
    const famillesCalmes = new Set(buildShowPlan(calme, false).scenes.map((scene) => scene.family));
    const famillesDenses = new Set(buildShowPlan(dense, false).scenes.map((scene) => scene.family));
    // Un passage lent sans attaques ne doit pas afficher de barres ni de grille.
    for (const family of famillesCalmes) {
      expect(["waves", "tunnel", "particles", "rings", "spiral", "pluie", "beams", "shutters", "spots", "parade", "mirror"]).toContain(family);
    }
    // Le passage dense doit atteindre le réservoir rythmique : c'est la branche
    // qui compte, pas une figure particulière du réservoir.
    expect([...famillesDenses].some((family) => RHYTHMIC_FAMILIES.includes(family))).toBe(true);
  });

  test("caractereAt mesure l'energie, la densite et la brillance", () => {
    const data = analysis({
      duration: 60,
      bass: [
        [0, 0.1],
        [60, 0.1],
      ],
      mid: [
        [0, 0.1],
        [60, 0.1],
      ],
      high: [
        [0, 0.9],
        [60, 0.9],
      ],
      energy: [
        [0, 0.8],
        [60, 0.8],
      ],
      onsets: Array.from({ length: 30 }, (_, i) => i * 2),
      beats: [],
    });
    const caractere = caractereAt(data, 0, 60);
    expect(caractere.energy).toBeGreaterThan(0.5);
    expect(caractere.density).toBeCloseTo(0.5, 1);
    expect(caractere.brightness).toBeGreaterThan(0.5);
  });

  test("les scenes se suivent sans trou ni recouvrement", () => {
    const plan = buildShowPlan(analysis({ duration: 150 }), false);
    expect(plan.scenes[0]!.start).toBe(0);
    expect(plan.scenes.at(-1)!.end).toBeCloseTo(150, 1);
    for (let index = 1; index < plan.scenes.length; index += 1) {
      expect(plan.scenes[index]!.start).toBeGreaterThanOrEqual(plan.scenes[index - 1]!.end - 0.001);
    }
  });

  test("un morceau de structure riche renouvelle souvent l'ambiance", () => {
    const plan = buildShowPlan(
      analysis({
        duration: 180,
        beats: Array.from({ length: 420 }, (_, i) => i * 0.43),
        sections: [
          { start: 0, end: 45, label: "calme", energy: 0.2 },
          { start: 45, end: 120, label: "intense", energy: 0.85 },
          { start: 120, end: 180, label: "descente", energy: 0.35 },
        ],
        builds: [
          { start: 20, end: 30, strength: 0.8 },
          { start: 90, end: 100, strength: 0.9 },
        ],
      }),
      false,
    );
    expect(plan.scenes.length).toBeGreaterThanOrEqual(8);
    expect(new Set(plan.scenes.map((scene) => scene.reason)).size).toBeGreaterThanOrEqual(3);
  });
});

describe("répétition des passages (couplet / refrain)", () => {
  /** A-B-A-B : deux couplets (A) et deux refrains (B) bien identifiés. */
  const morceau = (refrainEnergy = 0.9) =>
    analysis({
      duration: 120,
      sections: [
        { start: 0, end: 20, label: "calme", energy: 0.2, group: "A", kind: "couplet", occurrence: 1 },
        { start: 20, end: 40, label: "intense", energy: refrainEnergy, group: "B", kind: "refrain", occurrence: 1 },
        { start: 40, end: 60, label: "calme", energy: 0.25, group: "A", kind: "couplet", occurrence: 2 },
        { start: 60, end: 80, label: "intense", energy: refrainEnergy, group: "B", kind: "refrain", occurrence: 2 },
      ],
    });

  const scenesIn = (plan: ShowPlan, start: number, end: number) =>
    plan.scenes.filter((scene) => scene.start >= start && scene.start < end);

  test("deux passages du même groupe partagent famille et teinte", () => {
    const plan = buildShowPlan(morceau(), false);
    const couplets = [...scenesIn(plan, 0, 20), ...scenesIn(plan, 40, 60)];
    const refrains = [...scenesIn(plan, 20, 40), ...scenesIn(plan, 60, 80)];
    expect(couplets.length).toBeGreaterThan(1);
    expect(refrains.length).toBeGreaterThan(1);
    // Un couplet doit se reconnaître d'une occurrence à l'autre…
    expect(new Set(couplets.map((scene) => scene.family)).size).toBe(1);
    expect(new Set(couplets.map((scene) => scene.palette.hue)).size).toBe(1);
    // … et un refrain aussi.
    expect(new Set(refrains.map((scene) => scene.family)).size).toBe(1);
    expect(new Set(refrains.map((scene) => scene.palette.hue)).size).toBe(1);
    // Deux groupes différents ne se ressemblent pas pour autant.
    expect(refrains[0]!.palette.hue).not.toBe(couplets[0]!.palette.hue);
  });

  test("la dramaturgie des sections ne s'active que sur demande explicite", () => {
    const sections = [
      { start: 0, end: 30, label: "calme" as const, energy: 0.2, kind: "couplet" as const },
      { start: 30, end: 60, label: "intense" as const, energy: 0.9, kind: "refrain" as const },
      { start: 60, end: 90, label: "montee" as const, energy: 0.6, kind: "pont" as const },
    ];
    const data = analysis({ duration: 90, sections });
    const parDefaut = buildShowPlan(data, false);
    const dramatise = buildShowPlan(data, false, undefined, { dramaturgy: true });
    // Par défaut, seule la structure locale est ignorée : aucun rôle refrain ni
    // montée, même avec des sections explicites.
    expect(parDefaut.scenes.some((scene) => scene.role === "refrain")).toBe(false);
    expect(parDefaut.scenes.some((scene) => scene.role === "montee")).toBe(false);
    // L'option réveille la dramaturgie dormante pour le jour où le serveur
    // produira un vrai découpage.
    expect(dramatise.scenes.some((scene) => scene.role === "refrain")).toBe(true);
    expect(dramatise.scenes.some((scene) => scene.role === "montee")).toBe(true);
  });

  test("le refrain s'allume : humeur explosive et complémentaire", () => {
    const plan = buildShowPlan(morceau(), false, undefined, { dramaturgy: true });
    const refrains = [...scenesIn(plan, 20, 40), ...scenesIn(plan, 60, 80)];
    const ecart = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
    for (const scene of refrains) {
      expect(scene.mood).toBe("explosif");
      expect(ecart(scene.palette.hue, plan.track.accent)).toBeLessThanOrEqual(plan.track.spread);
    }
  });

  test("un refrain peu énergique est tout de même poussé (hors mode réduit)", () => {
    const timide = morceau(0.4);
    const normal = scenesIn(buildShowPlan(timide, false, undefined, { dramaturgy: true }), 20, 40);
    expect(normal.length).toBeGreaterThan(0);
    for (const scene of normal) expect(scene.mood).toBe("explosif");
    // En mode réduit, on ne force pas : l'énergie mesurée reprend la main.
    const reduit = scenesIn(buildShowPlan(timide, true), 20, 40);
    for (const scene of reduit) expect(scene.mood).not.toBe("explosif");
  });
});
