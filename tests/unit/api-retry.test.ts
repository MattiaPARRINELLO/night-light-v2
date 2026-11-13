import { describe, expect, it } from "bun:test";
import {
  ApiError,
  isTransientResolveError,
  isUnrecognizedTrackError,
  resolveRetryDelayMs,
  resolveUnrecognizedRetryDelayMs,
} from "../../src/core/api";

describe("relance d'une récupération automatique", () => {
  it("considère un serveur indisponible comme passager", () => {
    expect(isTransientResolveError(new ApiError("injoignable", "server_unavailable"))).toBe(true);
    expect(isTransientResolveError(new TypeError("Failed to fetch"))).toBe(true);
  });

  it("considère un 5xx comme passager", () => {
    expect(isTransientResolveError(new ApiError("saturé", "error", undefined, 503))).toBe(true);
  });

  it("ne relance pas un refus définitif", () => {
    expect(isTransientResolveError(new ApiError("absent", "no_match", undefined, 422))).toBe(false);
    expect(isTransientResolveError(new ApiError("pas d'ARL", "deezer_not_configured"))).toBe(false);
    expect(isTransientResolveError(new ApiError("périmé", "stale_result"))).toBe(false);
  });

  it("ne relance jamais une recherche annulée", () => {
    expect(isTransientResolveError(new ApiError("annulée", "aborted"))).toBe(false);
  });

  it("espace les tentatives puis s'arrête", () => {
    expect(resolveRetryDelayMs(0)).toBe(2000);
    expect(resolveRetryDelayMs(1)).toBe(5000);
    expect(resolveRetryDelayMs(2)).toBe(15000);
    expect(resolveRetryDelayMs(3)).toBeNull();
  });
});

describe("relance d'un morceau non reconnu", () => {
  it("reconnaît un refus pour absence de candidat", () => {
    expect(isUnrecognizedTrackError(new ApiError("absent", "no_match", undefined, 422))).toBe(true);
  });

  it("ne confond pas les autres refus avec un morceau non reconnu", () => {
    expect(isUnrecognizedTrackError(new ApiError("ambigu", "ambiguous_match"))).toBe(false);
    expect(isUnrecognizedTrackError(new ApiError("pas d'ARL", "deezer_not_configured"))).toBe(false);
    expect(isUnrecognizedTrackError(new ApiError("périmé", "stale_result"))).toBe(false);
    expect(isUnrecognizedTrackError(new TypeError("Failed to fetch"))).toBe(false);
  });

  it("retente vite (1 à 2 s) puis s'arrête", () => {
    expect(resolveUnrecognizedRetryDelayMs(0)).toBe(1500);
    expect(resolveUnrecognizedRetryDelayMs(1)).toBe(2000);
    expect(resolveUnrecognizedRetryDelayMs(2)).toBeNull();
  });
});
