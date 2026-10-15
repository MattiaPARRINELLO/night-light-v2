import { describe, expect, it } from "bun:test";
import {
  crossCorrelation,
  estimatePlayerPositionMs,
  normalizePlaybackText,
  showDriftMs,
  syncCorrection,
  syncRamp,
  syncRampDuration,
} from "../src/core/playback";

describe("playback helpers", () => {
  it("normalizes versions", () => {
    expect(normalizePlaybackText("Café (Remastered)")).toBe("cafe");
  });

  it("estime la position sur la même horloge epoch que le serveur", () => {
    const state = {
      source: "mpris",
      status: "playing",
      title: "",
      artist: "",
      positionMs: 1000,
      capturedAtMs: 1000,
    };
    expect(estimatePlayerPositionMs(state, 1500)).toBe(1500);
    // Horloge incohérente (performance.now face à l'epoch serveur) : 0, jamais de valeur négative.
    expect(estimatePlayerPositionMs({ ...state, capturedAtMs: 1_700_000_000_000 }, 1500)).toBe(0);
    // Lecteur en pause : la position ne dérive plus.
    expect(estimatePlayerPositionMs({ ...state, status: "paused" }, 99_999_999)).toBe(1000);
  });

  it("finds a shifted window", () => {
    const signal = [0, 0, 1, 2, 3, 0, 0];
    const reference = [1, 2, 3];
    const result = crossCorrelation(reference, signal);
    expect(result?.lag).toBe(2);
    expect((result?.score ?? 0) > 0.99).toBe(true);
  });
});

describe("syncCorrection", () => {
  it("ne bouge rien sous 150 ms", () => {
    expect(syncCorrection(0)).toBe("none");
    expect(syncCorrection(-149)).toBe("none");
  });

  it("recalcule l'origine entre 150 ms et 1,5 s", () => {
    expect(syncCorrection(151)).toBe("soft");
    expect(syncCorrection(-1499)).toBe("soft");
  });

  it("recale directement au-delà de 1,5 s", () => {
    expect(syncCorrection(1500)).toBe("hard");
    expect(syncCorrection(-2500)).toBe("hard");
  });
});

describe("rattrapage progressif de la synchronisation", () => {
  it("le décalage part de zéro et rejoint l'écart", () => {
    // C'est ce qui évite le saut : au moment de la correction, le temps du show
    // ne bouge pas ; il glisse ensuite jusqu'à la bonne position.
    expect(syncRamp(240, 0, 400)).toBe(0);
    expect(syncRamp(240, 200, 400)).toBe(120);
    expect(syncRamp(240, 400, 400)).toBe(240);
    // Une fois la durée écoulée, on ne dépasse jamais l'écart.
    expect(syncRamp(240, 900, 400)).toBe(240);
  });

  it("le rattrapage est continu", () => {
    // Aucune marche : c'est la propriété qui garantit que le projecteur ne
    // saute pas pendant la correction.
    let precedent = syncRamp(-300, 0, 500);
    for (let ecoule = 10; ecoule <= 500; ecoule += 10) {
      const courant = syncRamp(-300, ecoule, 500);
      expect(Math.abs(courant - precedent)).toBeLessThan(8);
      precedent = courant;
    }
  });

  it("la durée reste bornée pour que la vitesse du show reste crédible", () => {
    // Un petit écart se rattrape sans qu'on le voie ; un gros écart met plus
    // longtemps, mais jamais au point de faire « glisser » le spectacle.
    expect(syncRampDuration(40)).toBe(350);
    expect(syncRampDuration(300)).toBe(900);
    expect(syncRampDuration(1400)).toBe(3200);
    // La vitesse demandée au show pendant le rattrapage reste sous 50 % : un
    // écart de 1500 ms met 3,2 s à se rattraper, jamais une glissade brutale.
    for (const ecart of [160, 300, 600, 1200, 1499]) {
      expect(Math.abs(ecart) / syncRampDuration(ecart)).toBeLessThanOrEqual(0.5);
    }
  });
});

describe("showDriftMs", () => {
  const state = (positionMs: number, capturedAtMs: number) => ({
    source: "mpris",
    status: "playing",
    title: "x",
    artist: "y",
    positionMs,
    capturedAtMs,
  });

  it("reste nul quand les deux horloges epoch avancent ensemble", () => {
    const epoch = 1_700_000_000_000;
    // Le show est lancé à la position du lecteur (6 s) à cet instant.
    const drift = showDriftMs(state(6000, epoch), epoch + 3000, 6000, epoch);
    expect(drift).toBe(0);
    expect(syncCorrection(drift)).toBe("none");
  });

  it("prend en compte la latence comme avance du show", () => {
    const epoch = 1_700_000_000_000;
    // Lecteur à 10 s, show démarré à 10,2 s (latence +200 ms) → écart nul.
    const drift = showDriftMs(state(10_000, epoch), epoch + 4000, 10_200, epoch, 200);
    expect(drift).toBe(0);
  });

  it("voit un écart énorme quand l'horloge du show n'est pas l'epoch", () => {
    // Régression : mélanger performance.now() et l'horloge du serveur ramenait
    // la position du lecteur à 0 et recalait le show sur 0 en boucle.
    const drift = showDriftMs(state(6000, 1_700_000_000_000), 3500, 6000, 0);
    expect(syncCorrection(drift)).toBe("hard");
    expect(estimatePlayerPositionMs(state(6000, 1_700_000_000_000), 3500)).toBe(0);
  });
});
