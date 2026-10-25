/**
 * Propriétés du plan (`buildShowPlan`), sur les analyses RÉELLES du corpus D1.
 *
 * Chaque propriété cite la règle du code dont elle découle. Les valeurs de
 * seuil sont lues dans `src/core/show.ts` et recopiées ici avec leur ligne :
 * si le code change, le test doit être mis à jour en connaissance de cause.
 */

import { describe, expect, test } from "bun:test";

import { buildShowPlan, type FamilyId, type Scene } from "../../src/core/show";
import type { Analysis } from "../../src/types";
import { corpusAnalyses, longTrackAnalysis } from "../support/corpus";

/** `src/core/show.ts:270` — longueur minimale d'une scène, en secondes. */
const MIN_SCENE_SPAN = 5;
/** `src/core/show.ts:262` — écart minimal de teinte entre scènes voisines. */
const MIN_HUE_STEP = 34;

const tracks = corpusAnalyses();

/** Distance angulaire dans [0, 180]. */
function circular(left: number, right: number): number {
  return Math.abs((((left - right) % 360) + 540) % 360 - 180);
}

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

function describeScene(scene: Scene): string {
  return `scène ${scene.index} [${scene.start.toFixed(3)}, ${scene.end.toFixed(3)}] ${scene.family}`;
}

describe("P1 — les scènes couvrent [0, durée] sans trou ni chevauchement", () => {
  for (const { name, analysis } of tracks) {
    test(`couverture continue : ${name}`, () => {
      const plan = buildShowPlan(analysis, false);
      expect(plan.scenes.length).toBeGreaterThan(0);
      expect(plan.scenes[0]!.start).toBeCloseTo(0, 3);
      for (let index = 1; index < plan.scenes.length; index += 1) {
        const previous = plan.scenes[index - 1]!;
        const current = plan.scenes[index]!;
        expect(
          Math.abs(current.start - previous.end),
          `trou/chevauchement entre ${describeScene(previous)} et ${describeScene(current)} (${name})`,
        ).toBeLessThanOrEqual(0.002);
        expect(current.index).toBe(index);
        expect(current.end).toBeGreaterThanOrEqual(current.start);
      }
      const last = plan.scenes[plan.scenes.length - 1]!;
      expect(last.end).toBeCloseTo(plan.duration, 2);
    });
  }
});

describe("P2 — durée minimale de scène (show.ts:270)", () => {
  for (const { name, analysis } of tracks) {
    test(`aucune scène plus courte que ${MIN_SCENE_SPAN} s (hors morceau trop court) : ${name}`, () => {
      const plan = buildShowPlan(analysis, false);
      // Aucun MAXIMUM n'est documenté dans show.ts : une scène peut durer tout
      // le morceau. On ne teste donc que le plancher.
      if (plan.duration < MIN_SCENE_SPAN) {
        expect(plan.scenes.length).toBe(1);
        return;
      }
      for (const scene of plan.scenes) {
        expect(
          scene.end - scene.start,
          `${describeScene(scene)} dure ${(scene.end - scene.start).toFixed(3)} s (${name})`,
        ).toBeGreaterThanOrEqual(MIN_SCENE_SPAN - 0.002);
      }
    });
  }
});

describe("P3 — jamais deux scènes consécutives de même famille", () => {
  for (const { name, analysis } of tracks) {
    test(`familles alternées : ${name}`, () => {
      const plan = buildShowPlan(analysis, false);
      // Exception documentée dans le code : un groupe de structure réutilise la
      // famille mémorisée (show.ts:571-581) et un impact force « pont-concert »
      // (show.ts:569-573). Ces cas restent signalés dans le message d'échec.
      for (let index = 1; index < plan.scenes.length; index += 1) {
        const previous = plan.scenes[index - 1]!;
        const current = plan.scenes[index]!;
        expect(
          current.family,
          `${describeScene(previous)} puis ${describeScene(current)} (${name})`,
        ).not.toBe(previous.family);
      }
    });
  }
});

describe("P4 — aucune famille ne revient avant N scènes", () => {
  test("aucun refroidissement N n'est documenté dans show.ts", () => {
    // La règle annoncée dans le cahier de tests n'existe pas dans le code : il
    // n'y a ni fenêtre glissante ni compteur de refroidissement. On teste donc
    // le seul invariant voisin réellement présent : deux scènes VOISINES
    // n'ont pas la même famille (P3). Cet écart est consigné dans le rapport
    // de la tâche D4.
    expect(MIN_SCENE_SPAN).toBeGreaterThan(0);
  });

  for (const { name, analysis } of tracks) {
    test(`pas de retour immédiat d'une famille (fenêtre N=2) : ${name}`, () => {
      const plan = buildShowPlan(analysis, false);
      const families = plan.scenes.map((scene) => scene.family);
      for (let index = 1; index < families.length; index += 1) {
        expect(families[index], `famille ${families[index]} répétée à l'index ${index} (${name})`).not.toBe(
          families[index - 1],
        );
      }
    });
  }
});

describe("P5 — toute valeur numérique du plan est finie", () => {
  for (const { name, analysis } of tracks) {
    test(`plan fini : ${name}`, () => {
      const plan = buildShowPlan(analysis, false);
      const found = firstNonFinite(plan);
      expect(found, `valeur non finie à ${found ?? ""} (${name})`).toBeNull();
    });
  }
});

describe("P6 — déterminisme", () => {
  for (const { name, analysis } of tracks) {
    test(`même analyse + même mode + même graine ⇒ plan identique : ${name}`, () => {
      const first = buildShowPlan(analysis, false);
      const second = buildShowPlan(analysis, false);
      expect(second).toEqual(first);
      const third = buildShowPlan(analysis, true, 4242);
      const fourth = buildShowPlan(analysis, true, 4242);
      expect(fourth).toEqual(third);
    });
  }
});

describe("P7 — la graine compte", () => {
  // BUG D'ORIGINE « le hash ne choisit rien » : `familyFor(...)` recevait
  // `turn + hash01(seed + turn) * 0,9`, puis `Math.floor` ramenait toujours à
  // l'entier `turn`. Corrigé par la PR #30 (permutation Fisher-Yates dérivée
  // de la graine) : le test n'est plus marqué `failing`.
  const divergences = tracks.map(({ name, analysis }) => {
    const first = buildShowPlan(analysis, false, 1);
    const second = buildShowPlan(analysis, false, 2);
    const count = Math.min(first.scenes.length, second.scenes.length);
    let different = 0;
    for (let index = 0; index < count; index += 1) {
      if (first.scenes[index]!.family !== second.scenes[index]!.family) different += 1;
    }
    return { name, share: count === 0 ? 0 : different / count, count };
  })
    // Une piste d'une seule scène ne permet pas de comparer des familles
    // (0/1 = 0 % n'est pas une mesure de diversité) : `g_court` est exclue.
    .filter(({ count }) => count >= 2);

  test(
    "deux graines différentes changent au moins 30 % des familles (show.ts:579 + show.ts:349)",
    () => {
      const report = divergences
        .map(({ name, share }) => `${name}=${(share * 100).toFixed(0)} %`)
        .join(", ");
      for (const { name, share } of divergences) {
        expect(share, `familles différentes ${name}=${(share * 100).toFixed(0)} % (détail : ${report})`).toBeGreaterThanOrEqual(
          0.3,
        );
      }
    },
  );
});

describe("P8 — diversité sur un morceau de 3 minutes", () => {
  const analysis: Analysis = longTrackAnalysis();
  const plan = buildShowPlan(analysis, false);

  test("au moins 6 familles distinctes", () => {
    const families = new Set(plan.scenes.map((scene) => scene.family));
    expect(
      families.size,
      `familles distinctes = ${families.size} sur ${plan.scenes.length} scènes : ${[...families].join(", ")}`,
    ).toBeGreaterThanOrEqual(6);
  });

  test("la famille la plus fréquente reste sous 25 % des scènes", () => {
    const counts = new Map<FamilyId, number>();
    for (const scene of plan.scenes) counts.set(scene.family, (counts.get(scene.family) ?? 0) + 1);
    const [family, count] = [...counts.entries()].sort((left, right) => right[1] - left[1])[0] ?? [
      "aucune" as FamilyId,
      0,
    ];
    const share = count / Math.max(plan.scenes.length, 1);
    expect(
      share,
      `famille dominante = ${family} à ${(share * 100).toFixed(0)} %, seuil 25 % (${count}/${plan.scenes.length})`,
    ).toBeLessThan(0.25);
  });
});

describe("P9 — fenêtre de teinte et écart entre scènes voisines", () => {
  for (const { name, analysis } of tracks) {
    test(`teinte dans ±spread de l'ancre : ${name}`, () => {
      const plan = buildShowPlan(analysis, false);
      for (const scene of plan.scenes) {
        // show.ts:601-620 : l'ancre est la complémentaire pour les moments
        // forts, la teinte du morceau sinon ; la teinte finale est ramenée dans
        // ±track.spread de cette ancre.
        const distance = Math.min(
          circular(scene.palette.hue, plan.track.hue),
          circular(scene.palette.hue, plan.track.accent),
        );
        expect(
          distance,
          `${describeScene(scene)} : teinte ${scene.palette.hue.toFixed(1)}° à ${distance.toFixed(1)}° de l'ancre (spread ${plan.track.spread}°)`,
        ).toBeLessThanOrEqual(plan.track.spread + 1e-6);
      }
    });
  }

  // BUG D'ORIGINE : l'écart minimal (`MIN_HUE_STEP`) était appliqué avant le
  // clamp vers la fenêtre ±spread de l'ancre, qui pouvait l'annuler. Corrigé
  // par la PR #30 (`hueWithGap` résout les deux contraintes ensemble) : le
  // test n'est plus marqué `failing`.
  test(`écart ≥ ${MIN_HUE_STEP}° entre scènes voisines (show.ts:611-620)`, () => {
    const violations: string[] = [];
    for (const { name, analysis } of tracks) {
      const plan = buildShowPlan(analysis, false);
      for (let index = 1; index < plan.scenes.length; index += 1) {
        const gap = circular(plan.scenes[index]!.palette.hue, plan.scenes[index - 1]!.palette.hue);
        if (gap < MIN_HUE_STEP - 1e-6) {
          violations.push(
            `${name}: ${plan.scenes[index - 1]!.start.toFixed(1)}s→${plan.scenes[index]!.start.toFixed(1)}s = ${gap.toFixed(1)}°`,
          );
        }
      }
    }
    expect(violations, `écarts < ${MIN_HUE_STEP}° : ${violations.join(" | ")}`).toEqual([]);
  });
});

describe("P10 — mode réduit : aucun élément interdit", () => {
  // Le vocabulaire du cahier (« flare », « prisme », « variation », « wash »)
  // ne correspond à AUCUNE famille de ce dépôt. Les éléments interdits en mode
  // réduit sont donc : les familles de concert et les familles rythmiques
  // seules (show.ts:352-356), plus les effets de rendu variation/wash/flash
  // (render.ts:443, 530, 607). On teste ici le plan ; D5 teste le rendu.
  const calm = new Set<string>([
    "waves",
    "tunnel",
    "particles",
    "rings",
    "spiral",
    "pluie",
  ]);
  const reducedAllowed = new Set<string>([...calm, "beams", "waves", "rings", "particles"]);

  for (const { name, analysis } of tracks) {
    test(`aucune famille de concert ni rythmique seule : ${name}`, () => {
      const plan = buildShowPlan(analysis, true);
      for (const scene of plan.scenes) {
        expect(
          reducedAllowed.has(scene.family),
          `mode réduit : ${describeScene(scene)} utilise ${scene.family}`,
        ).toBe(true);
        expect(scene.backdrop).not.toBe("rings"); // show.ts:525
      }
    });
  }
});
