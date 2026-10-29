# Vérité terrain — banc rap

Propositions de structure pour les quatre titres marqués `"reference": true`
dans `tests/support/real_corpus.json`. Les entrées `source: "proprietaire"`
sont **validées à l'écoute** ; les autres restent des propositions
(`"source": "agent-proposition"`) avec une `confidence` (0..1). Le propriétaire
corrige, l'outil compare.

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
  "refrains": [],
  "refrainsStatus": "valide",
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
- `refrains` (optionnel) : liste des refrains **validés**, au même format que
  `sections`. La présence de la clé fait foi :
  - clé absente → **non annoté** : `eval:ref` retombe sur les sections de rôle
    `refrain` et le signale ;
  - `"refrains": []` + `"refrainsStatus": "valide"` → **validé : aucun
    refrain**. Toute détection est alors un faux positif (Minimum, Focus) ;
  - liste non vide → refrains validés.
  `"refrainsStatus": "valide"` sans `refrains` marque une annotation validée
  dérivée des sections (Gogo, Karma).
- Pour corriger : éditer `value`, `start`, `end`, `time`, `confidence`, et
  passer `source` à `proprietaire` (ou toute valeur explicite). Les entrées
  peuvent être supprimées ou ajoutées ; l'outil lit tout le tableau.
- `drops` liste les impacts, pas les sections : un drop peut tomber au début
  d'une section `refrain`.
- Focus : le passage calme validé est **137–152 s** (auparavant 127–152).

## Comparer

```bash
uv run python tools/real_corpus.py      # télécharge/analyse (cache local)
bun run eval:ref                        # rapport texte
bun run eval:ref --json tests/metrics/reference-eval.json
bun run shots:ref                       # captures 1080p + mesures
```

`eval:ref` compare avec une tolérance de ±0,5 s sur les drops. Les captures
(`tests/fixtures/reference-shots/`) et l'audio ne sont jamais versionnés.
