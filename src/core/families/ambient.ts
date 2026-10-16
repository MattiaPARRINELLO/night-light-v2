import { clamp01, hash01, mix } from "../series";
import { shiftHue } from "../color";
import { softBeam } from "./beams";
import { contrastHue, lampHue } from "./harmony";
import { beatSwing } from "./tempo";
import type { FamilyDraw } from "./types";
import { GRAND_BALAYAGE_BEATS } from "./types";
import { count, paint } from "./util";

const beams: FamilyDraw = (ctx, f, view) => {
  const { width: w, height: h } = f;
  const originX = w * 0.5;
  const originY = h * 1.02;
  const spread = (Math.PI * 0.78) / (f.reduced ? 1.15 : 1);
  const rays = count(f.energy > 0.55 ? 20 : 13, f.quality, f.reduced);
  // Un pas tous les deux temps forts : l'éventail se réoriente sur la musique,
  // la dérive continue n'étant plus qu'un très léger fond.
  const sweep = beatSwing(f, view, f.reduced ? 0.4 : 0.62, GRAND_BALAYAGE_BEATS) + f.t * (f.reduced ? 0.02 : 0.04);
  const widthBase = Math.min(w, h) * 0.055 * (0.45 + f.bass * 0.9);
  const length = Math.hypot(w, h) * 0.95;

  ctx.lineJoin = "round";
  for (let i = 0; i < rays; i += 1) {
    const ratio = rays === 1 ? 0.5 : i / (rays - 1);
    const wobble = Math.sin(f.t * (0.7 + hash01(i * 31 + f.seed) * 0.9) + i * 1.7) * 0.05;
    const angle = -Math.PI / 2 + (ratio - 0.5) * spread + sweep + wobble;
    const hue = lampHue(f, i);
    const light = f.palette.lightness * (0.55 + 0.45 * f.bass);
    const alpha = (0.05 + 0.32 * f.energy + 0.2 * f.beat * f.bass) * f.alpha;
    if (alpha <= 0.002) continue;
    const width = widthBase * (0.5 + hash01(i * 57 + f.seed) * 0.9) * (0.7 + f.bass * 0.7);
    softBeam(ctx, {
      x: originX,
      y: originY,
      angle,
      length,
      width: width * 1.15,
      hue,
      saturation: f.palette.saturation,
      lightness: light,
      alpha,
      quality: f.quality,
      reduced: f.reduced,
      fumee: f.haze,
    });
  }

  // Halo au point de fuite, piloté par les basses.
  const haloRadius = Math.min(w, h) * (0.16 + f.bass * 0.4 + f.beat * 0.08);
  const haloHue = contrastHue(f);
  const halo = ctx.createRadialGradient(originX, originY, 0, originX, originY, Math.max(haloRadius, 1));
  halo.addColorStop(0, paint(haloHue, 0.9, 0.72, (0.16 + 0.34 * f.bass) * f.alpha));
  halo.addColorStop(1, paint(haloHue, 0.9, 0.6, 0));
  ctx.fillStyle = halo;
  ctx.fillRect(0, originY - haloRadius, w, haloRadius * 1.2);
};

const tunnel: FamilyDraw = (ctx, f) => {
  const { width: w, height: h } = f;
  const cx = w * 0.5;
  const cy = h * 0.48;
  const rings = count(26, f.quality, f.reduced);
  const speed = f.reduced ? 0.16 : 0.42;
  const maxRadius = Math.hypot(w, h) * 0.62;
  ctx.lineCap = "round";

  for (let i = 0; i < rings; i += 1) {
    const depth = (i / rings + f.t * speed) % 1;
    const radius = Math.pow(depth, 2.4) * maxRadius + 6;
    const fade = clamp01(depth * 1.35) * (1 - depth * 0.65);
    // Les anneaux du tunnel portent l'accord de la scène au lieu d'un dégradé
    // d'une seule teinte : c'est là que la monotonie se voyait le plus, ces
    // familles occupant les passages calmes.
    const hue = lampHue(f, i);
    const alpha = (0.06 + 0.4 * f.energy) * fade * f.alpha;
    if (alpha <= 0.004) continue;
    ctx.strokeStyle = paint(hue, f.palette.saturation, f.palette.lightness, alpha);
    ctx.lineWidth = Math.max(0.6, maxRadius * 0.02 * (0.35 + f.bass * 1.5) * (1 - depth * 0.6));
    ctx.beginPath();
    ctx.arc(cx, cy + Math.sin(f.t * 0.6 + i * 0.4) * h * 0.03, radius, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Traînée radiale : rayons qui balayent le tunnel.
  const spokes = count(16, f.quality, f.reduced);
  const turn = f.t * (f.reduced ? 0.1 : 0.3);
  for (let i = 0; i < spokes; i += 1) {
    const angle = turn + (i / spokes) * Math.PI * 2;
    const hue = lampHue(f, i);
    const alpha = (0.05 + 0.2 * f.mid) * f.alpha;
    const gradient = ctx.createLinearGradient(
      cx,
      cy,
      cx + Math.cos(angle) * maxRadius,
      cy + Math.sin(angle) * maxRadius,
    );
    gradient.addColorStop(0, paint(hue, 0.9, 0.7, alpha));
    gradient.addColorStop(1, paint(hue, 0.9, 0.6, 0));
    ctx.strokeStyle = gradient;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(angle) * maxRadius, cy + Math.sin(angle) * maxRadius);
    ctx.stroke();
  }
};

const particles: FamilyDraw = (ctx, f, view) => {
  const { width: w, height: h } = f;
  const cx = w * 0.5;
  const cy = h * 0.5;
  const dots = count(160, f.quality, f.reduced);
  const radius = Math.min(w, h) * 0.42;
  const speed = f.reduced ? 0.12 : 0.3;

  for (let i = 0; i < dots; i += 1) {
    const seedA = hash01(i * 131 + f.seed);
    const seedB = hash01(i * 977 + f.seed);
    const seedC = hash01(i * 3571 + f.seed);
    const orbit = seedA * Math.PI * 2 + f.t * speed * (0.35 + seedB * 0.9) * (1 + f.energy * 1.4);
    const ring = (0.18 + seedB * 0.82) * radius * (1 + f.build * 0.35);
    const x = cx + Math.cos(orbit) * ring;
    const y = cy + Math.sin(orbit) * ring * (0.55 + seedC * 0.45) + Math.sin(f.t * 0.7 + seedA * 9) * h * 0.03;
    const size = (0.7 + seedC * 2.2) * (0.6 + f.high * 1.1 + f.beat * 0.5);
    // Chaque particule prend un membre de l'accord : le nuage devient un semis
    // de teintes au lieu d'un dégradé d'une seule couleur.
    const hue = lampHue(f, i);
    const alpha = (0.12 + 0.55 * f.energy * (0.4 + seedC * 0.6)) * f.alpha;
    ctx.fillStyle = paint(hue, f.palette.saturation, f.palette.lightness + 0.08, alpha);
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fill();
  }

  // Étincelles sur les attaques aiguës récentes.
  const sparks = view.onsetsIn(f.t - 0.35, f.t);
  for (let i = 0; i < sparks.length && i < 8; i += 1) {
    const onset = sparks[sparks.length - 1 - i];
    if (onset === undefined) continue;
    const age = f.t - onset;
    const seedA = hash01(Math.round(onset * 1000) + f.seed);
    const seedB = hash01(Math.round(onset * 7919) + f.seed);
    const x = cx + (seedA - 0.5) * w * 0.8;
    const y = cy + (seedB - 0.5) * h * 0.7;
    const r = (6 + age * 90) * (0.6 + f.high);
    const alpha = clamp01(1 - age / 0.35) * 0.5 * f.alpha * (0.3 + f.high);
    ctx.strokeStyle = paint(contrastHue(f), 0.7, 0.78, alpha);
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
  }
};

const waves: FamilyDraw = (ctx, f) => {
  const { width: w, height: h } = f;
  const lines = count(6, f.quality, f.reduced);
  const speed = f.reduced ? 0.25 : 0.7;

  for (let i = 0; i < lines; i += 1) {
    const ratio = lines === 1 ? 0.5 : i / (lines - 1);
    const baseY = h * mix(0.78, 0.3, ratio) + Math.sin(f.t * 0.35 + i) * h * 0.015;
    const amp = h * (0.018 + 0.07 * f.mid + 0.05 * f.bass) * (0.5 + ratio);
    const hue = lampHue(f, i);
    const alpha = (0.1 + 0.4 * f.energy) * (0.4 + ratio * 0.6) * f.alpha;
    const grad = ctx.createLinearGradient(0, baseY - amp, w, baseY + amp);
    grad.addColorStop(0, paint(hue, f.palette.saturation, f.palette.lightness, alpha));
    grad.addColorStop(0.5, paint(shiftHue(hue, 12), f.palette.saturation, f.palette.lightness + 0.1, alpha * 0.6));
    grad.addColorStop(1, paint(hue, f.palette.saturation, f.palette.lightness, alpha));
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1.5 + f.beat * 2.4 * (0.4 + f.bass);
    ctx.beginPath();
    const step = Math.max(8, w / 44);
    for (let x = 0; x <= w + step; x += step) {
      const phase = (x / w) * Math.PI * 2.2;
      const y =
        baseY +
        Math.sin(phase + f.t * speed * (1 + ratio) + i * 0.6) * amp +
        Math.sin(phase * 2.3 - f.t * speed * 1.4) * amp * 0.35 * f.high;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Remplissage sous la courbe principale.
    if (i === lines - 1) {
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      const fill = ctx.createLinearGradient(0, baseY - amp, 0, h);
      fill.addColorStop(0, paint(hue, f.palette.saturation, f.palette.lightness, alpha * 0.5));
      fill.addColorStop(1, paint(hue, f.palette.saturation, f.palette.lightness, 0));
      ctx.fillStyle = fill;
      ctx.fill();
    }
  }
};

const grid: FamilyDraw = (ctx, f) => {
  const { width: w, height: h } = f;
  const horizon = h * 0.62;
  const columns = count(15, f.quality, f.reduced);
  const speed = f.reduced ? 0.12 : 0.35;
  const depthLines = count(14, f.quality, f.reduced);
  // Deux membres de l'accord : les colonnes et les lignes de fuite ne partagent
  // donc pas la même teinte, et la grille n'est plus d'une seule couleur.
  const hue = lampHue(f, 0);
  const hueFuite = lampHue(f, 1);

  ctx.lineWidth = 1.1;
  for (let i = 0; i < columns; i += 1) {
    const ratio = columns === 1 ? 0.5 : i / (columns - 1);
    const x = (ratio - 0.5) * 2;
    const alpha = (0.05 + 0.18 * f.energy) * f.alpha * (1 - Math.abs(x) * 0.35);
    ctx.strokeStyle = paint(hue, f.palette.saturation, f.palette.lightness, alpha);
    ctx.beginPath();
    ctx.moveTo(w * 0.5 + x * w * 0.03, horizon);
    ctx.lineTo(w * 0.5 + x * w * 0.9, h * 1.02);
    ctx.stroke();
  }

  for (let i = 0; i < depthLines; i += 1) {
    const z = (i / depthLines + ((f.t * speed) % (1 / depthLines)) * depthLines) % 1;
    const y = horizon + Math.pow(z, 2.2) * (h - horizon) * 1.25;
    if (y > h * 1.05) continue;
    const alpha = (0.05 + 0.22 * f.energy) * clamp01(z * 1.4) * f.alpha;
    ctx.strokeStyle = paint(hueFuite, f.palette.saturation, f.palette.lightness, alpha);
    ctx.lineWidth = 0.8 + z * 2.2;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  // Ligne d'horizon lumineuse.
  const horizonGlow = ctx.createLinearGradient(0, horizon - h * 0.08, 0, horizon + h * 0.05);
  horizonGlow.addColorStop(0, paint(hue, 0.9, 0.65, 0));
  horizonGlow.addColorStop(0.7, paint(hue, 0.9, 0.68, (0.1 + 0.3 * f.energy) * f.alpha));
  horizonGlow.addColorStop(1, paint(hueFuite, 0.9, 0.6, 0));
  ctx.fillStyle = horizonGlow;
  ctx.fillRect(0, horizon - h * 0.08, w, h * 0.13);
};

const rings: FamilyDraw = (ctx, f, view) => {
  const { width: w, height: h } = f;
  const cx = w * 0.5;
  const cy = h * 0.52;
  const maxRadius = Math.hypot(w, h) * 0.55;

  // Ondes émises à chaque temps fort récent.
  const beats = view.beatsIn(f.t - 2.6, f.t);
  for (let i = 0; i < beats.length; i += 1) {
    const beat = beats[beats.length - 1 - i];
    if (beat === undefined) continue;
    const age = f.t - beat;
    const progress = age / 2.2;
    if (progress >= 1) continue;
    const radius = 10 + Math.pow(progress, 0.55) * maxRadius;
    const fade = 1 - progress;
    const alpha = (0.1 + 0.45 * f.energy) * fade * f.alpha * (i === 0 ? 1 : 0.55);
    ctx.strokeStyle = paint(lampHue(f, i), f.palette.saturation, f.palette.lightness, alpha);
    ctx.lineWidth = Math.max(0.8, 5 * fade * (0.5 + f.bass));
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Anneaux pulsés par les basses, concentriques et alternés.
  const pulses = count(7, f.quality, f.reduced);
  for (let i = 0; i < pulses; i += 1) {
    const phase = (f.t * 0.8 + i / pulses) % 1;
    const radius = 12 + phase * maxRadius * 0.7;
    const alpha = (1 - phase) * (0.05 + 0.3 * f.bass) * f.alpha;
    ctx.strokeStyle = paint(lampHue(f, i), f.palette.saturation, 0.68, alpha);
    ctx.lineWidth = 1 + 3 * f.beat * f.bass;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
  }
};

const shutters: FamilyDraw = (ctx, f) => {
  const { width: w, height: h } = f;
  const slats = count(16, f.quality, f.reduced);
  const gap = w / slats;
  const speed = f.reduced ? 0.35 : 1.1;
  const baseY = h * 0.5;

  for (let i = 0; i < slats; i += 1) {
    const phase = f.t * speed * (0.6 + hash01(i * 71 + f.seed) * 0.8) + i * 0.7;
    const open = 0.5 + 0.5 * Math.sin(phase);
    const height = h * (0.06 + 0.5 * open) * (0.4 + f.energy * 1.2) + f.beat * h * 0.06;
    const hue = lampHue(f, i);
    const alpha = (0.08 + 0.42 * f.energy + 0.2 * f.beat) * f.alpha * (0.4 + open * 0.6);
    const x = i * gap;
    const gradient = ctx.createLinearGradient(0, baseY - height, 0, baseY + height);
    gradient.addColorStop(0, paint(hue, f.palette.saturation, f.palette.lightness, 0));
    gradient.addColorStop(0.5, paint(hue, f.palette.saturation, f.palette.lightness + 0.12, alpha));
    gradient.addColorStop(1, paint(hue, f.palette.saturation, f.palette.lightness, 0));
    ctx.fillStyle = gradient;
    ctx.fillRect(x + gap * 0.16, baseY - height, gap * 0.68, height * 2);
  }
};

const bars: FamilyDraw = (ctx, f) => {
  const { width: w, height: h } = f;
  const columns = count(28, f.quality, f.reduced);
  const gap = w / columns;
  const floor = h * 0.88;

  for (let i = 0; i < columns; i += 1) {
    const band = hash01(i * 911 + f.seed);
    const level =
      0.12 +
      0.6 * (band < 0.33 ? f.bass : band < 0.72 ? f.mid : f.high) *
        (0.4 + 0.6 * Math.abs(Math.sin(f.t * (0.8 + band) * (f.reduced ? 0.4 : 1.2) + i * 0.5)));
    const height = (h * 0.5) * level * (0.4 + f.energy);
    const hue = lampHue(f, i);
    const alpha = (0.12 + 0.5 * f.energy) * f.alpha;
    const gradient = ctx.createLinearGradient(0, floor - height, 0, floor);
    gradient.addColorStop(0, paint(hue, f.palette.saturation, f.palette.lightness + 0.18, alpha));
    gradient.addColorStop(1, paint(shiftHue(hue, 20), f.palette.saturation, f.palette.lightness, alpha * 0.15));
    ctx.fillStyle = gradient;
    ctx.fillRect(i * gap + gap * 0.14, floor - height, gap * 0.72, height);
  }

  const line = ctx.createLinearGradient(0, 0, w, 0);
  line.addColorStop(0, paint(f.palette.hue, 0.9, 0.7, 0));
  line.addColorStop(0.5, paint(f.palette.hue, 0.9, 0.7, (0.1 + 0.4 * f.energy) * f.alpha));
  line.addColorStop(1, paint(shiftHue(f.palette.hue, f.palette.spread), 0.9, 0.7, 0));
  ctx.fillStyle = line;
  ctx.fillRect(0, floor - 2, w, 2);
};

const spiral: FamilyDraw = (ctx, f) => {
  const { width: w, height: h } = f;
  const cx = w * 0.5;
  const cy = h * 0.5;
  const arms = count(5, f.quality, f.reduced);
  const perArm = count(26, f.quality, f.reduced);
  const maxRadius = Math.min(w, h) * 0.46;
  const turn = f.t * (f.reduced ? 0.12 : 0.32);

  for (let arm = 0; arm < arms; arm += 1) {
    const armOffset = (arm / arms) * Math.PI * 2;
    const hue = lampHue(f, arm);
    for (let step = 0; step < perArm; step += 1) {
      const ratio = step / perArm;
      const angle = armOffset + turn * (1 + ratio * 1.6) + ratio * Math.PI * 1.4;
      const radius = ratio * maxRadius * (1 + f.build * 0.3);
      const size = (1 + (1 - ratio) * 5) * (0.5 + f.bass * 0.9 + f.beat * 0.4);
      const alpha = (0.1 + 0.45 * f.energy) * (1 - ratio * 0.7) * f.alpha;
      ctx.fillStyle = paint(hue + ratio * 30, f.palette.saturation, f.palette.lightness + 0.1, alpha);
      ctx.beginPath();
      ctx.arc(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius, size, 0, Math.PI * 2);
      ctx.fill();
    }
  }
};

/** Familles « ambiantes » : nappes, boucles et figures concentriques. */
export const AMBIENT_FAMILIES = {
  beams,
  tunnel,
  particles,
  waves,
  grid,
  rings,
  shutters,
  bars,
  spiral,
} as const;
