# Vague 3 — Métrique et retour de basse

Agent Métrique. Contrat appliqué : **V3.1** (amendement du 2026-10-28), qui
remplace la section « CONTRAT » du prompt V3 pour le socle `main` `dac9766`.

## Constat de départ

Le constat de la vague 0 cité par le contrat — **« Latch et Shine On détectés
3/4 (réel 4/4), La Vie en Rose détecté 4/4 (réel 3/4) »** — reste la référence.
Sur le socle de cette branche, le correctif de métrique déjà fusionné
(`1ee1398`) a corrigé Latch et Your Hand in Mine ; restaient faux :

- **Shine On You Crazy Diamond** : 3/4 détecté, 4/4 réel ;
- **La Vie en Rose** : 4/4 détecté, 3/4 réel ;
- **Bolero** : 4/4 détecté, 3/4 réel (cas supplémentaire, objectif 100 %).

Le constat est confirmé sur le corpus réel le 2026-10-28, avec les analyses
du cache audio local (voir le tableau « avant » ci-dessous).

## Amendement V3.1 — décisions d'implémentation

- `meter` reste un `int` (3 ou 4) : aucun champ existant n'est renommé, retypé
  ni supprimé.
- Nouveaux champs additifs : `meterConfidence` (0..1) et `events`
  (`[{t, kind: "bass-return", strength}]`, tableau vide si rien).
- `sections[i].kind/group/confidence` sont laissés à l'agent Structure : le
  socle de cette branche ne les produit pas encore.
- `ANALYZER_VERSION` **n'est pas bumpé** (consigne V3.1) : le passage `"4"` →
  `"5"` est réservé à la réconciliation, pour ne pas invalider le cache deux
  fois. Conséquence assumée : tant que la réconciliation n'a pas bumpé, une
  entrée de cache `"4"` antérieure peut être servie sans `meterConfidence` ni
  `events` ; le client les traite comme optionnels.
- Aucun `src/**` touché, aucune modification de `server/structure.py`, des
  beats ni des builds.

## Méthode métrique (`server/meter.py`)

Deux hypothèses, 3 ou 4 temps par mesure. Trois preuves, dans cet ordre :

1. **Accentuation de la basse sur le premier temps** : énergie 20–150 Hz
   moyennée par temps, contraste de phase (`fold`) entre la phase la plus
   forte et les autres, à 3 et 4 temps. Pour couvrir les valses dont le tempo
   est suivi au double, on regarde aussi le pic d'autocorrélation au lag 6.
2. **Profil de valse acoustique** : les bandes médium et aigu s'accordent sur
   3 temps avec une marge minimale, et la basse ne contredit pas. Ce chemin
   rattrape La Vie en Rose, dont la basse est peu accentuée, sans accepter
   Shine On (sa basse est plus périodique sur 4 que sur 3).
3. **Période dominante de la basse** (repli) : autocorrélation continue de la
   bande basse, rapportée au temps médian. Ce repli récupère les valses dont
   la grille de tempo ne porte aucune accentuation exploitable (Blue Danube),
   avec essai de l'octave de tempo (99 BPM suivis au lieu de 172). Le pic doit
   être le plus fort de l'autocorrélation, pour ne pas prendre un motif de
   3 temps isolé dans un 4/4 pour une mesure.

La grille d'accents est moyennée sur ±50 ms : le retard de groupe de la STFT
(~46 ms) faisait basculer Shine On de 4/4 à 3/4 selon l'alignement. Sous 0,6
de confiance ternaire, repli 4/4. Toutes les opérations sont déterministes.

## Tableau par morceau

Confiance = `meterConfidence` après. « Avant » = métrique du socle `dac9766`
(mesure réelle sur le cache audio, ou analyse sauvegardée pour Blue Danube).

| Morceau | Métrique réelle | Avant | Après | Confiance |
|---|---:|---:|---:|---:|
| One More Time | 4 | 4 | **4** | 0,67 |
| Bolero | 3 | 4 | **3** | 0,74 |
| They Don't Care About Us | 4 | 4 | **4** | 0,92 |
| The Blue Danube, Op. 314 | 3 | 3 | **3**¹ | 0,98–1,00¹ |
| La Vie en Rose | 3 | 4 | **3** | 0,67 |
| Gymnopédie No. 1 | 3 | 3 | **3** | 0,87 |
| Latch | 4 | 4 | **4** | 0,75 |
| Your Hand in Mine | 4 | 4 | **4** | 0,60 |
| Shine On You Crazy Diamond | 4 | 3 | **4** | 0,67 |
| TRINITYVILLE | 4 | 4 | **4** | 1,00 |

¹ L'identifiant Deezer `63812742` n'est plus présent au catalogue : l'audio
original est absent du cache local. La métrique a été validée sur **trois
autres enregistrements de la même valse** (City of Prague 3/4, Wiener
Philharmoniker 3/4, Arthur Fiedler 3/4), tous à 3 avec une confiance ≥ 0,98.
Les features de l'analyse sauvegardée de l'original donnent également 3.

**Bilan : 10/10 attendus, dont 9 mesurés directement ; les 3 cas connus
(Latch, Shine On, La Vie en Rose) sont corrects.** Aucun 4/4 du corpus n'est
basculé en 3/4.

## Retours de basse

Détection : énergie < 60 Hz par temps, moyenne glissante sur une mesure pour
l'absence, puis première attaque nette qui atteint le niveau « présent » dans
la mesure suivante. Absence minimale de 2 mesures, seuil relatif au morceau
(quantiles 10/90), plancher de sous-grave (ratio sous-grave / total ≥ 3 %)
pour écarter les orchestres sans basse électronique. Force = contraste
avant/après normalisé. Espacement minimal 8 s, aucun événement à moins de 2 s
d'une fin de montée.

| Morceau | Retours (`t` en s, force) |
|---|---|
| One More Time | 257,463 (0,45) |
| Bolero | — |
| They Don't Care About Us | — |
| The Blue Danube, Op. 314 | — (audio absent) |
| La Vie en Rose | — |
| Gymnopédie No. 1 | — |
| Latch | — |
| Your Hand in Mine | 42,516 (0,71) |
| Shine On You Crazy Diamond | 164,003 (0,62) · 205,473 (1,00) · 359,352 (0,99) · 383,524 (1,00) · 453,741 (1,00) · 521,149 (1,00) |
| TRINITYVILLE | 177,145 (0,58) |

Vérifications : **TRINITYVILLE (rap) a 1 retour** ; **Bolero et Gymnopédie
(orchestre sans basse électronique) ont 0 retour** ; aucun événement à moins
de 2 s d'une fin de montée ; espacement ≥ 8 s respecté partout.

## Déterminisme et performance

- Analyse de TRINITYVILLE sérialisée deux fois : SHA-256
  `451f991a163bb54f2fbf3dfb530ef7160b10c64a7d55cfb374f9a418d50060a6`
  identique sur deux exécutions (hors `phase_timings`, comme le test existant).
- Temps à chaud (2e passage, même machine, cache audio local) :

| Morceau | Avant | Après | Écart |
|---|---:|---:|---:|
| Shine On | 2,56 s | 2,46 s | −4 % |
| One More Time | 1,07 s | 1,03 s | −4 % |
| TRINITYVILLE | 0,67 s | 0,65 s | −3 % |

Aucun surcoût mesurable (bien sous le plafond de +15 %).

## Tests

- `uv run pytest -q` : **203 passed**.
- `uv run ruff check .` et `bun run lint` : OK.
- `bun run typecheck` : OK.
- Nouveaux tests : `tests/unit/test_meter_module.py`,
  `tests/unit/test_bass_return.py` ; fixture `tests/fixtures/meter_truth.json`.
- Corpus synthétique ajouté : **3 valses 3/4 réelles** (90, 120, 150 BPM)
  détectées 3/4 et **1 6/8** (120 BPM) documenté en repli 4/4, conformément au
  contrat (« 3 ou repli documenté »).
- Un `AnalysisResult` construit sans `meter_confidence` ni `events` conserve
  les valeurs par défaut (`0.6`, `[]`) : les producteurs et consommateurs
  anciens continuent de fonctionner.

## Fichiers

- `server/meter.py` (nouveau) : métrique, repli de période, retours de basse.
- `server/analysis.py` : bloc balisé `# --- vague3:metrique ---`, deux champs
  additifs dans `AnalysisResult`, retour associé.
- `server/main.py`, `scripts/analyze_corpus.py`, `tests/support/make_corpus.py`,
  `tools/real_corpus.py` : sérialisation de `meterConfidence` et `events`.
- `tests/unit/test_meter_module.py`, `tests/unit/test_bass_return.py`,
  `tests/fixtures/meter_truth.json`, `tests/support/make_fixture.py`
  (`write_meter_track`).

## Reproductibilité

```bash
uv run pytest -q
uv run ruff check .
bun run typecheck && bun run lint

# Corpus réel (cookie dans .env local, jamais exposé) :
uv run python tools/real_corpus.py
```

Le cache d'analyse n'est pas invalidé manuellement : le bump de version sera
fait une seule fois par la réconciliation.
