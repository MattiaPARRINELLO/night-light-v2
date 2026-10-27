# Réconciliation vague 3 — #45 (Métrique) × #43 (Structure) × #44 (Dramaturgie)

Branche : `reconcile/vague3`, créée depuis `origin/main` (`dac9766`, merge de
#42 + vague 2). Merges `--no-ff` : `891e4e0` (#45), `acc61d4` (#43),
`56cf74e` (#44), puis bump `9121587` et correctif d'intégration `6417cda`.
Aucun push sur `#43/#44/#45`, aucun merge dans `main`.

> **Limite majeure — étape 0 non satisfaite.** `tools/corpus-manifest.json` et
> `tools/review/lot0.md` sont **absents de `main` et de toutes les branches**
> (vérifié par `git ls-tree` sur les 50+ refs distantes). Le manifeste
> `tests/support/real_corpus.json` existe mais n'est pas le lot 0 demandé : il
> ne définit ni le corpus admis ni le « drop ». Conformément à la consigne, les
> mesures **réelles** ont été arrêtées. Le verdict porte donc uniquement sur le
> **synthétique** et la **rétrocompatibilité** ; les chiffres réels des PR sont
> rapportés comme *annoncés, non reproduits*.

## 1. Identification

| PR | Agent | Branche | Fichiers | Δ | `ANALYZER_VERSION` | CI (GitHub) |
|---|---|---|---:|---:|---|---|
| **#45** | Métrique | `fix/meter-detection-bass-return` | 11 | +952 / −0 | `"4"` | ✅ les 3 checks, état `CLEAN` |
| **#43** | Structure | `feat/sections-vague3` | 9 | +1719 / −12 | `"4"` | ✅ les 3 checks, état `CLEAN` |
| **#44** | Dramaturgie | `feat/dramaturgie-vague3` | 23 | +57210 / −89 | `"4"` | ✅ les 3 checks, état `CLEAN` |

Les trois jobs « lint, types, tests front & serveur, build », « parcours
navigateur (Playwright) » et « GitGuardian » sont `SUCCESS` sur les trois PR.
Aucun échec à requalifier en flake d'infra côté GitHub.

**Flake local identifié (hors CI)** : `bun run check:browser` échoue par
intermittence sur « l'audio est en pause juste après le lancement » / « la pause
ne fige pas la lecture ». Le même échec se reproduit **à l'identique sur
`origin/main`** (`/tmp/opencode/wt-main-v3`), donc il est antérieur à la vague 3
et sans lien avec le diff. Cause probable : la touche `s` force `startShow`
alors que le show vient de démarrer automatiquement (course déjà présente).
Une exécution locale passe parfois ; le job CI Playwright des trois PR est vert.

## 2. Verdict par PR

- **#45 Métrique : ✅ mergeable.** Contrat respecté, champs additifs, `meter`
  reste un `int`. Tests module/métrique/retour de basse verts.
- **#43 Structure : ✅ mergeable.** Périmètre serveur respecté, contrat
  additif, test de compatibilité v4 fourni. Les métriques de refrain réelles
  ne sont pas reproductibles sans le lot 0, mais le code et la vérité terrain
  sont cohérents et testés.
- **#44 Dramaturgie : ✅ mergeable après le correctif d'intégration `6417cda`.**
  Tel quel, #44 violait la rétrocompatibilité v4 sur une analyse à plusieurs
  sections contenant un label `silence` (voir §4a). Le correctif est un
  aiguillage d'une ligne, pas une réécriture de la logique de l'agent. **Si #44
  est mergée seule, elle doit porter ce correctif et son test.**

## 3. Périmètre (contrôlé par `git diff`, pas par les titres)

### #45 — conforme, avec extensions de sérialisation

Fichiers : `server/meter.py` (nouveau), `server/analysis.py`,
`server/main.py`, `scripts/analyze_corpus.py`, `tools/real_corpus.py`,
`tests/support/make_corpus.py`, `tests/support/make_fixture.py`,
`tests/unit/test_meter_module.py`, `tests/unit/test_bass_return.py`,
`tests/fixtures/meter_truth.json`, `tools/review/vague3-metrique.md`.

- Bloc `# --- vague3:metrique ---` : un seul appel à
  `analyse_meter_and_events`, entre `builds` et `check_cancel(0.9)`.
- **Écart de forme (non bloquant)** : l'import, deux champs de dataclass
  (`meter_confidence`, `events`) et leur retour sont hors du bloc balisé. Ils ne
  peuvent pas y vivre sans casser la dataclass ; la logique algorithmique, elle,
  est bien dans le bloc.
- **Écart de forme (non bloquant)** : `server/main.py`, `scripts/analyze_corpus.py`
  et `tools/real_corpus.py` ajoutent la sérialisation des deux champs, hors du
  périmètre littéral annoncé, mais nécessaires au contrat client.
- Aucun `src/**`. Aucun `barStarts`, brillance ni densité côté serveur.

### #43 — conforme

Fichiers : `server/structure.py` (nouveau), `server/analysis.py`,
`tests/unit/test_structure.py`, `tests/unit/test_analysis.py`,
`tests/unit/analysis-v4-compat.test.ts`, `tests/fixtures/structure_truth.json`,
`tools/structure_eval.py`, `tools/review/vague3-structure.{md,json}`.

- Bloc `# --- vague3:structure ---` : remplacement de `detect_sections` par
  `detect_structure`, un seul appel.
- Aucun `src/**`, aucun `server/meter.py`, aucun snapshot modifié.
- **Écart de forme (non bloquant)** : `detect_sections` reste défini et n'est
  plus appelé (code mort conservé pour l'historique). Aucun impact, `ruff`
  passe.
- **Écart de forme (non bloquant)** : le rapport ne donne pas la part des
  frontières `cycle` **après** (seule la référence vague 2, 49/355 = 13,8 %,
  est citée). Mesurable seulement avec le corpus réel.

### #44 — conforme après correctif

Fichiers : `src/core/show.ts`, `src/types.ts`, `tests/unit/plan-v3.test.ts`,
`tests/unit/show.test.ts`, `tests/unit/plan-snapshot.test.ts`,
`tests/support/*`, `tests/fixtures/contract_v3/*`,
`tests/snapshots/plans/contract_v3*.json`, `tools/plan-snapshots.ts`,
`tools/vague3-fixtures-report.json`, timelines de fixtures.

- Aucun `src/core/render.ts`, aucun `server/**`, aucun `src/browser/**`.
- Ajouts **optionnels** uniquement : `Section.confidence?`, `AnalysisEvent`,
  `Analysis.events?`, `Analysis.meterConfidence?`, `SectionKind += "silence"`,
  `SceneReason += "bass-return"`, `FamilyBranch += "pont"`.
- Aucun champ existant renommé, retypé ni supprimé ; `meter` reste `3 | 4`.
- **Écart de forme (non bloquant)** : 57 k lignes de fixtures/timelines dans la
  PR, dont `tools/vague3-fixtures-report.json` **sans générateur committé**
  (reproductible seulement par `bun run report -- --corpus <dossier des
  fixtures>` ; nous l'avons refait, voir §5).
- **Écart de comportement corrigé** : voir §4a et §7.

### Tous

- `ANALYZER_VERSION` restait `"4"` dans les trois branches : conforme à la
  consigne. Le bump `"5"` est un commit séparé (`9121587`) avec commentaire
  d'invalidation du cache vague 2.
- Aucun `barStarts` / brillance / densité côté serveur
  (`rg` sur `server/` : aucun hit).
- **Secrets** : `git diff origin/main...<branche>` filtré sur
  `arl|deezer_arl|token|secret|password|api_key` → aucune valeur. La seule
  occurrence est une phrase de documentation dans le rapport Structure qui dit
  que `DEEZER_ARL` n'est jamais lu ni versionné. Aucun `.env` suivi.

## 4. Contrat V3.1

### a. Rétrocompatibilité v4 — ✅ après correctif

- Analyse v4 réelle (une section `kind: "section"`, label quelconque, sans
  `meterConfidence`, `events`, `confidence`) : plan **identique octet pour
  octet** à `main`, normal et réduit. Test
  `tests/unit/analysis-v4-compat.test.ts` (empreinte
  `ec970395…e73791`), et vérification indépendante par script sur les deux
  arbres : mêmes SHA-256.
- Analyse v4 **à plusieurs sections** avec une pause `label: "silence"` :
  **écart initial** (une scène de plus à 56 s). Cause : `isSilenceSection`
  appliquait le plancher de fusion de 1,5 s à tout label `silence`, même sans
  `kind: "silence"`. `main` fusionnait à 5 s. **Bloquant, corrigé en `6417cda`** :
  le plancher 1,5 s est réservé à `isReliableSection && kind === "silence"`, le
  poids 0,4 reste attaché au label historique. Après correctif, les SHA-256
  normal/réduit sont identiques à `main`
  (`529754b1…4c8e83e` / `0272fe78…93d63a`), et le fixture `confidence-faible`
  donne exactement le plan de `main` (`ccad1f1b…`).
- Test de non-régression ajouté : `analysis-v4-compat.test.ts`, second cas
  « une pause non typée V3.1 garde la fusion des frontières de la vague 2 ».

### b. Snapshots synthétiques — ✅

- `git diff origin/main -- tests/snapshots/plans/corpus.json corpus-reduced.json` :
  **vide**. Les six pistes synthétiques gardent exactement leur plan.
- Seuls deux fichiers **nouveaux** apparaissent : `contract_v3.json` et
  `contract_v3-reduced.json` (fixtures V3.1).
- Après correctif, `contract_v3*` ne change que pour `confidence-faible`
  (9 → 8 scènes). Justification détaillée en §9.

### c. Seuil de confiance — ✅

- `tests/unit/plan-v3.test.ts` : « confidence < 0,5 : aucun rôle
  refrain/pont/silence, aucune humeur forcée » → **passe**.
- Vérification indépendante : sur `confidence-faible`, le plan avec dramaturgie
  auto (champs V3.1 présents, toutes confiances < 0,5) est **identique** au plan
  forcé `{ dramaturgy: false }` et **identique octet pour octet à `main`**.
- « sans `kind` » : couvert par le cas v4 multi-sections ci-dessus (aucun
  `kind` V3.1) → plan identique à `main`.
- Nuance de forme : l'ancien test ne comparait qu'à `dramaturgy: false`, pas à
  `main`. Le nouveau test fige les deux.

### d. Serveur `"5"` et client actuel — ✅

`bun run test` : **417 tests front + 209 tests serveur, 0 échec**.
`bun run typecheck`, `bun run lint` (oxlint + ruff), `bun run build` :
**verts**. `bun run check:browser` : vert une fois, puis flake local identique
sur `main` (voir §1). Le JSON `"5"` ajoute `meterConfidence` et `events`
optionnels, `sections[].kind/group/confidence` optionnels ; le client les
ignore ou les traite comme absents.

## 5. Objectifs (mesure | cible | obtenu)

**Tout ce qui suit est synthétique.** Les lignes « annoncé » sont les chiffres
des rapports d'agents, non reproduits faute de lot 0.

### Métrique

| mesure | cible | obtenu |
|---|---|---|
| Latch / Shine On 4/4, La Vie en Rose 3/4 | 3/3 | annoncé 3/3 par #45 ; **non reproduit** |
| Aucune régression sur métrique connue | 0 | annoncé 10/10 ; **non reproduit** |
| Valses synthétiques 90/120/150 BPM | 3/3 en 3/4 | **3/3** (`test_valses_synthetiques_detectees_3_4`) |
| 6/8 synthétique | 3 ou repli 4/4 | **repli 4/4** documenté et testé |
| `meterConfidence` basse sur ambigus | liste | annoncé : Your Hand in Mine 0,60 ; One More Time / La Vie en Rose / Shine On 0,67. Plancher du code = 0,60 : « basse » signifie au plancher, jamais < 0,60. **non reproduit** |
| `bass-return` rap / sans montée ; absent sans basse | présence/absence | annoncé : TRINITYVILLE 1 ; One More Time, Your Hand in Mine, Shine On ≥1 ; Bolero et Gymnopédie 0. Tests synthétiques `test_bass_return.py` **verts**. **réel non reproduit** |

### Structure (vérité terrain annotée)

| mesure | cible | obtenu |
|---|---|---|
| Précision des débuts de refrain (±2 s) | ≥ 70 % | annoncé **92,3 %** (12/13) ; **non reproduit** |
| Rappel des débuts de refrain | ≥ 60 % | annoncé **80,0 %** (12/15) ; **non reproduit** |
| Faux refrain sur morceau sans refrain | 0 | annoncé **0/3** ; **non reproduit** |
| Refrains détectés / attendus par morceau | — | annoncé : One More Time 2/2, La Vie en Rose 3/3, Latch 3/4 (+1 faux à 173,3 s), Your Hand in Mine 4/4, They Don't Care 0/3 ; **non reproduit** |
| Silence → humeur sombre atteignable | ≥ 1 cas réel sinon expliquer | réel annoncé **0/0** (aucun silence intérieur annoté) ; **atteint sur fixture** `silence-milieu` : scène 38,00→40,50 s, humeur `sombre`, famille `particles` (vérifié par `plan-report`) |
| Raison `section` vivante | oui | **oui** : 30/68 scènes (44,1 %) sur les 6 fixtures V3.1 |
| Part des frontières `cycle` avant / après | avant / après | avant **13,8 %** (49/355, vague 2) ; **après réel non mesuré**, et absent du rapport #43. Sur fixtures : **0/68 cycle** (non comparable) |

### Dramaturgie

| mesure | cible | obtenu |
|---|---|---|
| `role` refrain / montee | vivants | **22 scènes refrain, 3 montee** sur les 6 fixtures |
| `moodFor` refrain-explosif / montee-pulse / silence-sombre | vivants | **22 / 3 / 1** scènes ; branches mortes restantes : `build-explosif`, `aerien`, rôles `drop` |
| Mémoire de groupe (même `group` → même famille et même teinte) | oui | **test `plan-v3.test.ts` « même famille de base, même teinte complémentaire, intensité croissante » : passe** |
| Familles de drop identiques à la vague 2 | identique | **6 drops synthétiques avant = après** (6 `lyres-suspendues`) ; les fixtures V3.1 n'ont aucun drop (0/6), donc la répartition réelle 33,3/40,7/25,9 % n'est **pas comparable**. Réel non mesuré |

## 6. Sécurité et non-régression

Mesures sur `reconcile/vague3`, image 320×180, 30 Hz, `measure-families.ts`.

### Corpus synthétique (6 pistes, 6 drops) — avant / après identiques

| mesure | cible | obtenu |
|---|---|---|
| Fenêtres > 3 flashs/s | 0 | **0** ; max **3/s** (170 BPM), identique à `main` |
| Flashs dans 1,5 s après un drop | 0 | **0** (6 drops) |
| Flash plein écran en mode réduit | 0 | **0** ; part de blanc max **0,127** (< 0,25) |
| Spearman force ↔ pic | ≥ 0,880 audio / 0,902 manifeste | **0,708 sur le corpus synthétique, avant comme après**. Le corpus synthétique n'est pas le corpus réel de référence : la cible réelle n'est pas transposable. Aucune régression avant/après |
| Pic max | — | 0,180 (`rich`), 0/6 ≥ 0,25 |
| Largeur d'impact médiane | 0,15–0,6 s | **0,467 s** |
| render-purity | 0 px, delta 0 | **2 tests verts**, 0 px |
| Déterminisme | SHA-256 ×2 identiques | **identique** : `36681f40…1cca4` sur deux `plan-report` |
| Drops avant / après | écart justifié | **6 → 6**, aucun déplacement (les analyses synthétiques n'ont pas de champ V3.1) |

### Fixtures V3.1 (6 pistes, 0 drop)

Fenêtres > 3 flashs/s : **0** ; flashs réduits : **0** ; part de blanc max
**0,019**. Les fixtures ne contiennent aucun `build`/drop : elles exercent les
nouvelles branches dramaturgiques, pas la sécurité d'impact.

### Temps d'analyse (synthétique, 2ᵉ passage à chaud)

| piste | `main` | intégré | écart |
|---|---:|---:|---:|
| 128bpm-low | 0,170 s | 0,163 s | −4,1 % |
| 128bpm | 0,168 s | 0,156 s | −7,1 % |
| 170bpm | 0,180 s | 0,160 s | −11,1 % |
| 60bpm | 0,212 s | 0,156 s | −26,4 % |
| 90bpm | 0,137 s | 0,154 s | +12,4 % |
| rich | 0,135 s | 0,170 s | **+25,9 %** |

Pire cas synthétique : **`rich`, +25,9 %**, sous le plafond de +45 %. La mesure
est bruitée (±0,02 s). Les agents annoncent : Structure max +28 %, Métrique
−3 à −4 % ; le cumulé réel n'a pas été mesuré (lot 0 absent).

## 7. Conflits et arbitrages

- **Un seul conflit de merge** : `server/analysis.py`, bloc d'imports. #45
  ajoute `from .meter import analyse_meter_and_events`, #43 ajoute
  `from .structure import detect_structure`. Résolution : **les deux imports
  conservés**, aucune logique modifiée.
- **Arbitrage d'intégration `6417cda`** : le plancher de silence de 1,5 s de
  #44 s'appliquait à tout `label: "silence"`, y compris sans champ V3.1. Une
  analyse v4 multi-sections changeait alors de plan. Correctif minimal dans
  `sceneBoundaries` : `silence = isReliableSection(section) && kind === "silence"`,
  `weight = 0.4` pour le label historique, plancher 1,5 s réservé au silence
  typé. Aucune autre branche, aucun seuil, aucune famille modifiée. Test de
  non-régression + snapshots `confidence-faible` mis à jour.
- **Aucun snapshot synthétique existant réécrit** ; seuls les snapshots des
  fixtures V3.1 changent, et uniquement `confidence-faible`.

## 8. Corrections demandées

### Bloquantes

| PR | fichier / bloc | raison | état |
|---|---|---|---|
| #44 | `src/core/show.ts`, `sceneBoundaries` (ligne ~1141) | plancher de silence 1,5 s appliqué sans `kind: "silence"` → plan v4 multi-sections différent de `main` | **corrigé dans `6417cda`** ; à reporter sur #44 si elle est mergée sans `reconcile/vague3` |
| #44 | `tests/unit/analysis-v4-compat.test.ts` | le test « comportement historique » ne comparait qu'à `dramaturgy: false`, pas à `main` | **test ajouté** avec empreintes `main` normal + réduit |

### Non bloquantes

| PR | correction |
|---|---|
| lot 0 | créer `tools/corpus-manifest.json` + `tools/review/lot0.md` (définition unique du corpus et du drop) avant toute mesure réelle. **Sans cela, aucun objectif réel n'est validable.** |
| #43 | donner la part des frontières `cycle` **après** dans `vague3-structure.md` (aujourd'hui seulement 13,8 % avant) ; supprimer ou documenter `detect_sections` devenu mort. |
| #44 | committer le générateur de `tools/vague3-fixtures-report.json` (ou le supprimer) ; 57 k lignes de fixtures à vérifier en revue humaine. |
| #45 | documenter explicitement les champs de dataclass/sérialisation hors bloc balisé ; clarifier que `meterConfidence` a un plancher de 0,60 (aucune valeur < 0,60, donc « ambigu » = 0,60) ; vérifier la liste des morceaux ambigus. |
| test e2e | `check:browser` est instable localement (course `s` / auto-démarrage), sur `main` comme sur la branche. À stabiliser hors vague 3. |

## 9. Diff de snapshots expliqué

- `corpus.json`, `corpus-reduced.json` : **inchangés** (diff vide contre
  `main`). Les six pistes synthétiques n'ont pas de champ V3.1 : la dramaturgie
  reste dormante et le plan est identique.
- `contract_v3.json`, `contract_v3-reduced.json` : **nouveaux** fichiers.
- Après `6417cda`, seul `confidence-faible` change : **9 → 8 scènes**.
  - La frontière de la section `56,00 s` (`label: "silence"`, `confidence 0,3`)
    n'est plus protégée par le plancher de 1,5 s ; elle est fusionnée avec la
    suivante à `58,00 s`, comme dans `main`. La scène `56→67,742` disparaît.
  - Effet en cascade : le nombre de segments change, donc les quantiles
    d'énergie de `moodThresholdsFor` changent aussi. Les scènes `8→19,839` et
    `19,839→32` passent de `calme/particles` à `pulse/rings` (teinte inchangée,
    seule la famille et l'intensité suivent l'humeur). C'est exactement le plan
    de `main` pour la même analyse ; aucune autre piste n'est touchée.
  - Justification : rétablissement du comportement strict sous le seuil de
    confiance (contrat §4c), pas un changement de dramaturgie.

## 10. Moments suspects et priorités vague 4

Captures 960×540 générées hors git dans `tools/review/vague3/captures/`
(ignoré), avec `createHeadlessRenderer` sur les fixtures V3.1 :

| # | moment | constat |
|---|---|---|
| 1 | `refrain-x3` · **33,00 s** (scène 30→44, rôle `refrain`, `lyres-suspendues`) | Refrain lisible : rideau de faisceaux verticaux, teinte complémentaire ; branche `refrain` bien réveillée. |
| 2 | `refrain-pont` · **26,05 s** (frontière `section` à 26,00 s, rôle `refrain`, `barres-led`) | La frontière passe bien ; à +0,05 s le fond de la scène précédente domine encore (fondu d'entrée), le nouveau motif n'est pas encore lisible. À vérifier à +0,8 s. |
| 3 | `rap-bass-return` · **24,05 s** (raison `bass-return`, `couplet`, `rings`) | Le retour de basse crée une frontière mais **aucun drop** : anneaux calmes, pas d'impact. Conforme au contrat. |
| 4 | `confidence-faible` · **9,00 s** (section 8→19,839, `confidence 0,35`, `couplet`) | Après correctif : `pulse/rings`, aucun rôle refrain/pont, aucune humeur sombre — exactement le plan de `main`. La retombée sur l'ancien comportement est visible et correcte. |
| 5 | `valse-3-4` · **8,05 s** (frontière `section` à 8,00 s, métrique 3) | Grille de 3 temps, motif `particles` calme ; la métrique 3/4 ne produit pas de cycle à 4 temps. |

### Priorités vague 4

1. **Créer le lot 0** (manifeste + chargeur unique) avant toute nouvelle PR : sans
   lui, aucune des promesses réelles (métrique 10/10, refrains 92 %/80 %,
   sécurité, timings) n'est vérifiable.
2. **Porter le correctif `6417cda` sur #44** si la dramaturgie est mergée hors
   `reconcile/vague3`, et ajouter le test de parité `main`.
3. **Mesurer la part de `cycle` après Structure** et la répartition réelle des
   familles de drop sur le corpus du lot 0.
4. **Stabiliser `check:browser`** (course auto-démarrage / touche `s`) : le
   flake est antérieur et pollue la lecture des CI.
5. **Nettoyer la dette de forme** : générateur du rapport de fixtures,
   `detect_sections` mort, champs hors bloc balisé documentés.

## Recommandation

**Merger `reconcile/vague3` telle quelle** (avec le correctif `6417cda`) : les
trois PR sont conformes au contrat V3.1 après ce correctif, la
rétrocompatibilité v4 et les snapshots synthétiques sont prouvés, la CI est
verte. **Réserve explicite** : le lot 0 est absent, donc les objectifs
« réels » (métrique, refrains, sécurité, timings, drops) restent **annoncés et
non reproduits**. Si la politique est de ne rien merger sans lot 0, alors
l'alternative est « merger Métrique + Structure, reprendre Dramaturgie sur les
vraies analyses `"5"` » ; dans ce cas le correctif `6417cda` doit être reporté
sur #44 avant son merge.
