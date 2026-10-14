import type { RenderSettings } from "../types";
import { clamp01, hash01, mix, quantizeQuality, smoothstep } from "./series";
import { drawCoreGlow, drawFamily, drawWash } from "./families";
import type { FrameState } from "./families";
import type { Palette, Scene } from "./show";
import { hslToRgb, shiftHue, shorthand } from "./color";
import { sceneAt, sceneWeight, type ShowPlan } from "./show";
import type { TrackView } from "./view";
import { type LiveAudioFeatures } from "./liveAudio";

export interface RenderInput {
  ctx: CanvasRenderingContext2D;
  /** Dimensions en pixels CSS. */
  width: number;
  height: number;
  /** Rapport de pixels de l'appareil. */
  dpr: number;
  /** Position de lecture musicale, en secondes. */
  time: number;
  view: TrackView;
  plan: ShowPlan;
  settings: RenderSettings;
  /** `prefers-reduced-motion` du système. */
  reducedMotion: boolean;
  /** Qualité adaptative 0..1. */
  quality: number;
  /** Numéro d'image. */
  frame: number;
  /** Caractéristiques audio live optionnelles, pour le mode réactif. */
  liveAudio?: LiveAudioFeatures;
}

export type { FrameState };

/** Plafond d'opacité d'un flash : évite les sauts de luminosité agressifs. */
export const FLASH_CEILING = 0.4;
/**
 * Deux flashs de temps fort sont toujours séparés d'au moins cette durée.
 *
 * La modération compte autant que l'effet : à 130 BPM, des temps forts toutes
 * les 0,46 s donneraient plus de deux flashs par seconde, et une salle qui
 * martèle finit par fatiguer. Un drop de montée garde sa priorité.
 */
const FLASH_MIN_GAP = 1.6;
/** Un flash ne naît que dans cette fenêtre après son évènement déclencheur. */
const FLASH_ATTACK_SEC = 0.12;
/** Glissement continu de la teinte, en degrés par seconde. */
export const HUE_DRIFT_PER_SEC = 14;
/** Teintes fortement écartées juste après un impact. */
const DROP_HUE_JUMP = 70;
/** Saut de teinte quand la variation d'une phrase surgit. */
const VARIATION_HUE_JUMP = 85;
/** Durée du grand wash de projecteurs après un impact, en secondes. */
const WASH_SPAN_SEC = 4.5;

function paint(h: number, s: number, l: number, a: number): string {
  return shorthand(hslToRgb({ h, s, l }), a);
}

function drawBackground(ctx: CanvasRenderingContext2D, f: FrameState): void {
  const { width: w, height: h } = f;
  const glow = 0.02 + f.energy * 0.05 + f.bass * 0.05;
  const top = paint(f.palette.hue, f.palette.saturation, 0.035 + glow * 0.5, 1);
  const bottom = paint(shiftHue(f.palette.hue, f.palette.spread * 0.4), f.palette.saturation, 0.05 + glow, 1);
  const gradient = ctx.createLinearGradient(0, 0, 0, h);
  gradient.addColorStop(0, top);
  gradient.addColorStop(1, bottom);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);

  // Lueur centrale très douce, liée à l'énergie.
  const cx = w * 0.5;
  const cy = h * 0.55;
  const radius = Math.hypot(w, h) * (0.35 + f.energy * 0.15);
  const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(radius, 1));
  const haloAlpha = (0.03 + 0.08 * f.energy + 0.06 * f.beat) * f.alpha;
  halo.addColorStop(0, paint(f.palette.hue, 0.85, 0.6, haloAlpha));
  halo.addColorStop(1, paint(f.palette.hue, 0.85, 0.5, 0));
  ctx.fillStyle = halo;
  // Le dégradé est transparent au-delà de `radius` : on ne remplit que son
  // cadre, jamais tout l'écran. Une passe plein écran de plus par image est
  // exactement ce qui fait ramer le compositing.
  const span = Math.min(radius, Math.max(w, h));
  ctx.fillRect(Math.max(0, cx - span), Math.max(0, cy - span), Math.min(w, span * 2), Math.min(h, span * 2));
}

function drawDust(ctx: CanvasRenderingContext2D, f: FrameState): void {
  const { width: w, height: h } = f;
  const base = f.reduced ? 26 : 64;
  const count = Math.max(8, Math.round(base * (0.4 + 0.6 * f.quality)));
  const drift = f.reduced ? 0.012 : 0.035;
  ctx.fillStyle = "#ffffff";
  for (let i = 0; i < count; i += 1) {
    const sx = hash01(i * 1531 + f.seed);
    const sy = hash01(i * 2749 + f.seed);
    const sp = 0.4 + hash01(i * 3301 + f.seed) * 1.6;
    const x = (((sx + f.t * drift * sp) % 1) + 1) % 1;
    const y = (((sy - f.t * drift * 0.6 * sp) % 1) + 1) % 1;
    const size = 0.6 + hash01(i * 4093 + f.seed) * 1.7;
    const alpha = (0.05 + 0.16 * f.energy) * f.alpha * (0.4 + sy * 0.6);
    ctx.globalAlpha = clamp01(alpha);
    ctx.beginPath();
    ctx.arc(x * w, y * h, size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/**
 * Opacité du flash global. Volontairement plafonnée et espacée : le spectacle
 * ne clignote jamais à haute fréquence, et le mode réduit l'annule.
 */
export function flashAlpha(f: FrameState, settings: RenderSettings): number {
  if (f.reduced) return 0;
  const budget = settings.flashes;
  if (budget <= 0) return 0;
  const beatHit = f.beat * (0.35 + 0.65 * f.bass);
  const dropHit = f.build > 0.92 ? f.buildStrength * 0.9 : 0;
  const raw = Math.max(beatHit, dropHit);
  if (raw < 0.3) return 0;
  const gated = raw * smoothstep(0.12, 0.4, f.energy);
  return Math.min(gated, 1) * FLASH_CEILING * Math.min(budget, 1.5);
}

/**
 * Nombre de montées en dessous duquel le morceau est jugé insuffisamment
 * dynamique : les drops ne suffisent alors plus à porter le spectacle.
 */
const BEAT_DRIVE_MAX_BUILDS = 2;

/** Part d'un vrai drop que prend une impulsion de temps fort. */
const BEAT_DRIVE_WEIGHT = 0.6;

/**
 * Force de l'évènement musical à l'instant `t` : 0 quand rien ne se passe, 1 sur
 * un kick franc dans un passage soutenu.
 *
 * Un temps fort ne compte que s'il porte des **basses** (30-150 Hz, la bande du
 * kick) : sinon c'est une charley, un temps mort ou une pédale, et le show n'a
 * rien à célébrer. C'est ce qui aligne les pulses sur la musique au lieu de les
 * multiplier — sur un morceau clair là où ça compte, muet là où la musique ne
 * demande rien.
 */
export function beatStrength(view: TrackView, t: number): number {
  const pulse = view.beatPulse(t, 0.45);
  if (pulse < 0.05) return 0;
  const kick = view.bassAt(t);
  if (kick < 0.12) return 0;
  const energy = view.energyAt(t);
  const sectionEnergy = clamp01(view.sectionAt(t).energy);
  return clamp01(pulse * kick * (0.35 + 0.65 * energy) * (0.55 + 0.45 * sectionEnergy));
}

/**
 * Impulsion de secours sur les temps forts.
 *
 * Un morceau fort d'un bout à l'autre — rap masterisé, electro compressée — ne
 * contient presque aucune montée, donc aucun drop : entre deux changements de
 * scène, le spectacle semble mort. Quand l'analyse trouve peu de montées, on
 * pulse alors sur les temps forts eux-mêmes, à une intensité inférieure à un
 * vrai drop pour rester honnête avec la musique.
 *
 * Retourne 0 dès que le morceau a assez de montées : les vrais drops restent
 * prioritaires, et un morceau dynamique ne voit rien changer.
 */
export function beatDrive(view: TrackView, t: number, builds: number): number {
  if (builds > BEAT_DRIVE_MAX_BUILDS) return 0;
  const pulse = view.beatPulse(t, 0.45);
  if (pulse < 0.05) return 0;
  // L'énergie locale dose l'impulsion : un temps fort sur un passage creux
  // reste discret.
  return clamp01(pulse * (0.35 + 0.65 * view.energyAt(t)));
}

/**
 * Force du wash : décroissance lente après chaque fin de montée. Le wash
 * commence avec l'impact et s'étire sur ~3 s, donc « l'impact puis la salle
 * entière qui balaie ».
 */
export function washStrength(view: TrackView, t: number, sceneCount: number): number {
  if (sceneCount === 0) return 0;
  let peak = 0;
  // Seules les montées qui viennent de finir comptent : pas besoin de balayer
  // tout le morceau à chaque image.
  for (const build of view.buildsEndingIn(t - WASH_SPAN_SEC, t + 0.2)) {
    const age = t - build.end;
    // Montée rapide, tenue, puis descente douce.
    const rise = age < 0 ? 1 + age / 0.15 : 1;
    const fall = age < 0.25 ? 1 : Math.exp(-(age - 0.25) / 2.4);
    const value = rise * fall * build.strength;
    if (value > peak) peak = value;
  }
  return clamp01(peak);
}

/**
 * Réaction aux montées d'énergie : tant que le morceau prend de l'ampleur, le
 * spectacle pulse sur les temps forts au lieu de simplement éclairer.
 * Jamais en mode réduit, toujours plafonné et toujours cadencé par le beat.
 */
export function surgeAlpha(f: FrameState, settings: RenderSettings): number {
  if (f.reduced || settings.flashes <= 0) return 0;
  const rise = smoothstep(0.4, 0.9, f.surge);
  if (rise <= 0.02 || f.beat < 0.45) return 0;
  return rise * f.beat * FLASH_CEILING * Math.min(settings.flashes, 1.5) * 0.85;
}

/**
 * Force de la variation d'une phrase : 0 au début et à la fin, 1 autour des
 * deux tiers. Fenêtre large et bords doux, donc jamais un coup de ciseaux.
 */
export function variationStrength(scene: Scene, t: number): number {
  const span = scene.end - scene.start;
  if (span <= 0.5) return 0;
  const ratio = (t - scene.start) / span;
  if (ratio < 0.25 || ratio > 0.9) return 0;
  const local = (ratio - 0.25) / 0.65;
  const wave = Math.sin(local * Math.PI);
  return Math.max(0, 0.15 + 0.85 * wave * wave);
}

/** Opacité de la couche de fond permanente. */
const BACKDROP_ALPHA = 0.3;

/**
 * Teinte réellement dessinée à l'instant `t`.
 *
 * Le glissement porte sur le temps du morceau, jamais sur le temps écoulé
 * depuis le début de la scène : en repartant de zéro à chaque changement de
 * scène, la couleur faisait un bond de plusieurs dizaines de degrés en plein
 * spectacle. Fonction partagée avec l'affichage, pour que le HUD annonce la
 * teinte qui est vraiment à l'écran.
 */
export function sceneHue(scene: Scene, t: number, drop: number, variation: number, reduced: boolean): number {
  const drift = HUE_DRIFT_PER_SEC * t * (reduced ? 0.4 : 1);
  const shift = drift + DROP_HUE_JUMP * drop + VARIATION_HUE_JUMP * variation;
  return (scene.palette.hue + shift + 360) % 360;
}

/**
 * Un flash est-il admissible à l'instant `t` ?
 *
 * Fonction pure du temps musical, donc déterministe : mêmes entrées ⇒ même
 * réponse, ce qui garde le spectacle identique après une pause ou un saut.
 *
 * Trois conditions :
 * 1. il doit naître sur l'attaque d'un évènement (pas pendant la décroissance) ;
 * 2. un impact de montée garde la priorité — il est rare, et c'est le moment que
 *    le spectacle doit montrer ;
 * 3. sinon, le temps fort doit tomber dans la cadence : un flash tous les
 *    `n` temps forts, `n` choisi pour que l'intervalle dépasse `FLASH_MIN_GAP`.
 *    À 130 BPM, un flash toutes les 0,46 s fatigue ; tous les 4 temps forts
 *    (≈ 2 s), le spectacle respire.
 */
export function flashAdmitted(view: TrackView, t: number): boolean {
  const beats = view.beatsIn(t - (FLASH_MIN_GAP + 1.0), t);
  const lastBeat = beats.length > 0 ? (beats[beats.length - 1] ?? -Infinity) : -Infinity;
  const lastDrop = view.lastBuildEnd(t);
  const current = Math.max(lastBeat, lastDrop);
  if (current === -Infinity) return false;

  const age = t - current;
  if (age < -0.02 || age > FLASH_ATTACK_SEC) return false;

  // Impact de montée : prioritaire.
  if (lastDrop >= lastBeat) return true;

  // Temps fort : cadence espacée, calée sur l'index du temps fort pour rester
  // stable quel que soit le moment où l'image est calculée.
  const period = Math.max(view.beatPeriod, 0.05);
  const every = Math.max(1, Math.ceil(FLASH_MIN_GAP / period));
  if (every <= 1) return true;
  return view.beatIndexAt(current) % every === 0;
}

/**
 * Rend une image complète du spectacle. Fonction pure du temps musical :
 * mêmes entrées ⇒ image identique, ce qui garde la synchronisation après une
 * pause, une reprise ou un déplacement dans le morceau.
 */
export function renderFrame(input: RenderInput): void {
  const { ctx, width, height, dpr, view, plan, settings, reducedMotion, frame } = input;
  const t = input.time;
  const liveAudio = input.liveAudio;
  const isLive = liveAudio !== undefined;
  const reduced = settings.reduced || reducedMotion;
  // La qualité est ramenée à un palier connu ici, et pas seulement par
  // l'appelant : c'est ce qui garantit qu'une variation de fps ne change jamais
  // le nombre d'éléments d'une image à l'autre (voir QUALITY_STEPS).
  const quality = quantizeQuality(input.quality);
  const scene = sceneAt(plan, t);
  // En mode live, `transient` est déjà une détection d'attaque réelle. En mode
  // analysé, un temps fort ne vaut que par ce qu'il porte : `beatStrength`
  // renvoie 0 sur un temps sans basse, donc le show ne pulse plus à vide.
  const beat = liveAudio !== undefined ? liveAudio.transient : beatStrength(view, t);
  const build = liveAudio !== undefined ? 0 : view.buildProgress(t);
  const buildNow = view.buildAt(t);
  // La couleur vit en permanence : elle glisse dans le temps, fait un saut net
  // à chaque impact (drop) et un autre à chaque variation de phrase, pour que
  // le morceau « change de lumière » sans cesse. Le pulsage de secours sur les
  // temps forts ne sert qu'aux morceaux sans montée, pour qu'un morceau fort
  // d'un bout à l'autre ne paraisse pas mort entre deux scènes.
  const beatDriveValue = isLive ? 0 : beatDrive(view, t, view.analysis.builds.length);
  const drop = liveAudio !== undefined ? 0 : Math.max(view.buildIntensity(t), beatDriveValue * BEAT_DRIVE_WEIGHT);
  const variation = reduced ? 0 : variationStrength(scene, t);
  const surge = liveAudio !== undefined ? liveAudio.transient : view.energyTrend(t, 1.2);
  const palette: Palette = {
    name: scene.palette.name,
    hue: sceneHue(scene, t, drop, variation, reduced),
    spread: scene.palette.spread * (0.75 + 0.5 * (0.5 + 0.5 * Math.sin(t * 0.55))),
    saturation: Math.min(1, scene.palette.saturation + drop * 0.16 + variation * 0.1),
    lightness: Math.min(0.8, scene.palette.lightness + drop * 0.12 + variation * 0.06),
  };

  const base: FrameState = {
    t,
    width,
    height,
    dpr,
    scene,
    palette,
    energy: liveAudio !== undefined ? clamp01(liveAudio.energy * 1.35 + liveAudio.transient * 0.3) : view.energyAt(t),
    bass: liveAudio !== undefined ? liveAudio.bass : view.bassAt(t),
    mid: liveAudio !== undefined ? liveAudio.mid : view.midAt(t),
    high: liveAudio !== undefined ? liveAudio.high : view.highAt(t),
    beat,
    beatPhase: view.beatPhase(t),
    beatIndex: view.beatIndexAt(t),
    build,
    buildStrength: buildNow?.strength ?? 0,
    surge,
    intensity: scene.intensity * settings.intensity * (isLive ? (1.35 + liveAudio!.energy * 0.9 + liveAudio!.transient * 0.85) : (1 + surge * 0.6 + beatDriveValue * 0.5)),
    alpha: sceneWeight(scene, t),
    reduced,
    quality,
    seed: plan.seed,
    frame,
  };

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  // Pas de `clearRect` : le contexte est opaque et `drawBackground` repeint
  // intégralement l'écran juste en dessous. Une passe plein écran économisée à
  // chaque image, c'est une écriture de framebuffer en moins sur le GPU.

  drawBackground(ctx, { ...base, palette });
  ctx.globalCompositeOperation = "lighter";

  // Scène courante + scène sortante pendant le fondu (transition fluide).
  drawFamily(ctx, base, view, scene.family);
  drawCoreGlow(ctx, base);

  // Couche de fond permanente : même pendant les phrases « calmes », l'écran
  // montre deux mondes superposés au lieu d'un seul.
  if (scene.backdrop !== scene.family) {
    const backdropState: FrameState = {
      ...base,
      palette: { ...palette, hue: (palette.hue + 130) % 360 },
      alpha: base.alpha * BACKDROP_ALPHA,
      intensity: base.intensity * 0.6,
    };
    drawFamily(ctx, backdropState, view, scene.backdrop);
  }

  // Variation au milieu de la phrase : une autre famille surgit brièvement,
  // avec sa propre teinte. C'est ce qui empêche le spectacle de tourner en boucle.
  if (variation > 0.05) {
    const variationState: FrameState = {
      ...base,
      palette: {
        ...palette,
        hue: (palette.hue + 48) % 360,
        saturation: Math.min(1, palette.saturation + 0.1),
      },
      alpha: base.alpha * variation * 0.8,
      intensity: base.intensity * (0.7 + 0.6 * variation),
    };
    drawFamily(ctx, variationState, view, scene.variant);
  }

  // Grand wash de projecteurs après un impact : il vit plus longtemps que la
  // sur-couche et couvre tout l'écran. Jamais en mode réduit.
  const wash = reduced || isLive ? 0 : washStrength(view, t, plan.scenes.length);
  if (wash > 0.02) {
    const washState: FrameState = {
      ...base,
      palette: { ...palette, hue: (palette.hue + 25) % 360 },
      alpha: base.alpha * wash,
      intensity: base.intensity,
    };
    drawWash(ctx, washState);
  }

  // Sur-couche d'impact : moments brefs et très soutenus, jamais en mode réduit.
  if (drop > 0.02 && !reduced) {
    const dropState: FrameState = {
      ...base,
      palette,
      alpha: base.alpha * Math.min(1, drop * 1.3),
      intensity: base.intensity * (1 + drop),
      buildStrength: 1,
    };
    const dropFamily = plan.seed % 2 === 0 ? "bars" : "shutters";
    drawFamily(ctx, dropState, view, dropFamily);
    const ceiling = FLASH_CEILING * Math.min(settings.flashes, 1.5);
    // Seul un vrai drop de l'analyse ouvre le lavage blanc : le pulsage de
    // secours sur les temps forts éclaire la scène, il ne blanchit pas l'écran.
    // Sinon un morceau sans montée clignoterait à chaque temps fort.
    const realDrop = isLive ? 0 : view.buildIntensity(t);
    if (ceiling > 0 && realDrop > 0.35) {
      ctx.fillStyle = `rgba(255,255,255,${Math.min(0.5, ceiling * realDrop).toFixed(3)})`;
      ctx.fillRect(0, 0, width, height);
    }
  }

  const previous = scene.index > 0 ? plan.scenes[scene.index - 1] : undefined;
  if (previous !== undefined && t < scene.start + scene.fadeIn) {
    const ratio = clamp01((t - scene.start) / Math.max(scene.fadeIn, 0.001));
    const outgoing: FrameState = {
      ...base,
      scene: previous,
      palette: previous.palette,
      alpha: (1 - ratio) * sceneWeight(previous, t),
      intensity: previous.intensity * settings.intensity,
    };
    drawFamily(ctx, outgoing, view, previous.family);
  }

  drawDust(ctx, base);

  const flash = Math.max(flashAlpha(base, settings), surgeAlpha(base, settings));
  if (flash > 0.002 && flashAdmitted(view, t)) {
    ctx.fillStyle = `rgba(255,255,255,${(flash * (0.5 + 0.5 * mix(0.7, 1, base.energy))).toFixed(3)})`;
    ctx.fillRect(0, 0, width, height);
  }

  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;

  // Vignette : garde la composition lisible même quand tout s'allume.
  // Le dégradé ne dépend que des dimensions : on le mémorise au lieu d'en
  // recréer un à chaque image.
  const vignette = vignetteFor(ctx, width, height);
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);
}

/** Vignettes déjà créées, par contexte puis par dimensions. */
const vignetteCache = new WeakMap<CanvasRenderingContext2D, Map<string, CanvasGradient>>();

function vignetteFor(ctx: CanvasRenderingContext2D, width: number, height: number): CanvasGradient {
  let bySize = vignetteCache.get(ctx);
  if (bySize === undefined) {
    bySize = new Map();
    vignetteCache.set(ctx, bySize);
  }
  const key = `${width}x${height}`;
  const cached = bySize.get(key);
  if (cached !== undefined) return cached;
  const vignette = ctx.createRadialGradient(
    width * 0.5,
    height * 0.5,
    Math.min(width, height) * 0.28,
    width * 0.5,
    height * 0.5,
    Math.hypot(width, height) * 0.62,
  );
  vignette.addColorStop(0, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,0.62)");
  bySize.set(key, vignette);
  return vignette;
}
