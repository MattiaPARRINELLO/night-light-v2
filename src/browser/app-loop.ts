/**
 * Boucle de rendu du show local, qualité adaptative, nappes de fumée,
 * transitions et HUD. Méthodes greffées sur `App` (voir le commentaire
 * d'en-tête de `app.ts`).
 */

import type { App } from "./app";
import type { HazeLayer, HazeTarget } from "../core/families";
import { drawTransition, renderFrame, sceneHue, variationStrength } from "../core/render";
import { clamp, formatTime, quantizeQuality } from "../core/series";
import { FAMILY_LABELS, MOOD_LABELS, SCENE_REASON_LABELS, buildShowPlan, sceneAt, type ShowPlan } from "../core/show";
import { el } from "./ui";

/**
 * Nombre d'images pendant lesquelles un palier de qualité doit être demandé
 * avant d'être adopté. Sans ce délai, un fps qui oscille autour d'une frontière
 * fait basculer le rendu d'un palier à l'autre en permanence.
 */
const QUALITY_HOLD_FRAMES = 24;
const SECTION_LABELS: Record<string, string> = {
  calme: "Passage calme",
  montee: "Montée",
  intense: "Impact",
  descente: "Descente",
  silence: "Silence",
};

/** Prépare une nappe de fumée à partir de ses deux surfaces de travail. */
function preparerNappe(canvases: readonly [HTMLCanvasElement, HTMLCanvasElement]): HazeLayer | undefined {
  const ctx = canvases[0].getContext("2d");
  const blurPass = canvases[1].getContext("2d");
  if (ctx === null || blurPass === null) return undefined;
  return { ctx, blurPass, scale: 1, used: false };
}

/**
 * Donne à une nappe sa résolution, sans la recréer si elle est déjà bonne.
 *
 * Redimensionner une toile efface tout et réalloue : on ne le fait donc que
 * lorsque la fenêtre ou le palier de qualité change.
 */
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

declare module "./app" {
  interface App {
    hazeFor(quality: number, width: number, height: number): HazeTarget | undefined;
    startLoop(): void;
    updateQuality(): void;
    stopLoop(): void;
    tick(): void;
    beginTransition(durationMs?: number): void;
    drawTransitionIfNeeded(time: number, plan: ShowPlan): void;
    renderAt(time: number): void;
    updateHud(): void;
    syncTrackLabels(): void;
  }
}

export function installLoop(Target: { prototype: App }): void {
  /**
   * Nappes de fumée, créées une fois et conservées.
   *
   * Elles sont en basse résolution — c'est tout leur intérêt — et leurs
   * dimensions suivent donc le palier de qualité et la taille de la fenêtre.
   * Elles ne sont redimensionnées que lorsque l'un des deux change.
   */
  Target.prototype.hazeFor = function (this: App, quality: number, width: number, height: number): HazeTarget | undefined {
    if (this.haze === undefined) {
      const fine = preparerNappe(this.hazeCanvases.fine);
      const large = preparerNappe(this.hazeCanvases.large);
      if (fine === undefined || large === undefined) return undefined;
      this.haze = { fine, large };
    }
    // La nappe fine garde plus de résolution : un trait de sept pixels au
    // dixième de sa taille n'existe plus.
    dimensionnerNappe(this.haze.fine, quality >= 0.6 ? 0.6 : 0.45, width, height);
    dimensionnerNappe(this.haze.large, quality >= 0.9 ? 0.5 : quality >= 0.6 ? 0.4 : 0.32, width, height);
    return this.haze;
  };

  Target.prototype.startLoop = function (this: App): void {
    if (this.rafId !== 0) return;
    this.lastTs = 0;
    const loop = (timestamp: number) => {
      this.rafId = requestAnimationFrame(loop);
      if (this.lastTs === 0) {
        this.lastTs = timestamp;
        return;
      }
      const delta = timestamp - this.lastTs;
      this.lastTs = timestamp;
      if (delta > 0) {
        const instant = 1000 / delta;
        this.fps += (instant - this.fps) * 0.06;
        this.updateQuality();
        // La résolution du canvas dépend de la qualité : sans ce rappel, un
        // passage sous la barre des 0,5 ne changerait jamais le dpr et le
        // spectacle continuerait à rendre en haute résolution alors qu'il rame.
        const band = this.quality < 0.5;
        if (band !== this.qualityBand) {
          this.qualityBand = band;
          this.resize();
        }
      }
      this.tick();
    };
    this.rafId = requestAnimationFrame(loop);
  };

  /**
   * Qualité réduite à des paliers, avec hystérésis.
   *
   * Le fps varie en continu ; en le passant tel quel au rendu, chaque
   * variation changeait le nombre d'éléments dessinés de 1 à 3 unités. Les
   * familles calculant leurs positions par `i / n`, tout se décalait d'un coup :
   * le spectacle « sautait » d'une image à l'autre, sur tous les types de scène.
   * Un palier n'est adopté que s'il est demandé sans interruption pendant
   * `QUALITY_HOLD_FRAMES`, ce qui supprime les bascules intempestives.
   */
  Target.prototype.updateQuality = function (this: App): void {
    const wanted = quantizeQuality(this.fps / 52);
    if (wanted === this.quality) {
      this.qualityHold = 0;
      return;
    }
    // Urgence : sous trente images par seconde, on descend tout de suite. Le
    // délai de garde évite d'osciller entre deux paliers au repos, mais à cinq
    // images par seconde il représenterait huit secondes de saccade.
    if (wanted < this.quality && this.fps < 30) {
      this.quality = wanted;
      this.qualityHold = 0;
      return;
    }
    this.qualityHold += 1;
    if (this.qualityHold < QUALITY_HOLD_FRAMES) return;
    this.quality = wanted;
    this.qualityHold = 0;
  };

  Target.prototype.stopLoop = function (this: App): void {
    if (this.rafId !== 0) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  };

  Target.prototype.tick = function (this: App): void {
    const view = this.view;
    const plan = this.plan;
    if (view === null || plan === null) return;
    this.renderAt(this.audio.currentTime);
    this.updateHud();
  };

  /**
   * Déclenche une ouverture depuis le noir. Utilisée à chaque changement de
   * nature du spectacle : entrée dans le show programmé, retour au direct,
   * lancement du show local.
   */
  Target.prototype.beginTransition = function (this: App, durationMs = 1500): void {
    this.transitionStart = performance.now();
    this.transitionDuration = Math.max(200, durationMs);
  };

  /**
   * Ouvre l'image : voile noir qui se lève, avec un front lumineux qui balaie.
   * Appelée après chaque rendu, pendant la transition uniquement.
   */
  Target.prototype.drawTransitionIfNeeded = function (this: App, time: number, plan: ShowPlan): void {
    if (this.transitionStart === 0) return;
    const progress = (performance.now() - this.transitionStart) / this.transitionDuration;
    if (progress >= 1) {
      this.transitionStart = 0;
      return;
    }
    const scene = sceneAt(plan, Math.max(0, time));
    drawTransition(this.ctx, this.canvas.clientWidth, this.canvas.clientHeight, progress, scene.palette.hue);
  };

  Target.prototype.renderAt = function (this: App, time: number): void {
    const view = this.view;
    const plan = this.plan;
    if (view === null || plan === null) return;
    const clamped = clamp(time, 0, view.duration);
    try {
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      renderFrame({
        ctx: this.ctx,
        width: this.canvas.clientWidth,
        height: this.canvas.clientHeight,
        dpr: this.canvas.width / Math.max(1, this.canvas.clientWidth),
        time: clamped,
        view,
        plan,
        settings: this.settings,
        reducedMotion: this.reducedMotion,
        quality: this.quality,
        frame: this.frame,
        haze: this.hazeFor(this.quality, this.canvas.clientWidth, this.canvas.clientHeight),
      });
      this.frame += 1;
      this.drawTransitionIfNeeded(clamped, plan);
    } catch (error) {
      // Le rendu a échoué : on descend d'un palier. La valeur reste quantifiée,
      // sinon le nombre d'éléments recommencerait à varier à chaque image.
      this.quality = quantizeQuality(this.quality * 0.7);
      console.error("Rendu interrompu", error);
    }
  };

  Target.prototype.updateHud = function (this: App): void {
    const now = performance.now();
    if (now - this.lastHudUpdate < 90) return;
    this.lastHudUpdate = now;
    const view = this.view;
    if (view === null) return;
    const t = this.audio.currentTime;
    if (!this.seeking) {
      const ratio = view.duration > 0 ? clamp(t / view.duration, 0, 1) : 0;
      el<HTMLInputElement>("seek").value = String(Math.round(ratio * 1000));
    }
    el<HTMLElement>("time-current").textContent = formatTime(t);
    const section = view.sectionAt(t);
    const scene = sceneAt(this.plan ?? buildShowPlan(view.analysis, this.effectiveReduced()), t);
    const label = SECTION_LABELS[section.label] ?? section.label;
    // La teinte affichée est celle réellement dessinée (même fonction, mêmes
    // entrées) : avant, le HUD recalculait sa propre dérive et annonçait une
    // couleur qui n'était pas à l'écran.
    const drop = view.buildIntensity(t);
    const variation = this.effectiveReduced() ? 0 : variationStrength(scene, t);
    const hue = sceneHue(scene, t, drop, variation, this.effectiveReduced());
    const moment = drop > 0.5 ? "impact" : variation > 0.4 ? "variation" : MOOD_LABELS[scene.mood];
    el<HTMLElement>("section-label").textContent =
      `${label} · ${SCENE_REASON_LABELS[scene.reason]} · ${moment} · ` +
      `${FAMILY_LABELS[scene.family]} · ${Math.round(hue)}°`;
    el<HTMLElement>("hud-stats").textContent =
      `${view.tempo.toFixed(1)} BPM · énergie ${(view.energyAt(t) * 100).toFixed(0)} % · ` +
      `basses ${(view.bassAt(t) * 100).toFixed(0)} % · aigus ${(view.highAt(t) * 100).toFixed(0)} % · ` +
      `${this.fps.toFixed(0)} fps`;
  };

  Target.prototype.syncTrackLabels = function (this: App): void {
    const view = this.view;
    if (view === null) return;
    const duration = this.audio.duration || view.duration;
    el<HTMLElement>("time-total").textContent = formatTime(duration);
  };
}
