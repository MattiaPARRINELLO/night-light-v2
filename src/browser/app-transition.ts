/**
 * Fondus entre les deux couches d'image : le direct (`live`) et le show.
 *
 * Une seule mécanique sert les trois passages : entrée dans un show depuis le
 * direct, sortie du show vers le direct à la fin d'un morceau, et réorientation
 * d'un fondu déjà en cours quand le morceau suivant arrive avant la fin du
 * précédent. Sortir d'un fondu par un autre, c'est repartir de l'image
 * réellement affichée à cet instant (une copie figée) : aucune coupe, même au
 * milieu d'un fondu.
 *
 * Méthodes greffées sur `App` (voir le commentaire d'en-tête de `app.ts`).
 */

import type { App, CrossfadeState, FadeLayer } from "./app";
import { clamp01 } from "../core/series";

declare module "./app" {
  interface App {
    createCrossfade(
      from: FadeLayer | "snapshot",
      to: FadeLayer,
      durationMs: number,
      options?: { delayMs?: number; source?: HTMLCanvasElement | null },
    ): CrossfadeState | null;
    fadeTarget(layer: FadeLayer): CanvasRenderingContext2D;
    resizeCrossfade(): void;
    composeCrossfade(): void;
    finishCrossfade(): void;
    cancelCrossfade(): void;
  }
}

/** Une surface hors écran et son contexte, ou `null` si le navigateur refuse. */
function fadeSurface(
  width: number,
  height: number,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  return ctx === null ? null : { canvas, ctx };
}

/** Recopie une image en l'étirant sur toute la surface (aucune déformation croisée). */
function fillSurface(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  width: number,
  height: number,
): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0, width, height);
}

export function installTransition(Target: { prototype: App }): void {
  /**
   * Prépare un fondu de `from` vers `to`.
   *
   * Avec `delayMs`, la couche sortante continue d'être rendue en direct et
   * l'image affichée est copiée au moment où le fondu démarre — c'est le
   * décalage sur le temps fort de l'entrée en show. Sans délai, le fondu
   * démarre à l'image courante. `source` impose la copie de départ.
   */
  Target.prototype.createCrossfade = function (
    this: App,
    from: FadeLayer | "snapshot",
    to: FadeLayer,
    durationMs: number,
    options: { delayMs?: number; source?: HTMLCanvasElement | null } = {},
  ): CrossfadeState | null {
    const width = Math.max(1, this.canvas.width);
    const height = Math.max(1, this.canvas.height);
    const sortie = fadeSurface(width, height);
    const entree = fadeSurface(width, height);
    if (sortie === null || entree === null) return null;
    const source = options.source ?? null;
    const delayMs = Math.max(0, options.delayMs ?? 0);
    const state: CrossfadeState = {
      active: delayMs === 0,
      startedAt: performance.now(),
      durationMs: Math.max(120, durationMs),
      from,
      to,
      fromCanvas: sortie.canvas,
      fromCtx: sortie.ctx,
      toCanvas: entree.canvas,
      toCtx: entree.ctx,
      fromPlan: null,
      timer: null,
    };
    if (source !== null) fillSurface(sortie.ctx, source, width, height);
    this.crossfade = state;
    if (delayMs > 0) {
      state.timer = window.setTimeout(() => {
        state.timer = null;
        if (this.crossfade !== state) return;
        // Les surfaces ont pu être redimensionnées pendant l'attente : on les
        // recale sur la toile avant de figer l'image de départ.
        const largeur = Math.max(1, this.canvas.width);
        const hauteur = Math.max(1, this.canvas.height);
        if (sortie.canvas.width !== largeur || sortie.canvas.height !== hauteur) {
          sortie.canvas.width = largeur;
          sortie.canvas.height = hauteur;
          entree.canvas.width = largeur;
          entree.canvas.height = hauteur;
        }
        if (source === null) fillSurface(sortie.ctx, this.canvas, largeur, hauteur);
        state.active = true;
        state.startedAt = performance.now();
      }, delayMs);
    } else if (source === null) {
      // Fondu immédiat depuis une couche encore rendue : l'image de départ est
      // celle qui est à l'écran maintenant.
      fillSurface(sortie.ctx, this.canvas, width, height);
    }
    return state;
  };

  /**
   * Surface sur laquelle une couche doit dessiner.
   *
   * Pendant un fondu actif, la couche concernée rend hors écran ; les autres
   * continuent sur la toile principale, qui sera de toute façon recouverte par
   * la composition.
   */
  Target.prototype.fadeTarget = function (this: App, layer: FadeLayer): CanvasRenderingContext2D {
    const fade = this.crossfade;
    if (fade !== null && fade.active) {
      if (fade.from === layer) return fade.fromCtx;
      if (fade.to === layer) return fade.toCtx;
    }
    return this.ctx;
  };

  /**
   * Recale les surfaces du fondu sur la taille réelle de la toile.
   *
   * Trois choses changent la taille du canvas en pleine transition : le passage
   * du mode ambiance au mode spectacle, un palier de qualité, un
   * redimensionnement de fenêtre. Sans ce recalage, les couches hors écran
   * gardaient leurs anciennes dimensions et le spectacle rendu dedans
   * n'occupait plus qu'un coin de l'image composée.
   */
  Target.prototype.resizeCrossfade = function (this: App): void {
    const fade = this.crossfade;
    if (fade === null) return;
    const width = Math.max(1, this.canvas.width);
    const height = Math.max(1, this.canvas.height);
    const surfaces = [
      { canvas: fade.fromCanvas, ctx: fade.fromCtx },
      { canvas: fade.toCanvas, ctx: fade.toCtx },
    ];
    for (const surface of surfaces) {
      if (surface.canvas.width === width && surface.canvas.height === height) continue;
      // Redimensionner efface tout : on garde l'image de la couche, remise à
      // l'échelle, pour qu'aucun frame noir ne s'intercale.
      const previous = document.createElement("canvas");
      previous.width = Math.max(1, surface.canvas.width);
      previous.height = Math.max(1, surface.canvas.height);
      const previousCtx = previous.getContext("2d");
      if (previousCtx !== null) previousCtx.drawImage(surface.canvas, 0, 0);
      surface.canvas.width = width;
      surface.canvas.height = height;
      if (previousCtx === null) continue;
      surface.ctx.setTransform(1, 0, 0, 1, 0, 0);
      surface.ctx.globalCompositeOperation = "source-over";
      surface.ctx.globalAlpha = 1;
      surface.ctx.drawImage(previous, 0, 0, width, height);
    }
  };

  Target.prototype.composeCrossfade = function (this: App): void {
    const fade = this.crossfade;
    if (fade === null || !fade.active) return;
    // Machine à la peine pendant le fondu : on le termine en 0,6 s.
    if (Math.min(this.quality, this.liveQuality) < 0.5 && fade.durationMs > 600) {
      fade.durationMs = 600;
      this.debug("sync", "fondu enchaîné raccourci · qualité < 0,5");
    }
    const largeur = Math.max(1, this.canvas.width);
    const hauteur = Math.max(1, this.canvas.height);
    const elapsed = performance.now() - fade.startedAt;
    const progress = clamp01(elapsed / Math.max(1, fade.durationMs));
    // ease-in-out (smoothstep) : pas de saut de luminance aux deux extrémités.
    const alpha = progress * progress * (3 - 2 * progress);
    const { ctx } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.drawImage(fade.fromCanvas, 0, 0, largeur, hauteur);
    ctx.globalAlpha = alpha;
    ctx.drawImage(fade.toCanvas, 0, 0, largeur, hauteur);
    ctx.globalAlpha = 1;
    if (progress >= 1) this.finishCrossfade();
  };

  Target.prototype.finishCrossfade = function (this: App): void {
    const fade = this.crossfade;
    if (fade === null) return;
    if (fade.timer !== null) window.clearTimeout(fade.timer);
    this.crossfade = null;
    if (fade.to === "show") {
      // Le direct a fourni la couche sortante : on peut l'arrêter maintenant que
      // le show occupe tout l'écran.
      this.stopLiveMode();
      this.stopLiveRender();
      this.liveMode = false;
      this.debug("sync", "fondu enchaîné terminé · live arrêté");
      return;
    }
    // Retour au direct : les deux couches vivaient déjà de la même boucle live.
    this.debug("sync", "fondu terminé · direct rétabli");
  };

  Target.prototype.cancelCrossfade = function (this: App): void {
    const fade = this.crossfade;
    if (fade === null) return;
    if (fade.timer !== null) window.clearTimeout(fade.timer);
    this.crossfade = null;
  };
}
