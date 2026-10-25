/**
 * La timeline visuelle doit être un fichier statique autonome : aucune requête
 * réseau, aucun script, et autant de bandes de scène que le plan en contient.
 */

import { describe, expect, test } from "bun:test";

import { buildShowPlan } from "../../src/core/show";
import type { Analysis } from "../../src/types";
import { timelineHtml } from "../../tools/plan-timeline";

function analysis(): Analysis {
  const beats = Array.from({ length: 120 }, (_, index) => index * 0.5);
  return {
    schema: 2,
    duration: 60,
    tempo: 120,
    meter: 4,
    beatCount: beats.length,
    beatPeriod: 0.5,
    beats,
    onsets: beats.map((beat) => beat + 0.25),
    energy: [
      [0, 0.3],
      [30, 0.9],
      [60, 0.4],
    ],
    bass: [
      [0, 0.3],
      [60, 0.5],
    ],
    mid: [
      [0, 0.4],
      [60, 0.5],
    ],
    high: [
      [0, 0.2],
      [60, 0.3],
    ],
    sections: [
      { start: 0, end: 30, label: "calme", energy: 0.3, kind: "couplet" },
      { start: 30, end: 60, label: "intense", energy: 0.8, kind: "refrain" },
    ],
    builds: [{ start: 26, end: 30, strength: 0.7 }],
  };
}

describe("timeline visuelle", () => {
  test("HTML autonome, sans réseau ni script", () => {
    const track = { name: "test", analysis: analysis(), source: "corpus" as const };
    const html = timelineHtml(track);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\bsrc=/i);
    expect(html).toContain("Timeline — test");
    expect(html).toContain("<polyline");
  });

  test("une bande et une ligne de tableau par scène", () => {
    const track = { name: "test", analysis: analysis(), source: "corpus" as const };
    const plan = buildShowPlan(track.analysis, false);
    const html = timelineHtml(track);
    expect(html.split('<span class="chip"').length - 1).toBe(plan.scenes.length);
    expect(html.split("<tr><td>#").length - 1).toBe(plan.scenes.length);
    // Les montées et les drops du plan sont marqués.
    expect(html.split('stroke="#ffc24a"').length - 1).toBe(track.analysis.builds.length);
    const drops = plan.scenes.filter((scene) => scene.role === "drop").length;
    expect(html.split('stroke="#ff4d6d"').length - 1).toBe(drops);
  });

  test("le titre échappe le HTML", () => {
    const track = { name: "<script>x</script>", analysis: analysis(), source: "corpus" as const };
    const html = timelineHtml(track);
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
  });
});
