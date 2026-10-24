# Baseline de la suite de tests

Mesure de référence prise sur le worktree `chore/test-harness-baseline`, avant
toute modification de code de production par les agents A (plan) et B (rendu).

## Environnement

| outil | version |
| --- | --- |
| Bun | 1.4.3 |
| Node | 26.11.1 |
| TypeScript | 7.0.2 |
| oxlint | 1.88.0 |
| uv | 0.13.1 |
| Python | 3.12 (`.python-version`) |
| ruff | 0.17.1 |
| pytest | 8.x (groupe `dev`) |

## Précondition : `bun install`

Sans `node_modules`, `bun run typecheck` échoue avec **TS2688** (`Cannot find
type definition file for 'bun' / 'node' / 'vite'`). Ce n'est pas une erreur de
code : c'est une précondition d'environnement. `bun install` installe les 6
paquets de développement (28 paquets avec les transitives).

## Résultat de référence (`bun run test`)

Commande : `bun install && bun run test` (types + tests front + tests serveur).

| étape | résultat | durée |
| --- | --- | --- |
| types (`tsc --noEmit`) | 0 erreur | < 1 s |
| tests front (`bun test tests/`) | **192 passés, 0 échec**, 15 329 assertions, 10 fichiers | 2,83 s |
| tests serveur (`uv run pytest tests/ -q`) | **149 passés, 0 échec** | 74,52 s |
| **total** | **341 tests verts** | **79 s** |

Avertissements : un seul, émis par Starlette lui-même
(`StarletteDeprecationWarning: Using 'httpx' with 'starlette.testclient' is
deprecated; install 'httpx2' instead`), sans effet sur les résultats.

`bun run lint` : `oxlint` et `ruff check .` passent sans avertissement.

## Reproductibilité

Le 24 octobre 2026, deux exécutions consécutives de `bun run test` sur ce
worktree donnent le même nombre de tests et le même statut. Les durées varient
de quelques secondes (pytest domine, l'analyse audio est coûteuse).
