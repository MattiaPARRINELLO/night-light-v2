/**
 * Show synchronisé sur un lecteur externe : appariement, boucle de resync et
 * rattrapage progressif de la dérive. Méthodes greffées sur `App` (voir le
 * commentaire d'en-tête de `app.ts`).
 */

import type { App } from "./app";
import { fetchPlaybackPosition, type PlaybackPositionResponse } from "../core/api";
import { dbgThrottled } from "../core/debug";
import {
  estimatePlayerPositionMs,
  normalizePlaybackText,
  syncCorrection,
  syncRamp,
  syncRampDuration,
} from "../core/playback";
import { renderFrame } from "../core/render";
import { buildShowPlan } from "../core/show";
import { TrackView } from "../core/view";
import { setStatus, showScreen } from "./ui";
import type { Analysis } from "../types";

declare module "./app" {
  interface App {
    tryAutoSynced(title: string, artist: string, duration: number, analysis: Analysis): Promise<void>;
    startSyncedShow(analysis: Analysis, initialMs: number, state?: PlaybackPositionResponse): Promise<void>;
    startSyncedLoop(): void;
    stopSyncedMode(): void;
    foldSyncCorrection(nowEpochMs: number): void;
    showTimeMs(nowEpochMs: number): number;
    renderSynced(): void;
    resyncSynced(duration: number): Promise<void>;
    calibrateLatency(): void;
  }
}

export function installSync(Target: { prototype: App }): void {
  Target.prototype.tryAutoSynced = async function (
    this: App,
    title: string,
    artist: string,
    duration: number,
    analysis: Analysis,
  ): Promise<void> {
    // Une analyse qui arrive pendant un show doit d'abord l'arrêter. Sans ça, le
    // deuxième morceau restait bloqué par la garde ci-dessous (`syncedMode` du
    // show précédent) et l'écran continuait d'afficher l'ancien.
    this.stopSyncedMode();
    this.stopLoop();
    this.audio.pause();
    this.view = null;
    this.plan = null;

    this.debugSync.phase = "SYNCING";
    this.debugSync.expectedTitle = title;
    this.debugSync.attempts = 0;
    this.debug("sync", "attente d'une lecture externe correspondante", {
      titre: title,
      artiste: artist || "—",
      dureeSec: Number(duration.toFixed(1)),
    });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      // `view !== null` : un show local a été forcé entre-temps, on ne le remplace pas.
      if (!this.pendingAnalysis || this.view !== null) return;
      this.debugSync.attempts = attempt + 1;
      try {
        const state = await fetchPlaybackPosition(title, artist, duration);
        this.debugLastPlayer = {
          source: state.source,
          status: state.status,
          title: state.title,
          artist: state.artist,
          positionMs: state.positionMs,
          capturedAtMs: state.capturedAtMs,
        };
        this.debugSync.source = state.source;
        this.debugSync.playerTitle = state.title;
        this.debugSync.playerMs = state.positionMs;
        this.debugSync.showMs = state.positionMs + this.syncedLatencyMs;
        const match = state.match?.accepted === true;
        const durationDelta = state.match?.durationDeltaSec ?? null;
        const formatOk = durationDelta === null || durationDelta <= 3;
        const reasons = state.match?.reasons ?? [];
        this.debugSync.match = [
          match ? "correspondance OK" : "pas de correspondance",
          reasons.length > 0 ? `motifs=${reasons.join(",")}` : "motifs=aucun",
          durationDelta === null ? "durée non comparée" : `écart durée ${durationDelta.toFixed(2)}s`,
          `statut=${state.status}`,
        ].join(" · ");
        dbgThrottled(
          "sync-attempt",
          "sync",
          `tentative ${attempt + 1}/10 de synchronisation`,
          {
            source: state.source,
            lecteur: state.title || "—",
            positionSec: Number((state.positionMs / 1000).toFixed(2)),
            statut: state.status,
            correspondance: match,
            motifs: reasons,
            ecartDureeSec: durationDelta,
          },
          1500,
        );
        if (match && formatOk && state.status === "playing") {
          // Position ramenée à l'instant présent : la mesure date du sous-processus
          // playerctl, pas de la réponse HTTP.
          const initialMs = estimatePlayerPositionMs(
            {
              source: state.source,
              status: state.status,
              title: state.title,
              artist: state.artist,
              positionMs: state.positionMs,
              capturedAtMs: state.capturedAtMs,
            },
            Date.now(),
          );
          await this.startSyncedShow(analysis, initialMs, state);
          return;
        }
      } catch (error) {
        this.debugSync.match = "position injoignable";
        this.debug("erreur", "lecture de position impossible", error instanceof Error ? error.message : String(error));
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    // Aucune lecture correspondante pendant 20 s : on renonce proprement.
    this.fallbackToLive(title, "Aucune position MPRIS/Spotify correspondante pendant 20 s.");
  };

  Target.prototype.startSyncedShow = async function (
    this: App,
    analysis: Analysis,
    initialMs: number,
    state?: PlaybackPositionResponse,
  ): Promise<void> {
    // Un show déjà en cours (calé ou local) doit s'arrêter net : sinon son
    // minuteur et sa boucle de rendu survivent au nouveau show.
    this.stopSyncedMode();
    this.stopLoop();
    this.audio.pause();
    this.view = null;
    this.plan = null;

    this.stopLiveMode();
    // On coupe le visualiseur en barres, PAS la capture : l'audio vient du
    // lecteur externe (aucun risque de boucle), et le tableau de bord continue
    // ainsi d'afficher le son en direct pendant tout le show.
    this.stopLiveRender();
    this.liveMode = false;
    this.syncedMode = true;
    this.debugSync.phase = "SHOW_SYNCED";
    if (state !== undefined) {
      this.debugSync.source = state.source;
      this.debugSync.playerTitle = state.title;
    }
    this.debugSync.expectedTitle = this.pendingTitle;
    this.debugSync.latencyMs = this.syncedLatencyMs;
    this.debugSync.match = "show lancé à la position du lecteur";

    this.syncedView = new TrackView(analysis);
    this.syncedPlan = buildShowPlan(analysis, this.effectiveReduced());
    // Le show s'ouvre depuis le noir au lieu d'apparaître d'un coup.
    this.beginTransition();
    this.syncedStartMs = initialMs + this.syncedLatencyMs;
    this.syncedStartedAtEpoch = Date.now();
    this.syncedPaused = false;
    this.syncDriftMs = 0;
    if (this.syncedTimer !== null) window.clearInterval(this.syncedTimer);
    this.syncedTimer = window.setInterval(() => void this.resyncSynced(analysis.duration), 2500);
    this.startSyncedLoop();
    // Un show calé occupe l'écran de spectacle : sans ce basculement, l'écran
    // de dépôt restait « actif » et le dashboard annonçait « Écran affiché :
    // Dépôt » pendant tout le show.
    showScreen("show");
    this.resize();
    setStatus(`Show synchronisé lancé : ${this.pendingTitle}.`);
    this.debug("sync", "show synchronisé démarré", {
      titre: this.pendingTitle,
      source: state?.source ?? "?",
      positionLecteurSec: Number((initialMs / 1000).toFixed(2)),
      latenceMs: this.syncedLatencyMs,
      positionShowSec: Number((this.syncedStartMs / 1000).toFixed(2)),
      dureeSec: Number(analysis.duration.toFixed(1)),
    });
  };

  Target.prototype.startSyncedLoop = function (this: App): void {
    if (this.syncedRaf !== 0) return;
    let lastTs = 0;
    const loop = (timestamp: number): void => {
      this.syncedRaf = requestAnimationFrame(loop);
      if (!this.syncedMode || this.syncedView === null || this.syncedPlan === null) return;
      // Sans ce suivi, la qualité restait au maximum pendant tout le show : une
      // scène chargée (wash complet plus une famille à faisceaux) dessinait tout
      // en pleine résolution avec du flou partout, et l'image saccadait.
      if (lastTs !== 0) {
        const delta = timestamp - lastTs;
        if (delta > 0) {
          // Moyenne rapide : à cinq images par seconde, une moyenne lente
          // mettrait dix secondes à voir que la machine souffre.
          this.fps += (1000 / delta - this.fps) * 0.2;
          this.updateQuality();
          const band = this.quality < 0.5;
          if (band !== this.qualityBand) {
            this.qualityBand = band;
            this.resize();
          }
        }
      }
      lastTs = timestamp;
      this.renderSynced();
    };
    this.syncedRaf = requestAnimationFrame(loop);
  };

  Target.prototype.stopSyncedMode = function (this: App): void {
    if (this.syncedRaf !== 0) cancelAnimationFrame(this.syncedRaf);
    this.syncedRaf = 0;
    if (this.syncedTimer !== null) {
      window.clearInterval(this.syncedTimer);
      this.syncedTimer = null;
    }
    this.syncedPaused = false;
    this.syncedMode = false;
  };

  /**
   * Intègre à l'origine la part déjà rattrapée, et termine le rattrapage.
   *
   * Indispensable avant d'en démarrer un nouveau : repartir de zéro ferait
   * reculer le show de tout ce qui avait déjà été corrigé — un saut en arrière,
   * exactement ce qu'on veut éviter.
   */
  Target.prototype.foldSyncCorrection = function (this: App, nowEpochMs: number): void {
    if (this.syncDriftMs === 0) return;
    this.syncedStartMs += syncRamp(this.syncDriftMs, nowEpochMs - this.syncCorrectionStart, this.syncCorrectionDur);
    this.syncDriftMs = 0;
  };

  /**
   * Temps du show à l'instant `nowEpochMs`, rattrapage en cours compris.
   *
   * Le temps du show est l'entrée de tous les mouvements : le déplacer d'un
   * coup faisait sauter les projecteurs (les wash surtout, dont le balayage est
   * calé sur le tempo). Un écart se rattrape donc progressivement, à vitesse
   * légèrement différente, et n'est intégré à l'origine qu'une fois rejoint.
   */
  Target.prototype.showTimeMs = function (this: App, nowEpochMs: number): number {
    // En pause, le temps du show est gelé : il ne doit pas avancer entre deux
    // resynchronisations, sinon chaque resync le ramènerait en arrière.
    if (this.syncedPaused) return this.syncedStartMs;
    if (this.syncDriftMs === 0) return this.syncedStartMs + (nowEpochMs - this.syncedStartedAtEpoch);
    const ecoule = nowEpochMs - this.syncCorrectionStart;
    if (ecoule >= this.syncCorrectionDur) {
      // Rattrapage terminé : on l'intègre à l'origine. La valeur est la même de
      // part et d'autre, donc aucun saut.
      this.foldSyncCorrection(nowEpochMs);
      return this.syncedStartMs + (nowEpochMs - this.syncedStartedAtEpoch);
    }
    const base = this.syncedStartMs + (nowEpochMs - this.syncedStartedAtEpoch);
    return base + syncRamp(this.syncDriftMs, ecoule, this.syncCorrectionDur);
  };

  Target.prototype.renderSynced = function (this: App): void {
    const view = this.syncedView;
    const plan = this.syncedPlan;
    if (view === null || plan === null) return;
    const time = Math.max(0, this.showTimeMs(Date.now()) / 1000);
    try {
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      renderFrame({
        ctx: this.ctx,
        width: this.canvas.clientWidth,
        height: this.canvas.clientHeight,
        dpr: this.canvas.width / Math.max(1, this.canvas.clientWidth),
        time: Math.min(time, view.duration),
        view,
        plan,
        settings: this.settings,
        reducedMotion: this.reducedMotion,
        quality: this.quality,
        frame: this.frame,
        haze: this.hazeFor(this.quality, this.canvas.clientWidth, this.canvas.clientHeight),
      });
      this.frame += 1;
      this.drawTransitionIfNeeded(Math.min(time, view.duration), plan);
    } catch (error) {
      this.debug("erreur", "rendu synchronisé interrompu", error instanceof Error ? error.message : String(error));
      console.error("Rendu synchronisé interrompu", error);
    }
  };

  Target.prototype.resyncSynced = async function (this: App, duration: number): Promise<void> {
    if (!this.syncedMode || this.syncedView === null) return;
    // Même horloge que le serveur (epoch) : la comparaison avec la position du
    // lecteur n'a de sens qu'à cette condition.
    const nowMs = Date.now();
    try {
      const state = await fetchPlaybackPosition(this.pendingTitle, "", duration);
      this.debugSync.resyncAt = nowMs;
      this.debugSync.source = state.source;
      this.debugSync.playerTitle = state.title;
      this.debugSync.expectedTitle = this.pendingTitle;
      this.debugSync.latencyMs = this.syncedLatencyMs;

      if (
        state.title &&
        this.pendingTitle &&
        normalizePlaybackText(state.title) !== normalizePlaybackText(this.pendingTitle)
      ) {
        this.debug("sync", "changement de morceau détecté · retour en Live", {
          attendu: this.pendingTitle,
          lecteur: state.title,
        });
        this.backToDrop();
        return;
      }

      const player = {
        source: state.source,
        status: state.status,
        title: state.title,
        artist: state.artist,
        positionMs: state.positionMs,
        capturedAtMs: state.capturedAtMs,
      };
      this.debugLastPlayer = player;
      // La requête de position a pris quelques centaines de millisecondes :
      // l'instant d'`nowMs` est périmé pour comparer les deux positions, et
      // replier un rattrapage avec un horodatage périmé faisait reculer le show
      // de ce qui avait déjà été rattrapé.
      const maintenant = Date.now();
      // Position réelle du lecteur, puis cible du show : le réglage de latence
      // place volontairement le show en avance sur le son (Bluetooth, HDMI…).
      const playerMs = estimatePlayerPositionMs(player, maintenant);
      const targetShowMs = playerMs + this.syncedLatencyMs;
      // Contre le temps réellement dessiné, rattrapage en cours compris : sans
      // ça, une correction en cours serait comptée comme une dérive à corriger,
      // et les deux corrections se combattraient.
      const showMs = this.showTimeMs(maintenant);
      const drift = targetShowMs - showMs;
      // L'écart mesuré avant correction sert à décider, pas à s'afficher : ce qui
      // compte pour l'utilisateur est l'écart résiduel une fois recadré.
      const driftAvantCorrection = drift;

      if (state.status === "paused") {
        this.debugSync.phase = "PAUSED";
        this.debugSync.match = "lecture en pause · show figé";
        // On se fige une seule fois, à la position du lecteur (avec la latence,
        // comme le show) : les resyncs suivants ne doivent plus toucher à
        // l'origine, sinon le temps du show reculerait à chaque contrôle.
        if (!this.syncedPaused) {
          this.syncedPaused = true;
          this.syncedStartMs = targetShowMs;
          this.syncedStartedAtEpoch = maintenant;
          this.debug("sync", "lecture en pause · show figé sur place", {
            positionSec: Number((this.syncedStartMs / 1000).toFixed(2)),
            positionLecteurSec: Number((playerMs / 1000).toFixed(2)),
          });
        }
        // L'origine est réécrite : le rattrapage en cours n'a plus lieu d'être.
        this.syncDriftMs = 0;
        return;
      }

      if (state.status !== "playing") {
        this.debugSync.phase = "LOST";
        this.debugSync.match = `lecteur statut=${state.status}`;
        this.debug("sync", `statut de lecture inattendu (${state.status}) · show laissé en l'état`);
        return;
      }

      // Reprise : le temps repart de la position figée sans saut, puis la
      // correction éventuelle (lecteur déplacé pendant la pause) s'applique.
      if (this.syncedPaused) {
        this.syncedPaused = false;
        this.syncedStartMs = showMs;
        this.syncedStartedAtEpoch = maintenant;
      }

      this.debugSync.phase = "SHOW_SYNCED";
      const correction = syncCorrection(drift);
      if (correction === "hard") {
        this.debugSync.match = "écart ≥ 1,5 s · recalage direct";
        this.syncedStartMs = targetShowMs;
        this.syncedStartedAtEpoch = maintenant;
        // Recalage volontaire : le rattrapage en cours est écrasé.
        this.syncDriftMs = 0;
        this.debug("sync", "écart important · recalage direct du show", {
          ecartMs: Math.round(driftAvantCorrection),
          nouvellePositionSec: Number((this.syncedStartMs / 1000).toFixed(2)),
          positionLecteurSec: Number((playerMs / 1000).toFixed(2)),
        });
      } else if (correction === "soft") {
        // Rattrapage progressif : le show se recale à vitesse légèrement
        // différente au lieu de sauter à la nouvelle position. On intègre
        // d'abord la part déjà rattrapée, sinon ce nouveau départ ferait
        // reculer le show.
        this.foldSyncCorrection(maintenant);
        this.syncDriftMs = drift;
        this.syncCorrectionStart = maintenant;
        this.syncCorrectionDur = syncRampDuration(drift);
        this.debugSync.match = "écart > 150 ms · rattrapage progressif";
        this.debug("sync", "dérive détectée · rattrapage progressif", {
          ecartMs: Math.round(driftAvantCorrection),
          dureeMs: this.syncCorrectionDur,
          positionLecteurSec: Number((playerMs / 1000).toFixed(2)),
        });
      } else {
        this.debugSync.match = "synchronisé (≤ 150 ms)";
        dbgThrottled(
          "resync",
          "sync",
          "synchronisé",
          {
            ecartMs: Math.round(drift),
            lecteurSec: Number((playerMs / 1000).toFixed(2)),
            showSec: Number(((this.syncedStartMs + (Date.now() - this.syncedStartedAtEpoch)) / 1000).toFixed(2)),
            latenceMs: this.syncedLatencyMs,
          },
          5000,
        );
      }

      // Affichage de l'état APRÈS correction : l'écart résiduel est la seule
      // valeur qui décrit ce que voit l'utilisateur.
      const affichage = Date.now();
      const lecteurAffiche = estimatePlayerPositionMs(player, affichage);
      const showAffiche = this.showTimeMs(affichage);
      this.debugSync.playerMs = lecteurAffiche;
      this.debugSync.showMs = showAffiche;
      this.debugSync.driftMs = lecteurAffiche + this.syncedLatencyMs - showAffiche;
    } catch (error) {
      this.debugSync.phase = "LOST";
      this.debugSync.match = "position de lecture injoignable";
      this.debug("erreur", "position de lecture injoignable pendant la resynchronisation", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  Target.prototype.calibrateLatency = function (this: App): void {
    if (!this.syncedMode || this.syncedView === null) return;
    const time = (this.syncedStartMs + (Date.now() - this.syncedStartedAtEpoch)) / 1000;
    const beats = this.syncedView.beats;
    let nearestMs = Math.round(time * 1000);
    let diffMs = Number.POSITIVE_INFINITY;
    for (const beat of beats) {
      const d = Math.abs(beat * 1000 - Math.round(time * 1000));
      if (d < diffMs) {
        diffMs = d;
        nearestMs = Math.round(beat * 1000);
      }
    }
    this.syncedLatencyMs = Math.max(-500, Math.min(1000, nearestMs - Math.round(time * 1000)));
    const input = document.getElementById("latency-offset") as HTMLInputElement | null;
    if (input !== null) input.value = String(this.syncedLatencyMs);
    localStorage.setItem("night-light-latency", String(this.syncedLatencyMs));
  };
}
