/**
 * Lien avec le tableau de bord (canal de contrôle), réglages poussés depuis le
 * dashboard, latence, et overlay de debug. Méthodes greffées sur `App` (voir le
 * commentaire d'en-tête de `app.ts`).
 */

import type { App } from "./app";
import { dbgLog, debugLog } from "../core/debug";
import { estimatePlayerPositionMs } from "../core/playback";
import { ControlLink, type DashboardCommand, type ShowMode, type ShowState } from "../shared/control";
import { num, seconds } from "./format";

declare module "./app" {
  interface App {
    bindControl(): void;
    handleCommand(command: DashboardCommand): void;
    receiveAnalysis(command: Extract<DashboardCommand, { type: "analysis-ready" }>): void;
    setLatency(ms: number): void;
    applySettings(patch: Partial<ShowState["settings"]>): void;
    setDebugOverlay(on: boolean): void;
    showMode(): ShowMode;
    publishState(): void;
    bindLatencyControls(): void;
    updateDebugOverlay(): void;
    bindDebugToggle(): void;
  }
}

export function installControl(Target: { prototype: App }): void {
  /**
   * Ouvre le canal de contrôle. L'écran de show reste une application normale
   * quand il est ouvert seul (utile pour les tests et l'usage à un seul écran) :
   * il passe en mode « kiosk » — aucune interface, que la toile — dès qu'un
   * dashboard lui parle, et il y revient si le dashboard disparaît.
   */
  Target.prototype.bindControl = function (this: App): void {
    this.control = new ControlLink();
    this.control.onMessage((message) => {
      const command = message.command;
      if (command === undefined) return;
      this.controllerAt = Date.now();
      this.handleCommand(command);
    });
    this.controlTimer = window.setInterval(() => this.publishState(), 200);
    this.publishState();
  };

  Target.prototype.handleCommand = function (this: App, command: DashboardCommand): void {
    switch (command.type) {
      case "hello":
        break;
      case "set-latency":
        this.setLatency(command.ms);
        break;
      case "set-settings":
        this.applySettings(command.patch);
        break;
      case "capture":
        if (command.on) this.startExternalCapture(true);
        else this.closeExternalCapture();
        break;
      case "force-live":
        this.backToDrop();
        break;
      case "force-show": {
        const analysis = this.pendingAnalysis;
        if (analysis !== null) {
          this.debug("show", "show analysé local demandé depuis le dashboard");
          void this.startShow(analysis);
        }
        break;
      }
      case "cancel-analysis":
        this.analysisController?.abort();
        this.backToDrop();
        break;
      case "debug-overlay":
        this.setDebugOverlay(command.on);
        break;
      case "analysis-ready":
        this.receiveAnalysis(command);
        break;
    }
    // Une commande change presque toujours quelque chose de visible.
    this.publishState();
  };

  /** Analyse faite par le dashboard : le show prend le relais et se cale. */
  Target.prototype.receiveAnalysis = function (
    this: App,
    command: Extract<DashboardCommand, { type: "analysis-ready" }>,
  ): void {
    this.jobId = command.jobId;
    this.pendingTitle = command.title;
    this.pendingAnalysis = command.analysis;
    this.lastError = null;
    this.clearNotice();
    this.debug("analyse", "analyse reçue du dashboard", {
      titre: command.title,
      dureeSec: Number(command.analysis.duration.toFixed(1)),
      temps: command.analysis.beats.length,
      montees: command.analysis.builds.length,
    });
    void this.tryAutoSynced(command.title, command.artist, command.analysis.duration, command.analysis);
  };

  Target.prototype.setLatency = function (this: App, ms: number): void {
    this.syncedLatencyMs = Math.max(-500, Math.min(1000, Math.round(ms)));
    localStorage.setItem("night-light-latency", String(this.syncedLatencyMs));
    // Sans ça, le dashboard continue d'afficher l'ancienne valeur : il ne peut
    // pas vérifier que son réglage est bien arrivé.
    this.debugSync.latencyMs = this.syncedLatencyMs;
    const input = document.getElementById("latency-offset") as HTMLInputElement | null;
    if (input !== null) input.value = String(this.syncedLatencyMs);
  };

  Target.prototype.applySettings = function (this: App, patch: Partial<ShowState["settings"]>): void {
    if (patch.intensity !== undefined) this.settings.intensity = Math.max(0, Math.min(2, patch.intensity));
    if (patch.flashes !== undefined) this.flashSlider = Math.max(0, Math.min(2, patch.flashes));
    if (patch.reduced !== undefined) this.settings.reduced = patch.reduced;
    if (patch.noflash !== undefined) this.noflash = patch.noflash;
    this.settings.flashes = this.noflash ? 0 : this.flashSlider;
    this.refreshPlan();
  };

  Target.prototype.setDebugOverlay = function (this: App, on: boolean): void {
    if (this.debugOverlayActive === on) return;
    this.debugOverlayActive = on;
    const overlay = document.getElementById("debug-overlay");
    if (overlay !== null) overlay.toggleAttribute("hidden", !on);
  };

  Target.prototype.showMode = function (this: App): ShowMode {
    if (this.syncedMode && this.debugSync.phase === "SHOW_SYNCED") return "show-synced";
    if (this.syncedMode && this.debugSync.phase === "PAUSED") return "paused";
    if (this.syncedMode && this.debugSync.phase === "LOST") return "lost";
    if (this.syncedMode) return "syncing";
    if (this.view !== null) return "show-local";
    return "live";
  };

  /** État complet publié vers le dashboard, ~5 fois par seconde. */
  Target.prototype.publishState = function (this: App): void {
    const link = this.control;
    if (link === null) return;
    const controlled = Date.now() - this.controllerAt < 3000;
    const etaitKiosk = document.body.classList.contains("kiosk");
    document.body.classList.toggle("kiosk", controlled);
    // Le passage en kiosk change la taille CSS du canvas (100vw x 100vh) : sans
    // nouveau calibrage, le tampon de dessin ne correspond plus à l'affichage.
    if (etaitKiosk !== controlled) {
      this.resize();
      dbgLog(
        "boot",
        `écran de show ${controlled ? "piloté par le dashboard (interface masquée)" : "rendu à son interface"}`,
      );
    }
    const state: ShowState = {
      version: 1,
      at: Date.now(),
      page: "show",
      screen:
        (document.querySelector(".screen.is-active")?.id?.replace("screen-", "") as ShowState["screen"]) ?? "drop",
      mode: this.showMode(),
      controlled,
      capture: {
        open: this.liveCapture !== null,
        state: this.debugCapture.state,
        source: this.debugCapture.source,
        error: this.debugCapture.error,
        rate: this.debugCapture.rate,
        messages: this.debugCapture.messages,
        lastAt: this.debugCapture.lastAt,
      },
      audio: { ...this.liveAudioRaw },
      smooth: { ...this.liveAudio },
      render: {
        liveFps: this.liveFps,
        liveQuality: this.liveQuality,
        liveFrame: this.liveFrame,
        showFps: this.fps,
        quality: this.quality,
        frame: this.frame,
      },
      sync: { ...this.debugSync },
      analysis:
        this.pendingAnalysis === null
          ? null
          : {
              title: this.pendingTitle,
              artist: "",
              durationSec: this.pendingAnalysis.duration,
              tempo: this.pendingAnalysis.tempo,
              beats: this.pendingAnalysis.beats.length,
              builds: this.pendingAnalysis.builds.length,
              sections: this.pendingAnalysis.sections.length,
            },
      settings: {
        intensity: this.settings.intensity,
        flashes: this.flashSlider,
        reduced: this.settings.reduced,
        noflash: this.noflash,
      },
      limits: this.limits === null ? null : { ...this.limits },
      debugOverlay: this.debugOverlayActive,
      error: this.lastError,
      notice: this.notice,
      log: debugLog.lines(10),
    };
    link.publishState(state);
  };

  Target.prototype.bindLatencyControls = function (this: App): void {
    const input = document.getElementById("latency-offset") as HTMLInputElement | null;
    if (input === null) return;
    input.value = String(this.syncedLatencyMs);
    input.addEventListener("change", () => {
      const value = Number(input.value);
      if (Number.isFinite(value)) {
        this.syncedLatencyMs = Math.max(-500, Math.min(1000, value));
        localStorage.setItem("night-light-latency", String(this.syncedLatencyMs));
      }
    });
    document.getElementById("latency-preset-wired")?.addEventListener("click", () => {
      this.syncedLatencyMs = 0;
      input.value = "0";
      localStorage.setItem("night-light-latency", "0");
    });
    document.getElementById("latency-calibrate")?.addEventListener("click", () => {
      this.calibrateLatency();
    });
    document.getElementById("latency-preset-bt")?.addEventListener("click", () => {
      this.syncedLatencyMs = 200;
      input.value = "200";
      localStorage.setItem("night-light-latency", "200");
    });
  };

  Target.prototype.bindDebugToggle = function (this: App): void {
    window.addEventListener("keydown", (event) => {
      if (
        event.key.toLowerCase() === "d" &&
        !(event.target instanceof HTMLInputElement) &&
        !(event.target instanceof HTMLTextAreaElement)
      ) {
        this.debugOverlayActive = !this.debugOverlayActive;
        const overlay = document.getElementById("debug-overlay");
        if (overlay !== null) overlay.toggleAttribute("hidden", !this.debugOverlayActive);
        this.debug("boot", `overlay de debug ${this.debugOverlayActive ? "affiché" : "masqué"}`);
      }
    });
  };

  /**
   * Concentre tout ce qui se passe en direct : mode courant, état de la capture
   * système, valeurs audio brutes et lissées, position du lecteur face à celle
   * du show, puis la fin du journal. Rafraîchi deux fois par seconde.
   */
  Target.prototype.updateDebugOverlay = function (this: App): void {
    const overlay = document.getElementById("debug-overlay");
    if (overlay === null || !this.debugOverlayActive) return;

    const cap = this.debugCapture;
    const sync = this.debugSync;
    const age = cap.lastAt === 0 ? "jamais" : `${Math.max(0, Math.round(Date.now() - cap.lastAt))} ms`;
    const raw = this.liveAudioRaw;
    const smooth = this.liveAudio;

    const lines: string[] = [
      "── Night Light · debug (touche D pour masquer) ──",
      `mode            ${sync.phase} · live=${this.liveMode ? "oui" : "non"} · show=${this.syncedMode ? "sync" : this.view === null ? "—" : "local"}`,
      `capture         SSE ${cap.link} · ${cap.messages} messages · ${cap.rate.toFixed(1)}/s · dernier il y a ${age}`,
      `capture état    ${cap.state}${cap.active === "?" ? "" : ` · active=${cap.active}`}${cap.source === "" ? "" : ` · source=${cap.source}`}${cap.error === "" ? "" : ` · erreur=${cap.error}`}`,
      `audio brut      rms=${num(raw.rms)} én=${num(raw.energy)} basses=${num(raw.bass)} méd=${num(raw.mid)} aigus=${num(raw.high)} transitoire=${num(raw.transient)}`,
      `audio lissé     rms=${num(smooth.rms)} én=${num(smooth.energy)} basses=${num(smooth.bass)} méd=${num(smooth.mid)} aigus=${num(smooth.high)} transitoire=${num(smooth.transient)}`,
      `rendu live      fps=${this.liveFps.toFixed(1)} · qualité=${this.liveQuality.toFixed(2)} · ${this.liveFrame} images`,
      `rendu show      fps=${this.fps.toFixed(1)} · qualité=${this.quality.toFixed(2)} · ${this.frame} images`,
    ];

    if (sync.phase !== "LIVE") {
      // Valeurs recalculées à l'instant de l'affichage : entre deux resyncs
      // (2,5 s), le show et le lecteur continuent d'avancer.
      const joueur = this.debugLastPlayer;
      const maintenant = Date.now();
      const lecteurMs = joueur === null ? sync.playerMs : estimatePlayerPositionMs(joueur, maintenant);
      const showMs = this.syncedMode ? this.showTimeMs(maintenant) : sync.showMs;
      const ecartMs = joueur === null ? sync.driftMs : lecteurMs + this.syncedLatencyMs - showMs;
      lines.push(
        `sync           source=${sync.source === "" ? "?" : sync.source} · attendu=${sync.expectedTitle === "" ? "—" : sync.expectedTitle}`,
        `sync morceau   lecteur=${sync.playerTitle === "" ? "—" : sync.playerTitle}`,
        `sync position  lecteur=${seconds(lecteurMs)} · show=${seconds(showMs)} · écart=${Math.round(ecartMs)} ms`,
        `sync réglages  latence=${sync.latencyMs} ms · tentatives=${sync.attempts} · corrélation=${sync.correlation === null ? "—" : sync.correlation.toFixed(2)}`,
        `sync verdict   ${sync.match === "" ? "—" : sync.match}${sync.resyncAt === 0 ? "" : ` · dernier contrôle il y a ${((performance.now() - sync.resyncAt) / 1000).toFixed(1)} s`}`,
      );
    }

    lines.push("── journal ──");
    for (const line of debugLog.lines(14, 6)) lines.push(line);
    overlay.textContent = lines.join("\n");
  };
}
