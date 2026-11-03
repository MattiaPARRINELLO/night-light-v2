/**
 * Effet forcé depuis le studio, par-dessus le spectacle en cours.
 *
 * L'écran de projection n'a pas besoin d'un morceau analysé pour jouer un
 * effet : on lui construit la même timeline synthétique que l'aperçu du studio
 * (`core/effects.ts`) et on rend avec le même `renderFrame`. Ce module ne
 * s'occupe que du cycle de vie ; les trois boucles de rendu (direct,
 * synchronisé, show local) lui délèguent la toile tant qu'un effet est actif.
 */

import type { App } from "./app";
import { applyEffectLook, buildEffectTimeline } from "../core/effects";
import type { HazeTarget } from "../core/families";
import { renderFrame } from "../core/render";
import type { EffectOverride } from "../shared/control";

declare module "./app" {
  interface App {
    applyEffectOverride(effect: EffectOverride | null): void;
    renderEffectOverride(quality: number, width: number, height: number, haze?: HazeTarget): boolean;
  }
}

export function installEffects(Target: { prototype: App }): void {
  /**
   * Installe (ou retire) l'effet forcé.
   *
   * La timeline est reconstruite à chaque changement : elle est courte et
   * synthétique, donc bon marché, et cela évite de garder un état intermédiaire
   * entre le studio et l'écran. Une commande identique à l'effet courant est
   * ignorée : le studio peut la renvoyer en battement de cœur sans remettre
   * l'horloge à zéro.
   */
  Target.prototype.applyEffectOverride = function (this: App, effect: EffectOverride | null): void {
    if (effect === null) {
      if (this.effectOverride !== null) this.debug("show", "fin de l'effet projeté · retour au show");
      this.effectOverride = null;
      this.effectTimeline = null;
      return;
    }
    if (this.effectOverride !== null && JSON.stringify(this.effectOverride) === JSON.stringify(effect)) return;

    const timeline = buildEffectTimeline({
      tempo: effect.tempo,
      energy: effect.energy,
      bass: effect.bass,
      high: effect.high,
      impacts: effect.impacts,
      seed: effect.seed,
    });
    applyEffectLook(timeline, {
      family: effect.family,
      variant: effect.variant,
      role: effect.role,
      mood: effect.mood,
      hue: effect.hue,
      spread: effect.spread,
      saturation: effect.saturation,
      lightness: effect.lightness,
    });

    this.effectOverride = effect;
    this.effectTimeline = timeline;
    this.effectStartMs = performance.now();
    this.effectFrame = 0;
    // Un fondu enchaîné en cours composerait par-dessus l'effet : on le coupe.
    this.cancelCrossfade();
    this.debug("show", "effet projeté depuis le studio", { famille: effect.family, teinte: effect.hue });
  };

  /**
   * Rend l'effet forcé s'il y en a un. Renvoie `true` pour dire à la boucle
   * appelante que la toile est déjà peinte et qu'elle doit s'arrêter là.
   */
  Target.prototype.renderEffectOverride = function (
    this: App,
    quality: number,
    width: number,
    height: number,
    haze?: HazeTarget,
  ): boolean {
    const override = this.effectOverride;
    const timeline = this.effectTimeline;
    if (override === null || timeline === null) return false;

    // Le temps vient de l'horloge murale : deux boucles qui se chevauchent ne
    // doublent pas la vitesse, contrairement à un accumulateur par image.
    const elapsed = ((performance.now() - this.effectStartMs) / 1000) * Math.max(0.1, override.speed);
    const time = elapsed % timeline.duration;
    try {
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.globalCompositeOperation = "source-over";
      this.ctx.globalAlpha = 1;
      renderFrame({
        ctx: this.ctx,
        width,
        height,
        dpr: this.canvas.width / Math.max(1, width),
        time,
        view: timeline.view,
        plan: timeline.plan,
        settings: {
          intensity: override.intensity,
          // La sécurité de l'écran (pas de flash) reste prioritaire sur le
          // réglage envoyé depuis le téléphone.
          flashes: this.noflash ? 0 : override.flashes,
          reduced: override.reduced || this.settings.reduced,
        },
        reducedMotion: this.reducedMotion,
        quality,
        frame: this.effectFrame,
        haze,
      });
      this.effectFrame += 1;
      return true;
    } catch (error) {
      this.debug("erreur", "rendu de l'effet projeté interrompu", error instanceof Error ? error.message : String(error));
      console.error("Rendu de l'effet projeté interrompu", error);
      return false;
    }
  };
}
