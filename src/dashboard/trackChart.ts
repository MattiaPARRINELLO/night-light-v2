/**
 * Tracé interactif du morceau courant.
 *
 * Trois problèmes rendaient ce tableau poussif :
 *
 *  1. il était entièrement redessiné à chaque message du show (5 fois par
 *     seconde), courbes comprises — le trait frémissait au lieu de couler ;
 *  2. le curseur du show avançait par bonds de 200 ms, alors que le reste de
 *     l'écran tourne à 60 images par seconde ;
 *  3. la zone était muette : impossible de savoir quelle valeur se cache sous
 *     un point, ni de regarder un passage de près.
 *
 * D'où la structure : un fond (sections, courbes, grille, règle) dessiné une
 * seule fois dans une image hors écran, puis un calque léger redessiné à chaque
 * image — curseur du show interpolé, réticule de survol, fenêtre de zoom. Le
 * survol, la molette et le glisser travaillent sur cette même fenêtre.
 */

import type { Analysis, Point, Section, SectionLabel } from "../types";
import { fmtTime, sampleCurve } from "./format";

const PAD_LEFT = 58;
const PAD_RIGHT = 30;
/** Zoom maximal : deux secondes visibles, de quoi lire une mesure. */
const MIN_SPAN = 2;
/** Au-delà, l'écart n'est plus un frémissement mais un saut : on recale net. */
const SNAP_MS = 1500;
/** Durée du rattrapage doux quand la position reçue corrige l'interpolation. */
const CORRECTION_MS = 420;

const PALETTE: Record<SectionLabel, { fill: string; line: string }> = {
  calme: { fill: "rgba(90, 140, 220, 0.30)", line: "rgba(120, 170, 240, 0.95)" },
  montee: { fill: "rgba(255, 180, 90, 0.30)", line: "rgba(255, 190, 110, 0.95)" },
  intense: { fill: "rgba(255, 100, 140, 0.32)", line: "rgba(255, 120, 160, 0.95)" },
  descente: { fill: "rgba(150, 200, 160, 0.28)", line: "rgba(160, 220, 180, 0.9)" },
  silence: { fill: "rgba(255, 255, 255, 0.10)", line: "rgba(255, 255, 255, 0.4)" },
};

export interface TrackFrame {
  analysis: Analysis | null;
  /** Position du show au moment du message, en millisecondes. */
  showMs: number;
  /** Horodatage epoch auquel `showMs` a été produit. */
  at: number;
  /** La lecture avance-t-elle encore ? */
  playing: boolean;
  driftMs: number;
}

export interface Range {
  start: number;
  end: number;
}

interface Scene {
  analysis: Analysis;
  width: number;
  height: number;
  dpr: number;
  viewStart: number;
  viewEnd: number;
  highlight: Range | null;
  bitmap: HTMLCanvasElement;
}

interface Layout {
  left: number;
  right: number;
  usable: number;
  bandTop: number;
  bandHeight: number;
  laneY: number;
  curveTop: number;
  curveBottom: number;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function layout(w: number, h: number): Layout {
  const left = PAD_LEFT;
  const right = Math.max(left + 40, w - PAD_RIGHT);
  const bandHeight = clamp(h * 0.11, 24, 40);
  const bandTop = 18;
  return {
    left,
    right,
    usable: Math.max(1, right - left),
    bandTop,
    bandHeight,
    laneY: bandTop + bandHeight + 16,
    curveTop: bandTop + bandHeight + 28,
    curveBottom: Math.max(bandTop + bandHeight + 60, h - 62),
  };
}

function sameRange(a: Range | null, b: Range | null): boolean {
  if (a === null || b === null) return a === b;
  return a.start === b.start && a.end === b.end;
}

/** Police courte, pour ne pas répéter la chaîne partout. */
function mono(size: number): string {
  return `${size}px ui-monospace, SFMono-Regular, monospace`;
}

/** Décalage de temps « sympa » pour la règle, selon la fenêtre visible. */
function tickStep(span: number): number {
  const candidates = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  for (const step of candidates) {
    if (span / step <= 9) return step;
  }
  return 600;
}

/** Premier index dont la valeur est ≥ `target` (tableau trié). */
function lowerBound(values: number[], target: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Sous-tableau des valeurs de `[start, end]`, un point de marge de chaque côté. */
function sliceNumbers(values: number[], start: number, end: number): number[] {
  const from = Math.max(0, lowerBound(values, start) - 1);
  const to = Math.min(values.length, lowerBound(values, end) + 1);
  return values.slice(from, to);
}

/** Sous-courbe de `[start, end]`, un point de marge de chaque côté. */
function slicePoints(curve: Point[], start: number, end: number): Point[] {
  const from = Math.max(0, lowerBoundTimes(curve, start) - 1);
  const to = Math.min(curve.length, lowerBoundTimes(curve, end) + 1);
  return curve.slice(from, to);
}

/** Premier index dont le temps est ≥ `target` (courbe triée par temps). */
function lowerBoundTimes(curve: Point[], target: number): number {
  let lo = 0;
  let hi = curve.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (curve[mid]![0] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Réduit une courbe à `max` points : au-delà, personne ne voit la différence. */
function decimate(curve: Point[], max: number): Point[] {
  if (curve.length <= max || max < 2) return curve;
  const step = Math.ceil(curve.length / max);
  const kept: Point[] = [];
  for (let index = 0; index < curve.length; index += step) kept.push(curve[index]!);
  const last = curve[curve.length - 1]!;
  if (kept[kept.length - 1] !== last) kept.push(last);
  return kept;
}

/** Fond complet : tout ce qui ne bouge qu'au changement de morceau ou de zoom. */
function renderScene(
  g: CanvasRenderingContext2D,
  w: number,
  h: number,
  analysis: Analysis,
  viewStart: number,
  viewEnd: number,
  highlight: Range | null,
): void {
  const lay = layout(w, h);
  const span = Math.max(viewEnd - viewStart, 1e-3);
  const px = (seconds: number): number => lay.left + ((seconds - viewStart) / span) * lay.usable;
  const x1Of = (seconds: number): number => clamp(px(seconds), lay.left, lay.right);

  const background = g.createLinearGradient(0, 0, 0, h);
  background.addColorStop(0, "rgba(17, 25, 45, 0.85)");
  background.addColorStop(1, "rgba(8, 12, 22, 0.9)");
  g.fillStyle = background;
  g.fillRect(0, 0, w, h);

  // ---- bande de structure, lisible en un coup d'œil
  g.font = "600 12px system-ui, sans-serif";
  for (const section of analysis.sections) {
    if (section.end < viewStart || section.start > viewEnd) continue;
    const x1 = x1Of(section.start);
    const x2 = x1Of(section.end);
    const width = Math.max(2, x2 - x1);
    const color = PALETTE[section.label] ?? PALETTE.silence;
    g.fillStyle = color.fill;
    g.fillRect(x1, lay.bandTop, width, lay.bandHeight);
    g.fillStyle = color.line;
    g.fillRect(x1, lay.bandTop, width, 3);

    const label = section.kind ?? section.label;
    g.fillStyle = "rgba(240, 245, 255, 0.92)";
    if (width > g.measureText(label).width + 12) {
      g.fillText(label, x1 + 6, lay.bandTop + lay.bandHeight - 12);
    }
  }
  g.strokeStyle = "rgba(255,255,255,0.10)";
  g.lineWidth = 1;
  g.strokeRect(lay.left, lay.bandTop, lay.usable, lay.bandHeight);

  // ---- montées (flèches) dans leur propre couloir
  for (const build of analysis.builds) {
    if (build.end < viewStart || build.start > viewEnd) continue;
    const x1 = x1Of(build.start);
    const x2 = x1Of(build.end);
    const alpha = 0.35 + build.strength * 0.6;
    g.strokeStyle = `rgba(255, 120, 165, ${alpha})`;
    g.lineWidth = 2.5;
    g.beginPath();
    g.moveTo(x1, lay.laneY);
    g.lineTo(x2, lay.laneY);
    g.stroke();
    g.beginPath();
    g.moveTo(x2, lay.laneY);
    g.lineTo(x2 - 7, lay.laneY - 5);
    g.lineTo(x2 - 7, lay.laneY + 5);
    g.closePath();
    g.fillStyle = `rgba(255, 120, 165, ${alpha})`;
    g.fill();
  }

  // ---- grille + repères
  g.font = mono(11);
  for (const level of [0, 0.25, 0.5, 0.75, 1]) {
    const y = lay.curveBottom - level * (lay.curveBottom - lay.curveTop);
    g.strokeStyle = level === 0 ? "rgba(255,255,255,0.20)" : "rgba(255,255,255,0.07)";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(lay.left, y);
    g.lineTo(lay.right, y);
    g.stroke();
    g.fillStyle = "rgba(170, 188, 220, 0.7)";
    g.fillText(level.toFixed(2), 14, y + 4);
  }

  // ---- temps forts
  const beatsVisible = sliceNumbers(analysis.beats, viewStart, viewEnd);
  const beatStep = Math.max(1, Math.ceil(beatsVisible.length / lay.usable));
  g.strokeStyle = "rgba(255,255,255,0.16)";
  g.lineWidth = 1;
  g.beginPath();
  for (let index = 0; index < beatsVisible.length; index += beatStep) {
    const x = px(beatsVisible[index]!);
    g.moveTo(x, lay.curveTop);
    g.lineTo(x, lay.curveBottom);
  }
  g.stroke();

  // ---- aire sous la courbe d'énergie
  const visible = (curve: Point[]): Point[] => decimate(slicePoints(curve, viewStart, viewEnd), Math.round(lay.usable * 2));

  const energyPoints = visible(analysis.energy);
  if (energyPoints.length > 1) {
    const area = g.createLinearGradient(0, lay.curveTop, 0, lay.curveBottom);
    area.addColorStop(0, "rgba(255, 217, 138, 0.30)");
    area.addColorStop(1, "rgba(255, 217, 138, 0.02)");
    g.fillStyle = area;
    g.beginPath();
    g.moveTo(px(energyPoints[0]![0]), lay.curveBottom);
    for (const [time, value] of energyPoints) g.lineTo(px(time), lay.curveBottom - value * (lay.curveBottom - lay.curveTop));
    g.lineTo(px(energyPoints[energyPoints.length - 1]![0]), lay.curveBottom);
    g.closePath();
    g.fill();
  }

  const stroke = (points: Point[], color: string, width: number): void => {
    if (points.length < 2) return;
    g.strokeStyle = color;
    g.lineWidth = width;
    g.beginPath();
    points.forEach(([time, value], index) => {
      const x = px(time);
      const y = lay.curveBottom - value * (lay.curveBottom - lay.curveTop);
      if (index === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    });
    g.stroke();
  };

  stroke(visible(analysis.bass), "rgba(120, 210, 255, 0.75)", 1.6);
  stroke(visible(analysis.mid), "rgba(180, 150, 255, 0.68)", 1.6);
  stroke(visible(analysis.high), "rgba(255, 170, 120, 0.68)", 1.6);
  g.save();
  g.shadowColor = "rgba(255, 217, 138, 0.85)";
  g.shadowBlur = 14;
  stroke(energyPoints, "#ffe08a", 3.2);
  g.restore();

  // ---- onsets sous les courbes
  const onsets = sliceNumbers(analysis.onsets, viewStart, viewEnd);
  const onsetStep = Math.max(1, Math.ceil(onsets.length / (lay.usable * 1.2)));
  g.fillStyle = "rgba(150, 220, 255, 0.7)";
  for (let index = 0; index < onsets.length; index += onsetStep) {
    g.beginPath();
    g.arc(px(onsets[index]!), lay.curveBottom + 7, 2, 0, Math.PI * 2);
    g.fill();
  }

  // ---- section survolée dans le tableau des sections
  if (highlight !== null) {
    const hx1 = x1Of(highlight.start);
    const hx2 = x1Of(highlight.end);
    g.fillStyle = "rgba(200, 225, 255, 0.14)";
    g.fillRect(hx1, lay.bandTop, Math.max(2, hx2 - hx1), lay.curveBottom - lay.bandTop);
    g.strokeStyle = "rgba(200, 225, 255, 0.55)";
    g.lineWidth = 1;
    g.strokeRect(hx1, lay.bandTop, Math.max(2, hx2 - hx1), lay.curveBottom - lay.bandTop);
  }

  // ---- règle temporelle, calée sur la fenêtre visible
  g.strokeStyle = "rgba(255,255,255,0.22)";
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(lay.left, lay.curveBottom + 16);
  g.lineTo(lay.right, lay.curveBottom + 16);
  g.stroke();
  g.font = mono(11);
  g.fillStyle = "rgba(200, 214, 240, 0.75)";
  const step = tickStep(span);
  for (let time = Math.ceil(viewStart / step) * step; time <= viewEnd; time += step) {
    const x = px(time);
    g.beginPath();
    g.moveTo(x, lay.curveBottom + 16);
    g.lineTo(x, lay.curveBottom + 21);
    g.stroke();
    const label = fmtTime(time);
    g.fillText(label, x - g.measureText(label).width / 2, lay.curveBottom + 36);
  }
}

/** Rôle lisible d'une section : « refrain n°2 », « pont »… */
function sectionTitle(section: Section | null): string {
  if (section === null) return "hors section";
  const kind = section.kind ?? section.label;
  return section.occurrence ? `${kind} n°${section.occurrence}` : kind;
}

/**
 * Associe le tableau de bord au canvas, et pilote tout le cycle de dessin.
 *
 * Le tracé garde sa propre boucle d'animation : il n'attend plus le prochain
 * message du show pour avancer, il extrapole la position entre deux messages et
 * rattrape les écarts en douceur.
 */
export class TrackChart {
  private readonly canvas: HTMLCanvasElement;
  private readonly host: HTMLElement;
  private readonly tooltip: HTMLElement;
  private readonly badge: HTMLElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly resizeObserver: ResizeObserver;
  /** Appelé à chaque image avec la position de show lissée, en secondes. */
  private readonly onPosition: (seconds: number) => void;

  private frame: TrackFrame = { analysis: null, showMs: 0, at: 0, playing: false, driftMs: 0 };
  private scene: Scene | null = null;
  private view: Range | null = null;
  private highlight: Range | null = null;
  private hover: { time: number } | null = null;
  private drag: { pointerId: number; startX: number; startView: Range } | null = null;

  private width = 0;
  private height = 0;
  private dpr = 1;

  private baseMs = 0;
  private baseAt = 0;
  private correctionMs = 0;
  private correctionAt = 0;
  private correctionDur = 1;
  private rate = 0;
  private started = false;

  private dirty = true;

  private readonly onPointerMove = (event: PointerEvent): void => this.pointerMove(event);
  private readonly onPointerDown = (event: PointerEvent): void => this.pointerDown(event);
  private readonly onPointerUp = (event: PointerEvent): void => this.pointerUp(event);
  private readonly onPointerLeave = (): void => this.pointerLeave();
  private readonly onWheel = (event: WheelEvent): void => this.wheel(event);
  private readonly onDoubleClick = (): void => this.resetZoom();
  private readonly onKeyDown = (event: KeyboardEvent): void => this.keyDown(event);

  constructor(
    canvas: HTMLCanvasElement,
    host: HTMLElement,
    tooltip: HTMLElement,
    badge: HTMLElement,
    onPosition: (seconds: number) => void,
  ) {
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("Canvas 2D indisponible pour le tracé du morceau.");
    this.canvas = canvas;
    this.host = host;
    this.tooltip = tooltip;
    this.badge = badge;
    this.ctx = ctx;
    this.onPosition = onPosition;

    this.resizeObserver = new ResizeObserver(() => this.measure());
    this.resizeObserver.observe(host);
    this.measure();

    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("dblclick", this.onDoubleClick);
    canvas.addEventListener("keydown", this.onKeyDown);

    requestAnimationFrame(this.loop);
  }

  /** Nouvel état du show : on recale l'interpolation sans casser le mouvement. */
  setFrame(frame: TrackFrame): void {
    const sameTrack = this.frame.analysis === frame.analysis;
    this.frame = frame;
    this.rate = frame.playing ? 1 : 0;
    const now = Date.now();
    if (!this.started || !sameTrack) {
      // Nouveau morceau : le zoom et la surbrillance de l'ancien n'ont plus de sens.
      this.view = null;
      this.highlight = null;
      this.hover = null;
      this.hideTooltip();
      this.updateBadge();
      this.dirty = true;
      this.baseMs = frame.showMs;
      this.baseAt = now;
      this.correctionMs = 0;
      this.started = true;
    } else {
      const predicted = this.showPosition(now);
      const delta = frame.showMs - predicted;
      if (Math.abs(delta) > SNAP_MS) {
        this.baseMs = frame.showMs;
        this.baseAt = now;
        this.correctionMs = 0;
      } else {
        // La correction repart de la position affichée : pas de marche d'escalier.
        this.baseMs = predicted;
        this.baseAt = now;
        this.correctionMs = delta;
        this.correctionAt = now;
        this.correctionDur = CORRECTION_MS;
      }
    }
    this.dirty = true;
  }

  /** Surbrillance d'un passage (survol d'une ligne du tableau des sections). */
  setHighlight(range: Range | null): void {
    if (sameRange(this.highlight, range)) return;
    this.highlight = range;
    this.dirty = true;
  }

  /** Revenir à la vue complète du morceau. */  resetZoom(): void {
    if (this.view === null) return;
    this.view = null;
    this.updateBadge();
    this.dirty = true;
  }

  /** Cadrer un passage précis (clic sur une ligne du tableau des sections). */
  focusRange(start: number, end: number): void {
    const duration = this.duration();
    if (this.frame.analysis === null) return;
    const pad = Math.max((end - start) * 0.12, 0.5);
    const span = clamp(end - start + pad * 2, MIN_SPAN, duration);
    const centre = (start + end) / 2;
    const viewStart = clamp(centre - span / 2, 0, Math.max(0, duration - span));
    this.view = { start: viewStart, end: viewStart + span };
    this.updateBadge();
    this.dirty = true;
  }

  // --------------------------------------------------------------- géométrie

  private measure(): void {
    const rect = this.host.getBoundingClientRect();
    const dpr = clamp(window.devicePixelRatio || 1, 1, 2.5);
    const width = Math.max(320, Math.round(rect.width));
    const height = Math.max(180, Math.round(rect.height));
    if (width === this.width && height === this.height && dpr === this.dpr) return;
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.dirty = true;
  }

  private duration(): number {
    return Math.max(this.frame.analysis?.duration ?? 0, 0.001);
  }

  private activeView(): Range {
    const full = { start: 0, end: this.duration() };
    if (this.view === null) return full;
    return {
      start: clamp(this.view.start, 0, Math.max(0, full.end - MIN_SPAN)),
      end: clamp(this.view.end, MIN_SPAN, full.end),
    };
  }

  private timeAt(clientX: number): number {
    const rect = this.canvas.getBoundingClientRect();
    const lay = layout(this.width, this.height);
    const view = this.activeView();
    const ratio = clamp((clientX - rect.left - lay.left) / lay.usable, 0, 1);
    return view.start + ratio * (view.end - view.start);
  }

  // ------------------------------------------------------------ interpolation

  /**
   * Position du show à l'instant `now`, extrapolée depuis le dernier message et
   * corrigée en douceur : c'est cette valeur, et non la position brute, qui est
   * dessinée, ce qui fait couler le curseur au lieu de le faire sauter.
   */
  private showPosition(now: number): number {
    if (this.correctionMs !== 0) {
      const elapsed = now - this.correctionAt;
      if (elapsed >= this.correctionDur) {
        // Terminé : la correction est intégrée à l'origine, la valeur ne bouge pas.
        this.baseMs += this.correctionMs;
        this.correctionMs = 0;
      } else {
        const x = clamp(elapsed / this.correctionDur, 0, 1);
        const eased = 1 - (1 - x) ** 3;
        return this.baseMs + this.rate * (now - this.baseAt) + this.correctionMs * eased;
      }
    }
    return this.baseMs + this.rate * (now - this.baseAt);
  }

  // ---------------------------------------------------------------- boucle

  private readonly loop = (): void => {
    requestAnimationFrame(this.loop);
    const now = Date.now();
    const animating =
      this.frame.playing || this.hover !== null || this.drag !== null || this.correctionMs !== 0 || this.dirty;
    if (!animating) return;
    this.dirty = false;
    this.draw(now);
  };

  private ensureScene(): Scene | null {
    const analysis = this.frame.analysis;
    if (analysis === null) return null;
    const view = this.activeView();
    const current = this.scene;
    if (
      current !== null &&
      current.analysis === analysis &&
      current.width === this.width &&
      current.height === this.height &&
      current.dpr === this.dpr &&
      current.viewStart === view.start &&
      current.viewEnd === view.end &&
      sameRange(current.highlight, this.highlight)
    ) {
      return current;
    }

    const bitmap = document.createElement("canvas");
    bitmap.width = Math.round(this.width * this.dpr);
    bitmap.height = Math.round(this.height * this.dpr);
    const g = bitmap.getContext("2d");
    if (g === null) return null;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    renderScene(g, this.width, this.height, analysis, view.start, view.end, this.highlight);

    this.scene = {
      analysis,
      width: this.width,
      height: this.height,
      dpr: this.dpr,
      viewStart: view.start,
      viewEnd: view.end,
      highlight: this.highlight,
      bitmap,
    };
    return this.scene;
  }

  private draw(now: number): void {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (this.frame.analysis === null) {
      ctx.fillStyle = "rgba(200, 210, 235, 0.75)";
      ctx.font = "600 16px system-ui, sans-serif";
      ctx.fillText("Aucune analyse chargée — dépose un morceau ou lance une recherche.", 24, h / 2);
      this.hideTooltip();
      return;
    }

    const scene = this.ensureScene();
    if (scene !== null) ctx.drawImage(scene.bitmap, 0, 0, w, h);

    const contributing = this.frame.playing || this.correctionMs !== 0 || this.drag !== null;
    const seconds = clamp(this.showPosition(now) / 1000, 0, this.duration());
    if (contributing) this.onPosition(seconds);

    const lay = layout(w, h);
    const view = this.activeView();
    const px = (t: number): number => lay.left + ((t - view.start) / (view.end - view.start)) * lay.usable;

    this.drawCursor(ctx, lay, px, seconds, view);
    this.drawHover(ctx, lay, px, view);
    this.updateBadge();
  }

  private drawCursor(
    ctx: CanvasRenderingContext2D,
    lay: Layout,
    px: (t: number) => number,
    seconds: number,
    view: Range,
  ): void {
    const inView = seconds >= view.start && seconds <= view.end;
    const x = clamp(px(seconds), lay.left, lay.right);

    if (!inView) {
      // La tête de lecture est hors de la fenêtre : une flèche sur le bord dit de quel côté.
      const left = seconds < view.start;
      ctx.fillStyle = "rgba(143, 240, 196, 0.9)";
      ctx.beginPath();
      ctx.moveTo(left ? lay.left : lay.right, lay.curveTop + 40);
      ctx.lineTo(left ? lay.left + 10 : lay.right - 10, lay.curveTop + 34);
      ctx.lineTo(left ? lay.left + 10 : lay.right - 10, lay.curveTop + 46);
      ctx.closePath();
      ctx.fill();
      return;
    }

    ctx.strokeStyle = "rgba(143, 240, 196, 0.9)";
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x, lay.bandTop - 6);
    ctx.lineTo(x, lay.curveBottom + 18);
    ctx.stroke();
    ctx.fillStyle = "rgba(143, 240, 196, 0.22)";
    ctx.fillRect(lay.left, lay.bandTop, Math.max(0, x - lay.left), lay.bandHeight);

    const tag = `${fmtTime(seconds)}  show`;
    ctx.font = "600 11px system-ui, sans-serif";
    const tagWidth = ctx.measureText(tag).width + 14;
    const tagX = Math.min(Math.max(x - tagWidth / 2, lay.left), lay.right - tagWidth);
    ctx.fillStyle = "rgba(143, 240, 196, 0.95)";
    ctx.fillRect(tagX, lay.bandTop - 24, tagWidth, 18);
    ctx.fillStyle = "#04070c";
    ctx.fillText(tag, tagX + 7, lay.bandTop - 11);
  }

  private drawHover(
    ctx: CanvasRenderingContext2D,
    lay: Layout,
    px: (t: number) => number,
    view: Range,
  ): void {
    const hover = this.hover;
    if (hover === null || this.frame.analysis === null || this.drag !== null) {
      this.hideTooltip();
      return;
    }
    const analysis = this.frame.analysis;
    const time = clamp(hover.time, view.start, view.end);
    const x = clamp(px(time), lay.left, lay.right);

    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x, lay.bandTop);
    ctx.lineTo(x, lay.curveBottom + 12);
    ctx.stroke();
    ctx.restore();

    const energy = sampleCurve(analysis.energy, time);
    const y = lay.curveBottom - energy * (lay.curveBottom - lay.curveTop);
    ctx.fillStyle = "rgba(255, 224, 138, 0.95)";
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fill();

    const section = analysis.sections.find((entry) => time >= entry.start && time < entry.end) ?? null;
    const build = analysis.builds.find((entry) => time >= entry.start && time <= entry.end) ?? null;
    const row = (label: string, value: string): string =>
      `<span class="tt-label">${label}</span><span class="tt-value">${value}</span>`;

    this.tooltip.innerHTML =
      `<b class="tt-time">${fmtTime(time)}</b>` +
      `<div class="tt-grid">` +
      row("section", sectionTitle(section)) +
      row("énergie", energy.toFixed(2)) +
      row("basses", sampleCurve(analysis.bass, time).toFixed(2)) +
      row("médiums", sampleCurve(analysis.mid, time).toFixed(2)) +
      row("aigus", sampleCurve(analysis.high, time).toFixed(2)) +
      row("montée", build === null ? "—" : `force ${(build.strength * 100).toFixed(0)} %`) +
      `</div>`;
    this.tooltip.hidden = false;

    const ttWidth = this.tooltip.offsetWidth;
    const ttHeight = this.tooltip.offsetHeight;
    const ttX = clamp(x - ttWidth / 2, 6, Math.max(6, this.width - ttWidth - 6));
    const ttY = y - ttHeight - 14 < 4 ? clamp(y + 16, 4, this.height - ttHeight - 4) : y - ttHeight - 14;
    this.tooltip.style.transform = `translate(${ttX.toFixed(1)}px, ${ttY.toFixed(1)}px)`;
  }

  private hideTooltip(): void {
    if (!this.tooltip.hidden) this.tooltip.hidden = true;
  }

  private updateBadge(): void {
    const view = this.activeView();
    const zoomed = this.view !== null;
    this.badge.hidden = !zoomed;
    if (zoomed) {
      const label = `${fmtTime(view.start)} – ${fmtTime(view.end)} · double-clic pour tout revoir`;
      if (this.badge.textContent !== label) this.badge.textContent = label;
    }
  }

  // ------------------------------------------------------------- interactions

  private pointerMove(event: PointerEvent): void {
    if (this.frame.analysis === null) return;
    if (this.drag !== null && event.pointerId === this.drag.pointerId) {
      const lay = layout(this.width, this.height);
      const span = this.drag.startView.end - this.drag.startView.start;
      const shiftSeconds = ((event.clientX - this.drag.startX) / lay.usable) * span;
      const start = clamp(this.drag.startView.start - shiftSeconds, 0, this.duration() - span);
      this.view = { start, end: start + span };
      this.dirty = true;
      return;
    }
    this.hover = { time: this.timeAt(event.clientX) };
    this.dirty = true;
  }

  private pointerDown(event: PointerEvent): void {
    if (this.frame.analysis === null) return;
    this.canvas.setPointerCapture(event.pointerId);
    this.drag = { pointerId: event.pointerId, startX: event.clientX, startView: this.activeView() };
    this.canvas.classList.add("is-panning");
  }

  private pointerUp(event: PointerEvent): void {
    if (this.drag === null || event.pointerId !== this.drag.pointerId) return;
    this.canvas.releasePointerCapture(event.pointerId);
    this.drag = null;
    this.canvas.classList.remove("is-panning");
    this.dirty = true;
  }

  private pointerLeave(): void {
    if (this.drag !== null) return;
    this.hover = null;
    this.hideTooltip();
    this.dirty = true;
  }

  /** Molette : zoom sur l'axe du temps, ancré sous le curseur. */
  private wheel(event: WheelEvent): void {
    if (this.frame.analysis === null) return;
    event.preventDefault();
    const view = this.activeView();
    const anchor = clamp(this.timeAt(event.clientX), view.start, view.end);
    const factor = Math.exp(clamp(event.deltaY, -400, 400) * 0.0015);
    const span = clamp((view.end - view.start) * factor, MIN_SPAN, this.duration());
    const ratio = (anchor - view.start) / Math.max(view.end - view.start, 1e-6);
    const start = clamp(anchor - ratio * span, 0, this.duration() - span);
    this.view = { start, end: start + span };
    this.dirty = true;
  }

  /** Clavier : ←/→ pour se déplacer, +/− pour zoomer, 0 pour tout revoir. */
  private keyDown(event: KeyboardEvent): void {
    if (this.frame.analysis === null) return;
    const view = this.activeView();
    const span = view.end - view.start;
    let handled = true;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowRight": {
        const direction = event.key === "ArrowLeft" ? -1 : 1;
        const shift = clamp(span * 0.15 * direction, -view.start, this.duration() - view.end);
        this.view = { start: view.start + shift, end: view.end + shift };
        break;
      }
      case "+":
      case "=":
      case "-": {
        const factor = event.key === "-" ? 1.4 : 1 / 1.4;
        const nextSpan = clamp(span * factor, MIN_SPAN, this.duration());
        const centre = (view.start + view.end) / 2;
        const start = clamp(centre - nextSpan / 2, 0, this.duration() - nextSpan);
        this.view = { start, end: start + nextSpan };
        break;
      }
      case "0":
      case "Home":
        this.view = null;
        break;
      default:
        handled = false;
    }
    if (!handled) return;
    event.preventDefault();
    this.dirty = true;
  }
}
