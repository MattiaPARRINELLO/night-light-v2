/**
 * Compare deux JSON produits par `scripts/measure.ts` et affiche les écarts.
 *
 *   bun scripts/compare-metrics.ts docs/metrics/baseline.json docs/metrics/A.json
 *
 * Seuils (documentés ici, volontairement simples) :
 *   - part / fraction (0..1)  : 0,005 en absolu (0,5 point) ;
 *   - degrés                  : 1° en absolu ;
 *   - images/minute, scènes…  : 0,5 en absolu ;
 *   - tout le reste           : 2 % en relatif, jamais moins de 1e-6.
 * Un écart sous le seuil est « = stable ». Au-delà :
 *   ▲ amélioré  si la métrique va dans le bon sens ;
 *   ▼ dégradé   si elle va dans le mauvais sens ;
 *   ◆ changement neutre (donnée de DA, pas un critère de qualité).
 */

import { readFileSync } from "node:fs";

type Direction = "up" | "down" | "neutral";

interface MetricSpec {
  path: string;
  label: string;
  direction: Direction;
  unit?: string;
}

const METRICS: MetricSpec[] = [
  { path: "plan.sceneCount", label: "scènes", direction: "neutral" },
  { path: "plan.topFamilyShare", label: "part famille dominante", direction: "down", unit: "%" },
  { path: "plan.longestFamilyStreak", label: "plus longue série de famille", direction: "down" },
  { path: "plan.brightSceneShare", label: "part scènes brightness > 0,62", direction: "down", unit: "%" },
  { path: "plan.adjacentHueGapMinDeg", label: "écart de teinte min entre scènes", direction: "up", unit: "°" },
  { path: "plan.adjacentHueGapMedianDeg", label: "écart de teinte médian", direction: "up", unit: "°" },
  { path: "plan.hueWindowDeg", label: "fenêtre de teinte utilisée", direction: "neutral", unit: "°" },
  { path: "plan.dropSceneCount", label: "scènes de drop", direction: "neutral" },
  { path: "render.maxHueDeltaDeg", label: "variation de teinte max / image", direction: "down", unit: "°" },
  {
    path: "render.maxHueDeltaOutsideEventDeg",
    label: "variation hors événement",
    direction: "down",
    unit: "°",
  },
  {
    path: "render.maxDriftFromSceneHueDeg",
    label: "dérive max depuis la teinte de scène",
    direction: "down",
    unit: "°",
  },
  { path: "render.flashesPerMinute", label: "flashs / minute", direction: "neutral" },
  { path: "render.flashAlphaMax", label: "alpha max de flash", direction: "neutral" },
  { path: "render.backgroundLightnessMin", label: "luminosité minimale du fond", direction: "up" },
  {
    path: "render.rawEnergyBelowFloorShare",
    label: "images sous le plancher (énergie brute)",
    direction: "down",
    unit: "%",
  },
  {
    path: "render.visibleEnergyBelowFloorShare",
    label: "images sous le plancher (énergie visible)",
    direction: "down",
    unit: "%",
  },
];

function get(data: unknown, path: string): unknown {
  let current: unknown = data;
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function tolerance(spec: MetricSpec): number {
  if (spec.unit === "%") return 0.005;
  if (spec.unit === "°") return 1;
  if (spec.path.endsWith("SceneCount") || spec.path.endsWith("Streak")) return 0.5;
  return 0;
}

function isStable(spec: MetricSpec, before: number, after: number): boolean {
  const absolute = Math.abs(after - before);
  const fixed = tolerance(spec);
  if (fixed > 0) return absolute < fixed;
  const scale = Math.max(Math.abs(before), Math.abs(after), 1e-9);
  return absolute / scale < 0.02 || absolute < 1e-6;
}

function format(spec: MetricSpec, value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (spec.unit === "%") return `${(value * 100).toFixed(1)} %`;
  if (spec.unit === "°") return `${value.toFixed(1)}°`;
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(3);
}

function flag(spec: MetricSpec, before: number, after: number): string {
  if (isStable(spec, before, after)) return "=";
  if (spec.direction === "neutral") return "◆";
  const improved = spec.direction === "up" ? after > before : after < before;
  return improved ? "▲" : "▼";
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function trackMean(data: unknown, path: string): number {
  const tracks = get(data, "tracks");
  if (tracks === null || typeof tracks !== "object") return 0;
  const values = Object.values(tracks)
    .map((track) => get(track, path))
    .filter((value): value is number => typeof value === "number");
  return mean(values);
}

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  process.stderr.write("usage : bun scripts/compare-metrics.ts a.json b.json\n");
  process.exit(2);
}
const before = JSON.parse(readFileSync(beforePath, "utf8"));
const after = JSON.parse(readFileSync(afterPath, "utf8"));

const header = ["métrique", before.label ?? "avant", after.label ?? "après", "écart", ""];
const width = [42, 14, 14, 12, 4];
const line = (cells: string[]) =>
  cells.map((cell, index) => cell.padEnd(width[index] ?? 10)).join(" ").trimEnd();

process.stdout.write(`\n${line(header)}\n${line(width.map((value) => "-".repeat(value)))}\n`);
let improved = 0;
let degraded = 0;
let stable = 0;
for (const spec of METRICS) {
  const a = trackMean(before, spec.path);
  const b = trackMean(after, spec.path);
  const verdict = flag(spec, a, b);
  if (verdict === "▲") improved += 1;
  else if (verdict === "▼") degraded += 1;
  else if (verdict === "=") stable += 1;
  const delta = b - a;
  const sign = delta > 0 ? "+" : "";
  process.stdout.write(
    `${line([
      spec.label,
      format(spec, a),
      format(spec, b),
      `${sign}${format(spec, delta)}`,
      verdict,
    ])}\n`,
  );
}

process.stdout.write(
  `\n▲ ${improved} amélioré(s) · ▼ ${degraded} dégradé(s) · = ${stable} stable(s) · ◆ changement neutre\n\n`,
);
