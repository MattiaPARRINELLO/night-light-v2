# Réconciliation vague 2 — #40 (Scénographie) × #41 (Rendu)

Branche : `reconcile/vague2`, créée depuis `origin/main` (`af2e8eb`), merges
`c1055e9` (#40) puis `e392522` (#41), outillage de revue `fad21cf`.
Aucun push sur les branches de #40/#41, aucun merge dans `main`.

## 1. Identification

| PR | Agent | Branche | Titre | Checks CI (au moment de la revue) |
|---|---|---|---|---|
| **#40** | Scénographie | `feat/vague2-scenographie-drops` | `feat(plan): diversifie les familles de drop et réserve le pont au climax` | ✅ lint/types/tests/build, ✅ Playwright, ✅ GitGuardian |
| **#41** | Rendu | `fix/render-impact-saturation-safety` | `fix(rendu): impact proportionnel au drop, flashs sûrs, seek pur` | ✅ lint/types/tests/build, ⚠️ Playwright (échec d'infra : API non démarrée), ✅ GitGuardian |

Les deux périmètres sont disjoints et les descriptions permettent de trancher
sans ambiguïté : #40 ne touche que `src/core/show.ts` (drops), #41 ne touche que
`src/core/render.ts` et l'outillage de mesure.

## 2. Verdict par PR

- **#40 Scénographie : ✅ mergeable.** Tous les chiffres annoncés sont
  reproductibles au chiffre près, périmètre respecté, aucun état global.
- **#41 Rendu : ✅ mergeable.** Sécurité et lisibilité reproductibles, périmètre
  respecté. Deux **inexactitudes de description** (non bloquantes) : le pic
  avant/après du mode réduit et le « 4 flashs/s à 170 BPM » ne se reproduisent
  pas (voir §7). Le code, lui, tient tous les objectifs.
  Le job CI « parcours navigateur » a échoué sur `http://127.0.0.1:8791/api/health
  n'a pas démarré` : l'API n'a pas répondu en 60 s. Le même parcours passe en
  local sur la branche intégrée après `bun run build` (`Vérification navigateur :
  tout est vert`). Échec d'infrastructure sans lien avec le diff (aucun fichier
  `server/*`) ; il suffit de relancer le job, aucun correctif de code.

## 3. Contrôle de périmètre

### #40 — conforme

Fichiers : `src/core/show.ts`, `tests/unit/show.test.ts`,
`tests/snapshots/plans/corpus.json`, `tools/vague2-report.json`,
`tools/review/vague2-scenographie.md`. Diff `show.ts` limité à :
`signatureDistance`, `DROP_PONT_STRENGTH_THRESHOLD` (utilisé par la seule
branche drop), le bloc `dropStrengths`/`dropClimaxRank` avant la boucle, la
sélection de signature et la famille inline `forceConcert` de `buildShowPlan`
(l'équivalent de la branche `drop` de `familyFor`, qui est inline et non une
fonction séparée dans ce fichier).

- `moodFor`, `roleFor`, `sceneBoundaries`, les seuils d'humeur et les
  réservoirs de la vague 1 : **aucune ligne modifiée** (le diff ne contient que
  les hunks `signatureKey`/`buildShowPlan`).
- `src/core/render.ts` : **non modifié**.
- Aucun état global introduit : une `const` exportée et des variables locales à
  `buildShowPlan`. La déterminisme repose sur la graine existante.
- `tests/snapshots/` : seules les six scènes `drop` synthétiques changent de
  famille (voir §9).

### #41 — conforme, avec deux ajouts hors périmètre mineurs

Fichiers : `src/core/render.ts`, `tests/support/headless_browser.ts`,
`tests/support/headless_render.ts`, `tests/unit/render-purity.test.ts`,
`tools/saturation-report.ts`, `tests/metrics/README.md`, `.gitignore`,
`tools/review/vague2-rendu/RAPPORT.md`.

- `git diff origin/main...fix/render-impact-saturation-safety -- tests/snapshots/` :
  **vide**.
- `src/core/show.ts` : **non modifié**.
- `ctx.reset()` : appelé dans `resetAfterSeek` (`render.ts`, `renderFrame`),
  uniquement si `previous === undefined || time < previous - 1e-6 ||
  time - previous > SEEK_GAP_SEC` (0,5 s), puis `lastRenderAt.set(ctx, time)`.
  Donc **une seule fois sur la première image après un seek**, jamais à chaque
  image. Le `WeakMap` ne porte que ce marqueur, pas d'état de rendu.
- Hors périmètre déclaré : `.gitignore` (exclusions des artefacts de revue) et
  `tests/metrics/README.md` (documentation). Aucun changement de comportement
  produit ; à garder, mais à mentionner comme écart de forme.

## 4. Vérification indépendante de chaque PR, seule

Chaque branche a été mesurée dans son propre worktree, avec
`bun run test`, `bun run lint`, `bun run typecheck` : **verts** sur les deux.

### #40 — chiffres recalculés (corpus réel de `tools/vague1-report.json`)

| Annonce #40 | Recalcul | Écart |
|---|---:|---:|
| `pont-concert` 9/27 drops (33,3 %) | 9/27 = 33,3 % | 0 |
| familles 33,3 / 40,7 / 25,9 % | 9 pont / 11 lyres / 7 barres = 33,3 / 40,7 / 25,9 % | 0 |
| 18/18 paires diffèrent d'au moins 2 composantes | 18/18 (et 0 paire à 0 ou 1 composante) | 0 |
| climax pont-concert pour ≥ 2 drops, Bolero inclus | 0 violation, Bolero : lyres → barres → **pont** | 0 |
| humeurs / rôles identiques à la vague 1 | `roles`, `moods`, `moodBranches`, `families` identiques | 0 |
| SHA-256 du rapport sur 2 exécutions | `7c04a4a0…67cd6`, identique aux 2 runs **et** au fichier committé | 0 |

Tous les morceaux à ≥ 2 drops ont leur dernier maximum en `pont-concert` ;
les autres impacts alternent lyres/barres sans reprendre la scène précédente.
`bun run test` : 383 tests front + 186 serveur.

### #41 — chiffres recalculés (corpus réel du manifeste, 75 drops)

| Annonce #41 | Recalcul | Verdict |
|---|---:|---|
| Spearman force ↔ pic 0,907 | **0,907** | ✅ |
| pic max 0,2008 | **0,2037** (+1,4 %, phase d'échantillonnage) | ✅ |
| drops ≥ 0,25 : 0/75 | **0/75** | ✅ |
| pics distincts (3 déc.) 52 | **52** | ✅ |
| flashs/s normal : 2/1/1/3/0/1/1/1/1/1 | **identique** (One More Time → TRINITYVILLE) | ✅ |
| pire fenêtre normale 3/s, fenêtres > 3/s : 0 | max **3/s**, 0 fenêtre > 3/s | ✅ |
| largeur min/méd/max 0,333 / 0,467 / 0,967 s | **identique** | ✅ |
| render-purity sans reset du harnais : 672 px, delta 9 | **672 px, delta 9** (128bpm, t = 10,796 s) | ✅ |
| coût du reset +0,10 ms (320×180), ~0 (1280×720) | **non reproductible** : médianes 0,2 ms continu / 0,1 ms seek, résolution du chrono 0,1 ms | ⚠️ mesure dans le bruit |
| part de blanc max en mode réduit : 0,295 → 0,172 | **0,172 avant ET après** ; le lavage était déjà interdit en mode réduit (`if (drop > 0.02 && !reduced)`) | ❌ description |
| flash plein écran en mode réduit : oui → non | déjà « non » avant : `flashAlphaAt` renvoie 0 si `reduced`, lavage gardé par `!reduced` | ❌ description |
| cadence 170 BPM : 4/s avant → 3/s après | **3/s avant ET après** ; en revanche 2 flashs post-drop → **0** après | ❌ description / ✅ effet |

## 5. Tableau des objectifs

Corpus de référence : celui de `tools/vague1-report.json` (6 pistes
synthétiques + 10 réelles, **33 drops**), sauf mention. Les colonnes « Rendu
seule » et la seconde ligne « intégré » portent sur le corpus du manifeste
(10 réelles, **75 drops**), celui qu'a utilisé #41.

| objectif | cible | vague 1 | Scéno seule | Rendu seule | intégré | atteint ? |
|---|---|---|---|---|---|---|
| fenêtres > 3 flashs/s (normal) | 0 (bloquant) | 0 (max 2) | — (rendu inchangé) | 0 (max 3) | **0** (max 2 audio / 3 manifeste) | ✅ |
| flash plein écran (réduit) | 0 (bloquant) | 0 (blanc max 0,172) | — | 0 (blanc max 0,172) | **0** (blanc max 0,172) | ✅ |
| sécurité par famille de drop | 0 dépassement (bloquant) | 26 pont, 1 lyres | — | 0 | **0** sur 3 familles | ✅ |
| corrélation strength / pic (Spearman) | ≥ 0,6 | 0,926 | — | 0,907 | **0,880 audio / 0,902 manifeste** | ✅ |
| plafond commun de saturation | absent | 0,2948, 12 pics distincts, 19/27 ≥ 0,25 | — | 0,2037, 52 pics, 0/75 ≥ 0,25 | **0,2150 audio / 0,2037 manifeste**, 0/75 ≥ 0,25 | ✅ (réserve §5.1) |
| largeur d'impact médiane | 0,15–0,6 s | 0,133 | — | 0,467 | **0,467** | ✅ |
| largeur d'impact min | ≥ 0,08 s | 0,067 | — | 0,333 | **0,300 audio / 0,333 manifeste** | ✅ |
| pont-concert | ≤ 40 % des drops réels | 96,3 % | 33,3 % | — (plan inchangé) | **33,3 % audio / 13,3 % manifeste** | ✅ |
| familles de drop présentes | ≥ 2 | 2 | 3 | 2 | **3** | ✅ |
| climax en pont-concert (≥ 2 drops) | 100 % | — | 100 % (0 violation) | — | **100 %** (0 violation) | ✅ |
| drops consécutifs à signature identique | 0 | 0 | 0 | — | **0** | ✅ |
| paires avec ≥ 2 composantes différentes | ≥ 80 % | — | 18/18 = 100 % | — | **18/18 audio, 65/65 manifeste** | ✅ |
| humeurs / rôles vs vague 1 | identique | référence | identique | — | **identique** | ✅ |
| render-purity sans reset du harnais | 0 px, delta 0 | — | — | 0 px, delta 0 (avec reset du harnais) | **0 px, delta 0** | ✅ |
| déterminisme (SHA-256 ×2) | identique | — | `7c04a4a0…67cd6` ×2 | — | **identique** | ✅ |

### 5.1 Plafond commun absent — liste des maxima par morceau

Corpus manifeste (intégré), du plus clair au plus sombre :

`0,2037` Your Hand in Mine · `0,1865` Gymnopédie · `0,1862` Latch ·
`0,1828` The Blue Danube · `0,1827` They Don't Care About Us · `0,1817`
La Vie en Rose · `0,1815` TRINITYVILLE · `0,1770` One More Time · `0,1761`
Shine On · `0,1708` Bolero.

Aucun plateau unique (les valeurs s'étalent sur 3,3 points, 52 pics distincts
à 3 décimales). **Réserve** : quatre morceaux sans rapport musical
(Gymnopédie, Latch, Blue Danube, They Don't Care) restent dans une bande de
0,5 point (0,1815–0,1865) autour de 0,184. Ce n'est plus un plafond à 0,295,
mais c'est un reliquat de saturation géométrique quand `strength ≈ 1` : le
rayon du disque plafonne avec la force, l'opacité reste constante. À traiter en
vague 3 si l'on veut une hiérarchie de brillance par morceau.

Corpus audio (intégré) : aucun groupe de plus de 2 morceaux dans ±0,5 point.

## 6. Contrôle croisé sécurité par famille (étape 4)

Mesuré sur `reconcile/vague2` (Scéno + Rendu), image 320×180, 30 Hz, corpus
réel complet, modes normal **et** réduit. Les flashs sont des transitions de
luminance moyenne Rec. 709 > 10 % (montée puis descente dans les 0,5 s),
comptées sur fenêtre glissante de 1 s. Le script est
`tools/review/vague2/measure-families.ts`.

### Corpus manifeste — 75 drops réels

| famille | drops | pic max | largeur min–méd–max (s) | pire fenêtre 1 s (flashs/s) | flashs dans 1,5 s post-drop |
|---|---:|---:|---|---:|---:|
| pont-concert | 10 | 0,2037 | 0,400 – 0,500 – 0,933 | 1 | 0 |
| lyres-suspendues | 36 | 0,1827 | 0,433 – 0,467 – 0,567 | 0 | 0 |
| barres-led | 29 | 0,1865 | 0,333 – 0,467 – 0,967 | 1 | 0 |

### Corpus audio de la vague 1 — 27 drops réels

| famille | drops | pic max | largeur min–méd–max (s) | pire fenêtre 1 s (flashs/s) | flashs dans 1,5 s post-drop |
|---|---:|---:|---|---:|---:|
| pont-concert | 9 | 0,2150 | 0,433 – 0,467 – 0,967 | 1 | 0 |
| lyres-suspendues | 11 | 0,1846 | 0,300 – 0,467 – 0,500 | 0 | 0 |
| barres-led | 7 | 0,2007 | 0,467 – 0,467 – 0,500 | 1 | 0 |

**Pire cas chiffré** : 3 flashs/s sur une fenêtre de 1 s (limite WCAG 2.3.1,
pas de dépassement), mesuré **hors drop** — The Blue Danube à 255,2 s
(manifeste) et la piste synthétique 170 BPM à 48,47 s. Dans les fenêtres de
drop, le maximum par famille est **1 flash/s** ; à moins de 1,5 s d'un impact,
**0 flash** sur les 75 drops. Le disque d'impact est une montée de luminance
étalée sur 80 ms, sous le seuil de 10 % par image : il ne crée pas de flash
détectable. Le mode réduit ne dépasse jamais 3/s, ne dessine aucun voile
plein écran et son maximum de part de blanc est **0,172** (< 0,25).

Les trois tempos les plus élevés : **170 BPM synthétique (172,3)**, puis
**Bolero** et **Shine On** (136,0). Fenêtre de 1,5 s post-drop : **0 flash**
partout, y compris sur le 170 BPM (2 flashs avant l'intégration → 0 après).

## 7. Corrections demandées

| PR | fichier | ligne / bloc | raison | bloquant |
|---|---|---|---|---|
| #41 | `tools/review/vague2-rendu/RAPPORT.md` | tableau « mode réduit » | « part de blanc max avant 0,295 » est faux : le lavage était déjà interdit en mode réduit (`render.ts` d'`origin/main`, `if (drop > 0.02 && !reduced)`). Mesure : 0,172 avant **et** après. | non |
| #41 | `tools/review/vague2-rendu/RAPPORT.md` | § « Cadence » | le « 4/s à 170 BPM » n'est pas reproduit : 3/s avant comme après (2 flashs post-drop → 0). Reformuler en « 2 flashs dans la fenêtre post-drop supprimés ». | non |
| #41 | `tools/review/vague2-rendu/RAPPORT.md` | § « Coût du reset » | coût non mesurable au-delà du bruit (0,1 ms de résolution) ; présenter comme « non concluant » plutôt que « +0,10 ms ». | non |
| #41 | description de PR | tableau « avant / après » | mêmes corrections que le rapport, pour ne pas laisser une affirmation de sécurité non reproduite dans l'historique. | non |
| #40 | — | — | aucune correction demandée. | — |
| intégration | `tools/vague2-report.json` | en-tête | le rapport est produit depuis le cache d'analyses audio de la vague 1, non reconstructible depuis le dépôt (audio absents). Documenter le cache utilisé ou régénérer depuis le manifeste. | non |

Aucune correction de seuil, de cadence, de courbe ou de calibrage n'est
demandée : les objectifs produit sont tenus. Aucune revue `--request-changes`
n'est justifiée.

## 8. Conflits rencontrés et résolutions

**Aucun conflit.** Les deux merges `--no-ff` passent avec la stratégie `ort` :

```
c1055e9 merge: #40 scénographie des drops (vague 2)
e392522 merge: #41 rendu de l'impact, flashs sûrs, seek pur (vague 2)
fad21cf chore(review): mesure de sécurité par famille de drop (vague 2)
```

Les périmètres sont réellement disjoints (`show.ts` vs `render.ts`), et #41 ne
suppose aucune famille de drop particulière : le rendu lit `scene.family` sans
branche en dur. Aucun conflit de logique. Les snapshots ne sont **jamais**
résolus à la main : `bun run snapshots:update` après intégration réécrit les
deux fichiers à l'identique de #40 (`git diff feat/vague2-scenographie-drops --
tests/snapshots/` vide).

Vérifications finales sur `reconcile/vague2` : `bun run test` (383 + 186),
`bun run lint`, `bun run typecheck`, `bun run build` et `bun run check:browser`
(« tout est vert ») : **verts**.

## 9. Différences de snapshots, par piste synthétique

Une seule scène change par piste, toujours la scène `drop` de force < 0,98 :
sa famille passe de `pont-concert` à `lyres-suspendues`. Aucune autre clé
(famille, teinte, intensité, signature, durée) ne bouge.

| piste | scène | avant | après |
|---|---:|---|---|
| `128bpm-low` | #3 | pont-concert | lyres-suspendues |
| `128bpm` | #3 | pont-concert | lyres-suspendues |
| `170bpm` | #2 | pont-concert | lyres-suspendues |
| `60bpm` | #2 | pont-concert | lyres-suspendues |
| `90bpm` | #3 | pont-concert | lyres-suspendues |
| `rich` | #1 | pont-concert | lyres-suspendues |

Justification : chaque piste synthétique n'a qu'un drop, de force inférieure au
seuil 0,98, donc il ne prend plus le pont ; la règle « seul le climax » ne
s'applique pas (un seul impact). `corpus-reduced.json` est **inchangé** (le mode
réduit ne déploie pas de famille concert). #41 ne modifie pas le plan : les
snapshots intégrés sont identiques à ceux de #40.

## 10. Inspection visuelle ciblée

`bun run timeline -- --all` exécuté sur la branche intégrée (HTML dans
`/tmp/opencode/timelines/`, 6 pistes synthétiques). Cinq moments suspects,
captures 960×540 avant (`main` = `af2e8eb`) / après (intégré) :

| # | morceau · instant | constat |
|---|---|---|
| 1 | Shine On · 76,10 s (drop force 0,45, lyres) | Avant : impact quasi invisible. Après : disque blanc plein cadre très lumineux alors que la force est faible. Le pic mesuré (0,041) sous-estime l'effet visuel : l'opacité du disque ne dépend pas de la force, seulement son rayon. |
| 2 | One More Time · 78,30 s (hors drop) | Scintillement de faisceaux, max 2 flashs/s. Captures avant/après **identiques** : préexistant, pas une régression de #41. |
| 3 | Gymnopédie · 40,88 s (barres-led, force 1,0) | Le pic le plus haut du corpus (0,1865) appartient à une famille `barres-led`, pas au `pont-concert`. Visuellement, l'orbe blanc + halo magenta est plus agressif que le pont du même morceau. Hiérarchie de brillance incohérente avec la hiérarchie de familles. |
| 4 | La Vie en Rose · 24,25 s (2ᵉ drop, signature à 2 composantes de distance) | Deux drops consécutifs qui se ressemblent encore : même lyres/barres, seuls blinders et teinte changent. La contrainte ≥ 2 composantes est tenue, mais le rendu reste proche. |
| 5 | Shine On · 264,83 s (barres-led, force 0,77) | Pic 0,088 : impact peu lisible malgré une force élevée, alors que des drops à 0,5 font mieux. Le disque est large mais lavé par les faisceaux dessinés par-dessus. |

Chemins des captures (hors git, ~7 Mo) :
`tools/review/vague2/captures/{avant,apres}-{1..5}-*.png`.
Régénération :

```bash
# après (branche intégrée)
OUT_DIR=tools/review/vague2/captures PREFIX=apres bun tools/review/vague2/capture.ts
# avant (main)
git worktree add --detach /tmp/wt-main af2e8eb
cp tests/support/headless_browser.ts tests/support/headless_render.ts /tmp/wt-main/tests/support/
cd /tmp/wt-main && OUT_DIR=…/captures PREFIX=avant bun tools/review/vague2/capture.ts
```

(`capturePng` n'existe dans le harnais qu'après #41 : pour l'« avant », on
copie les deux fichiers de harnais dans le worktree `main`, le rendu reste
celui d'`af2e8eb`.)

### Trois priorités pour la vague 3

1. **Faire dépendre l'opacité du disque de la force**, pas seulement son rayon
   (aujourd'hui un drop à 0,45 a un cœur blanc pur). Cela devrait aussi casser
   le reliquat de plafond commun autour de 0,184 sur quatre morceaux.
2. **Rétablir la hiérarchie des familles** : le `pont-concert` doit rester le
   plus brillant ; une `barres-led` à force 1,0 ne doit pas être le pic du
   corpus.
3. **Unifier le corpus réel** : `tools/vague1-report.json` (33 drops) et
   `tools/baseline-report.json` / #41 (75 drops) ne reposent pas sur les mêmes
   analyses du même manifeste. Tant que deux caches coexistent, les colonnes
   « avant / après » ne sont pas comparables. À figer avant la vague 3.

## Reproductibilité

```bash
bun run test && bun run lint && bun run typecheck
bun run snapshots               # « snapshots à jour »
uv run python tools/real_corpus.py
bun tools/review/vague2/measure-families.ts > tools/review/vague2/securite-familles.json
```

SHA-256 du rapport de plan sur deux exécutions :
`7c04a4a0b2e6e12d2b5a761f4c5bd50c5bbad9c2b12e0850d5b00e6d6be67cd6`.

Artefacts JSON versionnés (petits) : `tools/review/vague2/securite-familles-manifeste.json`,
`…-audio-vague1.json`, `purete-seek.json`, `plan-integration-manifeste.json`,
`plan-scenographie-audio-vague1.json`. Les captures PNG (~7 Mo) sont hors git
(`tools/review/vague2/captures/`, ignoré).
