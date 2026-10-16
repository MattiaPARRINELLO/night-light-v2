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
