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
  return spawn(
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
      stdio: process.env.CHECK_DEBUG ? "inherit" : "ignore",
      env: { ...process.env, PORT: String(port), ...env },
      detached: true,
    },
  );
}
