#!/usr/bin/env bun
/**
 * Captures de revue de la vague 2 (avant / après), 960×540.
 *
 *   uv run python tools/real_corpus.py
 *   OUT_DIR=tools/review/vague2/captures PREFIX=apres \
 *     bun tools/review/vague2/capture.ts
 *
 * Lancer le script depuis le worktree à capturer (il importe ses modules).
 */
import { mkdirSync, writeFileSync } from "node:fs";

import { DEFAULT_SETTINGS } from "../../../src/types";
import { createHeadlessRenderer } from "../../../tests/support/headless_render";
import { loadRealCorpus } from "../../../tests/support/plan_corpus";

const OUT = process.env.OUT_DIR ?? "tools/review/vague2/captures";
const PREFIX = process.env.PREFIX ?? "capture";

const shots = [
  { name: "1-shineon-76.10-impact-terne", track: "Shine On You Crazy Diamond (Pts. 1-5)", time: 76.1 },
  { name: "2-omt-78.30-scintillement", track: "One More Time", time: 78.3 },
  { name: "3-gymno-40.88-barres-agressif", track: "Gymnopédie No. 1", time: 40.88 },
  { name: "4-lavie-24.25-drops-ressemblants", track: "La Vie en Rose", time: 24.25 },
  { name: "5-shineon-264.83-barres-terne", track: "Shine On You Crazy Diamond (Pts. 1-5)", time: 264.83 },
];

const tracks = loadRealCorpus();
const renderer = await createHeadlessRenderer();
mkdirSync(OUT, { recursive: true });
try {
  for (const shot of shots) {
    const track = tracks.find((candidate) => candidate.name === shot.track);
    if (track === undefined) throw new Error(`piste absente : ${shot.track}`);
    await renderer.setup({
      analysis: track.analysis,
      reduced: false,
      width: 960,
      height: 540,
      dpr: 1,
      quality: 1,
      settings: DEFAULT_SETTINGS,
      reducedMotion: false,
    });
    const dataUrl = await renderer.capturePng(shot.time, Math.round(shot.time * 60));
    const bytes = Buffer.from(dataUrl.split(",")[1] ?? "", "base64");
    const path = `${OUT}/${PREFIX}-${shot.name}.png`;
    writeFileSync(path, bytes);
    console.error(`${path} (${(bytes.length / 1024).toFixed(0)} Ko)`);
  }
} finally {
  await renderer.close();
}
