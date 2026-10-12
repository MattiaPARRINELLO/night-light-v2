#!/usr/bin/env node
/** Lance toute la suite de vérifications : types, tests front, tests serveur. */

import { spawnSync } from "node:child_process";

const steps = [
  { name: "types (tsc)", command: "bunx", args: ["tsc", "--noEmit"] },
  { name: "tests front", command: "bun", args: ["test", "tests/"] },
  { name: "tests serveur", command: "uv", args: ["run", "pytest", "tests/", "-q"] },
];

let failures = 0;
for (const step of steps) {
  process.stdout.write(`\n=== ${step.name} ===\n`);
  const result = spawnSync(step.command, step.args, { stdio: "inherit" });
  if (result.status !== 0) {
    failures += 1;
    process.stderr.write(`\n[FAIL] ${step.name}\n`);
  }
}

if (failures > 0) {
  process.stderr.write(`\n${failures} étape(s) en échec.\n`);
  process.exit(1);
}
process.stdout.write("\nTout est vert.\n");
