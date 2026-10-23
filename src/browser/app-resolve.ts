/**
 * Résolution d'un morceau par titre/artiste, et suivi du lecteur externe.
 * Méthodes greffées sur `App` (voir le commentaire d'en-tête de `app.ts`).
 */

import type { App } from "./app";
import { ApiError, fetchNowPlaying, normalizeNowPlaying, resolveAndAnalyze, type JobTimings } from "../core/api";
import { dbgThrottled } from "../core/debug";
import { detectedTrackKey, detectedTrackLabel, shouldAutoResolve } from "../core/nowPlaying";
import { el, setShowError, setUploadState, showScreen } from "./ui";

declare module "./app" {
  interface App {
    bindResolve(): void;
    handleResolve(
      title: string,
      artist: string,
      duration: number | undefined,
      trackKey?: string,
      auto?: boolean,
    ): Promise<void>;
    pollNowPlaying(): Promise<void>;
    updateNowPlayingUI(): void;
    maybeAutoResolve(): Promise<void>;
    bindNowPlayingStream(): void;
    receiveNowPlaying(raw: Record<string, unknown>): void;
    startNowPlayingPolling(): void;
    stopNowPlayingPolling(): void;
    beginTrackTimings(): void;
    applyJobTimings(timings: JobTimings | undefined): void;
    markSynced(): void;
    markFirstFrame(): void;
  }
}

export function installResolve(Target: { prototype: App }): void {
  /** Ouvre une nouvelle chronologie au moment où le morceau est détecté. */
  Target.prototype.beginTrackTimings = function (this: App): void {
    this.trackTimings = {
      detectedAt: Date.now(),
      foundMs: null,
      downloadedMs: null,
      analyzedMs: null,
      partialMs: null,
      syncedMs: null,
      firstFrameMs: null,
      planMs: null,
      audioCache: false,
      analysisCache: false,
      phases: null,
    };
  };

  /** Reporte les mesures serveur sur la chronologie affichée par le dashboard. */
  Target.prototype.applyJobTimings = function (this: App, timings: JobTimings | undefined): void {
    if (this.trackTimings === null) this.beginTrackTimings();
    const current = this.trackTimings;
    if (current === null || timings === undefined) return;
    // La chronologie front commence à la détection (SSE) ; le serveur compte à
    // partir de la création du job, un peu plus tard. On garde la plus ancienne
    // origine et on décale les étapes serveur de cet écart.
    const serverBase =
      typeof timings.detectedAt === "number" && timings.detectedAt > 0
        ? timings.detectedAt
        : current.detectedAt;
    const base = Math.min(current.detectedAt, serverBase);
    const offset = Math.max(0, serverBase - base);
    current.detectedAt = base;
    if (timings.foundMs !== undefined) current.foundMs = Math.round(offset + timings.foundMs);
    if (timings.downloadedMs !== undefined) {
      current.downloadedMs = Math.round(offset + timings.downloadedMs);
    }
    if (timings.analyzedMs !== undefined) current.analyzedMs = Math.round(offset + timings.analyzedMs);
    if (timings.partialMs !== undefined) current.partialMs = Math.round(offset + timings.partialMs);
    current.audioCache = timings.audioCache === true;
    current.analysisCache = timings.analysisCache === true;
    if (timings.analysisPhases !== undefined) current.phases = { ...timings.analysisPhases };
  };

  /** Marque le moment où le show est calé sur le lecteur. */
  Target.prototype.markSynced = function (this: App): void {
    if (this.trackTimings === null) return;
    this.trackTimings.syncedMs = Math.max(0, Date.now() - this.trackTimings.detectedAt);
  };

  /** Marque la première image réellement dessinée après le calage. */
  Target.prototype.markFirstFrame = function (this: App): void {
    const timings = this.trackTimings;
    if (timings === null || timings.syncedMs === null || timings.firstFrameMs !== null) return;
    timings.firstFrameMs = Math.max(timings.syncedMs, Date.now() - timings.detectedAt);
  };

  Target.prototype.bindResolve = function (this: App): void {
    const form = el<HTMLFormElement>("resolve-form");
    const status = el<HTMLElement>("resolve-status");
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const title = el<HTMLInputElement>("resolve-title").value.trim();
      const artist = el<HTMLInputElement>("resolve-artist").value.trim();
      const rawDuration = el<HTMLInputElement>("resolve-duration").value.trim();
      const duration = rawDuration === "" ? undefined : Number(rawDuration);
      if (title === "" || artist === "") {
        status.hidden = false;
        status.classList.add("is-error");
        status.textContent = "Le titre et l'artiste sont requis.";
        return;
      }
      if (duration !== undefined && (!Number.isFinite(duration) || duration <= 0)) {
        status.hidden = false;
        status.classList.add("is-error");
        status.textContent = "La durée doit être un nombre positif.";
        return;
      }
      status.hidden = false;
      status.classList.remove("is-error");
      status.textContent = "Recherche en cours…";
      void this.handleResolve(title, artist, duration);
    });
  };

  Target.prototype.handleResolve = async function (
    this: App,
    title: string,
    artist: string,
    duration: number | undefined,
    trackKey?: string,
    auto = false,
  ): Promise<void> {
    const status = el<HTMLElement>("resolve-status");
    // Chaque tentative porte un numéro : une résolution remplacée par un morceau
    // plus récent s'arrête en silence, sans toucher à l'écran ni au show.
    const seq = (this.resolveSeq += 1);
    const startedAt = performance.now();
    if (!auto || this.trackTimings === null) this.beginTrackTimings();
    // Toute nouvelle résolution — manuelle comprise — annule la précédente :
    // elle ne doit ni continuer à télécharger pour rien, ni écraser son résultat.
    if (this.analysisController !== null) this.analysisController.abort();
    const controller = new AbortController();
    this.analysisController = controller;
    this.autoResolving = auto;
    this.pendingTitle = title;
    this.pendingAnalysis = null;
    // Une nouvelle tentative efface l'échec précédent. Le dock ne se masque que
    // pour une action manuelle : une résolution automatique doit laisser
    // l'écran de dépôt intact si elle échoue.
    this.resolveFailure = null;
    if (!auto) el<HTMLElement>("dock-panel").classList.add("is-hidden");
    this.debug("analyse", `recherche par titre · ${title} / ${artist}`, { dureeSec: duration ?? "—" });
    setUploadState({
      phase: "Recherche",
      progress: 0,
      detail: "Recherche du morceau sur YouTube",
      title,
      meta: "Résolution automatique",
    });
    let partialShown = false;
    try {
      const { jobId, analysis, timings } = await resolveAndAnalyze(
        title,
        artist,
        duration,
        {
          signal: controller.signal,
          onPhase: ({ progress, phase, detail }) => {
            setUploadState({ phase, progress, detail: detail.length > 0 ? detail : phase, title });
            dbgThrottled(
              `phase-${phase}`,
              "analyse",
              `phase « ${phase} »`,
              {
                progression: `${Math.round(progress * 100)} %`,
                detail: detail.length > 0 ? detail : phase,
              },
              4000,
            );
          },
          onPartial: (partial, partialTimings) => {
            if (seq !== this.resolveSeq) return;
            partialShown = true;
            this.pendingAnalysis = partial;
            this.applyJobTimings(partialTimings);
            document.body.dataset.analysisReady = "true";
            this.debug("analyse", "analyse partielle prête · bascule immédiate", {
              couverture: partial.coverage ?? null,
              tempo: Number(partial.tempo.toFixed(1)),
              temps: partial.beats.length,
            });
            void this.tryAutoSynced(title, artist, partial.duration, partial);
          },
        },
        trackKey,
      );
      if (seq !== this.resolveSeq) return;
      this.jobId = jobId;
      this.pendingAnalysis = analysis;
      this.applyJobTimings(timings);
      document.body.dataset.analysisReady = "true";
      this.debug("analyse", `analyse terminée · ${title} / ${artist}`, {
        dureeSec: Number(analysis.duration.toFixed(1)),
        tempo: Number(analysis.tempo.toFixed(1)),
        temps: analysis.beats.length,
        montees: analysis.builds.length,
        sections: analysis.sections.length,
        dureeMs: Math.round(performance.now() - startedAt),
        analyseEnCache: this.trackTimings?.analysisCache === true,
      });
      // Si le show partiel tourne déjà, on remplace le plan sans le relancer ;
      // sinon (analyse en cache, ou aucun calage encore) on tente le calage final.
      if (!partialShown || !this.updateSyncedAnalysis(analysis)) {
        void this.tryAutoSynced(title, artist, analysis.duration, analysis);
      }
      status.hidden = true;
    } catch (error) {
      if (seq !== this.resolveSeq) return;
      if (error instanceof ApiError && error.code === "aborted") {
        this.debug("analyse", "recherche annulée par l'utilisateur");
        // Une résolution automatique interrompue (morceau sauté) ne doit pas
        // renvoyer l'utilisateur à l'écran de dépôt : le show continue.
        if (!auto) this.backToDrop();
        return;
      }
      const message = error instanceof Error ? error.message : "Erreur inconnue pendant la résolution.";
      const detail =
        error instanceof ApiError ? `${error.code}${error.detail ? ` — ${error.detail}` : ""}` : String(error);
      // Une résolution automatique qui échoue est une situation normale (le
      // morceau peut ne pas être sur Deezer) : ce n'est pas une erreur. Elle ne
      // doit donc pas remplacer le show en cours par l'écran d'erreur.
      this.debug("attention", "morceau non récupéré automatiquement", { message, detail });
      if (auto) {
        // Échec normal côté show : on reste en direct et le dock reste visible.
        // L'état est publié vers le dashboard uniquement, jamais sur l'écran.
        this.resolveFailure = {
          title,
          artist,
          detail: error instanceof ApiError ? error.code : "erreur",
          at: Date.now(),
        };
        // Même clé = même morceau : le suivi du lecteur ne doit pas relancer
        // une résolution qui vient d'échouer.
        if (trackKey !== undefined) this.lastAutoTrackKey = trackKey;
        el<HTMLElement>("dock-panel").classList.remove("is-hidden");
        return;
      }
      setShowError("Le morceau n'a pas pu être récupéré", message, detail);
      showScreen("error");
      status.hidden = false;
      status.classList.add("is-error");
      status.textContent = message;
    } finally {
      this.debug("analyse", "résolution terminée", {
        titre: title,
        automatique: auto,
        dureeMs: Math.round(performance.now() - startedAt),
      });
      // Une résolution remplacée ne doit pas éteindre le contrôleur de la suivante.
      if (this.analysisController === controller) {
        this.analysisController = null;
        this.autoResolving = false;
      }
    }
  };

  /** Reçoit un morceau depuis le SSE : même traitement que le polling. */
  Target.prototype.receiveNowPlaying = function (this: App, raw: Record<string, unknown>): void {
    const data = normalizeNowPlaying(raw);
    const key = data.title.trim() === "" ? "" : detectedTrackKey(data);
    // La chronologie démarre à la détection réelle, pas à l'ouverture du job.
    if (key !== "" && key !== this.lastDetectedKey) {
      this.lastDetectedKey = key;
      this.beginTrackTimings();
    }
    this.nowPlaying = data;
    this.nowPlayingLastEventAt = Date.now();
    this.stopNowPlayingPolling();
    this.updateNowPlayingUI();
    // Le lecteur annonce le morceau suivant bien avant que son analyse soit
    // prête : on quitte immédiatement l'ancien show au lieu de le laisser
    // tourner (et se recaler sur le début du nouveau morceau). Plusieurs
    // lecteurs à la fois donnent un titre qui va et vient : on s'abstient.
    if (!data.ambiguous) this.abandonSyncedShowForTrackChange(data.title);
    void this.maybeAutoResolve();
  };

  Target.prototype.startNowPlayingPolling = function (this: App): void {
    if (this.nowPlayingPollTimer !== null) return;
    this.debug("sync", "SSE morceau indisponible · polling de secours");
    this.nowPlayingPollTimer = window.setInterval(() => void this.pollNowPlaying(), 1500);
    void this.pollNowPlaying();
  };

  Target.prototype.stopNowPlayingPolling = function (this: App): void {
    if (this.nowPlayingPollTimer === null) return;
    window.clearInterval(this.nowPlayingPollTimer);
    this.nowPlayingPollTimer = null;
  };

  /**
   * Ouvre le flux SSE des changements de morceau. Le polling ne sert plus que
   * de secours : il démarre si le flux tombe ou reste silencieux.
   */
  Target.prototype.bindNowPlayingStream = function (this: App): void {
    if (typeof EventSource === "undefined") {
      this.startNowPlayingPolling();
      return;
    }
    const source = new EventSource("/api/now-playing/stream");
    this.nowPlayingStream = source;
    source.onopen = () => {
      if (this.nowPlayingStream !== source) return;
      this.debug("sync", "flux SSE morceau ouvert");
      this.stopNowPlayingPolling();
    };
    source.onmessage = (event) => {
      if (this.nowPlayingStream !== source) return;
      try {
        const raw = JSON.parse(event.data) as Record<string, unknown>;
        this.receiveNowPlaying(raw);
      } catch {
        // Une ligne illisible ne doit pas couper le flux.
      }
    };
    source.onerror = () => {
      if (this.nowPlayingStream === source) this.startNowPlayingPolling();
    };
    this.nowPlayingWatchdog = window.setInterval(() => {
      if (this.nowPlayingStream === null) return;
      if (Date.now() - this.nowPlayingLastEventAt > 5000) this.startNowPlayingPolling();
    }, 1000);
  };

  Target.prototype.pollNowPlaying = async function (this: App): Promise<void> {
    try {
      const data = await fetchNowPlaying();
      this.nowPlaying = data;
      const key = data.title.trim() === "" ? "" : detectedTrackKey(data);
      if (key !== "" && key !== this.lastDetectedKey) {
        this.lastDetectedKey = key;
        this.beginTrackTimings();
      }
      this.updateNowPlayingUI();
      if (!data.ambiguous) this.abandonSyncedShowForTrackChange(data.title);
      dbgThrottled(
        "now-playing",
        "sync",
        "lecteur scruté",
        {
          source: data.available ? "détecté" : "aucun",
          titre: data.title || "—",
          artiste: data.artist || "—",
          statut: data.status,
          positionSec:
            data.positionSec === null || data.positionSec === undefined ? "—" : Number(data.positionSec.toFixed(1)),
          ambigue: data.ambiguous,
        },
        5000,
      );
      await this.maybeAutoResolve();
    } catch {
      // Service indisponible : on masque simplement l'indication.
      this.nowPlaying = null;
      const status = document.getElementById("resolve-detected");
      if (status !== null) status.hidden = true;
    }
  };

  Target.prototype.updateNowPlayingUI = function (this: App): void {
    const status = document.getElementById("resolve-detected");
    if (status === null) return;
    const label = detectedTrackLabel(this.nowPlaying);
    if (label === null) {
      status.hidden = true;
      return;
    }
    status.hidden = false;
    status.classList.remove("is-error");
    status.textContent = label;
  };

  Target.prototype.maybeAutoResolve = async function (this: App): Promise<void> {
    const data = this.nowPlaying;
    if (data === null || !shouldAutoResolve(data)) return;
    const key = detectedTrackKey(data);
    if (key === this.lastAutoTrackKey) return;
    // Le morceau a changé. Si une résolution automatique tournait encore pour le
    // morceau précédent — qu'on vient de sauter —, on l'abandonne : c'est le
    // morceau écouté maintenant qui doit être prêt en premier, comme une pile.
    // Le serveur, lui, finira de télécharger le morceau sauté pour le garder en
    // stock, mais sans l'analyser ni l'afficher. Une action manuelle (dépôt ou
    // saisie) n'est jamais interrompue par le suivi du lecteur.
    if (this.analysisController !== null) {
      if (!this.autoResolving) return;
      this.analysisController.abort();
    }
    this.lastAutoTrackKey = key;
    el<HTMLInputElement>("resolve-title").value = data.title;
    el<HTMLInputElement>("resolve-artist").value = data.artist;
    if (data.durationSec !== null && data.durationSec !== undefined && data.durationSec > 0) {
      el<HTMLInputElement>("resolve-duration").value = String(Math.round(data.durationSec));
    }
    await this.handleResolve(data.title, data.artist, data.durationSec ?? undefined, key, true);
  };
}
