# Vague 3 — Structure (sections locales, contrat V3.1)

Branche : `feat/sections-vague3`, créée depuis `origin/main` (`dac9766`).
Périmètre : `server/structure.py` (nouveau), le bloc
`# --- vague3:structure ---` de `server/analysis.py`, les tests serveur de
structure, `tests/fixtures/structure_truth.json`, l'outil de mesure
`tools/structure_eval.py`. Aucun fichier `src/**`, aucun `server/meter.py`,
aucun `tests/snapshots/**`, aucun `tools/vague*-report.json` modifié.

## 0. Entrées de référence (vague 2)

- Part des frontières `cycle` dans le rapport vague 2 : **49 / 355 = 13,8 %**
  (`tools/vague2-report.json`, `distributions.reasons`).
- Branches mortes relevées : familles `[]` ; branches de famille `refrain`,
  `montee` ; branches d'humeur `refrain-explosif`, `silence-sombre`,
  `montee-pulse` ; humeurs `sombre` ; raisons `section` ; rôles `refrain`,
  `montee`. La structure locale manquait donc au plan : `refrain` et `montee`
  n'étaient jamais produits.
- Sections par morceau réel, avant / après cette branche (mêmes morceaux que
  `tests/support/real_corpus.json`, 9 disponibles sur 10 — « The Blue Danube »
  n'est plus référencé par Deezer sous cet identifiant) :

| morceau | sections avant | sections après |
|---|---:|---:|
| One More Time | 1 | 16 |
| Bolero | 1 | 1 |
| They Don't Care About Us | 1 | 1 |
| La Vie en Rose | 1 | 10 |
| Gymnopédie No. 1 | 1 | 1 |
| Latch | 1 | 14 |
| Your Hand in Mine | 1 | 21 |
| Shine On You Crazy Diamond | 1 | 61 |
| TRINITYVILLE | 1 | 1 |

## 1. Contrat V3.1 — ce qui est livré

Champs **ajoutés** aux sections, tous optionnels côté client :

- `kind` : `intro` | `couplet` | `refrain` | `pont` | `silence` | `outro` ;
- `group` : chaîne (`A`, `B`, … `Z`, `AA`…) — même valeur = même matériau ;
- `confidence` : 0..1.

Champs historiques **inchangés** (format et sémantique) : `start`, `end`,
`label`, `energy`, `occurrence`. `meter` reste un entier, `beats`, `builds`,
courbes de bandes : intacts. **`ANALYZER_VERSION` n'est pas bumpé** (il reste
`"4"`) : le passage à `"5"` est réservé à la réconciliation, comme demandé.

Câblage : un seul appel, dans le bloc balisé de `analysis.py` :

```python
# --- vague3:structure ---
sections = detect_structure(...)
# --- /vague3:structure ---
```

`server/structure.py` reçoit le spectre déjà calculé (`spectrum`), les temps
forts, la métrique, les points d'énergie et l'audio. Il ne relit jamais le
fichier et ne refait pas de STFT.

## 2. Méthode

1. **Grille de mesures** : `beats[::meter]`, bornée par 0 et la durée ; repli
   régulier si moins de deux mesures exploitables.
2. **Descripteurs par mesure** : chroma `chroma_stft` (`tuning=0.0`, pour ne
   pas payer `estimate_tuning`/`piptrack`) et MFCC 13 depuis le mel-spectrogram
   du spectre existant. Le chroma décrit l'harmonie, le MFCC le timbre —
   indispensable sur les morceaux bâtis sur une boucle d'accords unique.
3. **Autosimilarité** : `0,4 × cosinus(chroma) + 0,6 × exp(−d_MFCC / échelle)`,
   l'échelle étant la distance MFCC médiane **entre sections** du morceau.
4. **Nouveauté** : noyau en damier gaussien de demi-largeur 3 mesures ; pics
   au-dessus de `moyenne + 0,7·écart-type`, espacés d'au moins 4 mesures,
   recalés sur les débuts de mesure.
5. **Durées minimales** : 4 s par section, 1,5 s pour un silence ; fusion des
   sections trop courtes.
6. **Groupes** : agglomératif à liaison moyenne, seuil 0,62. Les groupes sont
   nommés dans l'ordre de première apparition.
7. **Étiquetage**
   - **silence** : RMS **brut** sous 2 % du 95ᵉ centile pendant ≥ 1,5 s, à
     l'intérieur du morceau (les silences de fin de piste ne sont pas des
     sections musicales) ;
   - **refrain** : groupe répété (≥ 2 occurrences **et** ≥ 2 blocs contigus
     distincts), cohérent (similarité intra ≥ 0,60), le plus énergique, et dont
     au moins un retour suit un contraste réel d'énergie (≤ 88 % de la moyenne
     du refrain) ;
   - **pont** : section unique, immédiatement après un refrain, de similarité
     < 0,6 avec lui ;
   - **intro / outro** : première / dernière section, sous l'énergie médiane,
     hors groupe de refrain ;
   - **couplet** : tout le reste.
8. **Confiance** : netteté de la frontière d'entrée × cohérence du groupe,
   bornée à [0, 1].

**Choix assumé** : si aucun refrain, pont ni silence n'est détecté, le morceau
reste **une section unique** (`couplet`, confiance 0,5) au lieu de publier des
frontières de couplet hasardeuses — c'est exactement le constat de la vague 2.
C'est ce qui préserve les snapshots synthétiques sans les modifier.

## 3. Conformité au contrat (automatique)

`tools/structure_eval.py` valide chaque sortie : couverture `[0, durée]` sans
trou ni chevauchement, tri, durées minimales, `kind` dans l'énumération,
`group` textuel, `confidence` bornée, au plus une intro (en tête) et une outro
(en fin). Sur les 8 morceaux annotés : **0 violation**. Les tests unitaires
font de même sur les pistes synthétiques.

## 4. Vérité terrain et résultats

`tests/fixtures/structure_truth.json` : 8 morceaux réels, genres différents,
dont **un rap** (TRINITYVILLE), **un 3/4** (La Vie en Rose, également
Gymnopédie en 3), et **trois morceaux sans refrain clair** (Gymnopédie,
Bolero, TRINITYVILLE). Tolérance ±2 s sur les débuts de refrain.

**Méthode d'annotation — limite à connaître** : je n'ai pas d'oreilles. Les
timestamps viennent de la structure publiée/connue des morceaux, vérifiés sur
les courbes d'énergie, de bandes et les ruptures de timbre de l'audio réel.
Ce n'est **pas** une écoute humaine. Le risque de circularité est réel
(les blocs de refrain détectés ont servi à confirmer les timestamps) ; il est
signalé dans `doutes` pour chaque morceau et repris au §7.

| morceau | attendu (s) | détecté (s) | écart |
|---|---|---|---|
| One More Time | 31,4 · 215,5 | 31,4 · 215,5 | 0,0 / 0,0 |
| Bolero | — | — | — |
| They Don't Care About Us | 0,0 · 53,4 · 114,4 | — | 3 manqués |
| La Vie en Rose | 27,9 · 119,9 · 171,1 | 27,9 · 119,9 · 171,1 | 0,0 / 0,0 / 0,0 |
| Gymnopédie No. 1 | — | — | — |
| Latch | 96,6 · 128,1 · 206,8 | 96,6 · 128,1 · 173,3 · 206,8 | 0,0 / 0,0 / **+44,9** / 0,0 |
| Your Hand in Mine | 73,8 · 187,3 · 374,9 · 438,4 | 73,8 · 187,3 · 374,9 · 438,4 | ≈0 partout |
| TRINITYVILLE | — | — | — |

| objectif | cible | mesuré | atteint |
|---|---|---:|---|
| précision des débuts de refrain (±2 s) | ≥ 70 % | **92,3 %** (12/13) | ✅ |
| rappel des débuts de refrain | ≥ 60 % | **80,0 %** (12/15) | ✅ |
| faux refrain sur morceau sans refrain | 0 | **0** (3 morceaux) | ✅ |
| silence détecté là où l'annotation en contient | ≥ 1 | **0 / 0** sur le réel, **1 / 1** sur la fixture synthétique `f_silence_milieu` | ⚠️ voir §7 |
| silence sur morceau sans pause | 0 | **0** (8/8) | ✅ |
| conformité contrat | 100 % | **100 %** (8/8) | ✅ |
| déterminisme (2 analyses) | identique | **identique** (sections JSON + beats + builds) | ✅ |

Le rappel de « They Don't Care About Us » est nul : le refrain d'ouverture est
fondu dans l'intro et les deux retours partagent le groupe du couplet
(même boucle, même timbre). C'est le principal échec à corriger en vague 4.

## 5. Temps d'analyse

Mesuré dans le même processus, worker préchauffé, deux passes par morceau
(seconde passe retenue), avec la structure désactivée puis activée :

| morceau | avant | après | écart |
|---|---:|---:|---:|
| One More Time | 0,98 s | 1,06 s | +8,0 % |
| Bolero | 1,47 s | 1,62 s | +10,3 % |
| They Don't Care About Us | 0,68 s | 0,68 s | −0,6 % |
| La Vie en Rose | 0,56 s | 0,58 s | +3,4 % |
| Gymnopédie No. 1 | 0,71 s | 0,74 s | +3,8 % |
| Latch | 0,85 s | 1,09 s | +28,0 % |
| Your Hand in Mine | 1,54 s | 1,65 s | +7,2 % |
| Shine On | 2,43 s | 2,82 s | +15,9 % |
| TRINITYVILLE | 0,63 s | 0,72 s | +14,0 % |

Médiane ≈ +8 %, **maximum +28 %** (< 30 %). La mesure est bruitée de quelques
points ; le poste dominant est le chroma/MFCC, pas le regroupement. Aucune
dépendance ajoutée : `numpy` et `librosa` (déjà requis), `scipy` n'est pas
importé.

## 6. Compatibilité et intégration

- **Analyse version 4** : `src/**` n'est pas touché. Un test
  (`tests/unit/analysis-v4-compat.test.ts`) fige l'empreinte SHA-256 du plan
  produit par une analyse v4 sans `kind`/`group`/`confidence` :
  `ec970395…e73791`.
- **Snapshots synthétiques** : vérifiés sur un corpus `/tmp` **régénéré**
  (pas seulement en cache) — `bun test tests/unit/plan-snapshot.test.ts` :
  6/6. La politique « une seule section sans refrain/pont/silence » est ce qui
  garantit l'invariance.
- **Propriétés du plan** : `plan-properties.test.ts` 85/85 après régénération.
- **Version** : `ANALYZER_VERSION` reste `"4"`. Le bump `4 → 5` est laissé à la
  réconciliation ; il invalidera le cache d'analyse une seule fois.

## 7. Doutes et limites (honnêtes)

1. **Annotation sans écoute.** C'est la limite principale. Les huit morceaux
   ont des timestamps cohérents avec leurs courbes, mais je ne peux pas jurer
   qu'un chorus commence à 53,4 s plutôt qu'à 55 s. Les `doutes` du fichier de
   vérité le disent morceau par morceau.
2. **Circularité partielle.** Les timestamps de Latch et de Your Hand in Mine
   ont été confirmés sur les blocs détectés. Les métriques 92 %/80 % sont donc
   optimistes ; un annotateur humain indépendant les ferait probablement
   baisser.
3. **Aucun silence réel annoté.** Aucun des 8 morceaux n'a de pause intérieure
   (les seuls passages sous le seuil sont des fins de piste, exclues). L'objectif
   « au moins un silence détecté » est couvert par la fixture synthétique
   `f_silence_milieu` (15–25 s), pas par le corpus réel. Je ne l'ai pas maquillé
   avec une annotation inventée.
4. **They Don't Care About Us** : refrain non détecté (0/3). Le chœur d'enfants
   d'ouverture et les retours partagent le timbre du couplet.
5. **Post-rock** : qualifier le thème repris de Your Hand in Mine de « refrain »
   est une convention. Sans elle, ce serait 4 faux refrains.
6. **Bolero / Gymnopédie / TRINITYVILLE** : aucune section locale publiée
   (une seule section). C'est volontaire (pas de refrain/pont/silence fiable),
   mais cela prive le plan de repères de couplet sur ces morceaux.
7. **The Blue Danube** absent : l'identifiant Deezer `63812742` n'est plus
   retourné par la recherche. Le 3/4 est couvert par La Vie en Rose et
   Gymnopédie.

## 8. Reproduction

```bash
uv sync && bun install
bun run typecheck && bun run lint
bun test tests/ && uv run pytest tests/ -q
uv run python tools/structure_eval.py          # nécessite le cache audio réel
uv run python tools/structure_eval.py --json > tools/review/vague3-structure.json
```

Le cookie Deezer (`DEEZER_ARL`) n'est jamais lu, affiché ni versionné par ces
commandes : elles ne font que lire le cache audio existant.
