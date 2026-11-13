import { describe, expect, it } from "bun:test";
import { buildLivePlan } from "../../src/core/livePlan";

describe("plan du mode direct", () => {
  it("produit des scènes continues qui couvrent des heures", () => {
    const plan = buildLivePlan(42);
    expect(plan.scenes.length).toBeGreaterThan(100);
    expect(plan.profile).toBe("dynamic");
    expect(plan.duration).toBeGreaterThanOrEqual(60 * 60);
    expect(plan.scenes[0]?.index).toBe(0);
    expect(plan.scenes[0]?.start).toBe(0);
    for (let index = 1; index < plan.scenes.length; index += 1) {
      const previous = plan.scenes[index - 1]!;
      const scene = plan.scenes[index]!;
      expect(scene.index).toBe(index);
      expect(scene.start).toBeCloseTo(previous.end, 3);
      expect(scene.end).toBeGreaterThan(scene.start);
    }
  });

  it("varie les familles et ne les répète pas d'affilée", () => {
    const plan = buildLivePlan(42);
    const families = new Set(plan.scenes.map((scene) => scene.family));
    expect(families.size).toBeGreaterThan(15);
    for (let index = 1; index < plan.scenes.length; index += 1) {
      expect(plan.scenes[index]!.family).not.toBe(plan.scenes[index - 1]!.family);
    }
  });

  it("change de palette par blocs", () => {
    const plan = buildLivePlan(42);
    const hues = new Set(plan.scenes.map((scene) => scene.palette.hue));
    expect(hues.size).toBeGreaterThan(3);
  });

  it("est déterministe pour une même graine", () => {
    const a = buildLivePlan(7);
    const b = buildLivePlan(7);
    expect(a.scenes.slice(0, 50)).toEqual(b.scenes.slice(0, 50));
  });

  it("change de progression avec la graine", () => {
    const a = buildLivePlan(1);
    const b = buildLivePlan(2);
    expect(a.scenes[1]).not.toEqual(b.scenes[1]);
  });
});
