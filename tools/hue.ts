/**
 * Écart de teinte entre un passage calme et sa reprise.
 *
 * Pour chaque titre de référence, lit la section `pont` de la vérité terrain,
 * construit le plan et affiche la teinte de la dernière scène de calme puis
 * celle de la reprise (premier drop dans la fenêtre du pont). Sert à vérifier
 * le saut de teinte ~170° de R3.2 sans capture.
 *
 *     bun tools/hue.ts
 *     bun tools/hue.ts --analyses tests/fixtures/analyses
 *
 * Prérequis : `uv run python tools/real_corpus.py`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { buildShowPlan } from "../src/core/show";
import type { Analysis } from "../src/types";

const ROOT = resolve(import.meta.dir, "..");
const DEFAULT_MANIFEST = join(ROOT, "tests/support/real_corpus.json");
const DEFAULT_ANALYSES = join(ROOT, "tests/fixtures/analyses");
const DEFAULT_TRUTH = join(ROOT, "tests/ground-truth");
/** Fenêtre après la fin du calme où l'on cherche la reprise. */
const REPRISE_HORIZON = 5.0;

interface ManifestEntry {
  id: number;
  titre: string;
  reference?: true;
}

interface TruthSection {
  role: string;
  start: number;
  end: number;
}

interface Truth {
  sections: TruthSection[];
}

function slug(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function hueGap(left: number, right: number): number {
  const delta = Math.abs(left - right) % 360;
  return delta > 180 ? 360 - delta : delta;
}

function main(): number {
  const argv = process.argv.slice(2);
  let manifestPath = DEFAULT_MANIFEST;
  let analysesDir = DEFAULT_ANALYSES;
  let truthDir = DEFAULT_TRUTH;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = () => argv[++index];
    if (arg === "--manifest") manifestPath = next() ?? manifestPath;
    else if (arg === "--analyses") analysesDir = next() ?? analysesDir;
    else if (arg === "--truth") truthDir = next() ?? truthDir;
    else if (arg === "--help" || arg === "-h") {
      console.log("bun tools/hue.ts [--manifest f] [--analyses d] [--truth d]");
      return 0;
    } else {
      console.error(`argument inconnu : ${arg}`);
      return 2;
    }
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ManifestEntry[];
  let failed = false;
  for (const entry of manifest.filter((item) => item.reference === true)) {
    const analysisPath = join(analysesDir, `real-${entry.id}.json`);
    const truthPath = join(truthDir, `${slug(entry.titre)}.json`);
    if (!existsSync(analysisPath) || !existsSync(truthPath)) {
      console.error(`analyse ou vérité absente pour ${entry.titre}`);
      failed = true;
      continue;
    }
    const analysis = JSON.parse(readFileSync(analysisPath, "utf8")) as Analysis;
    const truth = JSON.parse(readFileSync(truthPath, "utf8")) as Truth;
    const plan = buildShowPlan(analysis, false, undefined, { dramaturgy: true });
    const calms = truth.sections.filter((section) => section.role === "pont");
    if (calms.length === 0) {
      console.log(`${entry.titre.padEnd(9)} aucun pont validé`);
      continue;
    }
    for (const calm of calms) {
      const reprises = plan.scenes.filter(
        (scene) =>
          scene.role === "drop" &&
          scene.start >= calm.start - 1 &&
          scene.start <= calm.end + REPRISE_HORIZON,
      );
      if (reprises.length === 0) {
        console.log(
          `${entry.titre.padEnd(9)} calme ${calm.start.toFixed(1)}–${calm.end.toFixed(1)} : aucune reprise`,
        );
        continue;
      }
      for (const reprise of reprises) {
        const calmScene = plan.scenes
          .filter((scene) => scene.mood === "calme" && scene.end <= reprise.start + 0.5)
          .at(-1);
        if (calmScene === undefined) {
          console.log(
            `${entry.titre.padEnd(9)} reprise ${reprise.start.toFixed(2)} : aucun calme classé avant`,
          );
          continue;
        }
        console.log(
          `${entry.titre.padEnd(9)} calme ${calmScene.start.toFixed(2)}–${calmScene.end.toFixed(2)} ` +
            `hue=${calmScene.palette.hue.toFixed(1)} -> reprise ${reprise.start.toFixed(2)} ` +
            `hue=${reprise.palette.hue.toFixed(1)} gap=${hueGap(calmScene.palette.hue, reprise.palette.hue).toFixed(1)}°`,
        );
      }
    }
  }
  return failed ? 1 : 0;
}

if (import.meta.main) process.exit(main());
