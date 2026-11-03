#!/usr/bin/env node
/**
 * Démarre l'API d'analyse et l'interface en un seul processus.
 *
 *   bun run dev
 *   NIGHTLIGHT_LAN=1 bun run dev   (ou `bun run dev:lan`)
 *
 * L'API écoute sur 127.0.0.1 uniquement (jamais exposée sur le réseau) ;
 * l'interface est publiée via Portless sur https://nightlight.localhost et
 * relaie /api vers l'API. En mode LAN, Vite écoute sur 0.0.0.0 et l'API reste
 * joignable uniquement par le proxy : le téléphone ne voit que l'interface.
 */

import { spawn, spawnSync } from "node:child_process";
import { networkInterfaces } from "node:os";

const apiPort = process.env.API_PORT ?? "8787";
// Toujours un chemin explicite : une chaîne vide ferait résoudre le répertoire
// des sessions en répertoire courant, donc le projet lui-même.
const sessionDir = process.env.SESSION_DIR?.trim() || "/tmp/night-light-sessions";
/**
 * `NIGHTLIGHT_LAN=1` publie l'interface sur le réseau local pour piloter le
 * show depuis un téléphone. L'API, elle, reste sur 127.0.0.1 : c'est le proxy
 * Vite qui relaie `/api` (WebSocket de contrôle compris).
 */
const lan = process.env.NIGHTLIGHT_LAN === "1";

const children = [];
let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(0), 200);
}

function launch(name, command, args, env = {}) {
  const child = spawn(command, args, {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ...env },
  });
  child.on("exit", (code, signal) => {
    if (!shuttingDown) {
      console.error(`[dev] ${name} s'est arrêté (code ${code ?? signal})`);
      shutdown();
    }
  });
  children.push({ name, child });
  return child;
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

launch(
  "api",
  "uv",
  ["run", "uvicorn", "server.main:app", "--host", "127.0.0.1", "--port", apiPort],
  { SESSION_DIR: sessionDir, PORT: apiPort },
);

await new Promise((resolve) => setTimeout(resolve, 2500));

// Pas de --port : Portless fournit PORT à Vite, c'est ce qui garantit que la
// route du proxy pointe bien sur le port réellement écouté. En mode LAN, Vite
// écoute en plus sur 0.0.0.0 : Portless continue de servir l'URL .localhost sur
// le PC, et le téléphone attaque le même serveur par son IP.
const webHost = lan ? "0.0.0.0" : "127.0.0.1";
launch("web", "npx", ["portless", "nightlight", "vite", "--host", webHost], {
  API_URL: `http://127.0.0.1:${apiPort}`,
});

/**
 * Annonce les URL LAN, une fois que Portless a choisi son port.
 *
 * Le port appartient à Portless : on le relit dans `portless list`. La route
 * est le nom explicite passé au lancement (`nightlight`), donc `portless get`
 * (qui préfixe par le worktree) ne conviendrait pas ici.
 */
function announceLan(attempt = 0) {
  const listed = spawnSync("npx", ["portless", "list"], { encoding: "utf8" });
  const line = (listed.stdout ?? "")
    .split("\n")
    .find((entry) => /https:\/\/nightlight\.localhost\s+->/.test(entry));
  const match = line?.match(/localhost:(\d+)/);
  if (match === undefined || match === null) {
    if (attempt < 6) {
      setTimeout(() => announceLan(attempt + 1), 1000);
      return;
    }
    console.log("[dev] réseau local : port Portless introuvable (`portless list`).");
    return;
  }
  const port = match[1];
  const blocked = /^(br-|docker|veth|virbr)/;
  const addresses = Object.entries(networkInterfaces())
    .filter(([name]) => !blocked.test(name))
    .flatMap(([, entries]) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
  if (addresses.length === 0) {
    console.log("[dev] réseau local : aucune adresse IPv4 trouvée.");
    return;
  }
  for (const address of addresses) {
    console.log(`[dev] téléphone / LAN : http://${address}:${port}/effets.html`);
  }
}

if (lan) {
  setTimeout(() => announceLan(), 2000);
}

// Les deux processus tournent jusqu'à Ctrl-C : le gestionnaire de signaux
// installé plus haut déclenche shutdown(). `launch()` renvoie un enfant de
// process, pas une promesse, donc on n'attend rien d'autre ici.
await new Promise(() => {});
