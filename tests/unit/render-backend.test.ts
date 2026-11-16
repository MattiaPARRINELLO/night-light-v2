import { describe, expect, test } from "bun:test";

import { classifyRenderer, detectRenderBackend } from "../../src/browser/renderBackend";

describe("backend de rendu", () => {
  test("reconnait les renderers logiciels", () => {
    for (const renderer of [
      "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
      "Mesa/X.org llvmpipe (LLVM 17.0.6, 256 bits)",
      "softpipe",
      "Microsoft Basic Render Driver",
      "Apple Software Renderer",
    ]) {
      expect(classifyRenderer(renderer).kind).toBe("software");
    }
  });

  test("reconnait les GPU materiels", () => {
    for (const renderer of [
      "ANGLE (Intel, Mesa Intel(R) Graphics (LNL), OpenGL ES 3.2)",
      "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)",
      "Apple M3 Pro",
      "Mali-G78 MP14",
    ]) {
      expect(classifyRenderer(renderer).kind).toBe("gpu");
    }
  });

  test("ne devine pas quand le navigateur masque le renderer", () => {
    expect(classifyRenderer(null).kind).toBe("unknown");
    expect(classifyRenderer(undefined).kind).toBe("unknown");
    expect(classifyRenderer("   ").kind).toBe("unknown");
  });

  test("la sonde est sans danger hors navigateur", () => {
    // Bun n'a pas de document : la sonde doit retomber sur « inconnu » au lieu
    // de lever, pour ne jamais bloquer le demarrage du show.
    expect(detectRenderBackend().kind).toBe("unknown");
  });
});
