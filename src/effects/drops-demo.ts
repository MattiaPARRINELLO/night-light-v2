/**
 * Démonstration visuelle temporaire : quatre impacts du mode concert.
 *
 * Le fichier est chargé uniquement par `drops-demo.html`, lui aussi temporaire.
 * Il construit un morceau synthétique à quatre montées, laisse `buildShowPlan`
 * choisir les plateaux, puis rend chaque impact avec le vrai `renderFrame`.
 */
import { buildShowPlan, type ShowPlan } from "../core/show";
import { renderFrame } from "../core/render";
import { TrackView } from "../core/view";
import type { HazeLayer, HazeTarget } from "../core/families";
import type { Analysis, RenderSettings } from "../types";

const WIDTH = 560;
const HEIGHT = 315;
const DPR = 2;

function analysis(): Analysis {
  const beats: number[] = [];
  for (let t = 0; t <= 120; t += 0.5) beats.push(Number(t.toFixed(3)));
  const flat = (value: number) => [
    [0, value],
    [120, value],
  ] as [number, number][];
  return {
    schema: 2,
    duration: 120,
    tempo: 120,
    beatCount: beats.length,
    beatPeriod: 0.5,
    beats,
    onsets: [],
    energy: flat(0.85),
    bass: flat(0.8),
    mid: flat(0.55),
    high: flat(0.35),
    sections: [{ start: 0, end: 120, label: "intense", energy: 0.9, kind: "refrain", group: "B" }],
    builds: [
      { start: 15, end: 20, strength: 1 },
      { start: 40, end: 45, strength: 1 },
      { start: 65, end: 70, strength: 1 },
      { start: 90, end: 95, strength: 1 },
    ],
  };
}

function preparerNappe(canvases: readonly [HTMLCanvasElement, HTMLCanvasElement]): HazeLayer | undefined {
  const ctx = canvases[0].getContext("2d");
  const blurPass = canvases[1].getContext("2d");
  if (ctx === null || blurPass === null) return undefined;
  return { ctx, blurPass, scale: 1, used: false };
}

function dimensionnerNappe(nappe: HazeLayer, scale: number, width: number, height: number): void {
  nappe.scale = scale;
  const largeur = Math.max(1, Math.round(width * scale));
  const hauteur = Math.max(1, Math.round(height * scale));
  if (nappe.ctx.canvas.width === largeur && nappe.ctx.canvas.height === hauteur) return;
  nappe.ctx.canvas.width = largeur;
  nappe.ctx.canvas.height = hauteur;
  nappe.blurPass.canvas.width = largeur;
  nappe.blurPass.canvas.height = hauteur;
}

function hazeFor(quality: number): HazeTarget | undefined {
  const fine = preparerNappe([
    document.createElement("canvas"),
    document.createElement("canvas"),
  ]);
  const large = preparerNappe([
    document.createElement("canvas"),
    document.createElement("canvas"),
  ]);
  if (fine === undefined || large === undefined) return undefined;
  dimensionnerNappe(fine, quality >= 0.6 ? 0.5 : 0.4, WIDTH, HEIGHT);
  dimensionnerNappe(large, quality >= 0.9 ? 0.42 : quality >= 0.6 ? 0.36 : 0.3, WIDTH, HEIGHT);
  return { fine, large };
}

const settings: RenderSettings = {
  intensity: 1,
  flashes: 1,
  reduced: false,
  hard: "dynamic",
  blackout: false,
};

const baseAnalysis = analysis();
const plan: ShowPlan = (() => {
  // On garde la première graine qui donne quatre plateaux distincts, pour que
  // la démonstration ne dépende pas d'un tirage particulier.
  for (let seed = 0; seed < 200; seed += 1) {
    const candidate = buildShowPlan(baseAnalysis, false, seed, { hard: "dynamic" });
    const drops = candidate.scenes.filter((scene) => scene.role === "drop");
    const plateaux = new Set(drops.map((scene) => scene.drop?.plateau));
    if (drops.length >= 4 && plateaux.size === drops.length) return candidate;
  }
  return buildShowPlan(baseAnalysis, false, 0, { hard: "dynamic" });
})();

const view = new TrackView(baseAnalysis);
const grid = document.getElementById("grid")!;
const drops = plan.scenes.filter((scene) => scene.role === "drop");
const haze = hazeFor(1);

const fragment = document.createDocumentFragment();
for (const [index, scene] of drops.entries()) {
  const drop = scene.drop!;
  const card = document.createElement("article");
  card.className = "card";

  const frames = document.createElement("div");
  frames.className = "frames";
  for (const [label, offset] of [
    ["impact", 0.32],
    ["geste déployé", 1.5],
  ] as const) {
    const figure = document.createElement("figure");
    const canvas = document.createElement("canvas");
    canvas.width = WIDTH * DPR;
    canvas.height = HEIGHT * DPR;
    const ctx = canvas.getContext("2d");
    if (ctx === null) continue;
    renderFrame({
      ctx,
      width: WIDTH,
      height: HEIGHT,
      dpr: DPR,
      time: scene.start + offset,
      view,
      plan,
      settings,
      reducedMotion: false,
      quality: 1,
      frame: index,
      haze,
    });
    const caption = document.createElement("figcaption");
    caption.textContent = `${label} · ${(scene.start + offset).toFixed(2)} s`;
    figure.append(canvas, caption);
    frames.append(figure);
  }

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.innerHTML = [
    `<b>Impact ${index + 1} · ${scene.family}</b>`,
    `<small>à ${scene.start.toFixed(1)} s · plateau « ${drop.plateau} »</small>`,
    `<div class="tags">${[
      `lyres ${drop.lyres}`,
      `barres ${drop.barres}`,
      `blinders ${drop.blinders}`,
      `strobe ${drop.strobes}`,
      `teinte ${drop.hue}`,
    ]
      .map((tag) => `<span class="tag">${tag}</span>`)
      .join("")}</div>`,
  ].join("");
  card.append(meta, frames);
  fragment.append(card);
}
grid.append(fragment);
document.body.dataset.ready = "true";
