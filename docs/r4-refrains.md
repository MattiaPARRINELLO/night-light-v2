# R4 — Vérité terrain corrigée et précision des refrains

Branche `fix/refrain-ground-truth`, une seule PR depuis `main` (après #50).
`src/core/render.ts` n'est pas modifié sur le fond (seul un commentaire de halo
statique est corrigé). Aucune règle ne dépend du titre.

## 1. Vérité terrain

- Focus : pont validé **137–152 s** (auparavant 127–152) ; le couplet précédent
  s'arrête donc à 137 s.
- Minimum et Focus : `"refrains": []` + `"refrainsStatus": "valide"`.
  La présence de la clé `refrains` fait foi : liste vide = **validé, aucun
  refrain**, à distinguer de l'absence de clé = **non annoté**.
  `eval:ref` affiche désormais `validé : aucun`, `annoté` ou `non annoté`,
  et liste les faux refrains.
- Gogo et Karma : `"refrainsStatus": "valide"` (refrains dérivés des sections
  validées, sans duplication de données).

Éval calme Focus 137–152 (rendu 1080p) : **luminance moyenne 0,286**,
**minimum 0,278**, saturation 0,41, blanc max 0,000, mode réduit 0,195.

## 2. Diagnostic des refrains (avant correctif)

13 blocs détectés `refrain` sur les 4 titres. `gain` = énergie du bloc moins
celle du bloc précédent ; `MFCC` = meilleure similarité de timbre avec un autre
bloc du même groupe ; `groupe` = nombre d'autres blocs de même matériau ;
`rép.` = occurrences totales ; `brillance` = moyenne de la bande 2–10 kHz.

| Titre | Début–fin | Vrai | Énergie | Gain | MFCC | Groupe | Rép. | Brillance | Densité |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Gogo | 31,65–50,62 | faux | 0,814 | +0,557 | 0,995 | 1 | 2 | 0,302 | 4,74 |
| Gogo | 79,62–89,12 | vrai | 0,770 | −0,041 | 0,994 | 1 | 2 | 0,382 | 4,95 |
| Gogo | 176,12–192,12 | vrai | 0,785 | +0,109 | 0,994 | 1 | 2 | 0,388 | 4,88 |
| Minimum | 82,59–100,59 | faux | 0,821 | +0,174 | 0,989 | 1 | 2 | 0,395 | 4,28 |
| Minimum | 137,00–154,16 | faux | 0,567 | +0,401 | — | 0 | 1 | 0,198 | 4,49 |
| Minimum | 154,16–171,29 | faux | 0,798 | +0,231 | 0,989 | 1 | 2 | 0,326 | 3,73 |
| Karma | 36,43–50,50 | faux | 0,759 | +0,376 | 0,993 | 1 | 2 | 0,118 | 3,77 |
| Karma | 148,03–159,01 | faux | 0,812 | +0,159 | 0,993 | 2 | 3 | 0,184 | 3,92 |
| Karma | 216,92–229,46 | vrai | 0,948 | +0,725 | 0,999 | 1 | 2 | 0,433 | 5,26 |
| Focus | 15,58–34,11 | faux | 0,848 | +0,784 | 0,986 | 2 | 3 | 0,429 | 4,91 |
| Focus | 87,59–98,08 | faux | 0,828 | +0,053 | 0,998 | 4 | 5 | 0,388 | 4,57 |
| Focus | 151,19–170,13 | faux | 0,818 | +0,575 | 0,996 | 1 | 2 | 0,252 | 4,28 |
| Focus | 210,09–230,57 | faux | 0,847 | +0,197 | 0,996 | 1 | 2 | 0,271 | 4,54 |

**Aucune mesure ne sépare proprement les vrais refrains des faux.** Les plages
se recouvrent toutes :

- MFCC : vrais 0,994–0,999 / faux 0,986–0,998 ;
- gain d'énergie : vrais −0,041…+0,725 / faux +0,053…+0,784 ;
- brillance : vrais 0,382–0,433 / faux 0,118–0,429 ;
- densité : vrais 4,88–5,26 / faux 3,73–4,95 ;
- groupe/répétitions : vrais 1/2, faux 0–4 / 1–5.

Focus 15,58 et Latch (hors vérité) partagent presque les mêmes valeurs : aucun
seuil de timbre ne peut les distinguer. Le diagnostic conclut donc à l'option
« pas de refrain clair » sans critère mesuré discriminant.

## 3. Correctif : confiance par saut complémentaire

Un bloc n'est un refrain que si le matériau revient **et** si son début coïncide
avec une reprise de production déjà détectée (`REFRAIN_DROP_TOLERANCE = 0,75 s`).
C'est le seul fait indépendant qui sépare les vrais refrains de Gogo et Karma :
sans retour de production, le bloc garde le rôle couplet/pulse. Les reprises de
production ne changent pas ; seule l'étiquette de section change.

## 4. Refrains avant / après

### Titres de référence

| Titre | Avant détectés | Avant justes/faux/manqués | Après détectés | Après justes/faux/manqués | P | R |
|---|---:|---|---:|---|---:|---:|
| Gogo | 3 | 2/1/1 | 2 | 2/0/1 | 1,00 | 0,67 |
| Minimum | 3 | 0/3/0 | 1 | 0/1/0 | 0,00 | — |
| Karma | 3 | 1/2/1 | 1 | 1/0/1 | 1,00 | 0,50 |
| Focus | 4 | 0/4/0 | 1 | 0/1/0 | 0,00 | — |
| **Tous** | **13** | **3/10/2** | **5** | **3/2/2** | **0,60** | **0,60** |

Objectifs : Minimum et Focus ≤ 1 faux → **atteint** (1 chacun) ;
précision tous titres ≥ 0,40 → **atteint** (0,60) ; Gogo rappel 0,67 →
**atteint** ; Karma rappel 0,50 → **non atteint** (le refrain de 81 s reste
manqué : sa frontière de section est à 76,58 s, hors tolérance ±2 s). Le rappel
combiné Gogo+Karma vaut 3/5 = 0,60. Rien n'est maquillé : l'objectif Karma pris
isolément n'est pas rempli.

### Les 13 titres (refrains qui disparaissent)

| Titre | Avant | Après | Disparus |
|---|---:|---:|---|
| Bolero | 2 | 0 | **tous** |
| Focus | 4 | 1 | 15,58 ; 87,59 ; 210,09 |
| Gogo | 3 | 2 | 31,65 |
| Gymnopédie No. 1 | 8 | 0 | **tous** |
| Karma | 3 | 1 | 36,43 ; 148,03 |
| La Vie en Rose | 6 | 2 | 58,63 ; 78,99 ; 117,00 ; 132,87 |
| Latch | 2 | 0 | **tous** |
| Minimum | 3 | 1 | 82,59 ; 154,16 |
| One More Time | 3 | 1 | 30,44 ; 61,67 |
| Shine On You Crazy Diamond | 21 | 2 | 19 blocs |
| They Don't Care About Us | 1 | 0 | **tous** |
| TRINITYVILLE | 0 | 0 | — |
| Your Hand in Mine | 0 | 0 | — |

Aucun refrain n'apparaît. **Titres qui perdent tous leurs refrains : Bolero,
Gymnopédie No. 1, Latch, They Don't Care About Us.** C'est le coût assumé d'une
règle conservatrice : ces titres n'ont pas de reprise de production au début de
leur matériau répété, donc le plan les traite en couplet/pulse.

## 5. Non-régression

| Vérification | Commande | Résultat |
|---|---|---|
| Sécurité photosensible | `bun run verify:safety` | `SÉCURITÉ OK` (0 fenêtre > 3 flashs/s, 0 flash post-drop, blanc réduit max 0,000) |
| Pureté du rendu | `bun test tests/unit/render-purity.test.ts` | 2 pass, 0 pixel d'écart |
| Snapshots de plans | `bun run snapshots` | à jour ; **une seule scène** change : `90bpm #2` (24,752–38,058) `refrain` → `couplet` (famille, humeur, intensité et saturation suivent, normal et réduit) |
| Types | `bun run typecheck` | OK |
| Lint | `bun run lint` | OK |
| Tests front | `bun test tests/` | 385 pass |
| Tests serveur | `uv run pytest tests/ -q` | 190 pass |
| Éval référence | `bun run eval:ref` | drops inchangés (mêmes justes/faux) |

Saut de teinte des reprises (`bun run hue`) : Gogo 170,0°, Minimum 169,6°,
Karma 153,9°, Focus 169,4° — les drops et les calmes sont inchangés.

## 6. Paramètres modifiés

- `server/structure.py` : ajout `REFRAIN_DROP_TOLERANCE = 0.75` ; les reprises
  sont calculées avant les rôles de section ; un refrain exige la corroboration
  d'une reprise (`corroborated`). Aucun seuil par titre.
- `tools/eval-reference.ts` : statut `aucun` / `annoté` / `non annoté`, faux
  refrains listés.
- `tests/ground-truth/*` : Focus 137–152, `refrains` validés.
- `tools/calm-report.ts` : commentaires de fenêtre.
- `tools/hue.ts` + script `bun run hue` : outil d'écart de teinte versionné.
- `src/core/render.ts` : commentaire du halo statique uniquement.
