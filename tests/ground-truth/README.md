# Vérité terrain — banc rap

Propositions de structure pour les quatre titres marqués `"reference": true`
dans `tests/support/real_corpus.json`. **Ce ne sont pas des vérités
définitives** : chaque entrée porte `"source": "agent-proposition"` et une
`confidence` (0..1). Le propriétaire corrige, l'outil compare.

## Format

Un fichier par titre, nommé d'après le titre en minuscules sans accents
(`minimum.json`, `gogo.json`, …).

```json
{
  "titre": "Minimum",
  "artiste": "Bigflo & Oli",
  "id": 3884482841,
  "durée": 196.3,
  "bpm": { "value": 142.9, "confidence": 0.4, "source": "agent-proposition" },
  "sections": [
    { "role": "intro", "start": 0.0, "end": 14.0, "confidence": 0.7, "source": "agent-proposition" }
  ],
  "drops": [
    { "time": 41.87, "confidence": 0.6, "source": "agent-proposition" }
  ]
}
```

- `role` : `intro`, `couplet`, `refrain`, `pont`, `montee`, `drop` ou `finale`.
- `start`, `end`, `time` : secondes, décimales acceptées.
- Pour corriger : éditer `value`, `start`, `end`, `time`, `confidence`, et
  passer `source` à `proprietaire` (ou toute valeur explicite). Les entrées
  peuvent être supprimées ou ajoutées ; l'outil lit tout le tableau.
- `drops` liste les impacts, pas les sections : un drop peut tomber au début
  d'une section `refrain`.

## Comparer

```bash
uv run python tools/real_corpus.py      # télécharge/analyse (cache local)
bun run eval:ref                        # rapport texte
bun run eval:ref --json tests/metrics/reference-eval.json
bun run shots:ref                       # captures 1080p + mesures
```

`eval:ref` compare avec une tolérance de ±0,5 s sur les drops. Les captures
(`tests/fixtures/reference-shots/`) et l'audio ne sont jamais versionnés.
