/** Caractéristiques audio live, normalisées dans [0, 1]. */
export interface LiveAudioFeatures {
  rms: number;
  energy: number;
  bass: number;
  mid: number;
  high: number;
  transient: number;
  /** État explicite de la capture. */
  state: string;
  /** Horodatage local de la dernière mise à jour, en millisecondes. */
  updatedAt: number;
}

export const EMPTY_LIVE_AUDIO: LiveAudioFeatures = {
  rms: 0,
  energy: 0,
  bass: 1 / 3,
  mid: 1 / 3,
  high: 1 / 3,
  transient: 0,
  state: "inactive",
  updatedAt: 0,
};

export function clampLiveLevel(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function normalizeLiveLevels(raw: Record<string, unknown>): LiveAudioFeatures {
  const rms = clampLiveLevel(raw.rms);
  const energy = clampLiveLevel(raw.energy ?? rms);
  const bass = clampLiveLevel(raw.bass ?? 1 / 3);
  const mid = clampLiveLevel(raw.mid ?? 1 / 3);
  const high = clampLiveLevel(raw.high ?? 1 / 3);
  const transient = clampLiveLevel(raw.transient);
  const state = typeof raw.state === "string" && raw.state !== "" ? raw.state : "inactive";
  const updatedAt = typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now();
  // Équilibre les bandes pour éviter un spectre entièrement vide.
  const sum = bass + mid + high;
  const normalizedBands = sum > 0 ? { bass: bass / sum, mid: mid / sum, high: high / sum } : { bass: 1 / 3, mid: 1 / 3, high: 1 / 3 };
  return {
    rms,
    energy,
    bass: normalizedBands.bass,
    mid: normalizedBands.mid,
    high: normalizedBands.high,
    transient,
    state,
    updatedAt,
  };
}

export function smoothFeature(previous: number, next: number, smoothing: number): number {
  const alpha = clampLiveLevel(smoothing);
  return previous * (1 - alpha) + next * alpha;
}

export function smoothLiveFeatures(
  previous: LiveAudioFeatures,
  next: LiveAudioFeatures,
  smoothing = 0.45,
): LiveAudioFeatures {
  const alpha = clampLiveLevel(smoothing);
  return {
    rms: smoothFeature(previous.rms, next.rms, alpha),
    energy: smoothFeature(previous.energy, next.energy, alpha),
    bass: smoothFeature(previous.bass, next.bass, alpha * 0.7),
    mid: smoothFeature(previous.mid, next.mid, alpha * 0.7),
    high: smoothFeature(previous.high, next.high, alpha * 0.7),
    transient: smoothFeature(previous.transient, next.transient, Math.min(1, alpha * 1.4)),
    state: next.state,
    updatedAt: next.updatedAt,
  };
}

export function isSilent(features: LiveAudioFeatures, threshold = 0.012): boolean {
  return features.state === "silent" || features.rms < threshold;
}
