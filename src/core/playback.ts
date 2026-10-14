export interface ExternalPlaybackState {
  source: "mpris" | "spotify" | "none" | string;
  status: "playing" | "paused" | "stopped" | string;
  title: string;
  artist: string;
  positionMs: number;
  capturedAtMs: number;
}

export function normalizePlaybackText(value: string | null | undefined): string {
  if (!value) return "";
  let text = value.toLowerCase();
  text = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  text = text.replace(/\([^)]*\)/g, " ").replace(/\[[^\]]*\]/g, " ");
  for (const marker of ["feat", "ft", "featuring", "remastered", "remaster", "live", "remix", "edit"]) {
    text = text.replace(new RegExp(`\\b${marker}\\b`, "g"), " ");
  }
  text = text.replace(/[^a-z0-9]+/g, " ");
  return text.trim().replace(/\s+/g, " ");
}

/**
 * Position estimée du lecteur à l'instant `nowEpochMs`.
 *
 * `capturedAtMs` (renvoyé par le serveur) et `nowEpochMs` doivent partager la
 * même horloge : les millisecondes epoch, donc `Date.now()`. Passer
 * `performance.now()` produit un délai négatif et une estimation ramenée à 0.
 */
export function estimatePlayerPositionMs(state: ExternalPlaybackState, nowEpochMs: number): number {
  if (state.status !== "playing") return Math.max(0, state.positionMs);
  const delayMs = nowEpochMs - state.capturedAtMs;
  return Math.max(0, state.positionMs + delayMs);
}

/**
 * Écart entre la position visée par le show et sa position réelle, en ms.
 *
 * Positif = le show est en retard sur le son ; négatif = il est en avance.
 * Les deux horloges doivent être epoch (`Date.now()`), celle du serveur comme
 * celle du show : c'est la seule comparaison qui ait un sens.
 */
export function showDriftMs(
  state: ExternalPlaybackState,
  nowEpochMs: number,
  showStartMs: number,
  showStartedAtEpoch: number,
  latencyMs = 0,
): number {
  const playerMs = estimatePlayerPositionMs(state, nowEpochMs);
  const showMs = showStartMs + (nowEpochMs - showStartedAtEpoch);
  return playerMs + latencyMs - showMs;
}

/** Niveau de correction à appliquer face à un écart mesuré. */
export type SyncCorrection = "none" | "soft" | "hard";

/**
 * Écart faible → on recalcule l'origine sans saut visible ; écart important →
 * recalage direct. Les deux seuils viennent de la spécification (150 ms / 1,5 s).
 */
export function syncCorrection(
  driftMs: number,
  softThresholdMs = 150,
  hardThresholdMs = 1500,
): SyncCorrection {
  const abs = Math.abs(driftMs);
  if (abs >= hardThresholdMs) return "hard";
  if (abs > softThresholdMs) return "soft";
  return "none";
}

export function crossCorrelation(reference: number[], signal: number[]): { lag: number; score: number } | null {
  if (reference.length === 0 || signal.length === 0 || signal.length < reference.length) return null;
  let best: { lag: number; score: number } | null = null;
  for (let lag = 0; lag <= signal.length - reference.length; lag += 1) {
    let numerator = 0;
    let denomA = 0;
    let denomB = 0;
    for (let i = 0; i < reference.length; i += 1) {
      const x = reference[i] ?? 0;
      const y = signal[lag + i] ?? 0;
      numerator += x * y;
      denomA += x * x;
      denomB += y * y;
    }
    const score = (denomA > 0 && denomB > 0) ? numerator / Math.sqrt(denomA * denomB) : 0;
    if (best === null || score > best.score) best = { lag, score };
  }
  return best;
}
