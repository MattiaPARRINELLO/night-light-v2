/**
 * Détection du morceau joué par un lecteur externe (MPRIS), logique pure.
 *
 * Un titre suffit à considérer le morceau détecté : certains lecteurs
 * (fichiers locaux dans Deezer, lecteurs partiels) n'exposent pas l'artiste, et
 * le serveur résout alors la recherche par le seul titre.
 */

import type { NowPlayingResponse } from "./api";

export function hasDetectedTrack(data: NowPlayingResponse | null): boolean {
  return data !== null && data.available && data.title.trim() !== "";
}

/** Libellé à afficher, ou `null` s'il n'y a aucun morceau à montrer. */
export function detectedTrackLabel(data: NowPlayingResponse | null): string | null {
  if (data === null || !hasDetectedTrack(data)) return null;
  if (data.ambiguous) return "Plusieurs lecteurs détectés. Import manuel recommandé.";
  const title = data.title.trim();
  const artist = data.artist.trim();
  const name = artist === "" ? title : `${title} — ${artist}`;
  return `Lecteur détecté : ${name}${data.status === "playing" ? " (lecture)" : " (pause)"}`;
}

/** Clé stable d'un morceau détecté : une résolution automatique par morceau. */
export function detectedTrackKey(data: NowPlayingResponse): string {
  return `${data.title.trim()}|${data.artist.trim()}`;
}

/**
 * Échec retenu pour un morceau, afin de réarmer la résolution si le lecteur
 * annonce ensuite une autre durée pour le même morceau.
 *
 * Certains lecteurs publient d'abord le nouveau titre avec l'ancienne durée :
 * la résolution part alors avec une durée fausse, tous les candidats échouent
 * au contrôle de durée, et sans réarmement le morceau restait définitivement
 * en échec (il fallait changer de morceau puis revenir).
 */
export interface AutoResolveFailure {
  key: string;
  durationSec: number | null;
}

/** Écart à partir duquel deux durées annoncées sont jugées différentes. */
export const AUTO_RESOLVE_DURATION_CHANGE_SEC = 1.0;

/**
 * Faut-il retenter un morceau déjà en échec parce que sa durée a changé ?
 *
 * Seul un changement franc réarme : une durée qui se stabilise à quelques
 * millièmes près ne doit pas relancer une résolution en boucle.
 */
export function shouldRetryAfterDurationChange(
  failure: AutoResolveFailure | null,
  key: string,
  durationSec: number | null | undefined,
): boolean {
  if (failure === null || failure.key !== key) return false;
  const current = durationSec ?? null;
  if (current === null || failure.durationSec === null) {
    return current !== failure.durationSec;
  }
  return Math.abs(current - failure.durationSec) >= AUTO_RESOLVE_DURATION_CHANGE_SEC;
}

/** Seul un morceau réellement en lecture peut être résolu automatiquement. */
export function shouldAutoResolve(data: NowPlayingResponse | null): boolean {
  return (
    data !== null &&
    data.available &&
    !data.ambiguous &&
    data.status === "playing" &&
    data.title.trim() !== ""
  );
}

/**
 * Le flux SSE now-playing n'émet que sur changement de morceau ; le serveur
 * ajoute un battement (`event: ping`) toutes les 2 s. Au-delà de ce silence,
 * le flux est considéré mort et le polling prend le relais même si le
 * navigateur le croit encore ouvert (proxy qui a coupé sans FIN).
 */
export const SSE_SILENCE_MS = 5000;

/** Faut-il basculer sur le polling de secours du lecteur externe ? */
export function shouldFallbackToPolling(options: {
  readyState: number;
  lastEventAt: number;
  now: number;
}): boolean {
  if (options.readyState === 2) return true; // EventSource.CLOSED
  return options.now - options.lastEventAt > SSE_SILENCE_MS;
}
