#!/usr/bin/env bash
# Enchaîne toutes les vérifications, dans l'ordre, et s'arrête au premier échec.
#
#   bash scripts/check.sh
#
# Contrairement à `bun run test` (qui exécute toutes les étapes et agrège les
# échecs), ce script sort immédiatement en cas de problème : c'est le point
# d'entrée à utiliser avant un commit ou en intégration continue.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "== dépendances (bun install) =="
bun install

echo "== types (tsc) =="
bun run typecheck

echo "== lint (oxlint + ruff) =="
bun run lint

echo "== tests (front + serveur) =="
bun run test

echo
echo "Tout est vert."
