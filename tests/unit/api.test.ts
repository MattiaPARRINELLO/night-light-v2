import { afterEach, describe, expect, test } from "bun:test";

import { fetchNowPlaying } from "../../src/core/api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fetchNowPlaying", () => {
  test("convertit les champs snake_case", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          available: true,
          player: "p",
          status: "playing",
          title: "Titre",
          artist: "Artiste",
          album: "Album",
          duration_sec: 12.5,
          position_sec: 3.25,
          updated_at: 99,
          ambiguous: false,
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const data = await fetchNowPlaying();
    expect(data.durationSec).toBe(12.5);
    expect(data.positionSec).toBe(3.25);
    expect(data.updatedAt).toBe(99);
  });

  test("conserve les valeurs nulles", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          available: false,
          player: "",
          status: "stopped",
          title: "",
          artist: "",
          album: "",
          duration_sec: null,
          position_sec: null,
          updated_at: 0,
          ambiguous: true,
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const data = await fetchNowPlaying();
    expect(data.durationSec).toBeNull();
    expect(data.positionSec).toBeNull();
  });
});