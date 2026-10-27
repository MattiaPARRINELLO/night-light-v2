/**
 * Génère les analyses synthétiques du contrat v3.1.
 *
 *   bun tests/support/make_contract_fixtures.ts
 *
 * Chaque fixture est un JSON autonome, au format exact du contrat : sections
 * contiguës couvrant [0, durée], `kind` / `group` / `confidence`, `events`
 * bass-return espacés, `meter` entier inchangé + `meterConfidence`.
 *
 * Les fichiers produits sont versionnés dans `tests/fixtures/contract_v3/` ;
 * ce script ne sert qu'à les régénérer à l'identique (déterminisme total).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Analysis, AnalysisEvent, Build, Point, Section, SectionKind, SectionLabel } from "../../src/types";

const ROOT = resolve(import.meta.dir, "../..");
export const CONTRACT_FIXTURE_DIR = join(ROOT, "tests/fixtures/contract_v3");

interface SectionSpec {
  start: number;
  end: number;
  label: SectionLabel;
  energy: number;
  kind: SectionKind;
  group?: string;
  occurrence?: number;
  confidence: number;
  /** Brillance spectrale moyenne de la section, 0..1. */
  high: number;
}

interface FixtureSpec {
  name: string;
  description: string;
  duration: number;
  tempo: number;
  meter: 3 | 4;
  meterConfidence: number;
  sections: SectionSpec[];
  builds: Build[];
  events: AnalysisEvent[];
}

function section(partial: Partial<SectionSpec> & Pick<SectionSpec, "start" | "end">): SectionSpec {
  return {
    label: "intense",
    energy: 0.5,
    kind: "section",
    confidence: 0.9,
    high: 0.3,
    ...partial,
  };
}

const FIXTURES: FixtureSpec[] = [
  {
    name: "refrain-x3",
    description: "Couplet / refrain ×3, même groupe de refrain, intensité croissante.",
    duration: 150,
    tempo: 128,
    meter: 4,
    meterConfidence: 0.9,
    sections: [
      section({ start: 0, end: 10, label: "calme", energy: 0.18, kind: "intro", confidence: 0.95, high: 0.18 }),
      section({ start: 10, end: 30, label: "calme", energy: 0.42, kind: "couplet", group: "A", occurrence: 1, high: 0.28 }),
      section({ start: 30, end: 50, label: "intense", energy: 0.82, kind: "refrain", group: "B", occurrence: 1, confidence: 0.92, high: 0.52 }),
      section({ start: 50, end: 70, label: "calme", energy: 0.44, kind: "couplet", group: "A", occurrence: 2, high: 0.3 }),
      section({ start: 70, end: 90, label: "intense", energy: 0.86, kind: "refrain", group: "B", occurrence: 2, confidence: 0.93, high: 0.56 }),
      section({ start: 90, end: 110, label: "calme", energy: 0.46, kind: "couplet", group: "A", occurrence: 3, high: 0.32 }),
      section({ start: 110, end: 130, label: "intense", energy: 0.9, kind: "refrain", group: "B", occurrence: 3, confidence: 0.94, high: 0.6 }),
      section({ start: 130, end: 150, label: "descente", energy: 0.3, kind: "outro", high: 0.24 }),
    ],
    builds: [],
    events: [],
  },
  {
    name: "refrain-pont",
    description: "Refrain + pont : le pont rompt famille et teinte, puis le refrain revient.",
    duration: 120,
    tempo: 120,
    meter: 4,
    meterConfidence: 0.85,
    sections: [
      section({ start: 0, end: 8, label: "calme", energy: 0.16, kind: "intro", high: 0.16 }),
      section({ start: 8, end: 26, label: "calme", energy: 0.44, kind: "couplet", group: "A", occurrence: 1, high: 0.3 }),
      section({ start: 26, end: 46, label: "intense", energy: 0.84, kind: "refrain", group: "B", occurrence: 1, confidence: 0.91, high: 0.54 }),
      section({ start: 46, end: 64, label: "calme", energy: 0.46, kind: "couplet", group: "A", occurrence: 2, high: 0.32 }),
      section({ start: 64, end: 84, label: "montee", energy: 0.56, kind: "pont", group: "P", occurrence: 1, confidence: 0.85, high: 0.42 }),
      section({ start: 84, end: 94, label: "montee", energy: 0.68, group: "M", occurrence: 1, confidence: 0.8, high: 0.46 }),
      section({ start: 94, end: 112, label: "intense", energy: 0.88, kind: "refrain", group: "B", occurrence: 2, confidence: 0.92, high: 0.58 }),
      section({ start: 112, end: 120, label: "descente", energy: 0.28, kind: "outro", high: 0.22 }),
    ],
    builds: [],
    events: [],
  },
  {
    name: "silence-milieu",
    description: "Silence de 2,5 s au milieu : humeur sombre, aucun flash ni drop.",
    duration: 100,
    tempo: 110,
    meter: 4,
    meterConfidence: 0.8,
    sections: [
      section({ start: 0, end: 18, label: "calme", energy: 0.4, kind: "couplet", group: "A", occurrence: 1, high: 0.3 }),
      section({ start: 18, end: 38, label: "intense", energy: 0.8, kind: "refrain", group: "B", occurrence: 1, confidence: 0.9, high: 0.52 }),
      section({ start: 38, end: 40.5, label: "silence", energy: 0.04, kind: "silence", confidence: 0.95, high: 0.04 }),
      section({ start: 40.5, end: 60, label: "calme", energy: 0.38, kind: "couplet", group: "A", occurrence: 2, high: 0.28 }),
      section({ start: 60, end: 80, label: "intense", energy: 0.82, kind: "refrain", group: "B", occurrence: 2, confidence: 0.9, high: 0.54 }),
      section({ start: 80, end: 100, label: "descente", energy: 0.26, kind: "outro", high: 0.22 }),
    ],
    builds: [],
    events: [],
  },
  {
    name: "valse-3-4",
    description: "Métrique ternaire validée : 3 temps par mesure.",
    duration: 120,
    tempo: 180,
    meter: 3,
    meterConfidence: 0.82,
    sections: [
      section({ start: 0, end: 8, label: "calme", energy: 0.18, kind: "intro", high: 0.18 }),
      section({ start: 8, end: 32, label: "calme", energy: 0.4, kind: "couplet", group: "A", occurrence: 1, high: 0.28 }),
      section({ start: 32, end: 56, label: "intense", energy: 0.78, kind: "refrain", group: "B", occurrence: 1, confidence: 0.88, high: 0.5 }),
      section({ start: 56, end: 80, label: "calme", energy: 0.42, kind: "couplet", group: "A", occurrence: 2, high: 0.3 }),
      section({ start: 80, end: 104, label: "intense", energy: 0.84, kind: "refrain", group: "B", occurrence: 2, confidence: 0.9, high: 0.54 }),
      section({ start: 104, end: 120, label: "descente", energy: 0.26, kind: "outro", high: 0.2 }),
    ],
    builds: [],
    events: [],
  },
  {
    name: "rap-bass-return",
    description: "Rap sans montée : trois bass-return espacés servent de frontières.",
    duration: 120,
    tempo: 96,
    meter: 4,
    meterConfidence: 0.7,
    sections: [
      section({ start: 0, end: 8, label: "calme", energy: 0.2, kind: "intro", high: 0.18 }),
      section({ start: 8, end: 40, label: "intense", energy: 0.52, kind: "couplet", group: "A", occurrence: 1, high: 0.3 }),
      section({ start: 40, end: 60, label: "intense", energy: 0.74, kind: "refrain", group: "B", occurrence: 1, confidence: 0.85, high: 0.46 }),
      section({ start: 60, end: 90, label: "intense", energy: 0.54, kind: "couplet", group: "A", occurrence: 2, high: 0.32 }),
      section({ start: 90, end: 110, label: "intense", energy: 0.76, kind: "refrain", group: "B", occurrence: 2, confidence: 0.86, high: 0.48 }),
      section({ start: 110, end: 120, label: "descente", energy: 0.3, kind: "outro", high: 0.22 }),
    ],
    builds: [],
    events: [
      { t: 24, kind: "bass-return", strength: 0.62 },
      { t: 72, kind: "bass-return", strength: 0.74 },
      { t: 104, kind: "bass-return", strength: 0.55 },
    ],
  },
  {
    name: "confidence-faible",
    description: "Sections peu fiables (< 0,5) : aucun rôle refrain / pont / silence.",
    duration: 96,
    tempo: 124,
    meter: 3,
    meterConfidence: 0.35,
    sections: [
      section({ start: 0, end: 8, label: "calme", energy: 0.2, kind: "intro", confidence: 0.3, high: 0.18 }),
      section({ start: 8, end: 32, label: "calme", energy: 0.44, kind: "couplet", group: "A", occurrence: 1, confidence: 0.35, high: 0.3 }),
      section({ start: 32, end: 56, label: "intense", energy: 0.84, kind: "refrain", group: "B", occurrence: 1, confidence: 0.4, high: 0.54 }),
      section({ start: 56, end: 58, label: "silence", energy: 0.05, kind: "silence", confidence: 0.3, high: 0.05 }),
      section({ start: 58, end: 74, label: "montee", energy: 0.56, kind: "pont", group: "P", occurrence: 1, confidence: 0.3, high: 0.4 }),
      section({ start: 74, end: 96, label: "descente", energy: 0.28, kind: "outro", confidence: 0.25, high: 0.22 }),
    ],
    builds: [],
    events: [],
  },
];

function curve(duration: number, valueAt: (time: number) => number, step = 0.25): Point[] {
  const points: Point[] = [];
  for (let time = 0; time <= duration + 1e-9; time += step) {
    points.push([Math.round(time * 1000) / 1000, Math.round(valueAt(time) * 1000) / 1000]);
  }
  return points;
}

function sectionAt(sections: readonly SectionSpec[], time: number): SectionSpec {
  for (const item of sections) {
    if (time >= item.start && time < item.end) return item;
  }
  return sections[sections.length - 1]!;
}

function buildAnalysis(spec: FixtureSpec): Analysis {
  const beatPeriod = 60 / spec.tempo;
  const beats: number[] = [];
  for (let time = 0; time < spec.duration; time += beatPeriod) {
    beats.push(Math.round(time * 1000) / 1000);
  }
  const onsets: number[] = [];
  for (const item of spec.sections) {
    const step = item.energy > 0.7 ? 0.125 : item.energy > 0.35 ? 0.25 : 0.75;
    for (let time = item.start; time < item.end; time += step) {
      onsets.push(Math.round(time * 1000) / 1000);
    }
  }
  const sections: Section[] = spec.sections.map((item) => ({
    start: item.start,
    end: item.end,
    label: item.label,
    energy: item.energy,
    kind: item.kind,
    group: item.group ?? "",
    occurrence: item.occurrence ?? 0,
    confidence: item.confidence,
  }));
  return {
    schema: 2,
    duration: spec.duration,
    tempo: spec.tempo,
    meter: spec.meter,
    meterConfidence: spec.meterConfidence,
    beatCount: beats.length,
    beatPeriod,
    beats,
    onsets,
    energy: curve(spec.duration, (time) => sectionAt(spec.sections, time).energy),
    bass: curve(spec.duration, (time) => 0.25 + sectionAt(spec.sections, time).energy * 0.55),
    mid: curve(spec.duration, (time) => 0.35 + sectionAt(spec.sections, time).energy * 0.2),
    high: curve(spec.duration, (time) => sectionAt(spec.sections, time).high),
    sections,
    builds: spec.builds,
    events: spec.events,
  };
}

/** Écrit toutes les fixtures et le manifeste. Retourne les noms produits. */
export function writeContractFixtures(directory = CONTRACT_FIXTURE_DIR): string[] {
  mkdirSync(directory, { recursive: true });
  const names: string[] = [];
  for (const spec of FIXTURES) {
    writeFileSync(join(directory, `${spec.name}.json`), `${JSON.stringify(buildAnalysis(spec), null, 2)}\n`, "utf8");
    names.push(spec.name);
  }
  writeFileSync(
    join(directory, "manifest.json"),
    `${JSON.stringify(
      {
        description: "Analyses synthétiques du contrat v3.1 (générées par tests/support/make_contract_fixtures.ts).",
        fixtures: FIXTURES.map((spec) => ({ name: spec.name, description: spec.description })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return names;
}

if (import.meta.main) {
  const names = writeContractFixtures();
  for (const name of names) console.log(`fixture écrite : ${join(CONTRACT_FIXTURE_DIR, `${name}.json`)}`);
}
