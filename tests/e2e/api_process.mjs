/**
 * Démarrage de l'API d'analyse pour les vérifications navigateur.
 *
 * On préfère l'exécutable du venv du projet (version verrouillée, démarrage
 * immédiat), avec repli sur `uv run uvicorn` quand il n'existe pas encore : une
 * machine fraîchement clonée ne doit pas échouer sur un chemin absent.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const HOST = "127.0.0.1";

export function spawnApi(root, port, env = {}) {
  const local = join(root, ".venv", "bin", "uvicorn");
  const useLocal = existsSync(local);
  const debug = Boolean(process.env.CHECK_DEBUG);
  const child = spawn(
    useLocal ? local : "uv",
    [
      ...(useLocal ? [] : ["run", "uvicorn"]),
      "server.main:app",
      "--host",
      HOST,
      "--port",
      String(port),
    ],
    {
      cwd: root,
      stdio: debug ? "inherit" : ["ignore", "pipe", "pipe"],
      env: { ...process.env, PORT: String(port), ...env },
      detached: true,
    },
  );

  // Garde les dernières lignes de l'API quand elle refuse de démarrer : sans
  // ça, un échec en intégration ne dit rien d'autre que « health injoignable ».
  const tail = [];
  const collect = (chunk) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim() !== "") tail.push(line);
    }
    if (tail.length > 40) tail.splice(0, tail.length - 40);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  child.output = () => tail.join("\n");

  return child;
}
