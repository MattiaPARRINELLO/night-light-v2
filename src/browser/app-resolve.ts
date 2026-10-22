/**
 * Résolution d'un morceau par titre/artiste, et suivi du lecteur externe.
 * Méthodes greffées sur `App` (voir le commentaire d'en-tête de `app.ts`).
 */

import type { App } from "./app";
import { ApiError, fetchNowPlaying, resolveAndAnalyze, type JobTimings } from "../core/api";
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
      syncedMs: null,
      firstFrameMs: null,
      planMs: null,
      audioCache: false,
      analysisCache: false,
    };
  };

  /** Reporte les mesures serveur sur la chronologie affichée par le dashboard. */
  Target.prototype.applyJobTimings = function (this: App, timings: JobTimings | undefined): void {
    if (this.trackTimings === null) this.beginTrackTimings();
    const current = this.trackTimings;
    if (current === null || timings === undefined) return;
    if (typeof timings.detectedAt === "number" && timings.detectedAt > 0) {
      current.detectedAt = timings.detectedAt;
    }
    if (timings.foundMs !== undefined) current.foundMs = timings.foundMs;
    if (timings.downloadedMs !== undefined) current.downloadedMs = timings.downloadedMs;
    if (timings.analyzedMs !== undefined) current.analyzedMs = timings.analyzedMs;
    current.audioCache = timings.audioCache === true;
    current.analysisCache = timings.analysisCache === true;
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
    this.beginTrackTimings();
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
      void this.tryAutoSynced(title, artist, analysis.duration, analysis);
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

  Target.prototype.pollNowPlaying = async function (this: App): Promise<void> {
    try {
      const data = await fetchNowPlaying();
      this.nowPlaying = data;
      this.updateNowPlayingUI();
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
