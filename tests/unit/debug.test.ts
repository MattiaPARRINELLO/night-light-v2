import { describe, expect, it } from "bun:test";
import { debugLog, dbgLog, dbgThrottled } from "../../src/core/debug";

describe("journal de debug", () => {
  it("garde les lignes les plus récentes en premier", () => {
    debugLog.clear();
    dbgLog("boot", "premier");
    dbgLog("capture", "deuxième");
    const lines = debugLog.lines(2);
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("deuxième");
    expect(lines[1]).toContain("premier");
  });

  it("limite le tampon", () => {
    debugLog.clear();
    for (let i = 0; i < 30; i += 1) dbgLog("live", `ligne ${i}`, undefined, false);
    dbgLog("live", "dernière", undefined, false);
    const lines = debugLog.lines(50);
    expect(lines.length).toBeLessThanOrEqual(240);
    expect(lines[0]).toContain("dernière");
  });

  it("throttle les messages répétitifs", () => {
    debugLog.clear();
    dbgThrottled("clé", "live", "message", { valeur: 1 }, 10_000);
    dbgThrottled("clé", "live", "message", { valeur: 2 }, 10_000);
    const lines = debugLog.lines(10);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("message");
  });

  it("n'émet rien dans la console quand echo est désactivé", () => {
    debugLog.clear();
    dbgLog("erreur", "silencieux", "détail", false);
    expect(debugLog.lines(5)[0]).toContain("silencieux");
  });
});
