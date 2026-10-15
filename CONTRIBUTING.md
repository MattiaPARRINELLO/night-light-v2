# Contribuer à Night Light

Merci de l'intérêt porté au projet. Ce dépôt est un projet personnel publié en
open source : les contributions sont bienvenues, dans le respect de son
intention — un light show musical **local**, sans dépendance à un service en
ligne.

## Mise en place

```bash
bun install                 # dépendances front
uv sync --group dev         # environnement Python (analyse + tests)
bun run dev                 # API + interface via Portless
```

Prérequis : **Bun ≥ 1.1**, **Node ≥ 24**, **Python ≥ 3.11** (voir
`pyproject.toml`). Les vérifications navigateur utilisent Playwright :
`bun add -D playwright && bunx playwright install chromium`.

## Vérifier avant de proposer une modification

```bash
bun run lint        # oxlint + ruff
bun run typecheck   # tsc
bun run test        # types, tests front, tests serveur
bun run build       # build de production
```

Les vérifications navigateur (`bun run check:*`) exigent un build préalable
(`bun run build`) : l'API sert alors `dist/`.

Tout doit être vert avant une pull request.

## Conventions

- **Langue** : le code, les commentaires, les messages de commit et les
  échanges sont en **français**.
- **Commits** : un commit par unité de travail cohérente, préfixé à la manière
  des *Conventional Commits* (`feat:`, `fix:`, `docs:`, `test:`, `chore:`,
  `ci:`).
- **Style** : le formatage suit `.editorconfig` ; le lint (`ruff`, `oxlint`)
  fait foi.
- **Tests** : toute correction de comportement s'accompagne d'un test de
  non-régression, dans `tests/`.
- **Cœur pur** : la logique de rendu (`src/core/`) reste une fonction pure du
  temps musical — pas d'état accumulé, pas de dérive. Voir les règles décrites
  dans le README.

## Signaler un problème

Ouvre une *issue* en décrivant ce que tu attendais, ce qui s'est produit, et en
joignant si possible le format du morceau et la sortie de l'overlay de debug
(touche `D`) ou de la console du navigateur.
