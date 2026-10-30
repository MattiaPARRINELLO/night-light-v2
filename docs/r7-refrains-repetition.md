# R7 — Refrains sans reprise de production

Branche `fix/dashboard-refrain-detection`, une seule PR depuis `main` (après #54).

## 1. Symptôme

Sur *Lune de fiel* (MZ, 294,6 s), le dashboard n'affichait **que des
couplets** et aucun refrain, alors que le morceau répète son refrain trois fois.
Le rôle vient directement de `section.kind` (`src/core/show.ts`), donc le défaut
est dans le détecteur de structure, pas dans l'affichage.

## 2. Diagnostic

L'analyse en cache (v5) donne 16 sections, toutes `couplet` sauf intro/pont, et
**une seule reprise de production** à 248,8 s. Or la règle R4/R5 exige :

```
refrain = matériau répété ET reprise de production à ±0,75 s du début
```

Les features du morceau montrent que les refrains sont bien répétés
(similarité de fenêtres de 8 s ≈ 0,9999 entre 46–74 s, 106–134 s et
202–230 s), mais :

| Bloc | Début | Répété ? | Reprise ? | Avant |
|---|---:|---|---|---|
| 3 | 53,3 s | oui (chroma 0,9998 / MFCC 0,9906) | non | couplet |
| 6 | 123,5 s | oui (0,9977) | non | couplet |
| 11 | 208,2 s | oui (0,9999) | non | couplet |
| 13 | 248,8 s | non (MFCC max 0,959 < 0,985) | oui | couplet |

Aucune section ne satisfait les deux conditions à la fois : les refrains
enchaînent sans creux de production, et l'unique drop tombe sur un bloc dont le
timbre ne ressemble pas assez aux autres occurrences.

## 3. Correctif : répétition franche et contrastée

Un second chemin, additif, s'ajoute à la corroboration R4/R5. Un bloc est
refrain si :

1. son matériau revient **au moins trois fois** (occurrences comptées avec les
   critères existants : durée comparable, énergie/basse/densité proches, chroma
   ≥ 0,80, MFCC ≥ 0,985, un bloc plus calme entre les occurrences) ;
2. son timbre **contraste** avec le voisin le plus proche :
   `min(cosine MFCC) < 0,96`. Les voisins calmes (énergie < 0,26 : intro, pont,
   outro) sont ignorés, sinon leur timbre différent ferait passer n'importe quel
   couplet pour un refrain.

Les portes existantes restent inchangées : ni premier/dernier bloc, énergie
≥ 62 % du maximum, énergie ≥ moyenne des voisins + 0,02.

Paramètres ajoutés (`server/structure.py`) :

- `REFRAIN_RECURRENCE_MIN_OCCURRENCES = 3` ;
- `REFRAIN_CONTRAST_MAX_MFCC = 0.96`.

Aucun seuil par titre. `ANALYZER_VERSION` passe de 5 à 6 : les analyses en
cache sont invalidées et recalculées avec la nouvelle règle.

## 4. Mesures

### Lune de fiel

Trois refrains retrouvés : **53,3 / 123,5 / 208,2 s**. Le contraste MFCC au
voisin le plus proche vaut 0,90 / 0,93 / 0,69, contre ≥ 0,998 partout pour
Gymnopédie.

### Non-régression (features figées)

| Titre | Refrains avant | Refrains après |
|---|---|---|
| One More Time (omen) | 30,4 ; 61,7 ; 257,9 | identiques |
| Latch | 95,6 ; 127,1 | identiques |
| They Don't Care (mj) | 10,5 | identique |
| Boléro | 0 | 0 |
| Gymnopédie | 0 | 0 |
| Lune de fiel | 0 | **53,3 ; 123,5 ; 208,2** |

### Titres annotés (analyse réelle)

| Titre | Refrains détectés | Justes / faux / manqués |
|---|---|---|
| Gogo | 31,6 ; 79,6 ; 176,1 | 2 / 1 / 1 |
| Karma | 216,9 | 1 / 0 / 1 |
| Minimum | 137,0 | 0 / 1 / 0 |
| Focus | 151,2 | 0 / 1 / 0 |
| **Tous** | **6** | **3 / 3 / 2** — P = 0,50 |

Identique à l'état R5 : la nouvelle règle n'ajoute aucun faux refrain sur le
corpus annoté (Focus 15,6 s est écarté par l'exclusion des voisins calmes).

## 5. Limites connues

- Les frontières restent approximatives : la boucle de refrain commence vers
  46 s alors que la section démarre à 53,3 s. Le recalage des frontières reste
  hors périmètre (voir `docs/r6-frontieres.md`).
- Un morceau instrumental qui répète une texture très contrastée avec un pont
  pourrait produire un refrain ; le seuil de contraste 0,96 a été mesuré sur le
  corpus (Lune 0,90–0,93, Boléro 0,98, Gymnopédie ≥ 0,998).
- Le rappel du refrain de Karma à 81 s reste manqué (frontière hors tolérance).
