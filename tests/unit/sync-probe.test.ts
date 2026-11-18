import { describe, expect, it } from "bun:test";
import { SyncProbe } from "../../src/core/syncProbe";

/** Enveloppe synthétique : quelques sinusoïdes lentes et des attaques marquées. */
function envelope(t: number): number {
  const slow = 0.5 + 0.3 * Math.sin(t * 0.9) + 0.2 * Math.sin(t * 2.7 + 1.1);
  const beat = Math.exp(-((t % 0.5) * 12)) * 0.35;
  return Math.min(1, Math.max(0, slow + beat));
}

/** Remplit la sonde : niveau entendu à `t`, énergie dessinée à `t - delay`. */
function fill(probe: SyncProbe, delayMs: number, startMs = 1_000_000): void {
  for (let at = startMs; at <= startMs + 20_000; at += 20) {
    const t = (at - startMs) / 1000;
    probe.push(at, envelope(t), envelope(t - delayMs / 1000));
  }
}

describe("SyncProbe", () => {
  it("retrouve un show en retard", () => {
    const probe = new SyncProbe();
    fill(probe, 200);
    const estimate = probe.estimate();
    expect(estimate).not.toBeNull();
    expect(estimate!.offsetMs).toBeGreaterThan(140);
    expect(estimate!.offsetMs).toBeLessThan(260);
    expect(estimate!.score).toBeGreaterThan(0.7);
  });

  it("retrouve un show en avance", () => {
    const probe = new SyncProbe();
    fill(probe, -160);
    const estimate = probe.estimate();
    expect(estimate).not.toBeNull();
    expect(estimate!.offsetMs).toBeLessThan(-100);
    expect(estimate!.offsetMs).toBeGreaterThan(-220);
  });

  it("ne corrige rien quand tout est aligné", () => {
    const probe = new SyncProbe();
    fill(probe, 0);
    const estimate = probe.estimate();
    expect(estimate).not.toBeNull();
    expect(Math.abs(estimate!.offsetMs)).toBeLessThanOrEqual(40);
    expect(estimate!.score).toBeGreaterThan(0.95);
  });

  it("ne conclut pas sur une fenêtre trop courte", () => {
    const probe = new SyncProbe();
    for (let at = 0; at <= 1_500; at += 20) probe.push(at, Math.random(), Math.random());
    expect(probe.estimate()).toBeNull();
  });

  it("ne conclut pas sur un signal plat", () => {
    const probe = new SyncProbe();
    for (let at = 0; at <= 10_000; at += 20) probe.push(at, 0.5, 0.5);
    expect(probe.estimate()).toBeNull();
  });

  it("ignore une horloge qui recule", () => {
    const probe = new SyncProbe();
    fill(probe, 100);
    const before = probe.size;
    probe.push(0, 1, 1);
    expect(probe.size).toBe(before);
  });
});
