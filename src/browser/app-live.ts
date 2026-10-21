/**
 * Mode direct : capture du son du PC (SSE), visualiseur en barres et rendu live.
 * Méthodes greffées sur `App` (voir le commentaire d'en-tête de `app.ts`).
 */

import type { App } from "./app";
import { dbgThrottled } from "../core/debug";
import { normalizeLiveLevels, smoothLiveFeatures } from "../core/liveAudio";
import { renderFrame } from "../core/render";
import { clamp01, quantizeQuality } from "../core/series";
import { TrackView } from "../core/view";
import { num } from "./format";
import { el } from "./ui";
import type { Analysis } from "../types";

declare module "./app" {
  interface App {
    bindLiveCapture(): void;
    openExternalCapture(): void;
    closeExternalCapture(): void;
    startLiveRender(): void;
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
  Target.prototype.startLiveRender = function (this: App): void {
    this.stopLiveRender();
    const canvas = el<HTMLCanvasElement>("live-stage");
    canvas.hidden = false;
    const context = canvas.getContext("2d");
    if (context === null) return;
    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener("resize", resize);
    const loop = () => {
      this.liveRaf = requestAnimationFrame(loop);
      if (canvas.width !== window.innerWidth || canvas.height !== window.innerHeight) resize();
      const w = canvas.width;
      const h = canvas.height;
      context.fillStyle = "rgba(0,0,0,0.18)";
      context.fillRect(0, 0, w, h);
      const rms = clamp01(Number(this.liveLevels.rms ?? 0));
      const energy = clamp01(Number(this.liveLevels.energy ?? rms));
      const bass = clamp01(Number(this.liveLevels.bass ?? 0.33));
      const mid = clamp01(Number(this.liveLevels.mid ?? 0.33));
      const high = clamp01(Number(this.liveLevels.high ?? 0.34));
      const transient = clamp01(Number(this.liveLevels.transient ?? 0));
      const bars = 48;
      for (let i = 0; i < bars; i++) {
        const section = i / bars;
        const tone = section < 0.33 ? bass : section < 0.66 ? mid : high;
        const barHeight = h * (0.08 + tone * 0.75 * energy) * (1 + transient * 0.35);
        const x = (i / bars) * w;
        const bw = w / bars - 4;
        context.fillStyle = `hsla(${200 + section * 120}, 80%, ${55 + tone * 35}%, ${0.5 + energy * 0.35})`;
        context.fillRect(x + 2, h - barHeight, bw, barHeight);
      }
      // Pulse central modulé par les basses.
      const radius = h * (0.08 + bass * 0.35 * energy);
      const gradient = context.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, radius);
      gradient.addColorStop(0, `rgba(255,255,255,${0.1 + transient * 0.25})`);
      gradient.addColorStop(1, "rgba(0,0,0,0)");
      context.fillStyle = gradient;
      context.beginPath();
      context.arc(w / 2, h / 2, radius, 0, Math.PI * 2);
      context.fill();
    };
    loop();
  };

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
    // Le visualiseur en barres n'a de sens qu'en mode live : pendant un show,
    // il se superposerait au spectacle. La capture, elle, doit continuer —
    // l'audio vient du lecteur externe, pas du navigateur, donc pas de boucle.
    if (this.liveMode) this.startLiveRender();
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
    const loop = (timestamp: number): void => {
      this.liveMainRaf = requestAnimationFrame(loop);
      if (!this.liveMode) return;
      if (this.liveLastTs === 0) {
        this.liveLastTs = timestamp;
        return;
      }
      const delta = timestamp - this.liveLastTs;
      this.liveLastTs = timestamp;
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
          }
        }
      }
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
    const view = this.liveView;
    const plan = this.livePlan;
    if (view === null || plan === null) return;
    try {
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      renderFrame({
        ctx: this.ctx,
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
      this.drawTransitionIfNeeded(time, plan);
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
