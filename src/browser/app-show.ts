/**
 * Show analysé local : lecture audio, commandes (lecture, relance, plein
 * écran), clavier et réglages qui recalculent le plan. Méthodes greffées sur
 * `App` (voir le commentaire d'en-tête de `app.ts`).
 */

import type { App } from "./app";
import { audioUrl } from "../core/api";
import { clamp, formatTime } from "../core/series";
import { buildShowPlan } from "../core/show";
import { TrackView } from "../core/view";
import { el, setPlaying, setShowError, setStatus, showScreen } from "./ui";
import type { Analysis } from "../types";

declare module "./app" {
  interface App {
    bindShow(): void;
    startShow(analysis: Analysis): Promise<void>;
    effectiveReduced(): boolean;
    refreshPlan(): void;
    togglePlay(): Promise<void>;
    restart(): Promise<void>;
    toggleFullscreen(): Promise<void>;
    bindKeyboard(): void;
    bumpVolume(delta: number): void;
  }
}

export function installShow(Target: { prototype: App }): void {
  Target.prototype.bindShow = function (this: App): void {
    el<HTMLButtonElement>("btn-play").addEventListener("click", () => void this.togglePlay());
    el<HTMLButtonElement>("btn-restart").addEventListener("click", () => void this.restart());
    el<HTMLButtonElement>("btn-change-track").addEventListener("click", () => {
      this.backToDrop();
    });
    el<HTMLButtonElement>("btn-fullscreen").addEventListener("click", () => void this.toggleFullscreen());

    el<HTMLInputElement>("volume").addEventListener("input", () => {
      this.audio.setVolume(Number(el<HTMLInputElement>("volume").value) / 100);
    });
    this.audio.setVolume(0.8);

    this.settings.intensity = Number(el<HTMLInputElement>("intensity").value) / 100;
    this.flashSlider = Number(el<HTMLInputElement>("flashes").value) / 100;
    this.noflash = el<HTMLInputElement>("chk-noflash").checked;
    this.settings.flashes = this.noflash ? 0 : this.flashSlider;

    el<HTMLInputElement>("intensity").addEventListener("input", () => {
      this.settings.intensity = Number(el<HTMLInputElement>("intensity").value) / 100;
    });
    el<HTMLInputElement>("flashes").addEventListener("input", () => {
      this.flashSlider = Number(el<HTMLInputElement>("flashes").value) / 100;
      this.settings.flashes = this.noflash ? 0 : this.flashSlider;
    });
    el<HTMLInputElement>("chk-reduced").addEventListener("change", () => {
      this.settings.reduced = el<HTMLInputElement>("chk-reduced").checked;
      this.refreshPlan();
    });
    el<HTMLInputElement>("chk-noflash").addEventListener("change", () => {
      this.noflash = el<HTMLInputElement>("chk-noflash").checked;
      this.settings.flashes = this.noflash ? 0 : this.flashSlider;
    });

    const seek = el<HTMLInputElement>("seek");
    seek.addEventListener("input", () => {
      this.seeking = true;
      const duration = this.view?.duration ?? 0;
      el<HTMLElement>("time-current").textContent = formatTime((Number(seek.value) / 1000) * duration);
    });
    seek.addEventListener("change", () => {
      const duration = this.view?.duration ?? 0;
      this.audio.seek((Number(seek.value) / 1000) * duration);
      this.seeking = false;
    });

    el<HTMLButtonElement>("hud-toggle").addEventListener("click", () => {
      const hud = el<HTMLElement>("hud");
      const collapsed = hud.classList.toggle("is-collapsed");
      el<HTMLButtonElement>("hud-toggle").setAttribute("aria-expanded", String(!collapsed));
    });

    this.audio.on("error", () => {
      const code = this.audio.element.error?.code ?? 0;
      setShowError(
        "Lecture impossible",
        "Le navigateur n'a pas réussi à lire ce morceau. Essaie un autre format (WAV ou MP3 sont les plus sûrs).",
        `MediaError code ${code}`,
      );
      showScreen("error");
      this.stopLoop();
    });

    this.audio.on("loadedmetadata", () => {
      if (this.view !== null) this.syncTrackLabels();
    });

    this.audio.onEnded(() => {
      setPlaying(false);
      this.stopLoop();
      this.renderAt(this.view?.duration ?? this.audio.duration);
      setStatus("Spectacle terminé. Tu peux le relancer ou changer de morceau.");
    });
  };

  Target.prototype.startShow = async function (this: App, analysis: Analysis): Promise<void> {
    // Les deux modes de show sont exclusifs : sans ça, le minuteur de
    // resynchronisation continue de tourner et finit par voir un « changement
    // de morceau » face au lecteur, ce qui coupait le show local net.
    this.stopSyncedMode();

    this.stopLiveMode();
    this.closeExternalCapture();
    this.liveMode = false;
    const title = this.pendingTitle;
    this.debugSync.phase = "SHOW_LOCAL";
    this.debugSync.expectedTitle = title;
    this.debugSync.match = "show analysé local (touche S)";
    this.session = {
      jobId: this.jobId,
      title,
      duration: analysis.duration,
      startedAt: Date.now(),
    };
    this.view = new TrackView(analysis);
    this.plan = buildShowPlan(analysis, this.effectiveReduced());
    this.beginTransition();
    this.audio.load(audioUrl(this.jobId));
    const detectedPosition = this.nowPlaying?.positionSec;
    if (this.nowPlaying?.status === "playing" && Number.isFinite(detectedPosition)) {
      const offset = detectedPosition as number;
      this.audio.element.addEventListener(
        "loadedmetadata",
        () => {
          try {
            (this.audio.element as HTMLAudioElement).currentTime = Math.max(
              0,
              Math.min(this.audio.duration || offset, offset),
            );
          } catch {
            /* ignore */
          }
        },
        { once: true },
      );
    }
    this.audio.setVolume(Number(el<HTMLInputElement>("volume").value) / 100);

    el<HTMLElement>("np-title").textContent = title;
    el<HTMLElement>("np-info").textContent = `${formatTime(analysis.duration)} · ${analysis.tempo.toFixed(1)} BPM`;
    el<HTMLElement>("hud-track").textContent = title;
    el<HTMLElement>("time-total").textContent = formatTime(analysis.duration);

    showScreen("show");
    this.resize();
    this.quality = 1;
    this.fps = 60;
    this.frame = 0;

    try {
      await this.audio.play();
      setPlaying(true);
      this.startLoop();
      setStatus(`Spectacle lancé : ${title}.`);
    } catch (error) {
      setShowError(
        "Lecture bloquée",
        "Le navigateur a refusé la lecture automatique. Appuie une nouvelle fois sur lecture.",
        error instanceof Error ? error.message : String(error),
      );
      showScreen("error");
    }
  };

  Target.prototype.effectiveReduced = function (this: App): boolean {
    return this.settings.reduced || this.reducedMotion;
  };

  Target.prototype.refreshPlan = function (this: App): void {
    const analysis = this.view?.analysis;
    if (analysis === undefined) return;
    this.plan = buildShowPlan(analysis, this.effectiveReduced());
  };

  Target.prototype.togglePlay = async function (this: App): Promise<void> {
    if (this.view === null) return;
    if (this.audio.paused) {
      if (this.audio.currentTime >= this.view.duration - 0.05) this.audio.seek(0);
      await this.audio.play();
      setPlaying(true);
      this.startLoop();
    } else {
      this.audio.pause();
      setPlaying(false);
      this.stopLoop();
    }
  };

  Target.prototype.restart = async function (this: App): Promise<void> {
    if (this.view === null) return;
    this.audio.seek(0);
    await this.audio.play();
    setPlaying(true);
    this.startLoop();
    setStatus("Spectacle rejoué depuis le début.");
  };

  Target.prototype.toggleFullscreen = async function (this: App): Promise<void> {
    try {
      if (document.fullscreenElement === null) {
        await document.documentElement.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch {
      setStatus("Plein écran refusé par le navigateur.");
    }
  };

  Target.prototype.bindKeyboard = function (this: App): void {
    window.addEventListener("keydown", (event) => {
      const target = event.target as HTMLElement | null;
      if (target !== null && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      switch (event.key) {
        case "s":
        case "S": {
          // Échappatoire discret : show analysé en local si la synchro est impossible.
          const analysis = this.pendingAnalysis;
          this.debug("show", "show analysé local forcé au clavier (S)", { titre: this.pendingTitle });
          if (analysis !== null) void this.startShow(analysis);
          break;
        }
        case " ":
          event.preventDefault();
          void this.togglePlay();
          break;
        case "r":
        case "R":
          void this.restart();
          break;
        case "f":
        case "F":
          void this.toggleFullscreen();
          break;
        case "ArrowLeft":
          this.audio.seek(this.audio.currentTime - 5);
          break;
        case "ArrowRight":
          this.audio.seek(this.audio.currentTime + 5);
          break;
        case "ArrowUp":
          event.preventDefault();
          this.bumpVolume(0.05);
          break;
        case "ArrowDown":
          event.preventDefault();
          this.bumpVolume(-0.05);
          break;
        default:
          break;
      }
    });
  };

  Target.prototype.bumpVolume = function (this: App, delta: number): void {
    const slider = el<HTMLInputElement>("volume");
    const next = clamp(Number(slider.value) + delta * 100, 0, 100);
    slider.value = String(Math.round(next));
    this.audio.setVolume(next / 100);
  };
}
