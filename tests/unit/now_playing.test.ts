import { describe, expect, it } from "bun:test";
import { normalizeNowPlaying, type NowPlayingResponse } from "../../src/core/api";
import {
  detectedTrackKey,
  detectedTrackLabel,
  hasDetectedTrack,
  shouldAutoResolve,
} from "../../src/core/nowPlaying";

function nowPlaying(overrides: Partial<NowPlayingResponse> = {}): NowPlayingResponse {
  return {
    available: true,
    player: "deezer",
    status: "playing",
    title: "Neon Skyline",
    artist: "Artiste de test",
    album: "",
    durationSec: 120,
    positionSec: 42,
    updatedAt: 1,
    ambiguous: false,
    ...overrides,
  };
}

describe("now playing normalization", () => {
  it("mappe les champs snake_case du serveur", () => {
    const result = normalizeNowPlaying({
      available: true,
      player: "deezer",
      status: "playing",
      title: "Mustang",
      artist: "",
      album: "Nouvelle Ecole",
      duration_sec: 149.0,
      position_sec: 91.45,
      updated_at: 1792138482.5,
      ambiguous: false,
      error: "",
    });
    expect(result.title).toBe("Mustang");
    expect(result.durationSec).toBe(149);
    expect(result.positionSec).toBeCloseTo(91.45);
    expect(result.updatedAt).toBeCloseTo(1792138482.5);
    expect(result.ambiguous).toBe(false);
  });

  it("tolère des champs absents ou invalides", () => {
    const result = normalizeNowPlaying({ title: "Seul le titre", position_sec: "n/a" });
    expect(result.durationSec).toBeNull();
    expect(result.positionSec).toBeNull();
    expect(result.updatedAt).toBe(0);
    expect(result.status).toBe("unknown");
  });
});

describe("détection du morceau joué", () => {
  it("considère un titre sans artiste comme détecté", () => {
    const data = nowPlaying({ artist: "" });
    expect(hasDetectedTrack(data)).toBe(true);
    expect(detectedTrackLabel(data)).toBe("Lecteur détecté : Neon Skyline (lecture)");
  });

  it("affiche l'artiste quand il est présent", () => {
    expect(detectedTrackLabel(nowPlaying())).toBe("Lecteur détecté : Neon Skyline — Artiste de test (lecture)");
  });

  it("ne détecte rien sans titre ni lecteur", () => {
    expect(detectedTrackLabel(null)).toBeNull();
    expect(detectedTrackLabel(nowPlaying({ title: "  " }))).toBeNull();
    expect(detectedTrackLabel(nowPlaying({ available: false }))).toBeNull();
  });

  it("signale l'ambiguïté plutôt qu'un morceau précis", () => {
    expect(detectedTrackLabel(nowPlaying({ ambiguous: true }))).toBe(
      "Plusieurs lecteurs détectés. Import manuel recommandé.",
    );
    expect(shouldAutoResolve(nowPlaying({ ambiguous: true }))).toBe(false);
  });

  it("ne résout automatiquement qu'un morceau en lecture avec un titre", () => {
    expect(shouldAutoResolve(nowPlaying({ artist: "" }))).toBe(true);
    expect(shouldAutoResolve(nowPlaying({ status: "paused" }))).toBe(false);
    expect(shouldAutoResolve(nowPlaying({ title: "" }))).toBe(false);
    expect(shouldAutoResolve(null)).toBe(false);
  });

  it("clé stable : l'artiste manquant ne change pas le morceau", () => {
    expect(detectedTrackKey(nowPlaying({ artist: "" }))).toBe("Neon Skyline|");
  });
});
