import { describe, expect, it } from "bun:test";
import { ApiError, isTransientResolveError, resolveRetryDelayMs } from "../../src/core/api";

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
