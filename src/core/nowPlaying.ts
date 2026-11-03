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
