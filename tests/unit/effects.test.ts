/**
 * Inventaire du studio d'effets.
 *
 * La galerie ne doit jamais dépendre d'une liste recopiée : ces tests
 * verrouillent le fait que tout effet du moteur est découvert, nommé et rangé,
 * et que la timeline synthétique alimente correctement le rendu.
 */

import { describe, expect, test } from "bun:test";

import {
  EFFECTS,
  EFFECT_CATEGORIES,
  EFFECT_DURATION_SEC,
  applyEffectLook,
  buildEffectTimeline,
  timelineKey,
  type EffectTimelineParams,
} from "../../src/core/effects";
import { FAMILIES } from "../../src/core/families";
import { FAMILY_LABELS, type FamilyId } from "../../src/core/show";

const PARAMS: EffectTimelineParams = {
  tempo: 120,
  energy: 0.7,
  bass: 0.55,
  high: 0.45,
  impacts: true,
  seed: 7,
};

describe("inventaire des effets", () => {
  test("chaque famille du moteur est découverte une seule fois", () => {
    const discovered = EFFECTS.map((effect) => effect.id).sort();
    const registered = (Object.keys(FAMILIES) as FamilyId[]).sort();
    expect(discovered).toEqual(registered);
    expect(new Set(discovered).size).toBe(discovered.length);
  });

  test("chaque effet porte son libellé et une catégorie non vide", () => {
    for (const effect of EFFECTS) {
      expect(effect.label).toBe(FAMILY_LABELS[effect.id]);
      expect(effect.label.length).toBeGreaterThan(0);
      expect(effect.categoryLabel.length).toBeGreaterThan(0);
    }
  });

  test("les catégories couvrent tout l'inventaire, sans doublon", () => {
    const flat = EFFECT_CATEGORIES.flatMap((category) => category.effects.map((effect) => effect.id));
    expect(flat.sort()).toEqual(EFFECTS.map((effect) => effect.id).sort());
    expect(flat.length).toBe(EFFECTS.length);
  });
});

describe("timeline synthétique du studio", () => {
  test("produit une boucle cohérente, calée sur le tempo demandé", () => {
    const timeline = buildEffectTimeline(PARAMS);
    expect(timeline.duration).toBe(EFFECT_DURATION_SEC);
    expect(timeline.tempo).toBe(120);
    expect(timeline.view.duration).toBe(EFFECT_DURATION_SEC);
    expect(timeline.view.beatPeriod).toBeCloseTo(0.5, 5);
    expect(timeline.view.beats.length).toBeGreaterThan(0);
    expect(timeline.plan.scenes.length).toBe(1);
  });

  test("les impacts sont présents quand on les demande, absents sinon", () => {
    const avec = buildEffectTimeline({ ...PARAMS, impacts: true });
    const sans = buildEffectTimeline({ ...PARAMS, impacts: false });
    expect(avec.view.analysis.builds.length).toBeGreaterThan(0);
    expect(sans.view.analysis.builds.length).toBe(0);
  });

  test("l'apparence s'applique à la scène sans reconstruire la timeline", () => {
    const timeline = buildEffectTimeline(PARAMS);
    applyEffectLook(timeline, {
      family: "lyres-eventail",
      variant: "mandala",
      role: "drop",
      mood: "explosif",
      hue: 300,
      spread: 90,
      saturation: 0.9,
      lightness: 0.65,
    });
    const scene = timeline.plan.scenes[0];
    expect(scene?.family).toBe("lyres-eventail");
    expect(scene?.variant).toBe("mandala");
    expect(scene?.role).toBe("drop");
    expect(scene?.mood).toBe("explosif");
    expect(scene?.palette.hue).toBe(300);
    expect(scene?.palette.accent).toBe(30);
    expect(timeline.plan.track.hue).toBe(300);
  });

  test("la clé de timeline ignore la couleur mais suit les réglages de temps", () => {
    const base = timelineKey(PARAMS);
    expect(timelineKey({ ...PARAMS, tempo: 121 })).not.toBe(base);
    expect(timelineKey({ ...PARAMS, energy: 0.8 })).not.toBe(base);
    expect(timelineKey({ ...PARAMS, impacts: false })).not.toBe(base);
    expect(timelineKey({ ...PARAMS })).toBe(base);
  });
});
