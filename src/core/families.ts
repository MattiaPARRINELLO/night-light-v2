import type { FamilyId, Palette, Scene } from "./show";
import { clamp01, hash01, mix, smoothstep } from "./series";
import { hslToRgb, shiftHue, shorthand } from "./color";
import type { TrackView } from "./view";

/** État complet d'une image, dérivé uniquement du temps musical. */
export interface FrameState {
  /** Position de lecture, en secondes. */
  t: number;
  width: number;
  height: number;
  /** Échelle de rendu (device pixel ratio), pour garder des tailles cohérentes. */
  dpr: number;
  scene: Scene;
  palette: Palette;
  energy: number;
  bass: number;
  mid: number;
  high: number;
  /** Battement 0..1 (décroissance depuis le dernier temps fort). */
  beat: number;
  /** Phase dans le temps fort, 0..1. */
  beatPhase: number;
  /** Numéro du temps fort courant. */
  beatIndex: number;
  /** Progression dans une montée, 0..1 (0 si aucune). */
  build: number;
  /** Force de la montée courante, 0..1. */
  buildStrength: number;
  /** Vitesse de montée de l'énergie, 0..1 (0 quand ça descend). */
  surge: number;
  /** Intensité effective = scène * réglage utilisateur. */
  intensity: number;
  /** Poids de la scène dans le fondu, 0..1. */
  alpha: number;
  reduced: boolean;
  /** Qualité adaptative 0..1 : pilote le nombre d'éléments dessinés. */
  quality: number;
  seed: number;
  /** Numéro d'image. */
  frame: number;
}

export type FamilyDraw = (ctx: CanvasRenderingContext2D, f: FrameState, view: TrackView) => void;

/* ------------------------------------------------------------------ tempo */

/**
 * Enveloppe d'allumage et d'extinction d'un élément.
 *
 * Un projecteur ne s'allume pas d'un coup : il monte, tient, puis s'éteint. Le
 * cycle se compte en temps forts — donc la lumière vit avec la musique — et
 * `index` décale la phase de chaque élément : ils s'allument l'un après l'autre
 * au lieu de clignoter en bloc. Les montées et descentes sont lissées, jamais
 * des sauts : c'est ce qui évite l'élément qui « apparaît en pleine scène ».
 *
 * `duty` est la part du cycle pendant laquelle l'élément reste allumé.
 */
export function elementEnvelope(
  f: FrameState,
  view: TrackView,
  index: number,
  cycleBeats = 16,
  duty = 0.6,
): number {
  const cycle = Math.max(1, cycleBeats);
  let phase: number;
  if (view.beats.length === 0) {
    // Sans grille rythmique (mode direct), le cycle se compte en secondes : la
    // lumière doit vivre quand même.
    phase = (f.t / (cycle * 0.45) + hash01(index * 97 + f.seed)) % 1;
  } else {
    phase = ((f.beatIndex + clamp01(f.beatPhase)) / cycle + hash01(index * 97 + f.seed)) % 1;
  }
  phase = ((phase % 1) + 1) % 1;

  const montee = 0.15;
  const extinction = 0.25;
  const allume = Math.max(montee + extinction, duty);
  if (phase >= allume) return 0;
  if (phase < montee) return smoothstep(0, montee, phase);
  const debutExtinction = allume - extinction;
  if (phase < debutExtinction) return 1;
  return 1 - smoothstep(debutExtinction, allume, phase);
}

/**
 * Balayage calé sur le tempo.
 *
 * La cible change à chaque pas — un temps fort par défaut, ou un groupe — et
 * l'interpolation arrive vite puis tient la note. Les faisceaux bougent donc
 * *avec* la musique, au lieu de dériver à côté d'elle à vitesse fixe. C'est la
 * différence entre un projecteur qui balaie et un projecteur qui joue.
 *
 * `offset` décale la phase d'un projecteur : sans lui, toute la rangée partirait
 * du même côté au même instant.
 */
export function beatSwing(
  f: FrameState,
  view: TrackView,
  spread: number,
  beatsPerStep = 1,
  offset = 0,
): number {
  // Aucune grille détectée (mode direct, morceau sans rythme) : on retombe sur
  // une oscillation lente plutôt qu'un balayage figé.
  if (view.beats.length === 0) return Math.sin(f.t * 0.37 + offset) * spread * 0.5;

  const pas = Math.max(1, Math.round(beatsPerStep));
  // Le décalage porte sur la position elle-même : deux lampes voisines sont
  // alors à des points différents de leur course, au lieu de bouger ensemble.
  const position = f.beatIndex + clamp01(f.beatPhase) + offset;
  const bloc = Math.floor(position / pas);
  const local = clamp01(position / pas - bloc);
  // L'ampleur suit l'énergie : une salle calme se contente d'un balayage
  // étroit, un passage fort ouvre largement. La cadence, elle, suit le tempo.
  const ampleur = spread * (0.7 + 0.5 * clamp01(f.energy));
  const depart = (hash01(bloc * 7919 + f.seed) - 0.5) * ampleur;
  const arrivee = (hash01((bloc + 1) * 7919 + f.seed) - 0.5) * ampleur;
  // La course se fait sur les 70 % du pas : le faisceau est en place juste
  // après le temps fort, puis tient sa position le reste du temps.
  return depart + (arrivee - depart) * smoothstep(0, 0.7, local);
}

/* --------------------------------------------------------------- faisceaux */

/** Une couche du faisceau : de l'enveloppe la plus large au cœur le plus dense. */
export interface BeamLayer {
  /** Demi-largeur au bout du faisceau. */
  halfWidth: number;
  /** Demi-largeur au pied (au niveau du projecteur). */
  footHalfWidth: number;
  alpha: number;
  lightness: number;
}

/**
 * Profil d'un faisceau, de l'extérieur vers le cœur.
 *
 * Un projecteur dans une salle enfumée ne dessine pas un triangle net : la
 * lumière diffuse, donc le bord est flou et le centre dense. On empile pour ça
 * quelques couches de plus en plus étroites et de plus en plus lumineuses ; leur
 * somme donne une section de lumière fondue sur les bords.
 */
export function beamLayers(
  width: number,
  alpha: number,
  lightness: number,
  layers = 3,
  footRatio = 0.32,
): BeamLayer[] {
  const nombre = Math.max(1, Math.round(layers));
  if (nombre === 1) {
    return [{ halfWidth: width, footHalfWidth: width * footRatio, alpha, lightness }];
  }
  const out: BeamLayer[] = [];
  for (let index = 0; index < nombre; index += 1) {
    const t = index / (nombre - 1);
    out.push({
      halfWidth: width * (1 - 0.52 * t),
      footHalfWidth: width * footRatio * (1 - 0.6 * t),
      // L'enveloppe est à peine visible, le cœur porte la lumière : leur
      // superposition donne la décroissance douce d'un bord de faisceau.
      alpha: alpha * (0.26 + 0.62 * t),
      lightness: lightness + 0.1 * t,
    });
  }
  return out;
}

/**
 * Rayon de flou d'un faisceau, en pixels.
 *
 * C'est lui qui donne l'épaisseur de fumée : sans lui, un faisceau reste un
 * triangle aux arêtes nettes. Proportionnel à la largeur du faisceau — les gros
 * pâtés de lumière sont plus diffus que les traits fins — mais plafonné : au-delà
 * d'une quinzaine de pixels, le faisceau devient une nappe de brouillard et on
 * perd la forme.
 */
export function beamBlurPixels(width: number, quality: number, reduced: boolean): number {
  if (reduced || quality < 0.55) return 0;
  const part = quality >= 0.85 ? 0.34 : 0.2;
  return Math.min(Math.max(2.5, width * part), quality >= 0.85 ? 16 : 9);
}

export interface BeamSpec {
  /** Origine, au niveau du projecteur. */
  x: number;
  y: number;
  /** Direction du faisceau, en radians. */
  angle: number;
  length: number;
  /** Demi-largeur au bout. */
  width: number;
  hue: number;
  saturation: number;
  lightness: number;
  alpha: number;
  /**
   * Qualité adaptative et mode réduit. Ils décident du flou — donc de la fumée —
   * et, si le navigateur ne sait pas flouter, du nombre de couches de repli.
   */
  quality?: number;
  reduced?: boolean;
  /** Force un nombre de couches, pour les tests. */
  layers?: number;
  /** Largeur du pied en fraction de `width` : une lampe ponctuelle vaut ~0. */
  footRatio?: number;
  /** Teinte de fin de course (par défaut, la même teinte décalée). */
  tailHue?: number;
}

/**
 * Dessine un faisceau souple.
 *
 * Deux façons d'adoucir le bord, dans cet ordre :
 * 1. un flou — c'est ce qui ressemble le plus à de la lumière dans la fumée ;
 * 2. à défaut, une superposition de couches de plus en plus étroites, qui
 *    approche le même profil sans dépendre d'un filtre.
 */
export function softBeam(ctx: CanvasRenderingContext2D, spec: BeamSpec): void {
  const { x, y, angle, length, width, hue, saturation, lightness, alpha } = spec;
  if (alpha <= 0.002 || width <= 0.2) return;
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const px = -dy;
  const py = dx;
  const tailHue = spec.tailHue ?? shiftHue(hue, 18);
  const quality = spec.quality ?? 1;
  const reduced = spec.reduced ?? false;
  const flou = beamBlurPixels(width, quality, reduced);
  // Le filtre n'existe pas partout (et pas dans le contexte de test) : on ne
  // l'active que s'il est réellement disponible.
  const flouter = flou > 0 && "filter" in ctx;
  const couches = spec.layers !== undefined
    ? beamLayers(width, alpha, lightness, spec.layers, spec.footRatio ?? 0.32)
    : flouter
      ? beamLayers(width, alpha, lightness, 1, spec.footRatio ?? 0.32)
      : beamLayers(width, alpha, lightness, beamLayerCount(quality, reduced), spec.footRatio ?? 0.32);

  if (flouter) ctx.filter = `blur(${flou.toFixed(1)}px)`;
  for (const couche of couches) {
    const gradient = ctx.createLinearGradient(x, y, x + dx * length, y + dy * length);
    gradient.addColorStop(0, paint(hue, saturation, couche.lightness + 0.06, couche.alpha));
    gradient.addColorStop(0.45, paint(hue, saturation, couche.lightness, couche.alpha * 0.55));
    gradient.addColorStop(1, paint(tailHue, saturation, couche.lightness, 0));
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.moveTo(x + px * couche.footHalfWidth, y + py * couche.footHalfWidth);
    ctx.lineTo(x + dx * length + px * couche.halfWidth, y + dy * length + py * couche.halfWidth);
    ctx.lineTo(x + dx * length - px * couche.halfWidth, y + dy * length - py * couche.halfWidth);
    ctx.lineTo(x - px * couche.footHalfWidth, y - py * couche.footHalfWidth);
    ctx.closePath();
    ctx.fill();
  }
  if (flouter) ctx.filter = "none";
}

/** Nombre de couches d'un faisceau selon la qualité : plus la machine souffle, plus le bord est travaillé. */
function beamLayerCount(quality: number, reduced: boolean): number {
  if (reduced) return 1;
  if (quality >= 0.85) return 3;
  if (quality >= 0.55) return 2;
  return 1;
}

function paint(h: number, s: number, l: number, a: number): string {
  return shorthand(hslToRgb({ h, s, l }), a);
}

/** Nombre d'éléments d'une famille, dégradé par la qualité et le mode réduit. */
function count(base: number, quality: number, reduced: boolean): number {
  const scaled = base * (reduced ? 0.55 : 1) * (0.45 + 0.55 * clamp01(quality));
  return Math.max(3, Math.round(scaled));
}

/* ------------------------------------------------------------------ faisceaux */

const beams: FamilyDraw = (ctx, f, view) => {
  const { width: w, height: h } = f;
  const originX = w * 0.5;
  const originY = h * 1.02;
  const spread = (Math.PI * 0.78) / (f.reduced ? 1.15 : 1);
  const rays = count(f.energy > 0.55 ? 20 : 13, f.quality, f.reduced);
  // Un pas tous les deux temps forts : l'éventail se réoriente sur la musique,
  // la dérive continue n'étant plus qu'un très léger fond.
  const sweep = beatSwing(f, view, f.reduced ? 0.4 : 0.62, 2) + f.t * (f.reduced ? 0.02 : 0.04);
  const widthBase = Math.min(w, h) * 0.055 * (0.45 + f.bass * 0.9);
  const length = Math.hypot(w, h) * 0.95;

  ctx.lineJoin = "round";
  for (let i = 0; i < rays; i += 1) {
    const ratio = rays === 1 ? 0.5 : i / (rays - 1);
    const wobble = Math.sin(f.t * (0.7 + hash01(i * 31 + f.seed) * 0.9) + i * 1.7) * 0.05;
    const angle = -Math.PI / 2 + (ratio - 0.5) * spread + sweep + wobble;
    const hue = i % 2 === 1 ? f.palette.accent : f.palette.hue + (ratio - 0.5) * f.palette.spread;
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
    });
  }

  // Halo au point de fuite, piloté par les basses.
  const haloRadius = Math.min(w, h) * (0.16 + f.bass * 0.4 + f.beat * 0.08);
  const halo = ctx.createRadialGradient(originX, originY, 0, originX, originY, Math.max(haloRadius, 1));
  halo.addColorStop(0, paint(f.palette.hue, 0.9, 0.72, (0.16 + 0.34 * f.bass) * f.alpha));
  halo.addColorStop(1, paint(f.palette.hue, 0.9, 0.6, 0));
  ctx.fillStyle = halo;
  ctx.fillRect(0, originY - haloRadius, w, haloRadius * 1.2);
};

/* -------------------------------------------------------------------- tunnel */

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
    const hue = f.palette.hue + depth * f.palette.spread * 0.6;
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
    const alpha = (0.05 + 0.2 * f.mid) * f.alpha;
    const gradient = ctx.createLinearGradient(
      cx,
      cy,
      cx + Math.cos(angle) * maxRadius,
      cy + Math.sin(angle) * maxRadius,
    );
    gradient.addColorStop(0, paint(f.palette.hue, 0.9, 0.7, alpha));
    gradient.addColorStop(1, paint(f.palette.hue, 0.9, 0.6, 0));
    ctx.strokeStyle = gradient;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(angle) * maxRadius, cy + Math.sin(angle) * maxRadius);
    ctx.stroke();
  }
};

/* ---------------------------------------------------------------- particules */

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
    const hue = f.palette.hue + seedA * f.palette.spread;
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
    ctx.strokeStyle = paint(shiftHue(f.palette.hue, f.palette.spread * 0.5), 0.7, 0.78, alpha);
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
  }
};

/* -------------------------------------------------------------------- vagues */

const waves: FamilyDraw = (ctx, f) => {
  const { width: w, height: h } = f;
  const lines = count(6, f.quality, f.reduced);
  const speed = f.reduced ? 0.25 : 0.7;

  for (let i = 0; i < lines; i += 1) {
    const ratio = lines === 1 ? 0.5 : i / (lines - 1);
    const baseY = h * mix(0.78, 0.3, ratio) + Math.sin(f.t * 0.35 + i) * h * 0.015;
    const amp = h * (0.018 + 0.07 * f.mid + 0.05 * f.bass) * (0.5 + ratio);
    const hue = f.palette.hue + ratio * f.palette.spread * 0.8;
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

/* -------------------------------------------------------------------- grille */

const grid: FamilyDraw = (ctx, f) => {
  const { width: w, height: h } = f;
  const horizon = h * 0.62;
  const columns = count(15, f.quality, f.reduced);
  const speed = f.reduced ? 0.12 : 0.35;
  const depthLines = count(14, f.quality, f.reduced);
  const hue = f.palette.hue;

  ctx.lineWidth = 1.1;
  for (let i = 0; i < columns; i += 1) {
    const ratio = columns === 1 ? 0.5 : i / (columns - 1);
    const x = (ratio - 0.5) * 2;
    const alpha = (0.05 + 0.18 * f.energy) * f.alpha * (1 - Math.abs(x) * 0.35);
    ctx.strokeStyle = paint(shiftHue(hue, f.palette.spread * 0.3), f.palette.saturation, f.palette.lightness, alpha);
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
    ctx.strokeStyle = paint(shiftHue(hue, -f.palette.spread * 0.2), f.palette.saturation, f.palette.lightness, alpha);
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
  horizonGlow.addColorStop(1, paint(shiftHue(hue, f.palette.spread), 0.9, 0.6, 0));
  ctx.fillStyle = horizonGlow;
  ctx.fillRect(0, horizon - h * 0.08, w, h * 0.13);
};

/* ------------------------------------------------------------------- anneaux */

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
    ctx.strokeStyle = paint(f.palette.hue + i * 12, f.palette.saturation, f.palette.lightness, alpha);
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
    ctx.strokeStyle = paint(shiftHue(f.palette.hue, f.palette.spread * phase), f.palette.saturation, 0.68, alpha);
    ctx.lineWidth = 1 + 3 * f.beat * f.bass;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
  }
};

/* -------------------------------------------------------------------- volets */

const shutters: FamilyDraw = (ctx, f) => {
  const { width: w, height: h } = f;
  const slats = count(16, f.quality, f.reduced);
  const gap = w / slats;
  const speed = f.reduced ? 0.35 : 1.1;
  const baseY = h * 0.5;

  for (let i = 0; i < slats; i += 1) {
    const ratio = slats === 1 ? 0.5 : i / (slats - 1);
    const phase = f.t * speed * (0.6 + hash01(i * 71 + f.seed) * 0.8) + i * 0.7;
    const open = 0.5 + 0.5 * Math.sin(phase);
    const height = h * (0.06 + 0.5 * open) * (0.4 + f.energy * 1.2) + f.beat * h * 0.06;
    const hue = i % 2 === 1 ? f.palette.accent : f.palette.hue + (ratio - 0.5) * f.palette.spread;
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

/* --------------------------------------------------------------------- barres */

const bars: FamilyDraw = (ctx, f) => {
  const { width: w, height: h } = f;
  const columns = count(28, f.quality, f.reduced);
  const gap = w / columns;
  const floor = h * 0.88;

  for (let i = 0; i < columns; i += 1) {
    const ratio = columns === 1 ? 0.5 : i / (columns - 1);
    const band = hash01(i * 911 + f.seed);
    const level =
      0.12 +
      0.6 * (band < 0.33 ? f.bass : band < 0.72 ? f.mid : f.high) *
        (0.4 + 0.6 * Math.abs(Math.sin(f.t * (0.8 + band) * (f.reduced ? 0.4 : 1.2) + i * 0.5)));
    const height = (h * 0.5) * level * (0.4 + f.energy);
    const hue = i % 2 === 1 ? f.palette.accent : f.palette.hue + (ratio - 0.5) * f.palette.spread;
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

/* -------------------------------------------------------------------- spirale */

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
    const hue = f.palette.hue + (arm / arms) * f.palette.spread;
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

/* ---------------------------------------------------------------- projecteurs */

const spotOrigin = (i: number, w: number, h: number, seed: number) => {
  // Les projecteurs peuvent venir des quatre bords, coins compris : un show
  // n'éclaire pas que depuis le sol.
  const roll = hash01(i * 8191 + seed);
  if (roll < 0.34) {
    const x = w * (0.08 + hash01(i * 337 + seed) * 0.84);
    return { x, y: h };
  }
  if (roll < 0.67) {
    const x = w * (0.08 + hash01(i * 421 + seed) * 0.84);
    return { x, y: 0 };
  }
  if (roll < 0.85) {
    return { x: 0, y: h * (0.08 + hash01(i * 523 + seed) * 0.84) };
  }
  return { x: w, y: h * (0.08 + hash01(i * 677 + seed) * 0.84) };
};

const spots: FamilyDraw = (ctx, f, view) => {
  const { width: w, height: h } = f;
  const lamps = count(7, f.quality, f.reduced);
  const length = Math.hypot(w, h) * 1.15;
  const sweep = f.reduced ? 0.22 : 0.5;
  const cx = w * 0.5;
  const cy = h * 0.5;

  for (let i = 0; i < lamps; i += 1) {
    const origin = spotOrigin(i, w, h, f.seed);
    // Chaque lampe a son propre décalage : la salle n'est jamais éclairée
    // d'un seul mouvement, mais tout le monde reste sur le tempo.
    const drift = beatSwing(f, view, sweep, i % 3 === 0 ? 2 : 1, i * 0.31);
    const aimX = cx + (hash01(i * 733 + f.seed) - 0.5) * w * 0.9 + drift * w * 0.35;
    const aimY = cy + (hash01(i * 887 + f.seed) - 0.5) * h * 0.9 + drift * h * 0.2;
    const angle = Math.atan2(aimY - origin.y, aimX - origin.x);
    const aperture = (f.reduced ? 0.03 : 0.062) * (0.7 + f.energy * 0.9 + f.beat * 0.4);
    // Une lampe sur deux part sur la complémentaire : les projecteurs n'ont pas
    // à être tous de la même couleur, c'est ce qui donne du relief à la scène.
    const hue = i % 2 === 1 ? f.palette.accent : f.palette.hue + (i / lamps) * f.palette.spread;
    // Les projecteurs ne restent pas tous allumés : chacun a son cycle, donc la
    // salle change de visage sans qu'aucun ne s'éteigne d'un coup.
    const allumage = elementEnvelope(f, view, i * 3 + 1, f.energy > 0.55 ? 12 : 22, 0.8);
    if (allumage <= 0.01) continue;
    const alpha = (0.06 + 0.28 * f.energy + 0.18 * f.beat) * f.alpha * allumage;

    softBeam(ctx, {
      x: origin.x,
      y: origin.y,
      angle,
      length,
      width: Math.tan(aperture) * length,
      hue,
      saturation: 0.85,
      lightness: 0.72,
      alpha,
      quality: f.quality,
      reduced: f.reduced,
      footRatio: 0.04,
      tailHue: shiftHue(hue, 24),
    });

    // Lampe elle-même : un point lumineux sur son bord.
    ctx.fillStyle = paint(hue, 0.9, 0.82, alpha * 1.5);
    ctx.beginPath();
    ctx.arc(origin.x, origin.y, 3 + f.beat * 8, 0, Math.PI * 2);
    ctx.fill();
  }
};

/* ------------------------------------------------------ faisceaux en miroir */

/**
 * Faisceaux miroirs : des paires de projecteurs parfaitement symétriques de
 * part et d'autre de l'axe vertical. Chaque lampe a sa jumelle exactement en
 * face, au même instant, à la même hauteur — et les deux visent leur reflet.
 *
 * C'est le seul effet du spectacle où deux faisceaux se répondent, donc le
 * seul qui donne l'impression d'un vrai show réglé à la main. Les ouvertures
 * sont volontairement étroites : un faisceau long et net se lit beaucoup mieux
 * de loin qu'un large pâté de lumière.
 */
const mirror: FamilyDraw = (ctx, f, view) => {
  const { width: w, height: h } = f;
  const pairs = count(8, f.quality, f.reduced);
  const cx = w * 0.5;
  const cy = h * 0.5;
  // La portée dépasse largement l'écran : le faisceau doit traverser la scène
  // sans s'arrêter au bord.
  const reach = Math.hypot(w, h) * 1.35;

  for (let i = 0; i < pairs; i += 1) {
    const ratio = pairs === 1 ? 0.5 : i / (pairs - 1);
    const row = hash01(i * 711 + f.seed);
    const originY = h * (0.1 + row * 0.8);
    const aimY = cy + (hash01(i * 911 + f.seed) - 0.5) * h * 0.62;
    // Un décalage entre deux lampes voisines : les paires ne balayent jamais
    // toutes dans le même sens, le motif respire — mais sur le tempo.
    const swing = beatSwing(f, view, 0.8, 2, hash01(i * 1213 + f.seed));
    const aimX = cx + swing * w * 0.4;
    const hue = i % 2 === 1 ? f.palette.accent : f.palette.hue + (ratio - 0.5) * f.palette.spread;
    const alpha = (0.05 + 0.26 * f.energy + 0.14 * f.beat) * f.alpha;
    if (alpha <= 0.002) continue;
    const aperture = (0.013 + hash01(i * 1367 + f.seed) * 0.018) * (0.7 + f.bass * 0.7 + f.beat * 0.3);

    for (const side of [-1, 1] as const) {
      const originX = side < 0 ? 0 : w;
      // Reflet du point visé par rapport au centre : c'est tout le secret de
      // la symétrie, et elle tient même quand le point se déplace.
      const targetX = side < 0 ? aimX : w - aimX;
      const angle = Math.atan2(aimY - originY, targetX - originX);
      const range = reach * (0.8 + hash01(i * 1517 + f.seed) * 0.5);
      softBeam(ctx, {
        x: originX,
        y: originY,
        angle,
        length: range,
        width: Math.tan(aperture) * range,
        hue,
        saturation: 0.9,
        lightness: 0.76,
        alpha,
        quality: f.quality,
      reduced: f.reduced,
        footRatio: 0.03,
        tailHue: shiftHue(hue, 14),
      });

      ctx.fillStyle = paint(hue, 0.92, 0.82, alpha * 1.4);
      ctx.beginPath();
      ctx.arc(originX, originY, 3 + f.beat * 7, 0, Math.PI * 2);
      ctx.fill();
    }
  }
};

/* --------------------------------------------------------- mur de projecteurs */

/**
 * Rangée de projecteurs alignée sur un même bord, tous parallèles, qui
 * balayent d'un seul bloc. À l'inverse de `mirror`, il n'y a pas de paire :
 * une seule direction, une seule impulsion, comme une rangée de lampes de
 * concert qui pivote ensemble sur sa structure.
 */
const parade: FamilyDraw = (ctx, f, view) => {
  const { width: w, height: h } = f;
  const lamps = count(9, f.quality, f.reduced);
  if (lamps < 1) return;
  // La rangée déborde des deux bords (voir `rowPositions`) : c'est ce qui évite
  // le trou du côté vers lequel les faisceaux se penchent.
  const positions = rowPositions(lamps, w, w * 0.14);
  const reach = Math.hypot(w, h) * 1.35;
  // Un pas tous les deux temps forts : la rangée s'incline *avec* la musique.
  const sweep = beatSwing(f, view, f.reduced ? 0.3 : 0.7, 2);
  const tilt = -Math.PI / 2 + sweep;
  const lampY = h * 0.98;
  const alpha = (0.05 + 0.24 * f.energy + 0.12 * f.beat) * f.alpha;
  if (alpha <= 0.002) return;

  for (let i = 0; i < positions.length; i += 1) {
    const ratio = positions.length === 1 ? 0.5 : i / (positions.length - 1);
    // Léger décalage par lampe : la rangée reste parallèle sans être rigide.
    const angle = tilt + (hash01(i * 311 + f.seed) - 0.5) * 0.07;
    const hue = i % 2 === 1 ? f.palette.accent : f.palette.hue + (ratio - 0.5) * f.palette.spread;
    const aperture = (0.02 + hash01(i * 433 + f.seed) * 0.014) * (0.7 + f.bass * 0.8 + f.beat * 0.25);
    const range = reach * (0.75 + hash01(i * 557 + f.seed) * 0.6);
    const originX = positions[i] ?? 0;
    softBeam(ctx, {
      x: originX,
      y: lampY,
      angle,
      length: range,
      width: Math.tan(aperture) * range,
      hue,
      saturation: 0.88,
      lightness: 0.74,
      alpha,
      quality: f.quality,
      reduced: f.reduced,
      footRatio: 0.04,
    });

    ctx.fillStyle = paint(hue, 0.9, 0.8, alpha * 1.3);
    ctx.beginPath();
    ctx.arc(originX, lampY, 3 + f.beat * 6, 0, Math.PI * 2);
    ctx.fill();
  }
};

/* ------------------------------------------------------------ tirs croisés */

/**
 * Tirs croisés : un projecteur par coin, quatre faisceaux longs et fins qui
 * se croisent au milieu de l'écran. Chaque lampe visant le centre, la figure
 * reste une étoile quelle que soit la taille de l'écran ; la respiration
 * lente élarg puis resserre l'écart, ce qui donne un effet de « ouverture de
 * porte » sans jamais cesser de converger.
 */
const crossfire: FamilyDraw = (ctx, f, view) => {
  const { width: w, height: h } = f;
  const cx = w * 0.5;
  const cy = h * 0.5;
  const reach = Math.hypot(w, h) * 1.45;
  const breath = beatSwing(f, view, f.reduced ? 0.12 : 0.34, 2);
  const alpha = (0.06 + 0.3 * f.energy + 0.16 * f.beat) * f.alpha;
  if (alpha <= 0.002) return;

  for (let corner = 0; corner < 4; corner += 1) {
    const originX = corner === 0 || corner === 3 ? 0 : w;
    const originY = corner < 2 ? 0 : h;
    // Angle vers le centre, décalé d'un quart de tour par coin : les quatre
    // tirs restent écartés de 90° et se croisent tous au même point.
    const base = Math.atan2(cy - originY, cx - originX);
    const angle = base + breath;
    const hue = corner % 2 === 1 ? f.palette.accent : f.palette.hue + (corner / 4) * f.palette.spread;
    const aperture = (0.014 + 0.012 * hash01(corner * 97 + f.seed)) * (0.7 + f.energy * 0.8 + f.beat * 0.35);
    softBeam(ctx, {
      x: originX,
      y: originY,
      angle,
      length: reach,
      width: Math.tan(aperture) * reach,
      hue,
      saturation: 0.9,
      lightness: 0.78,
      alpha,
      quality: f.quality,
      reduced: f.reduced,
      footRatio: 0.03,
      tailHue: shiftHue(hue, 20),
    });

    ctx.fillStyle = paint(hue, 0.92, 0.84, alpha * 1.5);
    ctx.beginPath();
    ctx.arc(originX, originY, 3 + f.beat * 8, 0, Math.PI * 2);
    ctx.fill();
  }
};

/**
 * Grand wash de projecteurs : couche massive utilisée après un impact.
 * Beaucoup de faisceaux larges venant des quatre bords, qui balayent tout
 * l'écran. C'est l'effet « salle entière qui s'allume ».
 */
export function drawWash(ctx: CanvasRenderingContext2D, f: FrameState): void {
  const { width: w, height: h } = f;
  const lamps = count(16, f.quality, f.reduced);
  const length = Math.hypot(w, h) * 1.35;
  const sweep = 0.42;
  const alpha = (0.13 + 0.12 * f.energy + 0.04 * f.beat) * f.alpha;

  for (let i = 0; i < lamps; i += 1) {
    const origin = spotOrigin(i * 3 + 1, w, h, f.seed + 17);
    const phase = f.t * (0.22 + hash01(i * 1291 + f.seed) * 0.35) + i * 1.9;
    const target = i % 2 === 0
      ? { x: w * (0.1 + hash01(i * 1543 + f.seed) * 0.8), y: h * 0.5 }
      : { x: w * 0.5, y: h * (0.1 + hash01(i * 1777 + f.seed) * 0.8) };
    const angle = Math.atan2(target.y - origin.y, target.x - origin.x) + Math.sin(phase) * sweep;
    // Ouverture et portée varient d'une lampe à l'autre : sans ça, tous les
    // faisceaux se ressemblent et le wash ressemble à un éventail régulier.
    const width = 0.04 + hash01(i * 1979 + f.seed) * 0.05;
    const range = length * (0.75 + hash01(i * 2267 + f.seed) * 0.7);
    const aperture = width * (0.8 + f.energy * 0.5 + f.beat * 0.45);
    const hue = f.palette.hue + (i / lamps) * f.palette.spread;

    softBeam(ctx, {
      x: origin.x,
      y: origin.y,
      angle,
      length: range,
      width: Math.tan(aperture) * range,
      hue,
      saturation: 0.85,
      lightness: 0.74,
      alpha,
      // Le wash couvre tout l'écran : on se contente du repli à deux couches,
      // pour ne pas payer seize flous pleine taille à chaque impact.
      quality: f.quality,
      reduced: f.reduced,
      layers: f.reduced ? 1 : 2,
      footRatio: 0.05,
      tailHue: shiftHue(hue, 16),
    });
  }
};

/**
 * Noyau lumineux commun à toutes les familles : sans lui, les familles
 * concentriques laissent un trou sombre au centre et le spectacle paraît vide.
 * Il pulse sur les basses et les temps forts.
 */
export function drawCoreGlow(ctx: CanvasRenderingContext2D, f: FrameState): void {
  const { width: w, height: h } = f;
  const cx = w * 0.5;
  const cy = h * 0.5;
  const radius = Math.max(Math.min(w, h) * (0.16 + f.bass * 0.42 + f.beat * 0.14), 1);
  const alpha = (0.05 + 0.17 * f.bass + 0.09 * f.beat) * f.alpha;
  if (alpha <= 0.003) return;
  const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
  gradient.addColorStop(0, paint(f.palette.hue, 0.72, 0.72, alpha));
  gradient.addColorStop(0.35, paint(f.palette.hue, 0.8, 0.6, alpha * 0.4));
  gradient.addColorStop(1, paint(f.palette.hue, 0.8, 0.5, 0));
  ctx.fillStyle = gradient;
  // Cadre du dégradé seulement : le halo est nul au-delà de `radius`, remplir
  // tout l'écran ajoutait une passe additive plein écran par image.
  ctx.fillRect(Math.max(0, cx - radius), Math.max(0, cy - radius), Math.min(w, radius * 2), Math.min(h, radius * 2));
}

/* ------------------------------------------------------- rideau de faisceaux */

/**
 * Positions d'une rangée de projecteurs le long d'un bord.
 *
 * La rangée **déborde des deux côtés** : une rangée arrêtée aux bords laisse un
 * trou du côté vers lequel les faisceaux se penchent, puisque la lumière
 * inclinée quitte la zone couverte par les lampes. C'est le défaut que
 * `rowPositions` corrige une fois pour toutes.
 */
export function rowPositions(count: number, width: number, margin: number): number[] {
  if (count < 1) return [];
  if (count === 1) return [width * 0.5];
  const step = (width + margin * 2) / (count - 1);
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) out.push(-margin + step * i);
  return out;
}

/**
 * Rideau de lumière : des faisceaux serrés qui montent du plancher sur toute la
 * largeur, bords compris, et s'ouvrent en éventail. C'est l'effet qui remplit le
 * mieux une salle vue de loin — aucune zone ne reste sombre, même quand les
 * faisceaux s'inclinent — et il porte les moments forts sans dépendre d'un
 * mouvement de caméra.
 */
const curtain: FamilyDraw = (ctx, f, view) => {
  const { width: w, height: h } = f;
  const rangs = count(15, f.quality, f.reduced);
  const length = Math.hypot(w, h) * 1.15;
  const positions = rowPositions(rangs, w, w * 0.11);
  const balance = beatSwing(f, view, f.reduced ? 0.08 : 0.26, 4);
  const alpha = (0.05 + 0.26 * f.energy + 0.16 * f.beat) * f.alpha;
  if (alpha <= 0.002) return;

  for (let i = 0; i < positions.length; i += 1) {
    const originX = positions[i] ?? 0;
    const ratio = positions.length === 1 ? 0.5 : i / (positions.length - 1);
    const angle = -Math.PI / 2 + (ratio - 0.5) * 0.55 + balance;
    // Un faisceau sur deux part sur la complémentaire : le rideau n'est jamais
    // monochrome, et la couleur alterne régulièrement sur toute la largeur.
    const hue = i % 2 === 1 ? f.palette.accent : f.palette.hue + (ratio - 0.5) * f.palette.spread;
    // Chaque faisceau s'allume et s'éteint à son tour, sur un cycle musical :
    // la lumière « voyage » le long de la rangée au lieu de clignoter en bloc.
    const phase = elementEnvelope(f, view, i, f.energy > 0.55 ? 10 : 20, 0.85);
    if (phase <= 0.01) continue;
    const aperture = (0.01 + 0.016 * hash01(i * 271 + f.seed)) * (0.6 + phase * 0.8 + f.beat * 0.3);
    const portee = length * (0.78 + phase * 0.35);
    const intensite = alpha * phase;

    softBeam(ctx, {
      x: originX,
      y: h,
      angle,
      length: portee,
      width: portee * aperture,
      hue,
      saturation: 0.92,
      lightness: 0.78,
      alpha: intensite,
      quality: f.quality,
      reduced: f.reduced,
      footRatio: 0.03,
      tailHue: shiftHue(hue, 16),
    });

    // Le pied de chaque projecteur reste visible : c'est ce qui donne
    // l'impression d'une rangée d'appareils au sol.
    ctx.fillStyle = paint(hue, 0.95, 0.85, intensite * 1.4);
    ctx.beginPath();
    ctx.arc(originX, h, 2.5 + f.beat * 5, 0, Math.PI * 2);
    ctx.fill();
  }
};

/* ------------------------------------------------------------- rayonnement */

/**
 * Rayonnement : un tour complet de faisceaux partant du centre de l'image,
 * comme un projecteur rotatif de salle. Les faisceaux dépassent largement les
 * bords, donc le cadre est entièrement balayé quel que soit l'angle, et la
 * rotation est continue — c'est l'effet « soirée » par excellence.
 */
const burst: FamilyDraw = (ctx, f, view) => {
  const { width: w, height: h } = f;
  const cx = w * 0.5;
  const cy = h * 0.52;
  const rayons = count(18, f.quality, f.reduced);
  const reach = Math.hypot(w, h) * 1.5;
  // La tête tourne par quarts de tour sur la mesure, avec un léger glissement
  // continu : ça tourne, mais ça tourne sur la musique.
  const rotation = beatSwing(f, view, f.reduced ? 0.4 : 1.1, 4) + f.t * (f.reduced ? 0.02 : 0.05);
  const alpha = (0.045 + 0.24 * f.energy + 0.15 * f.beat) * f.alpha;
  if (alpha <= 0.002) return;

  for (let i = 0; i < rayons; i += 1) {
    const ratio = i / rayons;
    const angle = rotation + ratio * Math.PI * 2;
    // Deux teintes opposées : la moitié des rayons prend la couleur
    // complémentaire, ce qui casse l'uniformité et remplit mieux la salle.
    const complementaire = i % 2 === 1;
    const hue = complementaire
      ? f.palette.hue + 180 + (ratio - 0.5) * 40
      : f.palette.hue + (ratio - 0.5) * f.palette.spread;
    const aperture = (0.012 + 0.02 * hash01(i * 613 + f.seed)) * (0.7 + f.energy * 0.9 + f.beat * 0.4);
    const portee = reach * (0.7 + 0.3 * hash01(i * 719 + f.seed));
    const intensite = alpha * (complementaire ? 0.72 : 1);

    softBeam(ctx, {
      x: cx,
      y: cy,
      angle,
      length: portee,
      width: portee * aperture,
      hue,
      saturation: 0.9,
      lightness: 0.8,
      alpha: intensite,
      quality: f.quality,
      reduced: f.reduced,
      footRatio: 0.03,
    });
  }

  // Le moyeu : la source, toujours au centre, qui respire avec les basses.
  const moyeu = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(Math.min(w, h) * (0.08 + f.bass * 0.16), 1));
  moyeu.addColorStop(0, paint(f.palette.hue, 0.9, 0.86, (0.2 + 0.3 * f.bass) * f.alpha));
  moyeu.addColorStop(1, paint(f.palette.hue, 0.9, 0.6, 0));
  ctx.fillStyle = moyeu;
  ctx.fillRect(0, 0, w, h);
};

/* ------------------------------------------------------------ formes projetées */

/** Formes projetées par les gobos : cercle, anneau, losange, triangle. */
const GOBOS = ["cercle", "anneau", "losange", "triangle"] as const;

/**
 * Dessine une forme projetée.
 *
 * Les sommets sont calculés à la main plutôt qu'avec `rotate` : le rendu reste
 * une fonction pure des coordonnées, testable sans contexte graphique complet.
 */
function drewGobo(
  ctx: CanvasRenderingContext2D,
  forme: number,
  x: number,
  y: number,
  rayon: number,
  rotation: number,
  hue: number,
  saturation: number,
  alpha: number,
): void {
  const centre = ctx.createRadialGradient(x, y, 0, x, y, Math.max(rayon, 1));
  centre.addColorStop(0, paint(hue, saturation, 0.78, alpha));
  centre.addColorStop(1, paint(hue, saturation, 0.6, 0));

  if (forme === 0) {
    // Cercle plein : la tache de lumière la plus simple, et la plus lisible.
    ctx.fillStyle = centre;
    ctx.beginPath();
    ctx.arc(x, y, rayon, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  const sommets = forme === 1 ? 0 : forme === 2 ? 4 : 3;
  if (sommets === 0) {
    // Anneau : deux cercles, le second en creux. Un anneau large se lit de loin.
    ctx.fillStyle = centre;
    ctx.beginPath();
    ctx.arc(x, y, rayon, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    ctx.arc(x, y, rayon * 0.62, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "lighter";
    return;
  }

  ctx.fillStyle = centre;
  ctx.beginPath();
  for (let i = 0; i < sommets; i += 1) {
    const angle = rotation + (i / sommets) * Math.PI * 2;
    const px = x + Math.cos(angle) * rayon;
    const py = y + Math.sin(angle) * rayon;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
}

/**
 * Gobos : des formes projetées sur le mur, réparties sur tout le cadre.
 *
 * Chaque forme s'allume et s'éteint à son tour (`elementEnvelope`), tourne
 * lentement, et une sur deux prend la complémentaire. C'est l'effet « boîte de
 * nuit » : beaucoup de petits motifs qui vivent indépendamment, sans jamais
 * apparaître ni disparaître d'un coup.
 */
const gobos: FamilyDraw = (ctx, f, view) => {
  const { width: w, height: h } = f;
  const formes = count(f.energy > 0.55 ? 14 : 9, f.quality, f.reduced);
  const rayon = Math.min(w, h) * (0.07 + f.energy * 0.05 + f.beat * 0.02);
  const cycle = f.reduced ? 28 : f.energy > 0.55 ? 9 : 20;

  for (let i = 0; i < formes; i += 1) {
    const enveloppe = elementEnvelope(f, view, i, cycle, 0.55);
    if (enveloppe <= 0.01) continue;
    // Répartition sur tout le cadre, bords compris : aucune zone ne reste vide.
    const x = w * (0.06 + hash01(i * 1709 + f.seed) * 0.88);
    const y = h * (0.1 + hash01(i * 2017 + f.seed) * 0.8);
    const taille = rayon * (0.6 + hash01(i * 3001 + f.seed) * 0.7);
    const sens = i % 2 === 0 ? 1 : -1;
    const rotation = f.t * (0.08 + hash01(i * 2311 + f.seed) * 0.2) * sens;
    const hue = i % 2 === 1 ? f.palette.accent : f.palette.hue + (hash01(i * 2711 + f.seed) - 0.5) * f.palette.spread;
    const alpha = enveloppe * (0.08 + 0.3 * f.energy + 0.16 * f.beat) * f.alpha;
    if (alpha <= 0.004) continue;
    drewGobo(
      ctx,
      i % GOBOS.length,
      x,
      y,
      taille,
      rotation,
      hue,
      Math.min(1, f.palette.saturation + 0.06),
      alpha,
    );
  }
};

const FAMILIES: Record<FamilyId, FamilyDraw> = {
  beams,
  tunnel,
  particles,
  waves,
  grid,
  rings,
  shutters,
  bars,
  spiral,
  spots,
  mirror,
  parade,
  crossfire,
  curtain,
  burst,
  gobos,
};

export function drawFamily(
  ctx: CanvasRenderingContext2D,
  f: FrameState,
  view: TrackView,
  family: FamilyId,
): void {
  FAMILIES[family](ctx, f, view);
}
