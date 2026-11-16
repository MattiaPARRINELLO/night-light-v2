/**
 * Export vidéo d'un morceau : rendu image par image, puis audio d'origine.
 *
 * Le rendu passe par le même moteur que l'application (Chromium headless, vrai
 * canvas 2D). Les images sont envoyées à ffmpeg au fil de l'eau, sans passer par
 * des milliers de fichiers PNG sur le disque.
 *
 * Usage :
 *   bun tools/render-video.ts <analyse.json> <audio> <sortie.mp4> [fps] [largeur] [hauteur]
 */

import { readFileSync } from "node:fs";

import { DEFAULT_SETTINGS } from "../src/types";
import { createHeadlessRenderer } from "../tests/support/headless_render";

const [analysisPath, audioPath, outputPath, fpsArg, widthArg, heightArg] = process.argv.slice(2);
if (analysisPath === undefined || audioPath === undefined || outputPath === undefined) {
  console.error(
    "Usage : bun tools/render-video.ts <analyse.json> <audio> <sortie.mp4> [fps] [largeur] [hauteur]",
  );
  process.exit(1);
}

const fps = Number(fpsArg ?? 30);
const width = Number(widthArg ?? 1280);
const height = Number(heightArg ?? 720);
if (!(fps > 0) || !(width > 0) || !(height > 0)) {
  console.error("fps et dimensions doivent être positifs");
  process.exit(1);
}

const analysis = JSON.parse(readFileSync(analysisPath, "utf8")) as { duration: number };
const duration = Number(analysis.duration);
const totalFrames = Math.max(1, Math.round(duration * fps));

const ffmpeg = Bun.spawn(
  [
    "ffmpeg",
    "-y",
    "-loglevel",
    "error",
    "-f",
    "image2pipe",
    "-framerate",
    String(fps),
    "-i",
    "pipe:0",
    "-i",
    audioPath,
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-shortest",
    "-movflags",
    "+faststart",
    outputPath,
  ],
  { stdin: "pipe", stdout: "inherit", stderr: "inherit" },
);

const renderer = await createHeadlessRenderer();
const started = Date.now();
try {
  await renderer.setup({
    analysis,
    reduced: false,
    hard: "auto",
    width,
    height,
    dpr: 1,
    quality: 1,
    settings: DEFAULT_SETTINGS,
    reducedMotion: false,
  });

  for (let frame = 0; frame < totalFrames; frame += 1) {
    const png = await renderer.framePng(frame / fps, frame);
    const comma = png.indexOf(",");
    const buffer = Buffer.from(png.slice(comma + 1), "base64");
    ffmpeg.stdin.write(buffer);
    // Le tube ne doit pas accumuler les images en avance sur ffmpeg.
    await ffmpeg.stdin.flush();

    if (frame % (fps * 5) === 0 || frame === totalFrames - 1) {
      const elapsed = (Date.now() - started) / 1000;
      const done = (frame + 1) / totalFrames;
      const eta = done > 0 ? Math.round((elapsed / done) * (1 - done)) : 0;
      console.log(
        `${Math.round(done * 100)} % · image ${frame + 1}/${totalFrames} · reste ~${Math.round(eta / 60)} min`,
      );
    }
  }
  ffmpeg.stdin.end();
  const code = await ffmpeg.exited;
  if (code !== 0) throw new Error(`ffmpeg a échoué (code ${code})`);
  console.log(`Vidéo écrite : ${outputPath}`);
} finally {
  await renderer.close();
}
