# Changelog

Toutes les évolutions notables de ce projet sont consignées ici.
Le format suit [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) et le
projet adhère à [SemVer](https://semver.org/lang/fr/).

## [Non publié]

## [2.0.0]

### Ajouté

- Analyse audio serveur (librosa) : tempo, temps forts, attaques, bandes de
  fréquences, énergie, sections et montées.
- Vingt-deux familles visuelles tournantes, sur trois échelles de renouvellement
  (phrase, variation, dérive).
- Surface de fumée pour des faisceaux diffus, sans effondrement du framerate.
- Palette par morceau, bascule sur la complémentaire aux moments forts.
- Tableau de bord séparé (`/dashboard`), relié à l'écran de show par
  `BroadcastChannel`.
- Synchronisation sur un lecteur externe via MPRIS (`playerctl`), avec repli par
  corrélation d'énergie.
- Capture audio système (PipeWire/PulseAudio) et rendu en direct.
- Récupération d'un morceau par titre/artiste via Deezer (streamrip, opt-in par
  `DEEZER_ARL`).
- Overlay de debug (touche `D`) et journal console catégorisé.

### Modifié

- Le show est une fonction du temps musical (`audio.currentTime`) : aucune
  dérive, y compris après pause, reprise ou saut.

[Non publié]: https://github.com/MattiaPARRINELLO/night-light-v2/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/MattiaPARRINELLO/night-light-v2/releases/tag/v2.0.0
