# R7 — impacts hors frontière (creux profond)

**Statut : livré.** `server/structure.py`, `server/analysis.py`, plus
`ANALYZER_VERSION` (« 5 » → « 7 ») et les tests de
`tests/unit/test_structure.py`.

## 1. Défaut constaté

Sur « Je vis cette mélodie » (Jok'air), le vrai drop est à **122 s** : un creux
quasi silencieux de 113,5 à 120,2 s, les voix reviennent à 120 s, puis la basse
et l'énergie à 122 s. Le plan allumait un changement d'ambiance à **118,4 s**
(montée) et posait le premier drop à **136,6 s**, soit 14 s après l'impact.

Cause : les drops n'étaient cherchés que sur les **frontières de section**. Or
`STRUCTURE_MIN_SPACING` (8 s) fusionne deux frontières proches : le pic de
nouveauté de 120,35 s (score 0,37) est absorbé par celui de 113,55 s (score
0,84), puis la frontière 139,55 s est recalée à 136,6 s. L'impact de 122 s
n'avait donc plus aucune frontière pour le porter.

## 2. Règle ajoutée

`_deep_break_drops` cherche sur les courbes, indépendamment du découpage :

| Condition | Constante | Valeur |
|---|---|---|
| Durée du creux quasi silencieux | `BREAK_MIN_LENGTH` | ≥ 2,0 s |
| Énergie maximale pendant le creux | `BREAK_MAX_ENERGY` | ≤ 0,25 |
| Fenêtre de recherche du retour | `BREAK_RETURN_SEARCH` | 6,0 s |
| Énergie du retour | `BREAK_RETURN_ENERGY` | ≥ 0,55 |
| Basse du retour | `BREAK_RETURN_BASS` | ≥ 0,42 |
| Gain de basse (la basse doit **monter**) | `BREAK_MIN_BASS_GAIN` | ≥ 0,25 |
| Production déjà entendue avant | `_had_production` | 30 s |

Le drop est posé sur le **premier temps fort dont la mesure est déjà pleine**
(même recalage que `_late_return`) et sa force utilise la même formule que les
drops de frontière. Il passe ensuite par la fusion `DROP_MIN_SPACING` : à moins
de 18 s d'un drop existant, le plus fort des deux reste. `source = "break"`.

Les drops restent un sous-ensemble des reprises (`reprises` est initialisé
depuis `merged_drops` après cette passe).

## 3. Flash de montée recalé sur l'impact

Le flash blanc et le sursaut d'intensité ne lisent pas `drops` : le rendu
(`src/core/render.ts`) utilise `buildIntensity` / `dropImpact`, calculés depuis
**`builds[].end`**. Sur « Je vis cette mélodie », la montée détectée
117,8 → 120,4 s se terminait sur le retour des voix : le flash tombait donc à
120,4 s, avant le vrai impact, même une fois le drop replacé à 122,35 s.

`align_builds_to_drops` prolonge la fin d'une montée jusqu'au drop qui la suit
quand l'écart est de `0 < écart ≤ BUILD_DROP_ALIGNMENT` (3,0 s), sans jamais
dépasser le début de la montée suivante. Sur le morceau :

| | avant | après |
|---|---:|---:|
| fin de la montée | 120,40 s | **122,35 s** |
| flash (`dropImpact` à 120,5 s) | 0,79 | **0** |
| premier impact | 120,40 s | **122,35 s** |

Sur le corpus (≈ 40 titres), 78 fins de montée sont recalées, dont la plupart de
moins d'une seconde ; l'écart maximal retenu est de 2,2 s.

## 4. Mesures

- « Je vis cette mélodie » : premier drop **136,6 → 122,35 s** ; le drop de
  153,3 s (creux de 150-152 s, basse absente puis retour à 153) réapparaît ; le
  plan ne contient plus de scène à 118,4 s, le drop tombe à 122,35 s.
- Référence (`eval:ref --no-render`) : **identique** avant/après sur Gogo,
  Minimum, Karma et Focus (mêmes drops, mêmes écarts).
- Corpus complet (≈ 40 titres du cache) : 6 impacts ajoutés (Bottega 23,3 ;
  Blue Danube 58,9 ; Cannonball 155,9 ; Division rouge 84,1 ; MAMILĀH 100,4 ;
  JVCM 153,3), 7 recalages (0,4 à 2,9 s), un déplacement (Energie sombre 158,4 → 164,2,
  Imaginarium 147,4 → 150,6).

## 5. Limites

- Ne couvre que les creux **quasi silencieux** (≤ 0,25). Un break de house où
  la basse continue n'est pas traité par cette passe : il reste couvert par la
  reprise R5, mais sans drop.
- Un silence de 2 s dans un morceau calme (classique, ambient) peut produire un
  impact si la basse et l'énergie reviennent franchement.
- Les seuils sont communs au corpus, aucun réglage par titre.

## 6. Vérifier

```bash
uv run pytest tests/unit/test_structure.py -q
bun run test            # types + front + serveur
bun run eval:ref --no-render
```
