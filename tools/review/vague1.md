# Réconciliation vague 1 — #37 (Plan) + #38 (Analyse)

Branche : `reconcile/vague1`, créée depuis `origin/main` (`77074a6`).
Merges : `--no-ff` de `pr-38` puis `pr-37`, sans aucun conflit.
Aucun push sur #37/#38, aucun merge dans `main`, aucune logique ni tolérance modifiée.

## 1. Identification

| PR | Rôle | Branche | Titre | CI |
| --- | --- | --- | --- | --- |
| **#37** | **Plan** | `feat/calibrate-show-plan` | `feat(plan): calibre humeurs et frontières sur le corpus réel` | ❌ `lint/types/tests` (snapshots) + ❌ Playwright (API non démarrée) |
| **#38** | **Analyse** | `fix/builds-and-meter-detection` | `fix(analyse): fiabilise la métrique 3/4 et filtre les faux impacts` | ⚠️ Playwright ✅, `lint/types/tests` bloqué `in_progress` depuis 23:29 (run 40244997049) |

Les deux descriptions contiennent bien le rapport d'agent (résumé, vérifications, notes de méthode).

## 2. Verdict par PR

### #38 — Analyse : ⚠️ mergeable avec corrections

Périmètre conforme : `server/analysis.py`, `tests/unit/test_build_rules.py`,
`tests/unit/test_meter.py`, `tools/build_diagnostic.py`, `tools/corpus_metrics.py`.
Aucun fichier hors périmètre, aucun secret, aucune extension audio, aucun chemin `/home/`.

- `lint` ✅, `typecheck` ✅, `pytest` ✅ (186).
- `bun test` ❌ : `tests/unit/plan-snapshot.test.ts` échoue. La version `ANALYZER_VERSION = "4"`
  change les analyses synthétiques, donc les plans, mais les snapshots de plans ne sont pas régénérés.
  C'est cohérent avec la consigne « snapshots non modifiés » de l'agent Analyse, mais rend la CI rouge.
- Chiffres recalculés (cache vidé, corpus régénéré) :
  - Gymnopédie : **10 → 0** impacts ✅ (annoncé 10 → 0).
  - Plus gros ratio d'impacts : **2,52 → 1,10 /min** ✅ (annoncé ≤ 2).
  - Métrique réelle : **4/10 → 7/10** ✅ (annoncé 4/10 → 7/10 ; Latch, Your Hand in Mine, Gymnopédie corrigés).
  - Synthétique 90 BPM : **0 → 1** impact ✅ (annoncé).
  - Impacts réels : **77 → 28** non revérifié directement (le total dépend du plan, pas de l'analyse) ;
    le nombre de montées par morceau passe bien de 5→5 (One More Time), 10→0 (Gymnopédie),
    12→6 (Blue Danube), 12→2 (Shine On) sur les analyses recalculées.
- Tests de forme du contrat `builds { start, end, strength, source? }` : présents (`test_build_rules.py`).
- Journal des builds rejetés : fourni par `tools/build_diagnostic.py` (critère, gains, basses).
- Seuils : tous nommés et commentés (`BUILD_MIN_RATIO`, `BUILD_MIN_LIFT`, `TERNARY_MIN_PEAK`…),
  avec la raison mesurée et l'outil de reproduction. Aucun nombre magique non justifié.
- Rappel : les 3 morceaux encore faux en métrique sont explicitement documentés
  (Bolero et La Vie en Rose en 3/4 non mesurable, Shine On 6/8 à tempo doublé).

### #37 — Plan : ⚠️ mergeable avec corrections

Périmètre conforme : `src/core/show.ts`, `tests/support/plan_report.ts`,
`tests/snapshots/plans/*`, `tests/unit/*`.
Aucun secret, aucune extension audio, aucun chemin `/home/`.

- `lint` ✅, `typecheck` ✅, `pytest` ✅.
- **Chantier 1 testé seul** (`c10a2e5`, export de l'instrumentation) : ✅ `bun test` vert,
  **aucune différence de snapshot** (vérifié sur corpus neuf). `plan_report.ts` importe bien
  les branches et seuils depuis `src/core/show.ts` (plus de copie).
- **Snapshots non reproductibles sur la branche seule** : avec un corpus neuf, `bun test` échoue
  (12 lignes de diff, identique à la CI). Cause mesurée : les snapshots de #37 ont été générés
  avec le cache partagé `/tmp/night-light-plan-corpus` déjà produit par l'analyseur v4 de #38,
  pas par l'analyseur de `main` (v3). Preuve : une fois #38 intégré, `bun run snapshots:update`
  ne produit **aucune différence** — les snapshots de #37 sont exactement ceux de l'état intégré.
  Correction : régénérer après rebase sur #38 (fait par cette réconciliation), pas de modification manuelle.
- Justification mesurée des seuils : `CYCLE_*` (« 85 % des frontières réelles étaient des retours
  de cycle »), `MAX_SCENE_SPAN = 12` (« médiane réelle 8–20 s »), `MOOD_BRIGHTNESS_THRESHOLD = 0,4`
  (médiane 0,244, p70 0,392 sur le corpus), quantiles 0,4/0,68, plancher/plafond 0,62.
  Aucun nombre magique non justifié.
- `tests/unit/concert.test.ts` : `dramaturgy: true` explicite, cohérent avec la dramaturgie
  désactivée par défaut. `show.test.ts` : analyses enrichies pour tester la branche rythmique,
  pas un relâchement de tolérance.
- CI Playwright rouge pour une cause d'infrastructure (`/api/health` non démarré), sans lien
  avec les fichiers modifiés.

## 3. Tableau des objectifs (tous recalculés)

Corpus réel : 10 morceaux Deezer, audio depuis le cache, analyses régénérées par
`tools/real_corpus.py --no-download` sur chaque état. Corpus synthétique : cache vidé et
régénéré avant chaque mesure. Seuils de définition indiqués sous le tableau.

| objectif | baseline (`main`) | #38 Analyse seule | #37 Plan seule | intégré | atteint ? |
| --- | --- | --- | --- | --- | --- |
| Gymnopédie : 0 drop | 10 | **0** | 10 | **0** | ✅ |
| max impacts/min (tous morceaux) ≤ 2 | 2,52 (Gymnopédie) | **1,10** (They Don't Care) | 2,52 | **1,10** | ✅ |
| One More Time / Latch : ≥ 1 drop | 5 / 5 | 2 / 2 | 5 / 5 | 2 / 2 | ✅ |
| Bolero : climax final conservé | non | **oui** | non | **oui** | ✅ |
| meter correct (corpus réel) = 100 % | 4/10 | 7/10 | 4/10 | **7/10** | ❌ |
| synthétique : drops à ± 1 temps | 0/6 | 1/6 | 0/6 | **1/6** | ❌ |
| frontières cycle < 50 % | 83,8 % | 92,8 % | 14,1 % | **15,2 %** | ✅ |
| durée médiane de scène 8–20 s | 7,01 s | 7,31 s | 11,73 s | **11,73 s** | ✅ |
| scènes > 45 s hors intro/finale = 0 | 0 | 0 | 0 | **0** | ✅ |
| explosif hors drop 20–35 % | 60,4 % | 56,6 % | 34,3 % | **32,4 %** | ✅ |
| explosif toutes scènes ≤ 40 % | 66,2 % | 58,9 % | 49,4 % | **38,1 %** | ✅ |
| Gymnopédie : calme+aérien / explosif ≥ 80 % / 0 | 26,3 % / 10 | 30,0 % / 9 | 40,0 % / 10 | **40,0 % / 7** | ❌ |
| Bolero : explosif dernier tiers > 1er | 90,9 % > 55,6 % | 90,9 % > 31,8 % | 85,7 % > 53,8 % | **92,9 % > 7,1 %** | ✅ |
| 4 humeurs atteignables présentes | oui | oui | oui | **oui** | ✅ |
| familles distinctes (réel) 29/29 | 29 | 29 | 28 | **29** | ✅ |
| incohérences strictes = 0 | 0 | 0 | 0 | **0** | ✅ |
| déterminisme (SHA-256, 2 exécutions) | — | — | — | **identique** | ✅ |

Définitions utilisées :
- « climax final conservé » = au moins un drop démarre dans les 20 % finaux du morceau.
- « ± 1 temps » = écart entre le début de la scène `drop` (fin de montée analysée) et l'arrivée
  du plateau synthétique (66 % de 60 s = 39,6 s), comparé à `60/tempo`.
- « explosif hors drop » = scènes sans drop / humeur `explosif` ; « incohérences strictes » =
  `calmMoodNonCalmReservoir + nonCalmMoodCalmReservoir + unknownProvenance` (les mixtes sont
  volontairement non comptées).

### Point d'attention demandé : objectifs Plan qui régressent à l'intégration

**Aucun objectif Plan ne passe seul puis échoue après intégration.** L'effet croisé va dans
l'autre sens et s'explique :

- `explosif toutes scènes` : **49,4 % (Plan seule) → 38,1 % (intégré)**, passe sous 40 %.
  Cause mesurée : #38 supprime les fausses montées (Gymnopédie 10 → 0, Shine On 12 → 2), donc
  moins de scènes `build` forcées en `explosif`. La baisse d'impacts retire du budget explosif
  au lieu d'en ajouter.
- `familles distinctes` : **28 (Plan seule) → 29 (intégré)**. La famille manquante en Plan seule
  est `vortex` : avec les fausses montées, le plan réel de #37 ne produisait pas assez de scènes
  pour la faire sortir ; les analyses corrigées en produisent 29.

La crainte « calibrages faits sur les anciennes analyses » est donc infirmée pour ces deux
objectifs, mais confirmée sur un point : les snapshots de #37 avaient bien été produits avec les
analyses v4 de #38, pas avec celles de `main`.

### Objectifs non atteints après intégration (chiffrés, non corrigés)

1. **Métrique 100 %** : 7/10. Échecs restants : Bolero (3 attendu, 4 détecté), La Vie en Rose
   (3→4), Shine On (4→3). Valeur manquante : 3 morceaux. #38 documente ces trois cas comme
   non mesurables sur l'accentuation (3/4 sans accents, 6/8 à tempo doublé).
2. **Drops synthétiques à ± 1 temps** : 1/6. Écarts mesurés : 128bpm/128bpm-low **−9,53 s**,
   170bpm **−11,46 s**, 60bpm **−12,53 s**, rich **−24,30 s** ; 90bpm **−1,54 s** pour un temps
   de 0,673 s. La montée analysée se termine 9 à 24 s avant l'arrivée du plateau synthétique
   (seul 90 BPM s'en approche). Baseline identique : ce n'est pas une régression, c'est un
   défaut préexistant que #38 n'a pas couvert.
3. **Gymnopédie calme+aérien ≥ 80 % / explosif 0** : 8/20 (40 %) et **7 scènes explosif**.
   Le calibrage par quantiles de #37 améliore (26 % → 40 %) mais reste loin de la cible :
   l'énergie relative d'un piano seul fait basculer 7 scènes au-dessus du quantile 0,68.
   Valeur manquante : au moins 8 scènes à reclasser calme/aérien et 7 explosifs à supprimer.

## 4. Conflits rencontrés et résolutions

**Aucun conflit de merge.** Les deux PR touchent des fichiers disjoints :

- #38 : `server/analysis.py`, `tests/unit/test_*.py`, `tools/{build_diagnostic,corpus_metrics}.py`.
- #37 : `src/core/show.ts`, `tests/support/plan_report.ts`, `tests/snapshots/plans/*`, `tests/unit/*.ts`.

Résolutions appliquées (aucune manuelle) :

| fichier | nature | choix | raison |
| --- | --- | --- | --- |
| `tests/snapshots/plans/corpus.json` | aucune (fichier modifié par #37 seul) | conservé tel quel | identique à la régénération intégrée |
| `tests/snapshots/plans/corpus-reduced.json` | aucune | conservé tel quel | idem |
| `tests/support/plan_report.ts` | aucune | version #37 | #38 n'y touche pas |
| `package.json` / `bun.lock` | aucune | inchangés | Playwright reste `1.64.1` |

## 5. Corrections demandées

| PR | fichier | ligne / zone | raison | bloquant ? |
| --- | --- | --- | --- | --- |
| #38 | `tests/snapshots/plans/corpus.json`, `corpus-reduced.json` | global | analyser v4 change les plans synthétiques ; snapshots non régénérés → `bun test` rouge | non (fait par la réconciliation) |
| #37 | `tests/snapshots/plans/corpus.json`, `corpus-reduced.json` | global | snapshots générés avec le cache v4 de #38, non reproductibles sur la branche seule (diff CI 12 lignes) | non (régénérés/identiques après intégration) |
| #37 | — | — | aucun nombre magique non justifié, aucun fichier hors périmètre | — |
| #38 | `server/analysis.py` | métrique | 3/10 morceaux encore faux (Bolero, La Vie en Rose, Shine On) | non, documenté |

Aucune correction de logique, de seuil ni de tolérance n'a été appliquée.

## 6. Recommandation finale

**Merger la PR de réconciliation telle quelle.**

Justification : intégration complète, zéro conflit de logique, `lint`/`typecheck`/`test` verts
sur `reconcile/vague1`, snapshots canoniques (aucune différence après `snapshots:update`),
déterminisme vérifié. Les trois objectifs encore non atteints sont préexistants ou documentés
par #38 ; ils relèvent de la vague 2, pas d'un blocage de merge.

## 7. Différences de snapshots attendues, par piste synthétique

Toutes les différences sont expliquées par le calibrage #37 (plafond de scène, frontières de
cycle, quantiles d'humeur) et, pour 90 BPM, par le nouvel impact de #38.

| piste | scènes | drops | médiane | humeurs (avant → après) | cause |
| --- | --- | --- | --- | --- | --- |
| `128bpm` | 8 → 6 | 1 → 1 | 7,50 → 11,71 s | calme 3, aérien 1, explosif 4 → calme 3, explosif 3 | frontières de cycle filtrées, plafond 12 s |
| `128bpm-low` | 8 → 6 | 1 → 1 | 7,50 → 11,71 s | idem | idem |
| `170bpm` | 7 → 5 | 1 → 1 | 8,48 → 11,73 s | calme 2, pulse 1, explosif 4 → calme 2, explosif 3 | cycle/plafond |
| `60bpm` | 6 → 5 | 1 → 1 | 9,54 → 11,49 s | calme 2, pulse 1, explosif 3 → calme 2, explosif 3 | cycle/plafond |
| `90bpm` | 7 → 5 | **0 → 1** | 8,01 → 11,35 s | calme 3, aérien 1, explosif 3 → calme 2, pulse 1, explosif 2 | **impact #38** + calibrage #37 |
| `rich` | 7 → 5 | 1 → 1 | 7,50 → 11,96 s | calme 1, explosif 6 → calme 1, aérien 1, explosif 3 | quantiles d'humeur + cycle |

Diff global intégré vs baseline : **563 → 355 scènes**, rôles `couplet` 452 → 290,
`drop` 80 → 33, humeurs `explosif` 368 → 140, `aérien` 42 → 3. Aucune différence inexpliquée.

## 8. Contrôle visuel et informations vague 2

### Limite d'outillage constatée

`bun run timeline --all` ne charge **que le corpus synthétique** (`loadCorpusAnalyses`) : il
n'accepte ni `--real` ni `NIGHTLIGHT_REAL_CORPUS`. Impossible de produire la timeline du réel
intégré avec l'outil actuel. Les 5 moments ci-dessous sont donc extraits du rapport intégré
(scènes réelles : morceau, horodatage, humeur, énergie) et des analyses réelles.

### 5 moments les plus suspects (réel intégré)

1. **Gymnopédie No. 1, 11,70 s → 23,31 s** : première de **7 scènes `explosif` sans aucun drop**
   (11,70 · 34,92 · 58,38 · 93,37 · 151,00 · 174,47 · 209,40), sur un piano seul. Humeur
   incohérente avec le profil « acoustique calme » ; c'est le principal écart à l'objectif
   calme+aérien ≥ 80 %.
2. **One More Time, 45,95 s → 62,65 s** : scène `drop` de **16,70 s**, la plus longue scène
   drop du corpus. Le plafond `MAX_SCENE_SPAN = 12` n'est pas tenu (voir aussi 16,4–16,7 s).
3. **One More Time, 117,33 s** : `pulse → explosif` avec **ΔE = +0,007** (raison `beat`) —
   changement d'humeur inaudible.
4. **TRINITYVILLE, 26,75 s** : `explosif → calme` alors que **ΔE = +0,013** (l'énergie monte) :
   l'humeur va dans le sens inverse du signal.
5. **Shine On You Crazy Diamond, 247,97 s → 264,68 s** : scène `couplet` calme de **16,72 s**
   (et Gymnopédie finale 221,03 → 237,77, 16,74 s) : plafond de 12 s dépassé de ~40 %.

Aucun drop rapproché (< 8 s) détecté sur le réel intégré.

### Saturation (réel intégré)

- Drops réels : **27** (baseline : 75) ; total avec synthétique : 33.
- **max 0,2948 (29,48 %)**, p90 **0,0035**, moyenne 0,0042.
- Le plafond à ~29 % **n'a pas bougé** (baseline 0,2948). La baisse du nombre de drops réduit
  l'exposition, pas l'intensité maximale. Information pour la vague 2, pas un critère de merge.

### 3 priorités proposées pour la vague 2

1. **Métrique réelle 10/10** : traiter Bolero et La Vie en Rose (3/4 sans accentuation mesurable)
   et Shine On (6/8 à tempo doublé). Objectif actuel 7/10, 3 morceaux manquants.
2. **Humeurs de la Gymnopédie** : empêcher 7 scènes `explosif` sans drop sur un morceau calme
   (plancher absolu ou énergie relative au morceau) ; cible ≥ 80 % calme+aérien, 0 explosif.
3. **Alignement des drops et plafond de scène** : ramener les drops synthétiques à ± 1 temps
   (écarts actuels −1,54 à −24,30 s) et faire respecter réellement `MAX_SCENE_SPAN = 12`
   (scènes observées jusqu'à 16,74 s). Ajouter aussi `--real` à `plan-timeline.ts` pour que le
   contrôle visuel du réel soit possible.

## Reproductibilité

```bash
git switch reconcile/vague1
bun install --frozen-lockfile
uv run python tools/real_corpus.py --no-download
rm -rf /tmp/night-light-plan-corpus        # cache partagé : indispensable entre deux états
bun run report -- --real <dir-audio> --json tools/vague1-report.json
sha256sum tools/vague1-report.json         # 01220945… stable sur 2 exécutions
```

SHA-256 mesuré deux fois : `01220945265da671e4625ba6d5db3b3d9d099817aa39f9b4ceb38e1639810914`.

Vérifications finales sur `reconcile/vague1` : `bun run lint` ✅, `bun run typecheck` ✅,
`bun run test` ✅ (383 tests front, 0 échec ; pytest inclus).
