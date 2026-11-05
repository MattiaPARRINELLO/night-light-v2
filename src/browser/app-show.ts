/**
 * Show analysé local : lecture audio, commandes (lecture, relance, plein
 * écran), clavier et réglages qui recalculent le plan. Méthodes greffées sur
 * `App` (voir le commentaire d'en-tête de `app.ts`).
 */

import type { App } from "./app";
import { audioUrl } from "../core/api";
import { clamp, formatTime } from "../core/series";
import { buildShowPlan, type ShowPlan } from "../core/show";
import { TrackView } from "../core/view";
import { el, setPlaying, setShowError, setStatus, showScreen } from "./ui";
import type { Analysis, HardMode } from "../types";

declare module "./app" {
  interface App {
    bindShow(): void;
    startShow(analysis: Analysis): Promise<void>;
    startShowCrossfade(): void;
    buildPlan(analysis: Analysis, seed?: number): ShowPlan;
    effectiveReduced(): boolean;
    refreshPlan(transition?: boolean): void;
    togglePlay(): Promise<void>;
    restart(): Promise<void>;
    toggleFullscreen(): Promise<void>;
    bindKeyboard(): void;
    bumpVolume(delta: number): void;
  }
}

export function installShow(Target: { prototype: App }): void {
  /** Construit le plan en mesurant le temps réellement passé dans `buildShowPlan`. */
  Target.prototype.buildPlan = function (this: App, analysis: Analysis, seed?: number): ShowPlan {
    const startedAt = performance.now();
    const plan = buildShowPlan(analysis, this.effectiveReduced(), seed, {
      dramaturgy: true,
      hard: this.settings.hard,
    });
    const durationMs = performance.now() - startedAt;
    this.debug("show", "plan de spectacle construit", {
      dureeMs: Number(durationMs.toFixed(2)),
      scenes: plan.scenes.length,
    });
    if (this.trackTimings !== null) this.trackTimings.planMs = Math.round(durationMs);
    return plan;
  };

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
      this.refreshPlan(true);
    });
    const hardMode = el<HTMLSelectElement>("hard-mode");
    hardMode.value = this.settings.hard;
    hardMode.addEventListener("change", () => {
      this.settings.hard = hardMode.value as HardMode;
      // Rend le clavier au show : sans ça, la touche H restait avalée par le
      // menu qui gardait le focus après le choix.
      hardMode.blur();
      this.refreshPlan(true);
    });
    el<HTMLInputElement>("chk-noflash").addEventListener("change", () => {
      this.noflash = el<HTMLInputElement>("chk-noflash").checked;
      this.settings.flashes = this.noflash ? 0 : this.flashSlider;
    });
    el<HTMLInputElement>("chk-blackout").addEventListener("change", () => {
      this.settings.blackout = el<HTMLInputElement>("chk-blackout").checked;
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

    const useCrossfade = this.transitionMode === "crossfade";
    if (useCrossfade) {
      // Le direct reste affiché le temps du fondu : il fournit l'image sortante.
      // Il n'est arrêté qu'à la fin (voir `finishCrossfade`).
      this.liveMode = true;
    } else {
      this.stopLiveMode();
      this.liveMode = false;
    }
    // L'audio vient du navigateur : garder la capture ouverte ferait réagir le
    // direct à sa propre lecture.
    this.closeExternalCapture();
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
    this.plan = this.buildPlan(analysis);
    if (useCrossfade) this.startShowCrossfade();
    else this.beginTransition();
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
    this.markSynced();
    this.quality = 1;
    this.fps = 60;
    this.frame = 0;
    this.resize();

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

  /**
   * Entrée dans le show local en fondu depuis le direct.
   *
   * Le show local n'est pas calé sur un lecteur : il n'y a donc pas de temps
   * fort à attendre, le fondu part de l'image affichée. Si un fondu est déjà en
   * cours (retour au direct d'un morceau précédent), on repart de la
   * composition visible pour ne pas le couper.
   */
  Target.prototype.startShowCrossfade = function (this: App): void {
    const enCours = this.crossfade !== null && this.crossfade.active;
    const base = enCours ? this.snapshot() : null;
    this.cancelCrossfade();
    const state = this.createCrossfade(base === null ? "live" : "snapshot", "show", 1500, { source: base });
    if (state === null) {
      // Pas de canvas hors écran : ouverture historique depuis le noir.
      this.liveMode = false;
      this.stopLiveMode();
      this.beginTransition();
      return;
    }
    this.transitionStart = 0;
    // Même raison que pour le show calé : l'image de départ est figée, le
    // direct ne doit plus dessiner par-dessus la composition.
    if (base !== null) this.stopLiveMode();
    this.debug("show", "fondu d'entrée du show local armé", { repriseEnCours: base !== null });
  };

  Target.prototype.effectiveReduced = function (this: App): boolean {
    return this.settings.reduced || this.reducedMotion;
  };

  Target.prototype.refreshPlan = function (this: App, transition = false): void {
    // Changement de profil (standard ↔ rave) : on fige l'image actuelle et on
    // la fait fondre vers le nouveau plan. Sans ça, le mur de lyres remplaçait
    // la scène d'un coup, au milieu d'un temps.
    const activeLayer: "show" | "live" | null =
      this.syncedMode || this.view !== null ? "show" : this.liveMode ? "live" : null;
    if (transition && activeLayer !== null) {
      this.cancelCrossfade();
      this.createCrossfade("snapshot", activeLayer, 900);
    }
    // Show local : le plan porte `this.plan`. Show calé sur le lecteur : il vit
    // dans `syncedPlan`. Les deux doivent être reconstruits, sinon un réglage
    // comme le mode rave ne change rien pendant un morceau synchronisé.
    const analysis = this.view?.analysis;
    if (analysis !== undefined) this.plan = this.buildPlan(analysis, this.plan?.seed);
    const syncedAnalysis = this.syncedView?.analysis;
    if (syncedAnalysis !== undefined) {
      this.syncedPlan = this.buildPlan(syncedAnalysis, this.syncedPlan?.seed);
    }
    // Direct : pas d'analyse pour détecter, mais un forçage manuel doit quand
    // même allumer la scène de rave sur le son en cours.
    if (this.livePlan !== null) {
      this.livePlan = {
        ...this.livePlan,
        profile: this.settings.hard === "on" ? "hard" : "standard",
      };
    }
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
      // On ne vole jamais une frappe dans un champ de texte. Les curseurs, cases
      // et menus laissent passer H et B.
      const textField =
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLInputElement &&
          !["checkbox", "radio", "range", "button", "submit"].includes(target.type)) ||
        (target !== null && target.isContentEditable);
      if (textField) return;
      const key = event.key.toLowerCase();
      const formControl =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement;
      if (formControl && key !== "h" && key !== "b") return;
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
        case "h":
        case "H":
          this.settings.hard = this.settings.hard === "on" ? "off" : "on";
          this.refreshPlan(true);
          setStatus(
            this.settings.hard === "on"
              ? "Mode rave activé (touche H pour revenir)."
              : "Profil standard (touche H pour activer le mode rave).",
          );
          break;
        case "b":
        case "B": {
          this.settings.blackout = !this.settings.blackout;
          const blackout = document.getElementById("chk-blackout");
          if (blackout instanceof HTMLInputElement) blackout.checked = this.settings.blackout;
          setStatus(this.settings.blackout ? "Blackout." : "Lumière rétablie.");
          break;
        }
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
