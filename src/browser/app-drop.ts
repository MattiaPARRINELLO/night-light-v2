/**
 * Dépôt de fichier, analyse locale et retour à l'écran de dépôt.
 * Méthodes greffées sur `App` (voir le commentaire d'en-tête de `app.ts`).
 */

import type { App } from "./app";
import { ApiError, uploadAndAnalyze } from "../core/api";
import { dbgThrottled } from "../core/debug";
import { el, setDropError, setShowError, setUploadState, showScreen } from "./ui";

const AUDIO_EXTENSIONS = /\.(mp3|wav|ogg|oga|flac|m4a|aac|opus|weba|webm)$/i;

declare module "./app" {
  interface App {
    bindDrop(): void;
    handleFile(file: File): Promise<void>;
    fallbackToLive(title: string, reason: string): void;
    setNotice(text: string): void;
    clearNotice(): void;
    bindAnalysis(): void;
    releaseSession(): Promise<void>;
  }
}

export function installDrop(Target: { prototype: App }): void {
  Target.prototype.bindDrop = function (this: App): void {
    const zone = el<HTMLElement>("dropzone");
    const input = el<HTMLInputElement>("file-input");
    let depth = 0;

    zone.addEventListener("click", () => input.click());
    zone.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        input.click();
      }
    });
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file !== undefined) void this.handleFile(file);
      input.value = "";
    });

    const stop = (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };

    zone.addEventListener("dragenter", (event) => {
      stop(event);
      depth += 1;
      zone.classList.add("is-dragover");
    });
    zone.addEventListener("dragover", (event) => {
      stop(event);
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "copy";
      zone.classList.add("is-dragover");
    });
    zone.addEventListener("dragleave", (event) => {
      stop(event);
      depth -= 1;
      if (depth <= 0) {
        depth = 0;
        zone.classList.remove("is-dragover");
      }
    });
    zone.addEventListener("drop", (event) => {
      stop(event);
      depth = 0;
      zone.classList.remove("is-dragover");
      const file = event.dataTransfer?.files?.[0];
      if (file !== undefined) void this.handleFile(file);
    });

    // Empêche le navigateur d'ouvrir un fichier lâché hors zone.
    window.addEventListener("dragover", stop);
    window.addEventListener("drop", stop);
  };

  Target.prototype.handleFile = async function (this: App, file: File): Promise<void> {
    setDropError(null);
    if (this.limits !== null && file.size > this.limits.maxFileBytes) {
      setDropError(
        `Fichier trop volumineux (${(file.size / 1048576).toFixed(1)} Mo). Limite : ${(
          this.limits.maxFileBytes / 1048576
        ).toFixed(0)} Mo.`,
      );
      return;
    }
    if (file.size === 0) {
      setDropError("Ce fichier est vide.");
      return;
    }
    const looksAudio =
      file.type.startsWith("audio/") || file.type === "video/mp4" || AUDIO_EXTENSIONS.test(file.name);
    if (!looksAudio) {
      setDropError("Format non reconnu. Dépose un MP3, WAV, OGG, FLAC ou M4A.");
      return;
    }

    const title = file.name.replace(/\.[^.]+$/, "");
    this.pendingTitle = title;
    this.pendingAnalysis = null;
    el<HTMLElement>("dock-panel").classList.add("is-hidden");
    setUploadState({
      phase: "Envoi",
      progress: 0,
      detail: `${(file.size / 1048576).toFixed(1)} Mo — le fichier part vers le serveur local`,
      title,
      meta: "Analyse audio en approche",
    });

    const controller = new AbortController();
    this.analysisController = controller;
    this.autoResolving = false;
    this.debug("analyse", `fichier déposé · ${title}`, {
      tailleMo: Number((file.size / 1048576).toFixed(1)),
      type: file.type || "inconnu",
    });
    try {
      const { jobId, analysis } = await uploadAndAnalyze(file, {
        signal: controller.signal,
        onUploadProgress: (ratio) => {
          setUploadState({
            phase: "Envoi",
            progress: ratio * 0.25,
            detail: `${Math.round(ratio * 100)} % envoyé`,
          });
          dbgThrottled("upload", "analyse", "envoi vers le serveur", { progression: `${Math.round(ratio * 100)} %` }, 2000);
        },
        onPhase: ({ progress, phase, detail }) => {
          setUploadState({
            phase,
            progress: 0.25 + progress * 0.75,
            detail: detail.length > 0 ? detail : phase,
          });
        },
      });
      this.jobId = jobId;
      this.pendingAnalysis = analysis;
      document.body.dataset.analysisReady = "true";
      this.debug("analyse", "analyse terminée", {
        titre: title,
        dureeSec: Number(analysis.duration.toFixed(1)),
        tempo: Number(analysis.tempo.toFixed(1)),
        temps: analysis.beats.length,
        montees: analysis.builds.length,
        sections: analysis.sections.length,
      });
      void this.tryAutoSynced(title, "", analysis.duration, analysis);
    } catch (error) {
      if (error instanceof ApiError && error.code === "aborted") {
        this.debug("analyse", "analyse annulée par l'utilisateur");
        this.backToDrop();
        return;
      }
      const message = error instanceof Error ? error.message : "Erreur inconnue pendant l'analyse.";
      const detail =
        error instanceof ApiError ? `${error.code}${error.detail ? ` — ${error.detail}` : ""}` : String(error);
      this.debug("erreur", "analyse en échec", { message, detail });
      setShowError("L'analyse a échoué", message, detail);
      showScreen("error");
    } finally {
      this.analysisController = null;
    }
  };

  /**
   * Morceau non reconnu côté lecteur : ce n'est pas une erreur, c'est un repli.
   * On repasse en direct — qui réagit au son — et on se contente d'un avis
   * discret, plutôt que d'un écran d'erreur qui prend toute la salle.
   */
  Target.prototype.fallbackToLive = function (this: App, title: string, reason: string): void {
    this.debugSync.phase = "LOST";
    this.debugSync.match = reason;
    this.setNotice(`« ${title} » non reconnu — synchronisation sur le son en direct`);
    this.debug("attention", `morceau « ${title} » non reconnu · repli sur le direct`, reason);
    this.lastError = null;
    this.backToDrop();
  };

  /** Avis discret en bas d'écran, jamais un écran d'erreur. */
  Target.prototype.setNotice = function (this: App, text: string): void {
    this.notice = { text, at: Date.now() };
    const node = document.getElementById("notice");
    if (node !== null) {
      node.textContent = text;
      node.hidden = false;
    }
    // L'avis s'efface tout seul : il informe, il ne s'installe pas. Le dashboard
    // garde l'information tant qu'un nouveau morceau n'a pas été reconnu.
    if (this.noticeTimer !== null) window.clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => {
      const bar = document.getElementById("notice");
      if (bar !== null) bar.hidden = true;
    }, 12000);
  };

  Target.prototype.clearNotice = function (this: App): void {
    this.notice = null;
    if (this.noticeTimer !== null) window.clearTimeout(this.noticeTimer);
    this.noticeTimer = null;
    const node = document.getElementById("notice");
    if (node !== null) {
      node.textContent = "";
      node.hidden = true;
    }
  };

  Target.prototype.bindAnalysis = function (this: App): void {
    el<HTMLButtonElement>("btn-cancel-analysis").addEventListener("click", () => {
      this.analysisController?.abort();
      this.backToDrop();
    });
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.analysisController !== null) {
        this.analysisController.abort();
        this.backToDrop();
      }
    });
    el<HTMLButtonElement>("btn-error-back").addEventListener("click", () => {
      this.backToDrop();
    });
  };

  Target.prototype.releaseSession = async function (this: App): Promise<void> {
    const session = this.session;
    this.session = null;
    this.view = null;
    this.plan = null;
    this.pendingAnalysis = null;
    if (session === null) return;
    try {
      await fetch(`/api/session/${encodeURIComponent(session.jobId)}`, { method: "DELETE" });
    } catch {
      // La suppression est un confort : le serveur purge de toute façon.
    }
  };
}
