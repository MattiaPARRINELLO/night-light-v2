# Vague 2 — Scénographie des drops

## Entrée de référence (vague 1)

`tools/vague1-report.json` (355 scènes, 16 pistes dont 10 réelles) :

- **27 drops réels**, répartis sur 9 morceaux (Gymnopédie n'en a aucun).
- **Strength** (force de la montée qui produit l'impact) : **min 0,550 · p25 0,825 ·
  médiane 0,990 · p75 1,000 · max 1,000**. Le p67 vaut 1,000 : le tiers supérieur est
  massivement saturé par les montées à force 1.
- **Familles de drop** : `pont-concert` 26 (96,3 %), `lyres-suspendues` 1 (3,7 %),
  `barres-led` 0. Le constat de la vague 0 (« tout pont-concert ») était donc toujours
  vrai à 96 % après la vague 1.

## Chantier 1 — Fin du tout-pont-concert

### Calibrage

Le seuil littéral `strength >= 0,6` est remplacé par
`DROP_PONT_STRENGTH_THRESHOLD = 0,98` (`src/core/show.ts`). Ce seuil est **juste sous le
p67 réel (1,000)** : il ne peut pas inclure les 13 drops agglutinés à 1,000 sans rendre
le pont majoritaire. Il correspond au climax le plus faible du corpus (Shine On, 0,98).

Deux règles remplacent l'ancienne :

1. **Morceau à un seul drop** : pont-concert seulement si la force atteint 0,98. Un
   impact isolé et faible reste donc en lyres/barres.
2. **Morceau à ≥ 2 drops** : seul le **climax** — dernier drop à la force maximale du
   morceau — prend le pont-concert. Les autres alternent `lyres-suspendues` /
   `barres-led`, en évitant la famille de la scène précédente.

La contrainte « le drop le plus fort reste pont-concert » est ainsi tenue par
construction, Bolero compris (climax à 1,000). En cas d'égalité de force, le dernier
maximum est le climax : c'est la fin de la dernière montée, celle qui ferme l'arc.

### Résultat global (corpus réel)

| Famille de drop | Avant | Après |
|---|---:|---:|
| `pont-concert` | 26 (96,3 %) | **9 (33,3 %)** |
| `lyres-suspendues` | 1 (3,7 %) | **11 (40,7 %)** |
| `barres-led` | 0 | **7 (25,9 %)** |

- `pont-concert` = 9/27 = **33,3 % ≤ 40 %** ✅
- **3 familles** de drop présentes ✅
- Chaque morceau à ≥ 2 drops a bien son climax en pont-concert (voir tableau) ✅

### Tableau par morceau réel

`strengths` suit l'ordre des drops ; `composantes identiques` liste, pour chaque paire
consécutive, le nombre de composantes de signature égales (0 = tout diffère, 4 = rien
ne diffère).

| Morceau | Drops | Familles avant → après | Strengths | Composantes identiques avant → après |
|---|---:|---|---|---|
| One More Time | 2 | pont, pont → lyres, **pont** | 0,900 · 1,000 | 2 → 2 |
| Bolero | 3 | lyres, pont, pont → lyres, barres, **pont** | 0,550 · 1,000 · 1,000 | 1, 2 → 1, 2 |
| They Don't Care About Us | 4 | pont ×4 → lyres, barres, lyres, **pont** | 0,970 · 1,000 · 1,000 · 1,000 | 1, 2, 0 → 1, 2, 0 |
| The Blue Danube, Op. 314 | 6 | pont ×6 → lyres, barres, **pont**, barres, lyres, barres | 0,820 · 0,810 · 1,000 · 0,790 · 0,910 · 0,830 | 0, 2, 3, 1, 3 → 0, 2, 1, 1, 1 |
| La Vie en Rose | 1 | pont → pont | 1,000 | — |
| Gymnopédie No. 1 | 0 | — | — | — |
| Latch | 2 | pont, pont → lyres, **pont** | 0,990 · 1,000 | 2 → 2 |
| Your Hand in Mine | 5 | pont ×5 → lyres, barres, lyres, barres, **pont** | 0,770 · 0,990 · 0,760 · 1,000 · 1,000 | 0, 0, 1, 2 → 0, 0, 1, 2 |
| Shine On You Crazy Diamond | 2 | pont, pont → lyres, **pont** | 0,770 · 0,980 | 2 → 2 |
| TRINITYVILLE | 2 | pont, pont → lyres, **pont** | 0,910 · 1,000 | 1 → 1 |

Gras = climax du morceau, seul porteur du pont-concert. La Vie en Rose n'a qu'un drop,
mais sa force (1,000) le place dans le tiers supérieur.

## Chantier 2 — Signatures distinguables

### Mesure avant / après (paires de drops consécutifs, corpus réel)

| Composantes différentes | Avant | Après |
|---|---:|---:|
| 0 (signature identique) | 0 | **0** |
| 1 | 2 | **0** |
| 2 | 7 | **7** |
| 3 | 5 | **7** |
| 4 | 4 | **4** |
| Total des paires | 18 | **18** |

- Paires avec signature identique : **0** ✅ (déjà garanti par l'unicité globale).
- Paires avec ≥ 2 composantes différentes : **18/18 = 100 % ≥ 80 %** ✅ (avant : 16/18 =
  88,9 %).

### Mécanisme

`dropSignature` est inchangé (même graine, même hash, même paramètre `attempt`). La
boucle d'`attempt` de `buildShowPlan` ne retient plus seulement la première combinaison
inutilisée : elle retient la première combinaison **inutilisée et distante d'au moins deux
composantes** du drop précédent, avec repli sur la première inutilisée si aucune ne
convient. Aucun état global : la suite ne dépend que de la graine, du rang, de la force
et du drop précédent du même morceau. Même seed ⇒ même plan.

## Chantier 3 — Branches mortes (documentation seule)

`refrain`, `montee` (branches de `familyFor`) et `sombre` (humeur) restent
inatteignables. Ce n'est pas un bug de la scénographie : le plan ne les réveille pas
artificiellement, car l'analyse ne fournit pas les données qui les distinguent.

Ce qu'il faudrait côté analyse, sans toucher au plan :

1. **Sections locales réelles** (`analysis.sections` avec plus d'une section, chacune
   couvrant < 95 % du morceau) et des `kind`/`label` exploitables (`refrain`,
   `pont`/`montee`). Aujourd'hui `localSectionAt` écarte la section globale et
   `roleFor` ne voit donc jamais `section.kind === "refrain"` ni le label `montee` :
   les rôles `refrain`/`montee` n'existent pas, et les branches correspondantes de
   `familyFor` sont mortes par construction.
2. **Détection de silence** : un label `silence` (ou une énergie quasi nulle sur une
   fenêtre) pour que la branche `silence-sombre` de `moodBranchFor` et l'humeur
   `sombre` puissent être atteintes. Aujourd'hui aucune section ni aucun override ne
   produit ce label.
3. Le jour où ces données existeront, le mode `dramaturgy` déjà présent les consommera
   sans nouvelle modification du plan ; il faudra alors recalibrer le seuil de drop sur
   la distribution obtenue, les rôles n'étant plus exclusivement `build`.

## Snapshots synthétiques (`tests/snapshots/plans/`)

Diff : **une seule ligne par piste**, toutes des scènes `drop`, toutes justifiées par le
seuil 0,98 (les six pistes synthétiques n'ont qu'un drop, de force < 0,98) :

| Piste | Scène | Force | Famille avant → après |
|---|---|---:|---|
| `128bpm` | #3 | 0,820 | pont-concert → lyres-suspendues |
| `128bpm-low` | #3 | 0,820 | pont-concert → lyres-suspendues |
| `170bpm` | #2 | 0,820 | pont-concert → lyres-suspendues |
| `60bpm` | #2 | 0,860 | pont-concert → lyres-suspendues |
| `90bpm` | #3 | 0,850 | pont-concert → lyres-suspendues |
| `rich` | #1 | 0,970 | pont-concert → lyres-suspendues |

Aucune autre scène n'a bougé : starts, ends, rôles, humeurs, intensités, teintes et
signatures sont identiques. `corpus-reduced.json` est inchangé (le mode réduit ne force
ni pont ni signature).

## Preuve « seuls les drops changent »

Diff `tools/plan-report.ts --diff tools/vague1-report.json tools/vague2-report.json` :

- **humeurs** : aucune ligne — distribution identique
  (`aerien 3 · calme 135 · explosif 140 · pulse 77`).
- **rôles** : aucune ligne — distribution identique
  (`couplet 290 · drop 33 · finale 16 · intro 16`).
- **branches humeur** : aucune ligne.
- **caractères** : aucune ligne.
- Les seules différences sont des scènes `drop` (famille, signature, teinte) et, par
  propagation de l'exclusion de famille vers la scène suivante, quelques scènes
  voisines non-drop de famille (`They Don't Care About Us #9`, `Your Hand in Mine #15`,
  `Shine On #23` et `#25`). Aucune frontière, aucun rôle, aucune humeur ne change.

## Reproductibilité et vérifications

- Rapport vague 2 : `tools/vague2-report.json`, produit depuis les analyses en cache
  (mêmes noms de pistes que la vague 1).
- **SHA-256 sur deux exécutions** :
  `7c04a4a0b2e6e12d2b5a761f4c5bd50c5bbad9c2b12e0850d5b00e6d6be67cd6`.
- `bun run typecheck` ✅
- `bun run lint` ✅ (`oxlint` + `ruff`)
- `bun run test` ✅ (383 tests front, 0 échec ; 186 tests serveur, 0 échec)
