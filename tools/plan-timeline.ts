#!/usr/bin/env bun
/**
 * Timeline visuelle d'un morceau : énergie, montées, drops et scènes.
 *
 *   bun tools/plan-timeline.ts [piste] [--corpus <dir>] [--out <fichier>]
 *   bun tools/plan-timeline.ts --all [--out <répertoire>]
 *
 * Le fichier produit est un HTML statique autonome : aucune requête réseau,
 * aucun script, aucune police externe. Les bandes de scène sont colorées par
 * leur teinte et étiquetées rôle / humeur / famille / raison.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { buildShowPlan, FAMILY_LABELS, MOOD_LABELS, SCENE_REASON_LABELS, SCENE_ROLE_LABELS, type ShowPlan } from "../src/core/show";
import type { Analysis } from "../src/types";
import { DEFAULT_CORPUS_DIR, loadCorpusAnalyses, type PlanTrack } from "../tests/support/plan_corpus";

const W = 1200;
const H = 320;
const LEFT = 44;
const RIGHT = 16;
const TOP = 54;
const BOTTOM = 34;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function xOf(time: number, duration: number): number {
  return LEFT + (time / Math.max(duration, 0.001)) * (W - LEFT - RIGHT);
}

function energyPoints(analysis: Analysis, plan: ShowPlan): string {
  const height = H - TOP - BOTTOM;
  return analysis.energy
    .map(([time, value]) => {
      const x = xOf(time, plan.duration).toFixed(2);
      const y = (TOP + (1 - Math.min(1, Math.max(0, value))) * height).toFixed(2);
      return `${x},${y}`;
    })
    .join(" ");
}

function sceneBand(scene: ShowPlan["scenes"][number], duration: number): string {
  const x = xOf(scene.start, duration);
  const width = Math.max(1, xOf(scene.end, duration) - x);
  const color = `hsl(${scene.palette.hue.toFixed(1)} 78% 55%)`;
  const label = `${SCENE_ROLE_LABELS[scene.role]} · ${MOOD_LABELS[scene.mood]} · ${FAMILY_LABELS[scene.family]} · ${SCENE_REASON_LABELS[scene.reason]}`;
  const title = escapeHtml(
    `#${scene.index} ${scene.start.toFixed(2)}→${scene.end.toFixed(2)} s · ${label} · ` +
      `teinte ${scene.palette.hue.toFixed(0)}° · intensité ${scene.intensity.toFixed(2)}` +
      (scene.drop === undefined
        ? ""
        : ` · drop ${scene.drop.lyres}/${scene.drop.barres}/${scene.drop.blinders}/${scene.drop.hue}`),
  );
  const text =
    width > 64
      ? `<text x="${(x + width / 2).toFixed(1)}" y="44" text-anchor="middle" font-size="9" fill="#0b0b12">${escapeHtml(
          SCENE_ROLE_LABELS[scene.role],
        )}</text>`
      : "";
  return (
    `<g><title>${title}</title>` +
    `<rect x="${x.toFixed(1)}" y="${TOP}" width="${width.toFixed(1)}" height="${H - TOP - BOTTOM}" fill="${color}" opacity="0.10"/>` +
    `<rect x="${x.toFixed(1)}" y="30" width="${width.toFixed(1)}" height="18" fill="${color}" stroke="#0b0b12" stroke-width="0.5"/>` +
    `${text}</g>`
  );
}

export function timelineHtml(track: PlanTrack): string {
  const plan = buildShowPlan(track.analysis, false);
  const height = H - TOP - BOTTOM;
  const grid: string[] = [];
  for (let time = 0; time <= plan.duration; time += 10) {
    const x = xOf(time, plan.duration);
    grid.push(
      `<line x1="${x.toFixed(1)}" y1="${TOP}" x2="${x.toFixed(1)}" y2="${H - BOTTOM}" stroke="#2a2a3a" stroke-width="0.5"/>` +
        `<text x="${x.toFixed(1)}" y="${H - BOTTOM + 16}" text-anchor="middle" font-size="10" fill="#8b8ba0">${time.toFixed(0)} s</text>`,
    );
  }
  const builds = track.analysis.builds
    .map((build) => {
      const x = xOf(build.start, plan.duration);
      const width = Math.max(1, xOf(build.end, plan.duration) - x);
      const strength = Math.min(1, Math.max(0, build.strength));
      return (
        `<rect x="${x.toFixed(1)}" y="${TOP}" width="${width.toFixed(1)}" height="${height}" fill="#ffc24a" opacity="${(0.08 + 0.12 * strength).toFixed(2)}"/>` +
        `<line x1="${(x + width).toFixed(1)}" y1="${TOP}" x2="${(x + width).toFixed(1)}" y2="${H - BOTTOM}" stroke="#ffc24a" stroke-width="1" stroke-dasharray="3 3"/>`
      );
    })
    .join("");
  const drops = plan.scenes
    .filter((scene) => scene.role === "drop")
    .map((scene) => {
      const x = xOf(scene.start, plan.duration);
      return (
        `<line x1="${x.toFixed(1)}" y1="${TOP}" x2="${x.toFixed(1)}" y2="${H - BOTTOM}" stroke="#ff4d6d" stroke-width="1.5"/>` +
        `<text x="${(x + 3).toFixed(1)}" y="${TOP + 12}" font-size="9" fill="#ff8fa3">drop</text>`
      );
    })
    .join("");

  const rows = plan.scenes
    .map((scene) => {
      const color = `hsl(${scene.palette.hue.toFixed(1)} 78% 55%)`;
      return (
        `<tr><td>#${scene.index}</td><td>${scene.start.toFixed(2)}</td><td>${scene.end.toFixed(2)}</td>` +
        `<td>${escapeHtml(SCENE_ROLE_LABELS[scene.role])}</td><td>${escapeHtml(MOOD_LABELS[scene.mood])}</td>` +
        `<td><span class="chip" style="background:${color}"></span>${escapeHtml(FAMILY_LABELS[scene.family])}</td>` +
        `<td>${escapeHtml(SCENE_REASON_LABELS[scene.reason])}</td><td>${scene.palette.hue.toFixed(0)}°</td>` +
        `<td>${scene.intensity.toFixed(2)}</td>` +
        `<td>${scene.drop === undefined ? "—" : escapeHtml(`${scene.drop.lyres}/${scene.drop.barres}/${scene.drop.blinders}/${scene.drop.hue}`)}</td></tr>`
      );
    })
    .join("\n");

  return `<!doctype html>
<html lang="fr">
<meta charset="utf-8">
<title>Timeline — ${escapeHtml(track.name)}</title>
<style>
  html, body { margin: 0; background: #0b0b12; color: #e7e7f0; font: 13px/1.45 system-ui, sans-serif; }
  main { max-width: 1240px; margin: 24px auto; padding: 0 16px 40px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .meta { color: #8b8ba0; margin-bottom: 18px; }
  svg { width: 100%; height: auto; display: block; background: #101018; border-radius: 6px; }
  table { width: 100%; border-collapse: collapse; margin-top: 18px; font-size: 12px; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #232334; white-space: nowrap; }
  th { color: #9a9ab0; font-weight: 600; }
  tr:hover td { background: #16161f; }
  .chip { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 6px; vertical-align: middle; }
  .legend { color: #8b8ba0; margin-top: 10px; font-size: 12px; }
</style>
<main>
  <h1>Timeline — ${escapeHtml(track.name)}</h1>
  <div class="meta">${plan.duration.toFixed(1)} s · ${plan.duration > 0 ? (track.analysis.tempo).toFixed(1) : "0"} BPM · ${plan.scenes.length} scènes · ${plan.scenes.filter((scene) => scene.role === "drop").length} drops · palette ${escapeHtml(plan.track.name)}</div>
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Énergie, montées, drops et scènes de ${escapeHtml(track.name)}">
    <rect x="0" y="0" width="${W}" height="${H}" fill="#101018"/>
    ${grid.join("")}
    ${plan.scenes.map((scene) => sceneBand(scene, plan.duration)).join("")}
    ${builds}
    <polyline points="${energyPoints(track.analysis, plan)}" fill="none" stroke="#7bd3ff" stroke-width="1.6"/>
    ${drops}
    <text x="${LEFT}" y="20" font-size="10" fill="#7bd3ff">énergie</text>
    <text x="${LEFT + 60}" y="20" font-size="10" fill="#ffc24a">montées</text>
    <text x="${LEFT + 120}" y="20" font-size="10" fill="#ff8fa3">drops</text>
  </svg>
  <div class="legend">Bandes du haut : scène (couleur = teinte de scène). Curseur sur une bande : détail complet. Courbe bleue : énergie analysée.</div>
  <table>
    <thead><tr><th>#</th><th>début</th><th>fin</th><th>rôle</th><th>humeur</th><th>famille</th><th>raison</th><th>teinte</th><th>intensité</th><th>drop</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
</main>
</html>
`;
}

function main(): number {
  const args = process.argv.slice(2);
  let corpus = DEFAULT_CORPUS_DIR;
  let out: string | undefined;
  let all = false;
  let requested: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--corpus") corpus = args[++index] ?? corpus;
    else if (arg.startsWith("--corpus=")) corpus = arg.slice("--corpus=".length);
    else if (arg === "--out") out = args[++index];
    else if (arg.startsWith("--out=")) out = arg.slice("--out=".length);
    else if (arg === "--all") all = true;
    else if (arg.startsWith("--")) throw new Error(`option inconnue : ${arg}`);
    else requested = arg;
  }

  const tracks = loadCorpusAnalyses(corpus);
  if (tracks.length === 0) throw new Error("corpus vide");

  if (all) {
    const directory = out ?? "tests/metrics/timelines";
    mkdirSync(directory, { recursive: true });
    for (const track of tracks) {
      const file = join(directory, `${track.name}.html`);
      writeFileSync(file, timelineHtml(track), "utf8");
      console.log(`timeline : ${file}`);
    }
    return 0;
  }

  let track = tracks[0]!;
  if (requested !== undefined) {
    const found = tracks.find((candidate) => candidate.name === requested);
    if (found === undefined) {
      throw new Error(
        `piste inconnue : ${requested} (disponibles : ${tracks.map((t) => t.name).join(", ")})`,
      );
    }
    track = found;
  }
  const file = out ?? `tests/metrics/timelines/${track.name}.html`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, timelineHtml(track), "utf8");
  console.log(`timeline : ${file}`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`plan-timeline : ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
