import type { RenderSettings } from "../types";
import { clamp01, hash01, mix, quantizeQuality, smoothstep } from "./series";
import {
  contrastHue,
  dessinerBlinders,
  dessinerGrosBlinders,
  dessinerBordure,
  dessinerLyresRave,
  dessinerStructure,
  drawCoreGlow,
  drawFamily,
  drawWash,
  hazeFineRadiusPixels,
  hazeRadiusPixels,
} from "./families";
import type { FrameState, HazeTarget } from "./families";
import type { Palette, Scene } from "./show";
import { hslToRgb, shorthand } from "./color";
import { sceneAt, sceneWeight, type ShowPlan } from "./show";
import {
  hardStrobeAllowsFull,
  hardStrobeBarsOnly,
  hardStrobeFamily,
} from "./strobe";
import type { TrackView } from "./view";
import { type LiveAudioFeatures } from "./liveAudio";
import { chorusIntensityAt, drawLyrics } from "./lyrics";
import type { LiveMusic } from "./liveDirector";

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
  /**
   * Évènements musicaux dérivés du direct (temps forts, impacts, montées).
   *
   * Sans eux, le direct ne dispose que de niveaux lissés : aucun flash n'est
   * admis, aucun impact ne déclenche de wash, et les familles battent sur une
   * grille fixe. Voir `liveDirector.ts`.
   */
  liveMusic?: LiveMusic;
  /**
   * Surface de fumée, créée et conservée par l'appelant. Sans elle, les
   * faisceaux larges retombent sur la superposition de couches : le spectacle
   * reste juste, mais perd la diffusion dans la fumée.
   */
  haze?: HazeTarget;
}

export type { FrameState };

/**
 * Plafond d'opacité d'un flash.
 *
 * L'ancien plafond de 0,4 écrasait les impacts : un drop ne se distinguait plus
 * d'un temps fort ordinaire. Il reste un plafond (jamais un blanc pur), mais il
 * laisse la place à la hiérarchie : temps fort ≈ 0,44, drop ≈ 0,72.
 */
export const FLASH_CEILING = 0.8;
/** Poids d'un temps fort ordinaire dans le flash, relativement à un drop. */
const BEAT_FLASH_WEIGHT = 0.55;
/**
 * Latence entre le déclencheur musical et la naissance du flash, en secondes.
 *
 * Nulle : un flash naît sur le temps fort ou sur l'impact, jamais après. C'est
 * une propriété mesurée (`tests/unit/render-properties.test.ts`, F1) ; ne pas la
 * confondre avec la durée de montée ci-dessous, qui dose l'attaque visible.
 */
export const FLASH_LATENCY_SEC = 0;
/**
 * Durée de montée d'un flash de temps fort, en secondes.
 *
 * Courte : un flash qui pique après le kick paraît traînant.
 */
export const FLASH_ATTACK_BEAT_SEC = 0.04;
/**
 * Durée de montée d'un flash de temps fort en profil hard, en secondes.
 *
 * Le kick d'un morceau hard est sec : une attaque de 40 ms laisse une traîne
 * perceptible. 20 ms garde le flash lisible tout en le collant à l'attaque.
 */
export const FLASH_ATTACK_BEAT_HARD_SEC = 0.02;
/**
 * Durée de montée d'un flash de drop, en secondes.
 *
 * Plus lente : l'impact est large, la montée participe au geste.
 */
export const FLASH_ATTACK_DROP_SEC = 0.12;
/**
 * Durée de montée d'un flash de drop en profil hard, en secondes.
 *
 * L'impact hard est un coup, pas un déploiement : l'attaque est plus courte,
 * et le flash retombe plus vite sur le noir.
 */
export const FLASH_ATTACK_DROP_HARD_SEC = 0.08;
/** Gain d'opacité des flashs en profil hard, pour compenser le fond plus noir. */
export const HARD_FLASH_BOOST = 1.12;
/** Gain d'opacité des flashs en profil concert. */
export const DYNAMIC_FLASH_BOOST = 1.05;
/**
 * Poids d'un temps fort dans le flash, en profil concert.
 *
 * Entre la caresse du standard (0,55) et le claquement du hard (0,9) : la salle
 * s'allume franchement, mais la scène de concert garde un peu de respiration.
 */
export const DYNAMIC_BEAT_FLASH_WEIGHT = 0.72;
/** Durée de montée d'un flash de temps fort en profil concert, en secondes. */
export const DYNAMIC_FLASH_ATTACK_BEAT_SEC = 0.03;
/** Durée de montée d'un flash de drop en profil concert, en secondes. */
export const DYNAMIC_FLASH_ATTACK_DROP_SEC = 0.1;
/**
 * Éclats du stroboscope concert par temps fort.
 *
 * Moins dense que le hard (4 à 12) mais bien plus que le standard : 2 à 6
 * éclats, sur un seuil d'énergie plus bas, pour que le strobe parte plus
 * facilement sans transformer chaque morceau en rave.
 */
export const DYNAMIC_STROBE_DIVISIONS_MIN = 2;
export const DYNAMIC_STROBE_DIVISIONS_MAX = 4;
/**
 * Lumière ajoutée à la salle pendant un refrain, en profil concert.
 *
 * Le concert garde volontairement une salle noire, tenue par les lyres. Un
 * refrain chanté mérite pourtant d'ouvrir la salle : on relève le fond et le
 * halo d'une fraction fixe, sans toucher aux projecteurs ni à la teinte.
 */
export const CHORUS_ROOM_GLOW = 0.075;
/**
 * Poids d'un temps fort dans le flash, en profil hard.
 *
 * Le flash ordinaire est dosé pour une salle de soirée : il marque le temps sans
 * blanchir l'écran. Un morceau hard vit au contraire de claquements : le temps
 * fort pèse presque le maximum autorisé par le budget de flashs.
 */
export const HARD_BEAT_FLASH_WEIGHT = 0.9;
/**
 * Nombre d'éclats du stroboscope hard par temps fort.
 *
 * Le strobe suit le temps musical au lieu d'une horloge absolue : sa phase
 * repart de zéro à chaque temps, donc aucun « strobe, pause, strobe » quand la
 * vitesse change en cours de mesure. Quatre éclats dans un passage soutenu,
 * jusqu'à douze dans un pic : à 140 BPM, cela reste entre 9 et 28 Hz, sous la
 * limite où l'œil ne voit plus qu'un papillotement continu.
 */
export const HARD_STROBE_DIVISIONS_MIN = 4;
export const HARD_STROBE_DIVISIONS_MAX = 12;

/** Éclats par temps fort, de 4 à 12 selon l'énergie et l'impact. */
export function hardStrobeDivisions(f: FrameState, drop: number): number {
  const energy = clamp01(f.energy);
  const violence = clamp01(drop);
  const extra = Math.round((HARD_STROBE_DIVISIONS_MAX - HARD_STROBE_DIVISIONS_MIN) * 0.5 * (energy + violence));
  return Math.min(
    HARD_STROBE_DIVISIONS_MAX,
    HARD_STROBE_DIVISIONS_MIN + extra,
  );
}
/**
 * Nombre de temps forts par phrase hors drop.
 *
 * Hors impact, la lumière ne clignote pas : un seul temps fort par phrase porte
 * un flash. Pendant un drop, la cadence suit la musique (un flash par temps
 * fort), comme demandé par la direction artistique.
 */
const PHRASE_BEATS = 8;
/**
 * Ancienne vitesse de dérive de teinte, conservée pour les diagnostics.
 *
 * La couleur ne dérive plus : un morceau ne possède que deux teintes, et la
 * scène joue l'une ou l'autre. La constante reste exportée pour les rapports.
 */
export const HUE_DRIFT_PER_SEC = 0.4;
/**
 * Marge de teinte historique, conservée pour les diagnostics et les tests.
 *
 * Le rendu ne dérive plus autour de l'ancre : il choisit exactement l'une des
 * deux couleurs du morceau.
 */
export const HUE_BUDGET_MARGIN_DEG = 12;

function paint(h: number, s: number, l: number, a: number): string {
  return shorthand(hslToRgb({ h, s, l }), a);
}

function drawBackground(ctx: CanvasRenderingContext2D, f: FrameState): void {
  const { width: w, height: h } = f;
  // Un refrain détecté dans les paroles ouvre la salle : en concert, le fond
  // noir reste la règle, mais le refrain gagne une lumière d'ambiance franche.
  const chorus = f.dynamic === true ? clamp01(f.chorus ?? 0) : 0;
  // Le profil hard veut un fond plus noir : c'est ce qui fait ressortir les
  // barres, les volets et les strobes au lieu de baigner l'image dans une
  // lueur de salle. Le concert va plus loin : la salle reste noire, ce sont les
  // lyres qui l'éclairent, sauf pendant un refrain chanté.
  const glow = f.hard
    ? 0.012 + f.energy * 0.032 + f.bass * 0.028
    : f.dynamic === true
      ? 0.006 + f.energy * 0.016 + f.bass * 0.014 + chorus * CHORUS_ROOM_GLOW
      : 0.02 + f.energy * 0.05 + f.bass * 0.05;
  // Le fond est bicolore : la teinte dominante en haut, la teinte de contraste
  // de l'accord en bas. C'est lui qui donnait son uniformité à toute l'image.
  const contraste = contrastHue(f);
  const top = paint(
    f.palette.hue,
    f.palette.saturation,
    (f.hard ? 0.018 : f.dynamic === true ? 0.012 : 0.035) + glow * 0.5,
    1,
  );
  const bottom = paint(
    contraste,
    f.palette.saturation,
    (f.hard ? 0.026 : f.dynamic === true ? 0.018 : 0.05) + glow,
    1,
  );
  const gradient = ctx.createLinearGradient(0, 0, 0, h);
  gradient.addColorStop(0, top);
  gradient.addColorStop(1, bottom);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);

  // Lueur centrale très douce, liée à l'énergie.
  const cx = w * 0.5;
  const cy = h * 0.55;
  const radius = Math.hypot(w, h) * (0.35 + f.energy * 0.15 + chorus * 0.06);
  const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(radius, 1));
  const haloAlpha =
    (0.03 + 0.08 * f.energy + 0.06 * f.beat) *
    f.alpha *
    (f.hard ? 0.65 : f.dynamic === true ? 0.4 + 0.5 * chorus : 1);
  halo.addColorStop(0, paint(contraste, 0.85, 0.6, haloAlpha));
  halo.addColorStop(1, paint(contraste, 0.85, 0.5, 0));
  ctx.fillStyle = halo;
  // Le dégradé est transparent au-delà de `radius` : on ne remplit que son
  // cadre, jamais tout l'écran. Une passe plein écran de plus par image est
  // exactement ce qui fait ramer le compositing.
  const span = Math.min(radius, Math.max(w, h));
  ctx.fillRect(Math.max(0, cx - span), Math.max(0, cy - span), Math.min(w, span * 2), Math.min(h, span * 2));
}

/** Bloc de scènes calmes contiguës : le voile ne doit pas clignoter entre elles. */
interface CalmBlock {
  start: number;
  end: number;
  glow: number;
  fadeSec: number;
  riseSec: number;
}

function calmBlockFor(plan: ShowPlan, scene: Scene): CalmBlock | null {
  if (scene.mood !== "calme" || (scene.calmGlow ?? 0) <= 0) return null;
  let first = scene.index;
  while (first > 0 && plan.scenes[first - 1]?.mood === "calme") first -= 1;
  let last = scene.index;
  while (last + 1 < plan.scenes.length && plan.scenes[last + 1]?.mood === "calme") last += 1;
  const firstScene = plan.scenes[first] ?? scene;
  const lastScene = plan.scenes[last] ?? scene;
  return {
    start: firstScene.start,
    end: lastScene.end,
    glow: scene.calmGlow ?? 0,
    fadeSec: Math.max(0.1, scene.calmFadeSec ?? 2),
    riseSec: Math.max(0.1, scene.calmRiseSec ?? 2),
  };
}

/**
 * Voile de calme lumineux.
 *
 * Le fond de scène est volontairement sombre (il porte les impacts) : sans ce
 * voile, un passage calme tombe sous 0,10 de luminance moyenne et devient un
 * « noir de tension ». Le voile est une nappe pastel pleine image, dont
 * l'intensité vient de `scene.calmGlow` (paramètre fourni par `show.ts`).
 *
 * Fonction pure du temps musical : deux rendus au même instant donnent les
 * mêmes pixels. Le voile s'éteint sur 0,1 s à la fin du bloc calme pour que
 * l'impact suivant tranche ; le fondu d'entrée dure au moins une mesure.
 */
function drawCalmVeil(
  ctx: CanvasRenderingContext2D,
  f: FrameState,
  block: CalmBlock,
): void {
  const fadeSec = f.reduced ? Math.max(2, block.fadeSec) : block.fadeSec;
  const into = f.t - block.start;
  const left = block.end - f.t;
  const fadeIn = clamp01(into / fadeSec);
  const cut = clamp01(left / 0.1);
  const riseSec = f.reduced ? Math.max(2, block.riseSec) : block.riseSec;
  const rise = clamp01((riseSec - left) / riseSec);
  const envelope = Math.min(fadeIn, cut) * (1 + 0.06 * rise);
  const alpha = clamp01(block.glow * envelope);
  if (alpha <= 0.002) return;

  const { width: w, height: h } = f;
  const saturation = Math.min(0.6, f.palette.saturation + 0.05);
  const lightness = f.reduced ? 0.46 : 0.52;
  const top = paint(f.palette.hue, saturation, lightness, alpha);
  const bottom = paint(contrastHue(f), saturation, lightness * 0.84, alpha);
  const gradient = ctx.createLinearGradient(0, 0, 0, h);
  gradient.addColorStop(0, top);
  gradient.addColorStop(1, bottom);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);

  // Halo statique (aucune dépendance au temps) : il éclaire la salle sans flash.
  const cx = w * 0.5;
  const cy = h * 0.52;
  const radius = Math.hypot(w, h) * 0.55;
  const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
  halo.addColorStop(0, paint(f.palette.hue, saturation * 0.8, lightness + 0.08, alpha * 0.28));
  halo.addColorStop(1, paint(f.palette.hue, saturation * 0.8, lightness, 0));
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, w, h);
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
 * Opacité du flash global, à partir des composantes utiles.
 *
 * Séparée de `flashAlpha` pour que le diagnostic puisse mesurer l'alpha sans
 * construire un `FrameState` complet.
 */
export function flashAlphaAt(
  beat: number,
  bass: number,
  drop: number,
  /** Conservé pour la compatibilité de l'API de diagnostic (`drop` porte déjà la force). */
  _buildStrength: number,
  energy: number,
  reduced: boolean,
  settings: RenderSettings,
): number {
  if (reduced) return 0;
  const budget = settings.flashes;
  if (budget <= 0) return 0;
  const beatHit = beat * (0.35 + 0.65 * bass) * BEAT_FLASH_WEIGHT;
  const dropHit = drop > 0 ? drop * 0.95 : 0;
  const raw = Math.max(beatHit, dropHit);
  if (raw < 0.2) return 0;
  const gated = raw * smoothstep(0.12, 0.4, energy);
  return Math.min(gated, 1) * FLASH_CEILING * Math.min(budget, 1.5);
}

/**
 * Opacité du flash global. Plafonnée, et réservée aux moments porteurs : le
 * mode réduit l'annule et le budget utilisateur la dose.
 *
 * La naissance est à latence nulle (`FLASH_LATENCY_SEC`) ; seule la montée est
 * dosée, séparément pour un temps fort et pour un drop. Les composantes sont
 * évaluées séparément pour que chacune ait son attaque.
 */
export function flashAlpha(f: FrameState, settings: RenderSettings): number {
  const beatAlpha = flashAlphaAt(f.beat, f.bass, 0, 0, f.energy, f.reduced, settings);
  const dropAlpha = flashAlphaAt(0, f.bass, f.drop, f.buildStrength, f.energy, f.reduced, settings);
  // Profil hard : le temps fort est un claquement, pas une caresse. On calcule
  // son opacité directement, sans passer par le poids « soirée » de
  // `flashAlphaAt`, tout en gardant le plafond du budget de flashs.
  const hardBeatAlpha =
    f.hard && !f.reduced
      ? clamp01(f.beat * (0.6 + 0.4 * f.bass)) *
        FLASH_CEILING *
        Math.min(settings.flashes, 1.5) *
        HARD_BEAT_FLASH_WEIGHT
      : 0;
  // Profil concert : entre les deux. Le temps fort s'allume plus fort que le
  // standard, sans le claquement du hard.
  const dynamicBeatAlpha =
    f.dynamic === true && !f.reduced
      ? clamp01(f.beat * (0.45 + 0.55 * f.bass)) *
        FLASH_CEILING *
        Math.min(settings.flashes, 1.5) *
        DYNAMIC_BEAT_FLASH_WEIGHT
      : 0;
  const beatAttackSec = f.hard
    ? FLASH_ATTACK_BEAT_HARD_SEC
    : f.dynamic === true
      ? DYNAMIC_FLASH_ATTACK_BEAT_SEC
      : FLASH_ATTACK_BEAT_SEC;
  const dropAttackSec = f.hard
    ? FLASH_ATTACK_DROP_HARD_SEC
    : f.dynamic === true
      ? DYNAMIC_FLASH_ATTACK_DROP_SEC
      : FLASH_ATTACK_DROP_SEC;
  // Âge infini = aucun déclencheur : pas d'attaque en cours (facteur 1), sinon
  // `clamp01` ramènerait l'infini à 0 et éteindrait le flash.
  const attackBeat = Number.isFinite(f.beatAge)
    ? clamp01(f.beatAge / beatAttackSec)
    : 1;
  const attackDrop = Number.isFinite(f.dropAge)
    ? clamp01(f.dropAge / dropAttackSec)
    : 1;
  const boost = f.hard ? HARD_FLASH_BOOST : f.dynamic === true ? DYNAMIC_FLASH_BOOST : 1;
  return Math.min(
    FLASH_CEILING * Math.min(settings.flashes, 1.5),
    Math.max(
      beatAlpha * attackBeat,
      hardBeatAlpha * attackBeat,
      dynamicBeatAlpha * attackBeat,
      dropAlpha * attackDrop,
    ) * boost,
  );
}

/**
 * Opacité du stroboscope hard à l'instant courant, 0 s'il ne doit pas clignoter.
 *
 * C'est la couche qui distingue vraiment le profil hard : un éclat bref, deux
 * ou quatre fois par temps fort, dans les passages forts. Elle respecte le budget
 * de flashs et le mode réduit, et ne s'allume que sur un kick récent : sans
 * percussion, pas de strobe.
 */
export function hardStrobeAlpha(
  f: FrameState,
  settings: RenderSettings,
  drop: number,
): number {
  if (!f.hard || f.reduced || settings.flashes <= 0) return 0;
  // Pendant le creux du cycle, le plein écran s'éteint et laisse la bordure LED
  // tenir le rythme seule.
  if (hardStrobeBarsOnly(f)) return 0;
  const gate = smoothstep(0.55, 0.85, f.energy);
  if (gate <= 0.01) return 0;
  // Le stroboscope reste allumé tant que la basse tient : sur un 808, le beat
  // seul retombait avant la frappe suivante et produisait des trous
  // « strobe, pause, strobe ». La basse donne la continuité du passage.
  const kick = clamp01(0.4 * f.beat + 0.6 * f.bass);
  if (kick < 0.08) return 0;
  const divisions = hardStrobeDivisions(f, drop);
  const on = Math.floor(f.beatPhase * divisions) % 2 === 0;
  if (!on) return 0;
  const amount = gate * (0.45 + 0.55 * kick);
  return clamp01(amount) * FLASH_CEILING * Math.min(settings.flashes, 1.5);
}

/**
 * Éclats du stroboscope concert par temps fort, de 2 à 6.
 *
 * Le profil concert doit pouvoir strober sur des passages simplement énergiques,
 * pas seulement sur les pics du hard.
 */
export function dynamicStrobeDivisions(f: FrameState, drop: number): number {
  // La signature du drop choisit la forme du stroboscope. `aucun` laisse
  // l'impact au seul lavage coloré, `simple` garde deux éclats, `double` en
  // pose quatre, et `cascade` fait varier la cadence d'un temps à l'autre.
  const mode = f.scene?.drop?.strobes;
  if (mode === "aucun") return 0;
  if (mode === "simple") return DYNAMIC_STROBE_DIVISIONS_MIN;
  if (mode === "double") return DYNAMIC_STROBE_DIVISIONS_MIN + 2;
  if (mode === "cascade") {
    const beat = Math.max(0, Math.floor(f.beatIndex));
    return DYNAMIC_STROBE_DIVISIONS_MIN + (beat % 3);
  }
  const energy = clamp01(f.energy);
  const violence = clamp01(drop);
  const extra = Math.round(
    (DYNAMIC_STROBE_DIVISIONS_MAX - DYNAMIC_STROBE_DIVISIONS_MIN) * 0.5 * (energy + violence),
  );
  return Math.min(DYNAMIC_STROBE_DIVISIONS_MAX, DYNAMIC_STROBE_DIVISIONS_MIN + extra);
}

/**
 * Opacité du stroboscope concert à l'instant courant, 0 s'il ne doit pas clignoter.
 *
 * En concert, le strobe n'est pas une texture de fond : il est réservé aux vrais
 * impacts. Le reste du temps, ce sont les lyres qui tiennent la salle. Le budget
 * de flashs et le mode réduit restent maîtres.
 */
export function dynamicStrobeAlpha(
  f: FrameState,
  settings: RenderSettings,
  drop: number,
): number {
  if (f.dynamic !== true || f.reduced || settings.flashes <= 0) return 0;
  // Seuls les impacts francs ouvrent le strobe.
  if (drop < 0.4) return 0;
  const gate = smoothstep(0.62, 0.9, f.energy);
  if (gate <= 0.01) return 0;
  const kick = clamp01(0.5 * f.beat + 0.5 * f.bass);
  if (kick < 0.1) return 0;
  const divisions = dynamicStrobeDivisions(f, drop);
  if (divisions <= 0) return 0;
  const on = Math.floor(f.beatPhase * divisions) % 2 === 0;
  if (!on) return 0;
  const amount = gate * (0.25 + 0.45 * kick);
  return clamp01(amount) * FLASH_CEILING * Math.min(settings.flashes, 1.5);
}

/**
 * Nombre de montées à partir duquel l'impulsion de secours commence à
 * s'effacer. Elle disparaît complètement quatre montées plus loin.
 */
const BEAT_DRIVE_MAX_BUILDS = 2;
/** Nombre de montées au-delà du seuil avant extinction complète. */
const BEAT_DRIVE_FADE_BUILDS = 4;

/**
 * Plancher visuel de l'énergie.
 *
 * L'analyse normalise l'énergie en échelle logarithmique (le 10e centile tombe
 * à 0), ce qui écrase les couplets : un passage audible se retrouve à 0,05, et
 * toutes les familles — dont l'alpha vaut `0,05 + 0,32 × énergie` — deviennent
 * invisibles. L'écran est noir en pleine musique. On garde la dynamique (un
 * couplet reste plus calme qu'un refrain) mais on pose un plancher, pour que le
 * show ne s'éteigne jamais.
 */
export const ENERGY_FLOOR = 0.26;

/** Élément réellement dessiné : jamais sous le plancher visuel. */
export function visibleEnergy(energy: number): number {
  return Math.max(ENERGY_FLOOR, clamp01(energy));
}

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
  // Porte douce sur les basses : une coupure dure à 0,12 faisait passer le
  // pulse de 0 à sa valeur pleine en une image. On multiplie le niveau par un
  // smoothstep (0,08 → 0,16) : jamais plus fort qu'avant, mais plus de marche.
  const bass = view.bassAt(t);
  const kick = bass * smoothstep(0.08, 0.16, bass);
  if (kick <= 0) return 0;
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
 * prioritaires, et un morceau dynamique ne voit rien changer. L'extinction est
 * progressive — une piste à exactement trois montées perdait d'un coup toute son
 * impulsion avec l'ancien seuil dur.
 */
export function beatDrive(view: TrackView, t: number, builds: number): number {
  const attenuation = clamp01(1 - (builds - BEAT_DRIVE_MAX_BUILDS) / BEAT_DRIVE_FADE_BUILDS);
  if (attenuation <= 0) return 0;
  const pulse = view.beatPulse(t, 0.45);
  if (pulse < 0.05) return 0;
  // L'énergie locale dose l'impulsion : un temps fort sur un passage creux
  // reste discret.
  return clamp01(attenuation * pulse * (0.35 + 0.65 * view.energyAt(t)));
}

/**
 * Force du wash : décroissance lente après chaque fin de montée. Le wash
 * commence avec l'impact et s'étire sur ~3 s, donc « l'impact puis la salle
 * entière qui balaie ».
 */
/** Durée du grand wash de projecteurs après un impact, en secondes. */
const WASH_SPAN_SEC = 6.5;

/** Opacité d'un wash : montée vive, tenue, puis longue extinction sans coupure. */
export function washAlpha(ageSec: number, strength: number): number {
  if (ageSec < 0) return 0;
  const tenue = 0.35;
  if (ageSec <= tenue) return clamp01(strength);
  // Fenêtre quadratique : lente au début, puis elle rejoint exactement zéro à la
  // fin de la fenêtre. Une exponentielle tronquée par la fenêtre, elle, se
  // coupait net au bout de quelques secondes.
  const reste = clamp01(1 - (ageSec - tenue) / Math.max(WASH_SPAN_SEC - tenue, 0.001));
  return clamp01(strength * reste * reste);
}

export function washStrength(view: TrackView, t: number, sceneCount: number): number {
  if (sceneCount === 0) return 0;
  let peak = 0;
  // Seules les montées qui viennent de finir comptent : pas besoin de balayer
  // tout le morceau à chaque image.
  for (const build of view.buildsEndingIn(t - WASH_SPAN_SEC, t + 0.2)) {
    const age = t - build.end;
    // Montée vive avant l'impact, puis nappe lente qui s'efface.
    const rise = age < 0 ? clamp01(1 + age / 0.15) : 1;
    const value = rise * washAlpha(age, build.strength);
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
/**
 * Force de la variation d'une phrase : 0 au début et à la fin, 1 au milieu.
 *
 * Les bords doivent valoir exactement 0 : l'ancienne version gardait un plancher
 * de 0,15, donc la variation apparaissait et disparaissait d'un coup en pleine
 * scène — un élément qui « saute » au milieu du morceau.
 */
export function variationStrength(scene: Scene, t: number): number {
  const span = scene.end - scene.start;
  if (span <= 0.5) return 0;
  const ratio = (t - scene.start) / span;
  if (ratio < 0.25 || ratio > 0.9) return 0;
  const local = (ratio - 0.25) / 0.65;
  const wave = Math.sin(local * Math.PI);
  return clamp01(wave * wave);
}

/* --------------------------------------------------------------- transition */

/**
 * Opacité du voile de transition, pour une progression 0..1.
 *
 * Dense au tout début puis relâché : la lumière « monte » au lieu de s'ouvrir
 * linéairement, ce qui se lit mieux de loin.
 */
export function transitionAlpha(progress: number): number {
  return Math.pow(1 - clamp01(progress), 1.6) * 0.95;
}

/**
 * Transition entre deux moments du spectacle — passage du direct au show
 * programmé, ou retour au direct.
 *
 * Sans elle, l'image changeait d'un coup : le show « apparaissait ». On ouvre
 * depuis le noir avec un front lumineux qui balaie l'écran, ce qui donne
 * l'impression d'un rideau qui s'écarte plutôt que d'une coupure.
 */
export function drawTransition(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  progress: number,
  hue: number,
): void {
  const p = clamp01(progress);
  if (p >= 1) return;

  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = `rgba(3,5,12,${transitionAlpha(p).toFixed(3)})`;
  ctx.fillRect(0, 0, width, height);

  // Front lumineux : il part du bord gauche, hors cadre, et sort à droite.
  const front = p * 1.3 - 0.15;
  if (front <= 0 || front >= 1) return;
  const x = front * width;
  const demi = width * 0.3;
  const bande = ctx.createLinearGradient(x - demi, 0, x + demi, 0);
  const intensite = (1 - p) * 0.45;
  bande.addColorStop(0, paint(hue, 0.7, 0.62, 0));
  bande.addColorStop(0.5, paint(hue, 0.85, 0.82, intensite));
  bande.addColorStop(1, paint(hue, 0.7, 0.62, 0));
  ctx.fillStyle = bande;
  ctx.fillRect(Math.max(0, x - demi), 0, Math.min(width, demi * 2), height);
}

/** Écart angulaire signé, dans ]-180 ; 180]. */
export function angularDelta(from: number, to: number): number {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

/**
 * Ancre colorée de la scène : la teinte du morceau dont elle est partie.
 *
 * `show.ts` ancre tantôt sur la teinte principale, tantôt sur la complémentaire
 * (moments forts), et ajoute une dérive inférieure à une demi-largeur de
 * palette. On retrouve donc l'ancre en prenant, des deux teintes du morceau,
 * celle dont la scène est la plus proche.
 */
export function sceneAnchor(scene: Scene, track: { hue: number; accent: number }): number {
  const distanceHue = Math.abs(angularDelta(scene.palette.hue, track.hue));
  const distanceAccent = Math.abs(angularDelta(scene.palette.hue, track.accent));
  return distanceAccent < distanceHue ? track.accent : track.hue;
}

/**
 * Ramène une teinte dans le budget autour de l'ancre, sans jamais la couper.
 *
 * `tanh` compresse progressivement : les petites variations passent presque
 * inchangées, les grandes se rapprochent de la limite sans l'atteindre. Une
 * coupure dure aurait produit un palier visible — la couleur se serait figée au
 * bord du budget pendant tout un passage fort.
 */
export function clampHueToAnchor(hue: number, anchor: number, spread: number): number {
  const limit = Math.max(1, spread + HUE_BUDGET_MARGIN_DEG);
  const offset = angularDelta(anchor, hue);
  return (anchor + limit * Math.tanh(offset / limit) + 360) % 360;
}

/**
 * Teinte réellement dessinée à l'instant `t`.
 *
 * Un morceau ne possède que deux couleurs : la teinte de scène et sa
 * complémentaire. Un impact ou une variation peut basculer de l'une à l'autre,
 * mais le rendu n'invente jamais de teinte intermédiaire. `t`, `reduced` et
 * `anchor` restent dans la signature pour les diagnostics.
 */
export function sceneHue(
  scene: Scene,
  _t: number,
  _drop: number,
  _variation: number,
  _reduced: boolean,
  _anchor: number = scene.palette.hue,
): number {
  // Une scène tient UNE couleur du début à la fin. Les impacts sont marqués par
  // la lumière et le flash, jamais par un changement de teinte en plein strobe.
  return scene.palette.hue;
}

/**
 * Un flash est-il admissible à l'instant `t` ?
 *
 * Fonction pure du temps musical, donc déterministe : mêmes entrées ⇒ même
 * réponse, ce qui garde le spectacle identique après une pause ou un saut.
 *
 * La cadence est musicale, plus métronomique :
 * 1. il faut naître sur l'attaque d'un évènement (pas pendant la décroissance) ;
 * 2. un impact de montée est toujours admis — c'est le moment que le spectacle
 *    doit montrer ;
 * 3. pendant un drop, chaque temps fort peut flasher (la salle suit la musique) ;
 * 4. hors drop, un seul temps fort par phrase porte un flash.
 *
 * Aucun état n'est conservé : `t` seul décide.
 */
export function flashAdmitted(view: TrackView, t: number, hard = false, _dynamic = false): boolean {
  // Fenêtre d'éligibilité : latence nulle + la plus longue des montées. Un
  // flash reste admis pendant toute son attaque, jamais au-delà.
  const window = FLASH_LATENCY_SEC + Math.max(FLASH_ATTACK_BEAT_SEC, FLASH_ATTACK_DROP_SEC) + 0.05;
  const beats = view.beatsIn(t - window, t);
  const lastBeat = beats.length > 0 ? (beats[beats.length - 1] ?? -Infinity) : -Infinity;
  const lastDrop = view.lastBuildEnd(t);
  const current = Math.max(lastBeat, lastDrop);
  if (current === -Infinity) return false;

  const age = t - current;
  if (age < -0.02 || age > window) return false;

  // Impact de montée : toujours, et sans attendre la cadence.
  if (lastDrop >= lastBeat) return true;

  // Profil hard : chaque temps fort claque, y compris dans la traîne d'un
  // impact. C'est exactement le geste d'un strobe de club.
  if (hard) return true;

  // Le concert ne flashe pas à chaque temps : la salle est tenue par les lyres.
  // Les impacts restent admis par la branche du dessus, et les temps forts
  // gardent la cadence espacée du standard.

  // Dans les 1,5 s qui suivent un impact, aucun flash de temps fort : l'impact
  // lui-même est déjà admis par `lastDrop >= lastBeat` juste au-dessus. Sans
  // cette garde, la salle « battait » encore avec le drop et enchaînait un
  // flash par temps fort, au-delà du budget de sécurité.
  if (view.buildsEndingIn(t - 1.5, t).length > 0) return false;

  // Hors drop : un seul temps fort par phrase, calé sur l'index du temps fort
  // pour rester stable quel que soit le moment où l'image est calculée.
  return view.beatIndexAt(current) % PHRASE_BEATS === 0;
}

/**
 * Couches de rave ajoutées au plein strobe hard.
 *
 * Le plateau de lyres seul reste un concert de théâtre. Pour un moment qui doit
 * ressembler à une rave, on empile trois sources : les tirs croisés des coins,
 * les rayons du burst central et les projecteurs mobiles des bords. Chaque
 * couche est atténuée pour que les lyres gardent la vedette, et la qualité
 * adaptative réduit leur nombre comme pour une scène normale.
 */
function drawRaveLayers(
  ctx: CanvasRenderingContext2D,
  f: FrameState,
  view: TrackView,
): void {
  // Les couches de rave poussent le curseur couleur plus loin que la scène :
  // saturation maximale, luminosité néon et budget de teinte élargi pour que
  // les lasers, le burst et les projecteurs ne partagent pas tous la même gamme.
  const rave: FrameState = {
    ...f,
    palette: {
      ...f.palette,
      saturation: 1,
      lightness: Math.min(0.8, f.palette.lightness + 0.04),
      spread: Math.min(150, f.palette.spread * 1.5),
    },
  };
  drawFamily(
    ctx,
    { ...rave, alpha: rave.alpha * 0.85, quality: rave.quality * 0.8 },
    view,
    "crossfire",
  );
  drawFamily(
    ctx,
    { ...rave, alpha: rave.alpha * 0.7, quality: rave.quality * 0.7 },
    view,
    "burst",
  );
  drawFamily(
    ctx,
    { ...rave, alpha: rave.alpha * 0.6, quality: rave.quality * 0.7 },
    view,
    "spots",
  );
  drawRaveLasers(ctx, rave);
}

/**
 * Lasers de rave : jusqu'à 36 faisceaux ultra-fins partent de la scène et du
 * plafond, avec deux ou trois images de rémanence pour densifier le balayage.
 */
function drawRaveLasers(ctx: CanvasRenderingContext2D, f: FrameState): void {
  // Un vrai mur de lasers : jusqu'à 36 faisceaux en pleine qualité, moitié
  // depuis la scène, moitié depuis le plafond. La qualité adaptative divise le
  // nombre pour garder le rendu tenable sur une machine modeste.
  const count = Math.max(12, Math.round(36 * f.quality));
  const trails = f.quality >= 0.75 ? 3 : 2;
  const reach = Math.hypot(f.width, f.height) * 1.6;
  const alpha = (0.16 + 0.3 * clamp01(f.beat)) * clamp01(0.5 + 0.5 * f.energy);
  if (alpha <= 0.01) return;
  for (let index = 0; index < count; index += 1) {
    const fromTop = index % 2 === 1;
    const originX = f.width * (0.05 + (0.9 * index) / Math.max(count - 1, 1));
    const originY = fromTop ? -f.height * 0.04 : f.height * 1.04;
    const baseAngle = fromTop ? Math.PI / 2 : -Math.PI / 2;
    for (let trail = 0; trail < trails; trail += 1) {
      const time = f.t - trail * 0.045;
      const phase = time * (0.55 + (index % 3) * 0.09) + index * 0.73;
      const angle = baseAngle + Math.sin(phase) * 0.95;
      const hue = index % 2 === 0 ? f.palette.hue : f.palette.accent;
      const trailAlpha = alpha * (trail === 0 ? 1 : 0.3 / trail);
      const endX = originX + Math.cos(angle) * reach;
      const endY = originY + Math.sin(angle) * reach;
      ctx.globalAlpha = 1;
      // Halo.
      ctx.strokeStyle = paint(hue, 1, 0.55, trailAlpha * 0.45);
      ctx.lineWidth = trail === 0 ? 3.5 : 2.2;
      ctx.beginPath();
      ctx.moveTo(originX, originY);
      ctx.lineTo(endX, endY);
      ctx.stroke();
      // Cœur du laser.
      ctx.strokeStyle = paint(hue, 1, 0.72, trailAlpha);
      ctx.lineWidth = trail === 0 ? 1.1 : 0.7;
      ctx.beginPath();
      ctx.moveTo(originX, originY);
      ctx.lineTo(endX, endY);
      ctx.stroke();
      if (trail === 0) {
        // Point de départ brillant.
        ctx.fillStyle = paint(hue, 0.3, 0.92, trailAlpha * 1.6);
        ctx.beginPath();
        ctx.arc(originX, originY, 1.6 + f.beat * 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

/** Confettis et étincelles qui tombent pendant les drops. */
function drawRaveConfetti(
  ctx: CanvasRenderingContext2D,
  f: FrameState,
  drop: number,
): void {
  if (!(f.hard === true || f.live === true) || f.reduced || drop < 0.05) return;
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  const count = Math.round(220 * f.quality);
  const life = 1.8;
  const intensity = clamp01(drop * 1.6);
  for (let index = 0; index < count; index += 1) {
    const seed = index * 7919 + f.seed;
    const speed = 0.7 + hash01(seed + 3) * 0.6;
    const phase = ((f.t * speed) / life + hash01(seed)) % 1;
    const x =
      f.width * (0.06 + 0.88 * hash01(seed + 1)) +
      Math.sin(f.t * 3 + index) * f.width * 0.02;
    const y = -f.height * 0.1 + phase * f.height * 1.2;
    const size = (2.4 + hash01(seed + 4) * 4.2) * (0.6 + f.quality * 0.4);
    const alpha = (1 - phase) * intensity;
    if (alpha <= 0.01) continue;
    const hue = hash01(seed + 5) < 0.5 ? f.palette.hue : f.palette.accent;
    ctx.fillStyle = paint(hue, 1, 0.65, alpha);
    ctx.fillRect(x, y, size, size * 1.8);
  }
}

/** Jets de CO2 discrets : buse compressée, puis épanouissement en cône. */
function drawRaveCo2(ctx: CanvasRenderingContext2D, f: FrameState, drop: number): void {
  if (!(f.hard === true || f.live === true) || f.reduced || drop < 0.12) return;
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  const intensity = clamp01(drop * 1.6);
  // Un jet d'une seconde, puis une seconde de pause : quatre buses qui crachent
  // une gerbe complète, pas un filet continu.
  const cycle = 2;
  const local = (f.t % cycle) / cycle;
  if (local >= 0.5) return;
  const progress = local / 0.5;
  const envelope = 1 - progress * 0.6;
  const burst = Math.floor(f.t / cycle);

  for (const side of [-1, 1] as const) {
    for (let jet = 0; jet < 2; jet += 1) {
      const originX = side < 0 ? f.width * (0.06 + jet * 0.05) : f.width * (0.94 - jet * 0.05);
      const originY = f.height * 1.02;

      // Cœur de pression à la buse : très concentré au tout début du jet.
      const coreAlpha = intensity * Math.max(0, 1 - progress / 0.12) * 0.65;
      if (coreAlpha > 0.01) {
        const coreRadius = f.height * 0.035;
        const core = ctx.createRadialGradient(
          originX,
          originY - f.height * 0.02,
          0,
          originX,
          originY - f.height * 0.02,
          coreRadius,
        );
        core.addColorStop(0, paint(208, 0.04, 1, coreAlpha));
        core.addColorStop(1, paint(208, 0.08, 0.9, 0));
        ctx.fillStyle = core;
        ctx.beginPath();
        ctx.arc(originX, originY - f.height * 0.02, coreRadius, 0, Math.PI * 2);
        ctx.fill();
      }

      for (let puff = 0; puff < 24; puff += 1) {
        const seed = puff * 97 + jet * 13 + (side > 0 ? 1 : 0) + f.seed + burst * 7;
        // Les bouffées sortent étalées sur le premier tiers du jet : la gerbe
        // dure une seconde au lieu d'être un unique paquet.
        const delay = hash01(seed + 4) * 0.45;
        if (progress < delay) continue;
        const lateral = (hash01(seed) - 0.5) * 2;
        const speed = 0.75 + hash01(seed + 1) * 0.5;
        const p = clamp01(((progress - delay) / Math.max(1 - delay, 0.01)) * speed);
        // Au début, toutes les bouffées sortent du même point ; elles ne
        // divergent qu'en montant, comme un vrai jet sous pression.
        const spread = (-side * 0.14 + lateral * 0.24) * p;
        const x = originX + spread * f.width;
        const y = originY - p * f.height * (0.8 + hash01(seed + 2) * 0.15);
        const radius = f.height * (0.012 + p * 0.17 + hash01(seed + 3) * 0.02);
        const alpha = intensity * envelope * (1 - p * 0.5) * 0.62;
        if (alpha <= 0.01) continue;
        const puffGradient = ctx.createRadialGradient(x, y, 0, x, y, Math.max(radius, 1));
        puffGradient.addColorStop(0, paint(208, 0.08, 0.99, alpha));
        puffGradient.addColorStop(0.38, paint(208, 0.16, 0.92, alpha * 0.7));
        puffGradient.addColorStop(1, paint(208, 0.12, 0.78, 0));
        ctx.fillStyle = puffGradient;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(radius, 1), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

/** Onde de choc circulaire qui part du centre sur un impact. */
function drawRaveShockwave(ctx: CanvasRenderingContext2D, f: FrameState): void {
  // Le direct n'a pas de profil rave : sur un impact réel, l'onde reste un
  // geste de salle, coloré et bref, pas une signature de club.
  if (!(f.hard === true || f.live === true) || f.reduced) return;
  const age = f.dropAge;
  if (!Number.isFinite(age) || age < 0 || age > 0.9) return;
  const progress = age / 0.9;
  const radius = Math.min(f.width, f.height) * (0.08 + progress * 0.8);
  const alpha = (1 - progress) * (0.55 + 0.35 * f.energy);
  const hue = contrastHue(f);
  ctx.strokeStyle = paint(hue, 1, 0.62, alpha * 0.7);
  ctx.lineWidth = 5 + 12 * (1 - progress);
  ctx.beginPath();
  ctx.arc(f.width * 0.5, f.height * 0.5, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = paint(hue, 0.3, 0.88, alpha);
  ctx.lineWidth = 1.5 + 2 * (1 - progress);
  ctx.beginPath();
  ctx.arc(f.width * 0.5, f.height * 0.5, radius, 0, Math.PI * 2);
  ctx.stroke();
}

/** Deux panneaux LED verticaux sur les bords, en motifs de chenillard. */
function drawRavePanels(
  ctx: CanvasRenderingContext2D,
  f: FrameState,
): void {
  if (f.hard !== true || f.reduced) return;
  const cols = Math.max(2, Math.round(4 * f.quality));
  const rows = Math.max(8, Math.round(20 * f.quality));
  const panelWidth = f.width * 0.055;
  const temps = f.beatIndex + clamp01(f.beatPhase);
  for (const side of [0, 1] as const) {
    const originX = side === 0 ? 0 : f.width - panelWidth;
    for (let col = 0; col < cols; col += 1) {
      for (let row = 0; row < rows; row += 1) {
        const chase = (row + Math.floor(temps * 2) + side * 3) % 7;
        const on = chase < 2 || (f.energy > 0.85 && (row + col) % 2 === 0);
        if (!on) continue;
        const x = originX + (panelWidth * (col + 0.5)) / cols;
        const y = (f.height * (row + 0.5)) / rows;
        const alpha = 0.35 + 0.5 * clamp01(f.beat);
        const hue = row % 2 === 0 ? f.palette.hue : f.palette.accent;
        ctx.fillStyle = paint(hue, 1, 0.6, alpha);
        ctx.fillRect(x - panelWidth * 0.07, y - f.height * 0.007, panelWidth * 0.14, f.height * 0.014);
      }
    }
  }
}

/**
 * Sol de club en perspective : lignes de fuite et lignes horizontales qui
 * défilent vers le spectateur. C'est ce qui donne la profondeur sous les lyres.
 */
function drawRaveFloor(ctx: CanvasRenderingContext2D, f: FrameState): void {
  if (f.hard !== true || f.reduced) return;
  const horizon = f.height * 0.58;
  const bottom = f.height * 1.06;
  const center = f.width * 0.5;
  const alpha = 0.08 + 0.12 * f.energy;
  // Lignes de fuite.
  for (let index = 0; index <= 14; index += 1) {
    const x = f.width * (-0.25 + (1.5 * index) / 14);
    ctx.strokeStyle = paint(index % 2 === 0 ? f.palette.hue : f.palette.accent, 1, 0.55, alpha);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(center, horizon);
    ctx.lineTo(x, bottom);
    ctx.stroke();
  }
  // Lignes horizontales en perspective, qui descendent vers le bas.
  const scroll = (f.t * 0.35) % 1;
  for (let step = 0; step < 9; step += 1) {
    const progress = (step / 9 + scroll) % 1;
    const y = horizon + progress * progress * (bottom - horizon);
    const spread = 0.15 + progress * 0.95;
    const x0 = center - f.width * 0.62 * spread;
    const x1 = center + f.width * 0.62 * spread;
    ctx.strokeStyle = paint(step % 2 === 0 ? f.palette.hue : f.palette.accent, 1, 0.6, alpha * 0.9);
    ctx.lineWidth = 1 + progress * 1.6;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();
  }
}

/**
 * Mur de lyres du mode rave : quatre rangées frontales avec des gestes
 * différents, plus des colonnes de lyres sur les bords gauche et droit.
 */
function drawRaveLyreWall(
  ctx: CanvasRenderingContext2D,
  f: FrameState,
  view: TrackView,
): void {
  const drawRow = (
    gesture: "eventail" | "croisement" | "vague" | "cercle",
    alpha: number,
    offsetY: number,
    scale: number,
  ): void => {
    ctx.save();
    ctx.translate(f.width * 0.5, f.height * 0.5 + offsetY);
    ctx.scale(scale, scale);
    ctx.translate(-f.width * 0.5, -f.height * 0.5);
    dessinerLyresRave(ctx, { ...f, alpha: f.alpha * alpha }, view, gesture);
    ctx.restore();
  };

  // Rangées lointaines : petites, hautes et discrètes, elles remplissent le fond
  // de la scène et donnent la profondeur derrière le mur frontal.
  const farGestures = ["vague", "croisement", "eventail"] as const;
  const farRows = f.quality >= 0.9 ? 3 : 2;
  for (let row = 0; row < farRows; row += 1) {
    const depth = row / Math.max(farRows - 1, 1);
    const gesture = farGestures[row] ?? "vague";
    drawRow(
      gesture,
      0.2 + 0.16 * depth,
      -f.height * 0.16 + row * f.height * 0.075,
      0.42 + 0.12 * depth,
    );
  }

  // Quatre rangées frontales, de la plus lointaine à la plus proche.
  const gestures = ["eventail", "croisement", "vague", "cercle"] as const;
  for (let row = 0; row < gestures.length; row += 1) {
    const depth = row / (gestures.length - 1);
    const gesture = gestures[row] ?? "eventail";
    drawRow(gesture, 0.5 + 0.5 * depth, row * f.height * 0.16, 0.8 + 0.14 * depth);
  }

  // Colonnes latérales : mêmes lyres, mais tournées vers le centre.
  const drawSide = (side: -1 | 1, gesture: "croix" | "cercle"): void => {
    ctx.save();
    if (side < 0) {
      ctx.translate(0, f.height);
      ctx.rotate(-Math.PI / 2);
    } else {
      ctx.translate(f.width, 0);
      ctx.rotate(Math.PI / 2);
    }
    ctx.scale(f.height / Math.max(f.width, 1), 1);
    const rows = f.quality >= 0.9 ? 2 : 1;
    for (let row = 0; row < rows; row += 1) {
      ctx.save();
      ctx.translate(0, row * f.height * 0.18);
      dessinerLyresRave(
        ctx,
        { ...f, alpha: f.alpha * (row === 0 ? 0.7 : 0.4) },
        view,
        gesture,
      );
      ctx.restore();
    }
    ctx.restore();
  };
  drawSide(-1, "croix");
  drawSide(1, "cercle");
}

/**
 * Coupes glitch sur les gros drops : trois bandes horizontales décalées pendant
 * quelques images. Le décalage est tiré du temps musical, donc reproductible.
 */
function drawGlitchCuts(ctx: CanvasRenderingContext2D, f: FrameState, drop: number): void {
  if (f.hard !== true || f.reduced || drop < 0.3) return;
  const canvas = ctx.canvas;
  if (canvas.width < 2 || canvas.height < 2) return;
  const bands = 3;
  const frame = Math.floor(f.t * 24);
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  for (let band = 0; band < bands; band += 1) {
    const shift =
      (hash01(band * 7919 + frame * 131 + f.seed) - 0.5) * f.width * 0.18 * clamp01(drop);
    const sourceY = (band / bands) * canvas.height;
    const sourceH = canvas.height / bands;
    const destY = (band / bands) * f.height;
    const destH = f.height / bands;
    ctx.drawImage(canvas, 0, sourceY, canvas.width, sourceH, shift, destY, f.width, destH);
  }
  ctx.restore();
}

/**
 * Caméra de rave : léger zoom pulsé, rotation lente et balayage.
 *
 * Elle ne s'applique qu'au mode rave et seulement aux familles de lumière : le
 * fond, la vignette et la bordure restent fixes, donc l'image ne tremble pas
 * bêtement, elle « respire » comme une caméra de concert.
 */
interface RaveCamera {
  x: number;
  y: number;
  rotation: number;
  scale: number;
}

function raveCamera(f: FrameState, drop: number): RaveCamera | null {
  if (f.hard === true) {
    return {
      x: Math.sin(f.t * 0.42) * 0.012 * f.width,
      y: Math.cos(f.t * 0.31) * 0.008 * f.height,
      rotation: Math.sin(f.t * 0.28) * 0.04 + Math.sin(f.t * 0.11) * 0.02,
      scale:
        1.04 +
        0.04 * clamp01(f.beat) +
        0.05 * clamp01(drop) +
        0.012 * Math.sin(f.t * 0.8),
    };
  }
  if (f.dynamic === true) {
    // Caméra de concert : très lente, elle avance sur les montées et s'ouvre
    // au moment de l'impact. Aucun tremblement, juste une respiration.
    return {
      x: Math.sin(f.t * 0.16) * 0.008 * f.width,
      y: Math.cos(f.t * 0.12) * 0.005 * f.height,
      rotation: Math.sin(f.t * 0.1) * 0.007,
      scale:
        1.018 +
        0.045 * clamp01(f.build) -
        0.022 * clamp01(drop) +
        0.008 * Math.sin(f.t * 0.22),
    };
  }
  return null;
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
  const liveMusic = input.liveMusic;
  const isLive = liveAudio !== undefined || liveMusic !== undefined;
  const reduced = settings.reduced || reducedMotion;
  // Blackout : coupe tout, y compris les flashs et la fumée. Le retour est
  // immédiat, sans reconstruire le plan : la prochaine image se redessine.
  if (settings.blackout) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, width, height);
    return;
  }
  // La qualité est ramenée à un palier connu ici, et pas seulement par
  // l'appelant : c'est ce qui garantit qu'une variation de fps ne change jamais
  // le nombre d'éléments d'une image à l'autre (voir QUALITY_STEPS).
  const quality = quantizeQuality(input.quality);
  const haze = reduced ? undefined : input.haze;
  if (haze !== undefined) {
    // Les nappes repartent vides à chaque image, et dans le même espace que les
    // familles (des pixels CSS) : elles y déposent leurs faisceaux comme elles le
    // feraient sur la toile.
    for (const nappe of [haze.fine, haze.large]) {
      nappe.used = false;
      nappe.ctx.setTransform(1, 0, 0, 1, 0, 0);
      nappe.ctx.globalCompositeOperation = "source-over";
      nappe.ctx.globalAlpha = 1;
      nappe.ctx.clearRect(0, 0, nappe.ctx.canvas.width, nappe.ctx.canvas.height);
      nappe.ctx.setTransform(nappe.scale, 0, 0, nappe.scale, 0, 0);
      nappe.ctx.globalCompositeOperation = "lighter";
    }
  }
  const scene = sceneAt(plan, t);
  const hard = plan.profile === "hard";
  const dynamic = plan.profile === "dynamic";
  // En direct, la direction musicale fournit un vrai temps fort (attaque suivie
  // et enveloppe). À défaut, on retombe sur le transitoire brut ; en mode
  // analysé, un temps fort ne vaut que par ce qu'il porte : `beatStrength`
  // renvoie 0 sur un temps sans basse, donc le show ne pulse plus à vide.
  const beat =
    liveMusic !== undefined
      ? liveMusic.beat
      : liveAudio !== undefined
        ? liveAudio.transient
        : beatStrength(view, t);
  const build =
    liveMusic !== undefined
      ? liveMusic.build
      : liveAudio !== undefined
        ? 0
        : view.buildProgress(t);
  const buildNow = liveMusic !== undefined ? null : view.buildAt(t);
  // Flash : le trigger est l'instant de naissance (latence nulle). On expose
  // l'âge des deux déclencheurs pour que l'attaque puisse être dosée.
  const lastBeat =
    liveMusic !== undefined || liveAudio !== undefined ? -Infinity : view.lastBeatAt(t);
  const lastImpact =
    liveMusic !== undefined || liveAudio !== undefined ? -Infinity : view.lastBuildEnd(t);
  const beatAge =
    liveMusic !== undefined
      ? liveMusic.beatAge
      : lastBeat === -Infinity
        ? Infinity
        : t - lastBeat;
  const dropAge =
    liveMusic !== undefined
      ? liveMusic.dropAge
      : lastImpact === -Infinity
        ? Infinity
        : t - lastImpact;
  // La couleur vit en permanence : elle glisse dans le temps, fait un saut net
  // à chaque impact (drop) et un autre à chaque variation de phrase, pour que
  // le morceau « change de lumière » sans cesse.
  // L'impulsion de secours sur les temps forts ne touche plus la couleur : elle
  // ne sert qu'à l'intensité et à la taille, sinon un morceau sans montée faisait
  // clignoter la teinte de 12° d'une image à l'autre. Le saut de couleur reste
  // réservé au vrai drop (`buildIntensity`).
  const beatDriveValue = isLive ? 0 : beatDrive(view, t, view.analysis.builds.length);
  const drop =
    liveMusic !== undefined
      ? liveMusic.drop
      : liveAudio !== undefined
        ? 0
        : view.buildIntensity(t);
  const variation = reduced ? 0 : variationStrength(scene, t);
  const surge =
    liveMusic !== undefined
      ? liveMusic.surge
      : liveAudio !== undefined
        ? liveAudio.transient
        : view.energyTrend(t, 1.2);
  const anchor = sceneAnchor(scene, plan.track);
  const paletteHue = sceneHue(scene, t, drop, variation, reduced, anchor);  const paletteAccent =
    paletteHue === scene.palette.hue ? scene.palette.accent : scene.palette.hue;
  const palette: Palette = {
    name: scene.palette.name,
    hue: paletteHue,
    // L'autre couleur du morceau, jamais une teinte intermédiaire.
    accent: paletteAccent,
    ...(scene.palette.tertiary !== undefined ? { tertiary: scene.palette.tertiary } : {}),
    spread: scene.palette.spread * (0.75 + 0.5 * (0.5 + 0.5 * Math.sin(t * 0.55))),
    saturation: Math.min(1, scene.palette.saturation + drop * 0.16 + variation * 0.1),
    // Un temps fort pousse la lumière vers le blanc : c'est ce qui « allume la
    // salle » sur un impact, sans changer la couleur du morceau. En mode rave, on
    // plafonne plus bas pour garder la couleur saturée au lieu de la délaver.
    lightness: Math.min(
      hard ? 0.8 : 0.94,
      scene.palette.lightness + drop * 0.14 + variation * 0.06 + beat * 0.07,
    ),
  };

  const base: FrameState = {
    t,
    width,
    height,
    dpr,
    scene,
    palette,
    // Refrain chanté : les paroles datées sont la seule source fiable. En
    // direct, aucune parole n'est calée sur l'audio, donc la salle reste noire.
    chorus: isLive ? 0 : chorusIntensityAt(view.analysis.lyrics, t),
    energy:
      liveMusic !== undefined
        ? liveMusic.energy
        : liveAudio !== undefined
          ? clamp01(liveAudio.energy * 1.35 + liveAudio.transient * 0.3)
          : clamp01(visibleEnergy(view.energyAt(t)) * (dynamic ? 1.12 : 1)),
    bass: liveAudio !== undefined ? liveAudio.bass : view.bassAt(t),
    mid: liveAudio !== undefined ? liveAudio.mid : view.midAt(t),
    high: liveAudio !== undefined ? liveAudio.high : view.highAt(t),
    beat,
    beatPhase: liveMusic !== undefined ? liveMusic.beatPhase : view.beatPhase(t),
    beatIndex: liveMusic !== undefined ? liveMusic.beatIndex : view.beatIndexAt(t),
    build,
    buildStrength: liveMusic !== undefined ? liveMusic.buildStrength : (buildNow?.strength ?? 0),
    drop,
    beatAge,
    dropAge,
    surge,
    intensity:
      scene.intensity *
      settings.intensity *
      (dynamic ? 1.12 : 1) *
      (liveMusic !== undefined
        ? // Direct : le plateau s'allume avec ce qu'on entend, sans jamais
          // s'éteindre complètement (une salle vide reste une salle).
          0.55 + liveMusic.energy * 1.05 + liveMusic.beat * 0.25
        : isLive
          ? 1.1 + liveAudio!.energy * 0.9 + liveAudio!.transient * 0.4
          : 1 + surge * 0.6 + beatDriveValue * 0.5),
    alpha: sceneWeight(scene, t),
    reduced,
    hard,
    dynamic,
    // Le direct partage le vocabulaire du live : couches d'impact autorisées
    // dans le profil concert, sans passer par la noirceur du profil hard.
    live: isLive,
    quality,
    seed: plan.seed,
    haze,
    frame,
  };

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  // Pas de `clearRect` : le contexte est opaque et `drawBackground` repeint
  // intégralement l'écran juste en dessous. Une passe plein écran économisée à
  // chaque image, c'est une écriture de framebuffer en moins sur le GPU.

  drawBackground(ctx, { ...base, palette });
  const calmBlock = calmBlockFor(plan, scene);
  // En concert, la salle reste sombre : pas de voile pastel de calme.
  if (calmBlock !== null && !dynamic) drawCalmVeil(ctx, { ...base, palette }, calmBlock);

  // Couche permanente : le fond, le halo et la poussière ne dépendent pas du
  // fondu de scène. C'est ce qui garantit qu'il reste toujours quelque chose à
  // l'écran — y compris au croisement de deux scènes, où tout ce qui suit le
  // poids de la scène disparaît un instant et l'image plonge dans le noir.
  const permanent: FrameState = { ...base, alpha: 1 };

  // Structure fixe : ponts, totems et corps d'appareils. Elle est dessinée en
  // source-over, avant la lumière, pour rester une silhouette métallique.
  ctx.globalCompositeOperation = "source-over";
  dessinerStructure(ctx, permanent);
  ctx.globalCompositeOperation = "lighter";

  // Scène courante + scène sortante pendant le fondu (transition fluide).
  // En plein strobe hard, la scène cède la place au plateau de lyres : c'est le
  // mur de faisceaux qui doit clignoter, pas une nappe ou une figure seule.
  const strobeFull = hard && hardStrobeAllowsFull(base);
  const sceneFamily = hardStrobeFamily(base, scene.family);
  const camera = raveCamera(base, drop);
  if (camera !== null) {
    ctx.save();
    ctx.translate(width * 0.5 + camera.x, height * 0.5 + camera.y);
    ctx.rotate(camera.rotation);
    ctx.scale(camera.scale, camera.scale);
    ctx.translate(-width * 0.5, -height * 0.5);
  }
  if (hard) {
    drawRaveFloor(ctx, base);
    drawRaveLyreWall(ctx, base, view);
  } else {
    // Concert haut budget : plusieurs nappes de lumière restent allumées en
    // même temps derrière la famille principale. Le plateau n'est jamais une
    // seule rangée de têtes.
    if (dynamic) {
      if (sceneFamily !== "par-wash") {
        drawFamily(ctx, { ...base, alpha: base.alpha * 0.22 }, view, "par-wash");
      }
      if (sceneFamily !== "tours-lumiere") {
        drawFamily(ctx, { ...base, alpha: base.alpha * 0.14 }, view, "tours-lumiere");
      }
    }
    drawFamily(ctx, base, view, sceneFamily);
  }
  if (strobeFull) drawRaveLayers(ctx, base, view);
  drawCoreGlow(ctx, permanent);

  // (Plus de couche de fond permanente : seul le halo et la poussière subsistent.)

  // Variation au milieu de la phrase : une autre famille surgit brièvement,
  // avec sa propre teinte. C'est ce qui empêche le spectacle de tourner en boucle.
  // Elle se tait pendant le plein strobe : la scène doit rester un mur de faisceaux.
  if (variation > 0.05 && !strobeFull && !hard) {
    const variationState: FrameState = {
      ...base,
      palette: {
        ...palette,
        // La variante joue l'autre couleur du morceau, jamais une troisième.
        hue: palette.accent,
        accent: palette.hue,
        saturation: Math.min(1, palette.saturation + 0.1),
      },
      alpha: base.alpha * variation * 0.8,
      intensity: base.intensity * (0.7 + 0.6 * variation),
    };
    drawFamily(ctx, variationState, view, scene.variant);
  }
  if (camera !== null) ctx.restore();
  drawGlitchCuts(ctx, base, drop);
  drawRaveShockwave(ctx, base);
  drawRavePanels(ctx, base);

  // Grand wash de projecteurs après un impact : il vit plus longtemps que la
  // sur-couche et couvre tout l'écran. Jamais en mode réduit. En direct, c'est
  // la direction musicale qui fournit l'âge et la force de l'impact : un vrai
  // saut de niveau balaie la salle, un simple temps fort ne le déclenche pas.
  const wash = reduced
    ? 0
    : liveMusic !== undefined
      ? washAlpha(liveMusic.dropAge, liveMusic.impactStrength)
      : isLive
        ? 0
        : washStrength(view, t, plan.scenes.length);
  if (wash > 0.02) {
    const washState: FrameState = {
      ...base,
      palette: { ...palette, hue: palette.accent, accent: palette.hue },
      alpha: base.alpha * wash,
      intensity: base.intensity,
    };
    drawWash(ctx, washState);
  }

  // Lavage blanc d'impact : bref et réservé aux vrais drops, jamais en mode
  // réduit. Il n'y a plus de sur-couche de projecteurs ici — la rangée de barres
  // qui s'allumait en bas à chaque montée faisait « vu-mètre » et jurait avec le
  // reste ; l'impact se lit désormais par le lavage, le wash et la lumière de la
  // scène, qui porte déjà la couleur du morceau.
  if (drop > 0.02 && !reduced) {
    const ceiling = FLASH_CEILING * Math.min(settings.flashes, 1.5);
    // Seul un vrai drop de l'analyse, ou un impact réel du direct, ouvre le
    // lavage blanc : le pulsage de secours sur les temps forts éclaire la scène,
    // il ne blanchit pas l'écran. Sinon un morceau sans montée clignoterait à
    // chaque temps fort.
    const realDrop =
      liveMusic !== undefined
        ? liveMusic.drop > 0.35
          ? liveMusic.impactStrength
          : 0
        : isLive
          ? 0
          : view.buildIntensity(t);
    if (ceiling > 0 && realDrop > 0.35) {
      const washAlpha = Math.min(0.5, ceiling * realDrop);
      // En mode rave ou concert, l'impact est coloré au lieu d'être un blanc de
      // salle, et reste dans les deux couleurs du morceau. La signature du drop
      // peut demander un blanc franc ou un dégradé entre les deux pôles.
      const washHue = dynamic ? base.scene.drop?.hue : undefined;
      if (washHue === "blanc") {
        ctx.fillStyle = `rgba(255,255,255,${washAlpha.toFixed(3)})`;
      } else if (washHue === "bicolore") {
        const gradient = ctx.createLinearGradient(0, 0, width, 0);
        gradient.addColorStop(0, paint(base.palette.hue, 1, 0.62, washAlpha));
        gradient.addColorStop(1, paint(base.palette.accent, 1, 0.62, washAlpha));
        ctx.fillStyle = gradient;
      } else {
        ctx.fillStyle =
          hard || dynamic
            ? paint(contrastHue(base), 1, 0.62, washAlpha)
            : `rgba(255,255,255,${washAlpha.toFixed(3)})`;
      }
      ctx.fillRect(0, 0, width, height);
    }
  }

  const previous = scene.index > 0 ? plan.scenes[scene.index - 1] : undefined;
  if (previous !== undefined && t < scene.start + scene.fadeIn) {
    const ratio = clamp01((t - scene.start) / Math.max(scene.fadeIn, 0.001));
    // Croisement exactement complémentaire : ce que la nouvelle scène n'a pas
    // encore pris reste à l'ancienne. Chacune ayant par ailleurs sa propre
    // extinction, la somme retombait à 0,67 au milieu du fondu et l'image
    // s'assombrissait à chaque changement de scène.
    const outgoing: FrameState = {
      ...base,
      scene: previous,
      palette: previous.palette,
      alpha: 1 - ratio,
      intensity: previous.intensity * settings.intensity,
    };
    drawFamily(ctx, outgoing, view, hardStrobeFamily(outgoing, previous.family));
  }

  // Fumée : les faisceaux ont été déposés dans deux nappes, l'une pour les
  // traits, l'autre pour les gros faisceaux. Chacune est floutée une fois — c'est
  // cette unique passe, et non une passe par projecteur, qui rend la diffusion
  // tenable — puis remontée, agrandie d'autant : l'agrandissement finit d'adoucir
  // les bords. Une nappe que rien n'a nourrie n'est même pas floutée.
  if (haze !== undefined) {
    // En concert, la fumée s'épaissit dans les montées et les impacts : les
    // faisceaux deviennent plus volumétriques au lieu de rester des traits.
    const brume = dynamic
      ? 1.16 + 0.22 * clamp01(build) + 0.32 * clamp01(drop)
      : 1;
    const nappes = [
      { nappe: haze.fine, rayon: hazeFineRadiusPixels(width, height, quality) * brume },
      { nappe: haze.large, rayon: hazeRadiusPixels(width, height, quality) * brume },
    ];
    // Le flou de chaque nappe coûte à lui seul plusieurs millisecondes par image
    // (le filtre est synchrone, contrairement aux remplissages). La fumée se
    // déplace lentement et le flou est déjà une moyenne : le rafraîchir une
    // image sur deux ne se voit pas, et divise son coût par deux.
    const refresh = frame % 2 === 0;
    for (const { nappe, rayon } of nappes) {
      if (!nappe.used) continue;
      if (refresh) {
        nappe.blurPass.setTransform(1, 0, 0, 1, 0, 0);
        nappe.blurPass.globalCompositeOperation = "source-over";
        nappe.blurPass.globalAlpha = 1;
        nappe.blurPass.clearRect(0, 0, nappe.blurPass.canvas.width, nappe.blurPass.canvas.height);
        nappe.blurPass.filter = `blur(${(rayon * nappe.scale).toFixed(2)}px)`;
        nappe.blurPass.drawImage(nappe.ctx.canvas, 0, 0);
        nappe.blurPass.filter = "none";
      }
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 1;
      ctx.drawImage(nappe.blurPass.canvas, 0, 0, width, height);
    }
  }

  // Blinders : couche permanente, elle ne suit pas le fondu de scène, sinon
  // l'impact d'un drop s'éteindrait au moment précis où il doit frapper.
  ctx.globalCompositeOperation = "lighter";
  dessinerBlinders(ctx, permanent, view, settings.flashes);
  dessinerGrosBlinders(ctx, permanent, view, settings.flashes);

  // Bordure LED : dessinée APRÈS la vignette (plus bas), pour ne pas être
  // assombrie sur les bords de l'écran.

  drawDust(ctx, permanent);

  const fullStrobeAllowed = !hard || hardStrobeAllowsFull(base);
  const flash = fullStrobeAllowed ? Math.max(flashAlpha(base, settings), surgeAlpha(base, settings)) : 0;
  // En direct, il n'y a pas de grille de temps forts dans la vue : c'est la
  // direction musicale qui dit si un flash peut naître (impact toujours, temps
  // fort une fois sur deux).
  const admitted = liveMusic !== undefined ? liveMusic.admitted : flashAdmitted(view, t, hard, dynamic);
  if (flash > 0.002 && admitted) {
    const strength = flash * (0.5 + 0.5 * mix(0.7, 1, base.energy));
    // Flash de temps fort rave ou concert : la couleur principale du morceau,
    // jamais du blanc, et jamais une alternance d'une image à l'autre.
    ctx.fillStyle =
      hard || dynamic
        ? paint(base.palette.hue, 1, 0.6, strength)
        : `rgba(255,255,255,${strength.toFixed(3)})`;
    ctx.fillRect(0, 0, width, height);
  }
  // Stroboscope hard ou concert : la couche qui fait vraiment « clignoter » le
  // profil. Elle s'ajoute au flash de temps fort, sans dépendre de
  // `flashAdmitted`, car elle bat plusieurs fois à l'intérieur d'un même temps.
  const strobe = Math.max(
    hardStrobeAlpha(base, settings, drop),
    dynamicStrobeAlpha(base, settings, drop),
  );
  if (strobe > 0.002) {
    // Un seul éclat, une seule couleur : la couleur principale du morceau. On
    // ne bascule plus sur la complémentaire à chaque flash, sinon la teinte
    // change toutes les demi-secondes.
    ctx.fillStyle = paint(base.palette.hue, 1, 0.62, strobe);
    ctx.fillRect(0, 0, width, height);
  }

  // Vignette : garde la composition lisible même quand tout s'allume.
  const vignette = vignetteFor(ctx, width, height);
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);

  // Le lavage blanc d'impact, le strobe et la vignette sont passés : les
  // confettis et le CO2 se dessinent maintenant au-dessus, sinon la vignette
  // assombrissait justement les bords où sont les jets.
  const raveBurst = hard
    ? Math.max(drop, clamp01(base.energy * 0.85 + base.beat * 0.55))
    : drop;
  drawRaveConfetti(ctx, base, raveBurst);
  // Le CO2 reste réservé aux impacts : pas de canons qui crachent en continu.
  drawRaveCo2(ctx, base, drop);

  // La bordure LED passe en dernier : collée au bord, elle doit rester nette et
  // pleine au lieu d'être mangée par la vignette.
  ctx.globalCompositeOperation = "lighter";
  dessinerBordure(ctx, permanent, view, settings.flashes);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;

  // Les paroles passent au-dessus de tout : texte net, jamais fondu dans les
  // faisceaux. Absent du payload (morceau sans paroles), rien n'est dessiné.
  const lyrics = view.analysis.lyrics;
  if (lyrics !== undefined && lyrics.lines.length > 0) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawLyrics(ctx, lyrics, t, width, height, { palette, reduced, beat });
  }
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
