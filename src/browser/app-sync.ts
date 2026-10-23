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
import { sceneAt } from "../core/show";
import { TrackView } from "../core/view";
import { setStatus, showScreen } from "./ui";
import type { Analysis } from "../types";

declare module "./app" {
  interface App {
    tryAutoSynced(title: string, artist: string, duration: number, analysis: Analysis): Promise<void>;
    startSyncedShow(analysis: Analysis, initialMs: number, state?: PlaybackPositionResponse): Promise<void>;
    updateSyncedAnalysis(analysis: Analysis): boolean;
    startCrossfade(analysis: Analysis, initialMs: number): void;
    crossfadeDelayMs(analysis: Analysis, initialMs: number): number;
    composeCrossfade(): void;
    finishCrossfade(): void;
    cancelCrossfade(): void;
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
    const startedAt = performance.now();
    const attemptSeq = (this.syncAttemptSeq += 1);
    const finish = (verdict: string): void => {
      this.debug("sync", "tryAutoSynced terminé", {
        titre: title,
        verdict,
        dureeMs: Math.round(performance.now() - startedAt),
      });
    };
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
    // Premier essai immédiat, puis des intervalles croissants : la détection
    // MPRIS arrive en SSE, donc attendre 2 s fixe ne fait que perdre du temps
    // quand le morceau est déjà disponible.
    const delaysMs = [0, 250, 500, 1000, 1500, 2000, 2500, 3000, 3000, 4000];
    for (let attempt = 0; attempt < delaysMs.length; attempt += 1) {
      if (attemptSeq !== this.syncAttemptSeq) return finish("remplacé par une analyse plus récente");
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
      if (attemptSeq !== this.syncAttemptSeq) return finish("remplacé par une analyse plus récente");
      // `view !== null` : un show local a été forcé entre-temps, on ne le remplace pas.
      if (!this.pendingAnalysis || this.view !== null) return finish("show local prioritaire");
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
          `tentative ${attempt + 1}/${delaysMs.length} de synchronisation`,
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
          return finish("calé");
        }
      } catch (error) {
        this.debugSync.match = "position injoignable";
        this.debug("erreur", "lecture de position impossible", error instanceof Error ? error.message : String(error));
      }
    }
    // Aucune lecture correspondante pendant ~17 s : on renonce proprement.
    this.fallbackToLive(title, "Aucune position MPRIS/Spotify correspondante pendant ~17 s.");
    finish("repli en direct");
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

    const useCrossfade = this.transitionMode === "crossfade";
    if (useCrossfade) {
      // Le live continue de tourner : il fournit la première moitié du fondu.
      // On ne l'arrête qu'à la fin (voir `finishCrossfade`).
      this.liveMode = true;
    } else {
      this.stopLiveMode();
      // On coupe le visualiseur en barres, PAS la capture : l'audio vient du
      // lecteur externe (aucun risque de boucle), et le tableau de bord continue
      // ainsi d'afficher le son en direct pendant tout le show.
      this.stopLiveRender();
      this.liveMode = false;
    }
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
    this.syncedPlan = this.buildPlan(analysis);
    this.pendingSynced = null;
    this.syncedStartMs = initialMs + this.syncedLatencyMs;
    this.syncedStartedAtEpoch = Date.now();
    this.syncedPaused = false;
    this.syncDriftMs = 0;
    if (this.syncedTimer !== null) window.clearInterval(this.syncedTimer);
    this.syncedTimer = window.setInterval(() => void this.resyncSynced(analysis.duration), 2500);
    // Un show calé occupe l'écran de spectacle : sans ce basculement, l'écran
    // de dépôt restait « actif » et le dashboard annonçait « Écran affiché :
    // Dépôt » pendant tout le show.
    showScreen("show");
    this.resize();
    if (useCrossfade) {
      this.startCrossfade(analysis, initialMs);
    } else {
      // Le show s'ouvre depuis le noir au lieu d'apparaître d'un coup.
      this.beginTransition();
    }
    this.startSyncedLoop();
    this.markSynced();
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

  /**
   * Reçoit l'analyse complète alors qu'un show partiel tourne déjà.
   *
   * Le nouveau plan garde la graine du plan partiel (mêmes palettes) et n'est
   * appliqué qu'à la fin de la scène courante : aucun saut visible, aucune
   * frame noir. Si le tempo différait d'un facteur 2, le nouveau plan aligne la
   * grille sur le tempo final dès cette bascule.
   */
  Target.prototype.updateSyncedAnalysis = function (this: App, analysis: Analysis): boolean {
    if (!this.syncedMode || this.syncedPlan === null) return false;
    const seed = this.syncedPlan.seed;
    const plan = this.buildPlan(analysis, seed);
    const view = new TrackView(analysis);
    const nowSec = Math.max(0, this.showTimeMs(Date.now()) / 1000);
    const currentScene = sceneAt(this.syncedPlan, Math.min(nowSec, this.syncedPlan.duration));
    const switchAt = Math.max(nowSec + 0.05, currentScene.end);
    const previousTempo = this.syncedView?.tempo ?? analysis.tempo;
    const ratio = previousTempo > 0 ? analysis.tempo / previousTempo : 1;
    this.pendingSynced = { view, plan, switchAt };
    this.debug("sync", "analyse finale reçue · bascule à la fin de la scène", {
      dansSec: Number((switchAt - nowSec).toFixed(2)),
      tempoPartiel: Number(previousTempo.toFixed(1)),
      tempoFinal: Number(analysis.tempo.toFixed(1)),
      facteur: Number(ratio.toFixed(2)),
      aligneTempoFinal: ratio > 1.8 || ratio < 0.55,
    });
    return true;
  };

  /**
   * Attente avant le fondu : prochain temps fort (au plus un temps), ou l'impact
   * d'une montée s'il tombe dans les 4 s. Un impact est un meilleur point de
   * bascule qu'un temps ordinaire, même s'il est un peu plus loin.
   */
  Target.prototype.crossfadeDelayMs = function (this: App, analysis: Analysis, initialMs: number): number {
    const now = (initialMs + this.syncedLatencyMs) / 1000;
    let beatDelay = analysis.beatPeriod > 0 ? analysis.beatPeriod : 0.5;
    for (const beat of analysis.beats) {
      if (beat > now) {
        beatDelay = Math.min(beatDelay, beat - now);
        break;
      }
    }
    let dropDelay: number | null = null;
    for (const build of analysis.builds) {
      const delta = build.end - now;
      if (delta >= 0 && delta <= 4 && (dropDelay === null || delta < dropDelay)) {
        dropDelay = delta;
      }
    }
    return Math.max(0, Math.round((dropDelay ?? beatDelay) * 1000));
  };

  Target.prototype.startCrossfade = function (this: App, analysis: Analysis, initialMs: number): void {
    this.cancelCrossfade();
    const width = Math.max(1, this.canvas.width);
    const height = Math.max(1, this.canvas.height);
    const makeCanvas = (): HTMLCanvasElement => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      return canvas;
    };
    const liveCanvas = makeCanvas();
    const syncedCanvas = makeCanvas();
    const liveCtx = liveCanvas.getContext("2d");
    const syncedCtx = syncedCanvas.getContext("2d");
    if (liveCtx === null || syncedCtx === null) {
      // Pas de canvas hors écran : on retombe sur l'ouverture historique.
      this.liveMode = false;
      this.stopLiveMode();
      this.stopLiveRender();
      this.beginTransition();
      return;
    }
    // Aucun voile noir ne doit s'interposer : le fondu enchaîné remplace la
    // transition depuis le noir.
    this.transitionStart = 0;
    const state = {
      active: false,
      startedAt: 0,
      durationMs: 1500,
      liveCanvas,
      liveCtx,
      syncedCanvas,
      syncedCtx,
      timer: null as number | null,
    };
    this.crossfade = state;
    const delayMs = this.crossfadeDelayMs(analysis, initialMs);
    this.debug("sync", "fondu enchaîné armé", {
      attenteMs: delayMs,
      positionSec: Number((initialMs / 1000).toFixed(2)),
    });
    state.timer = window.setTimeout(() => {
      state.timer = null;
      if (this.crossfade !== state) return;
      // Premier composite : on part de l'image live déjà affichée à l'écran.
      try {
        liveCtx.setTransform(1, 0, 0, 1, 0, 0);
        liveCtx.clearRect(0, 0, width, height);
        liveCtx.drawImage(this.canvas, 0, 0);
      } catch {
        // Si la copie échoue, le premier frame live arrive juste après.
      }
      state.active = true;
      state.startedAt = performance.now();
      this.debug("sync", "fondu enchaîné démarré", { dureeMs: state.durationMs });
    }, delayMs);
  };

  Target.prototype.composeCrossfade = function (this: App): void {
    const fade = this.crossfade;
    if (fade === null || !fade.active) return;
    // Machine à la peine pendant le fondu : on le termine en 0,6 s.
    if (Math.min(this.quality, this.liveQuality) < 0.5 && fade.durationMs > 600) {
      fade.durationMs = 600;
      this.debug("sync", "fondu enchaîné raccourci · qualité < 0,5");
    }
    const elapsed = performance.now() - fade.startedAt;
    const progress = Math.max(0, Math.min(1, elapsed / Math.max(1, fade.durationMs)));
    // ease-in-out (smoothstep) : pas de saut de luminance aux deux extrémités.
    const alpha = progress * progress * (3 - 2 * progress);
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.globalCompositeOperation = "source-over";
    this.ctx.globalAlpha = 1;
    this.ctx.drawImage(fade.liveCanvas, 0, 0);
    this.ctx.globalAlpha = alpha;
    this.ctx.drawImage(fade.syncedCanvas, 0, 0);
    this.ctx.globalAlpha = 1;
    if (progress >= 1) this.finishCrossfade();
  };

  Target.prototype.finishCrossfade = function (this: App): void {
    const fade = this.crossfade;
    if (fade === null) return;
    if (fade.timer !== null) window.clearTimeout(fade.timer);
    this.crossfade = null;
    // Le live n'est arrêté qu'ici, une fois le fondu terminé.
    this.stopLiveMode();
    this.stopLiveRender();
    this.liveMode = false;
    this.debug("sync", "fondu enchaîné terminé · live arrêté");
  };

  Target.prototype.cancelCrossfade = function (this: App): void {
    const fade = this.crossfade;
    if (fade === null) return;
    if (fade.timer !== null) window.clearTimeout(fade.timer);
    this.crossfade = null;
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
    this.pendingSynced = null;
    this.cancelCrossfade();
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
    const time = Math.max(0, this.showTimeMs(Date.now()) / 1000);
    const pending = this.pendingSynced;
    if (pending !== null && time >= pending.switchAt) {
      this.syncedView = pending.view;
      this.syncedPlan = pending.plan;
      this.pendingSynced = null;
      this.debug("sync", "plan final appliqué · fin de la scène partielle");
    }
    const view = this.syncedView;
    const plan = this.syncedPlan;
    if (view === null || plan === null) return;
    const coverage = plan.coverage;
    const outside = coverage !== undefined && (time < coverage[0] || time > coverage[1]);
    const fade = this.crossfade;
    const target = fade === null ? this.ctx : fade.syncedCtx;
    try {
      target.setTransform(1, 0, 0, 1, 0, 0);
      renderFrame({
        ctx: target,
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
        liveAudio: outside ? this.liveAudio : undefined,
      });
      this.frame += 1;
      if (fade === null) {
        this.drawTransitionIfNeeded(Math.min(time, view.duration), plan);
      } else if (fade.active) {
        this.composeCrossfade();
      }
      this.markFirstFrame();
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
