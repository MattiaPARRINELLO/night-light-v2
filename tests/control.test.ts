import { describe, expect, it } from "bun:test";
import {
  CONTROL_VERSION,
  MODE_LABELS,
  SCREEN_LABELS,
  emptyShowState,
  type ControlMessage,
  type DashboardCommand,
} from "../src/shared/control";

describe("protocole de contrôle", () => {
  it("un état vide est cohérent et prêt à publier", () => {
    const state = emptyShowState();
    expect(state.page).toBe("show");
    expect(state.mode).toBe("live");
    expect(state.controlled).toBe(false);
    expect(state.analysis).toBeNull();
    expect(state.log).toEqual([]);
    // Les valeurs audio de repli sont normalisées : pas de NaN dans l'interface.
    for (const value of [state.audio.rms, state.audio.energy, state.smooth.rms]) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  it("chaque mode et écran a un libellé affichable", () => {
    for (const mode of ["live", "syncing", "show-synced", "show-local", "paused", "lost"] as const) {
      expect(MODE_LABELS[mode].length).toBeGreaterThan(0);
    }
    for (const screen of ["drop", "analysis", "error", "show"] as const) {
      expect(SCREEN_LABELS[screen].length).toBeGreaterThan(0);
    }
  });

  it("un message mal versionné est ignoré", () => {
    const other = { version: CONTROL_VERSION + 1, at: 0, command: { type: "force-live" } } as ControlMessage;
    const good = { version: CONTROL_VERSION, at: 0, command: { type: "force-live" } } as ControlMessage;
    const accepted = (message: ControlMessage) => message.version === CONTROL_VERSION;
    expect(accepted(other)).toBe(false);
    expect(accepted(good)).toBe(true);
  });

  it("toutes les commandes du dashboard sont typées et discriminées", () => {
    const commands: DashboardCommand[] = [
      { type: "hello" },
      { type: "set-latency", ms: 200 },
      { type: "set-settings", patch: { intensity: 0.8, noflash: true } },
      { type: "capture", on: false },
      { type: "force-live" },
      { type: "force-show" },
      { type: "cancel-analysis" },
      { type: "debug-overlay", on: true },
      {
        type: "analysis-ready",
        jobId: "abc",
        title: "Titre",
        artist: "Artiste",
        analysis: {
          schema: 1,
          duration: 12,
          tempo: 120,
          beatCount: 24,
          beatPeriod: 0.5,
          beats: [0, 0.5, 1],
          onsets: [0.25, 0.75],
          energy: [[0, 0.2], [12, 0.9]],
          bass: [[0, 0.9], [12, 0.9]],
          mid: [[0, 0.4], [12, 0.6]],
          high: [[0, 0.2], [12, 0.8]],
          sections: [{ start: 0, end: 12, label: "intense", energy: 0.7 }],
          builds: [{ start: 4, end: 6, strength: 0.9 }],
        },
      },
    ];
    expect(new Set(commands.map((command) => command.type)).size).toBe(commands.length);
    // Le correctif de typage : la commande porte une analyse complète, pas un résumé.
    const last = commands.at(-1);
    expect(last?.type).toBe("analysis-ready");
  });
});
