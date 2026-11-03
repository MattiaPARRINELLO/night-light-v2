/**
 * Mode direct : capture du son du PC (SSE), visualiseur en barres et rendu live.
 * Méthodes greffées sur `App` (voir le commentaire d'en-tête de `app.ts`).
 */

import type { App } from "./app";
import { dbgThrottled } from "../core/debug";
import { normalizeLiveLevels, smoothLiveFeatures } from "../core/liveAudio";
import { renderFrame } from "../core/render";
import { quantizeQuality } from "../core/series";
import { TrackView } from "../core/view";
import { num } from "./format";
import { el } from "./ui";
import type { Analysis } from "../types";

declare module "./app" {
  interface App {
    bindLiveCapture(): void;
    openExternalCapture(): void;
    closeExternalCapture(): void;
    stopLiveRender(): void;
    ensureLiveView(): Promise<void>;
    startLiveMode(): Promise<void>;
    startExternalCapture(force: boolean): void;
    startLiveLoop(): void;
    stopLiveMode(): void;
    tickLive(): void;
    renderLive(time: number): void;
  }
}

export function installLive(Target: { prototype: App }): void {
  /** Cadence de l'ambiance de l'écran de dépôt : 30 img/s, largement assez. */
  const AMBIENT_FRAME_MS = 1000 / 30;

  // Le visualiseur en barres qui peignait autrefois `#live-stage` a été retiré :
  // sa toile est peinte SOUS `#stage`, qu'un contexte opaque repeint
  // intégralement à chaque image. Il dessinait donc 48 barres et un dégradé
  // plein écran par image sans qu'un pixel n'atteigne l'écran — un second
  // spectacle invisible tournait pendant toute la capture.

  Target.prototype.stopLiveRender = function (this: App): void {
    if (this.liveRaf !== 0) cancelAnimationFrame(this.liveRaf);
    this.liveRaf = 0;
    const canvas = document.getElementById("live-stage");
    if (canvas instanceof HTMLCanvasElement) {
      const ctx = canvas.getContext("2d");
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
      canvas.hidden = true;
    }
  };

  Target.prototype.bindLiveCapture = function (this: App): void {
    el<HTMLButtonElement>("btn-live-capture").addEventListener("click", () => {
      if (this.liveCapture !== null) this.closeExternalCapture();
      else this.openExternalCapture();
    });
  };

  Target.prototype.openExternalCapture = function (this: App): void {
    if (this.liveCapture !== null) return;
    const btn = el<HTMLButtonElement>("btn-live-capture");
    const level = el<HTMLElement>("live-level");
    const source = new EventSource("/api/audio-levels");
    this.debugCapture.link = "connexion…";
    this.debug("capture", "ouverture du flux SSE /api/audio-levels");
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as Record<string, unknown>;
        this.liveLevels = data as Record<string, number>;
        const now = performance.now();
        this.debugCapture.messages += 1;
        this.debugCapture.lastAt = Date.now();
        this.debugRateWindowCount += 1;
        if (this.debugRateWindowAt === 0) this.debugRateWindowAt = now;
        if (now - this.debugRateWindowAt >= 1000) {
          this.debugCapture.rate = (this.debugRateWindowCount * 1000) / (now - this.debugRateWindowAt);
          this.debugRateWindowAt = now;
          this.debugRateWindowCount = 0;
        }
        this.debugCapture.link = "ouvert";
        this.debugCapture.state = String(data.state ?? "inactive");
        this.debugCapture.active = String(data.active ?? "?");
        this.debugCapture.source = String(data.source ?? "");
        this.debugCapture.error = String(data.error ?? "");
        if (this.debugCapture.error !== "") this.debug("erreur", "capture en erreur", this.debugCapture.error);
        if (this.debugCapture.state !== this.debugLastSseState) {
          this.debug("capture", `état de la capture → ${this.debugCapture.state}`, {
            source: this.debugCapture.source,
            rms: Number(data.rms ?? 0).toFixed(4),
          });
          this.debugLastSseState = this.debugCapture.state;
        }
        const next = normalizeLiveLevels(data);
        this.liveAudioRaw = next;
        if (data.error) {
          level.textContent = String(data.error);
          return;
        }
        const percent = Math.round((Number(data.rms ?? 0)) * 100);
        level.textContent = `Capture ${data.state ?? (data.active ? "active" : "inactive")} · niveau ${percent} %`;
        dbgThrottled(
          "levels",
          "capture",
          "caractéristiques reçues",
          {
            rms: next.rms.toFixed(3),
            energie: next.energy.toFixed(3),
            basses: next.bass.toFixed(2),
            mediums: next.mid.toFixed(2),
            aigus: next.high.toFixed(2),
            transitoire: next.transient.toFixed(3),
          },
          1000,
        );
      } catch {
        /* ignore malformed event */
      }
    };
    source.onerror = () => {
      level.textContent = "Erreur de capture audio";
      this.debugCapture.link = "erreur";
      this.debug("erreur", "flux SSE de capture interrompu (parec ou serveur)");
    };
    this.liveCapture = source;
    btn.textContent = "Arrêter la capture";
    level.textContent = "Capture en cours…";
    // Aucun visualiseur n'est ouvert ici : voir la note de `stopLiveRender`.
    // La capture doit vivre même pendant un show — l'audio vient du lecteur
    // externe, pas du navigateur, donc pas de boucle.
  };

  Target.prototype.closeExternalCapture = function (this: App): void {
    if (this.liveCapture === null) return;
    this.liveCapture.close();
    this.liveCapture = null;
    const btn = el<HTMLButtonElement>("btn-live-capture");
    const level = el<HTMLElement>("live-level");
    btn.textContent = "Écouter le son du PC";
    level.textContent = "Capture inactive";
    this.debug("capture", `flux SSE fermé · ${this.debugCapture.messages} messages reçus au total`);
    this.debugCapture.link = "fermé";
    this.debugCapture.state = "fermée";
    this.debugCapture.active = "?";
    this.debugCapture.error = "";
    this.debugLastSseState = "";
    this.stopLiveRender();
  };

  Target.prototype.ensureLiveView = async function (this: App): Promise<void> {
    if (this.liveView !== null && this.livePlan !== null) return;
    const analysis: Analysis = {
      schema: 2,
      duration: 1_000_000,
      tempo: 120,
      beatCount: 0,
      beatPeriod: 0.5,
      beats: [],
      onsets: [],
      energy: [[0, 0]],
      bass: [[0, 1 / 3]],
      mid: [[0, 1 / 3]],
      high: [[0, 1 / 3]],
      sections: [{ start: 0, end: 1_000_000, label: "intense", energy: 0.5 }],
      builds: [],
    };
    this.liveView = new TrackView(analysis);
    this.livePlan = {
      duration: 1_000_000,
      seed: 1,
      scenes: [
        {
          index: 0,
          start: 0,
          end: 1_000_000,
          family: "beams",
          variant: "tunnel",
          backdrop: "waves",
          palette: { name: "magenta-cyan", hue: 318, accent: 188, spread: 44, saturation: 0.88, lightness: 0.64 },
          intensity: 0.6,
          fadeIn: 0.7,
          fadeOut: 0.9,
          mood: "pulse",
          role: "intro",
          reason: "ouverture",
        },
      ],
      barStarts: [],
      track: { name: "magenta-cyan", hue: 318, accent: 188, spread: 44 },
      backdrop: "waves",
    };
  };

  Target.prototype.startLiveMode = async function (this: App): Promise<void> {
    this.liveMode = true;
    this.liveTimeStart = performance.now();
    this.resize();
    this.debugSync.phase = "LIVE";
    this.debugSync.match = "";
    this.debugSync.attempts = 0;
    await this.ensureLiveView();
    this.startExternalCapture(true);
    this.startLiveLoop();
    this.beginTransition();
    this.debug("live", "mode live démarré · capture du son du PC ouverte");
  };

  Target.prototype.startExternalCapture = function (this: App, force: boolean): void {
    // `force` conservé pour l'interface future ; la capture est ouverte via le même flux.
    if (force && this.liveCapture === null) this.openExternalCapture();
  };

  Target.prototype.startLiveLoop = function (this: App): void {
    if (this.liveMainRaf !== 0) return;
    this.liveLastTs = 0;
    // L'écran de dépôt ne montre que l'ambiance derrière son panneau : le
    // spectacle y était rendu à pleine cadence pour rien, et c'était la première
    // cause de saccade perçue au démarrage.
    const dropScreen = document.getElementById("screen-drop");
    let lastDraw = 0;
    const loop = (timestamp: number): void => {
      this.liveMainRaf = requestAnimationFrame(loop);
      if (!this.liveMode) return;
      if (this.liveLastTs === 0) {
        this.liveLastTs = timestamp;
        return;
      }
      const delta = timestamp - this.liveLastTs;
      this.liveLastTs = timestamp;
      // Le fps se mesure sur les rafraîchissements, pas sur les images
      // effectivement dessinées : sinon le bridage de l'ambiance ferait croire à
      // une machine à la peine et la qualité s'effondrerait pour rien.
      if (delta > 0) {
        const instant = 1000 / delta;
        this.liveFps += (instant - this.liveFps) * 0.06;
        const wanted = quantizeQuality(this.liveFps / 52);
        if (wanted === this.liveQuality) this.liveQualityHold = 0;
        else {
          this.liveQualityHold += 1;
          if (this.liveQualityHold >= 24) {
            this.liveQuality = wanted;
            this.liveQualityHold = 0;
            this.resize();
          }
        }
      }
      if (document.hidden) return;
      const ambient = dropScreen?.classList.contains("is-active") ?? false;
      if (ambient && timestamp - lastDraw < AMBIENT_FRAME_MS) return;
      lastDraw = timestamp;
      this.tickLive();
    };
    this.liveMainRaf = requestAnimationFrame(loop);
  };

  Target.prototype.stopLiveMode = function (this: App): void {
    if (this.liveMainRaf !== 0) cancelAnimationFrame(this.liveMainRaf);
    this.liveMainRaf = 0;
  };

  Target.prototype.tickLive = function (this: App): void {
    if (!this.liveMode || this.liveView === null || this.livePlan === null) return;
    const target = this.liveAudioRaw;
    if (target.updatedAt > this.liveAudio.updatedAt) {
      this.liveAudio = smoothLiveFeatures(this.liveAudio, target, 0.4);
    }
    const time = (performance.now() - this.liveTimeStart) / 1000;
    this.renderLive(time);
  };

  Target.prototype.renderLive = function (this: App, time: number): void {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    // Un effet forcé depuis le studio prend la toile, même sans morceau.
    if (this.renderEffectOverride(this.liveQuality, width, height, this.hazeFor(this.liveQuality, width, height))) {
      this.liveFrame += 1;
      return;
    }
    const view = this.liveView;
    const plan = this.livePlan;
    if (view === null || plan === null) return;
    const fade = this.crossfade;
    const target = fade !== null && fade.active ? fade.liveCtx : this.ctx;
    try {
      target.setTransform(1, 0, 0, 1, 0, 0);
      renderFrame({
        ctx: target,
        width: this.canvas.clientWidth,
        height: this.canvas.clientHeight,
        dpr: this.canvas.width / Math.max(1, this.canvas.clientWidth),
        time,
        view,
        plan,
        settings: this.settings,
        reducedMotion: this.reducedMotion,
        quality: this.liveQuality,
        frame: this.liveFrame,
        haze: this.hazeFor(this.liveQuality, this.canvas.clientWidth, this.canvas.clientHeight),
        liveAudio: this.liveAudio,
      });
      this.liveFrame += 1;
      if (fade === null) this.drawTransitionIfNeeded(time, plan);
      if (this.liveFrame % 120 === 0) {
        dbgThrottled(
          "live-render",
          "live",
          "rendu live en cours",
          {
            fps: this.liveFps.toFixed(1),
            qualite: this.liveQuality.toFixed(2),
            images: this.liveFrame,
            rms: num(this.liveAudio.rms),
            energie: num(this.liveAudio.energy),
          },
          4000,
        );
      }
    } catch (error) {
      this.liveQuality = quantizeQuality(this.liveQuality * 0.7);
      this.debug("erreur", "rendu live interrompu", error instanceof Error ? error.message : String(error));
      console.error("Rendu live interrompu", error);
    }
  };
}
