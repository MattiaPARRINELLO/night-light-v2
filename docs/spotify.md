# Spotify et file Deezer

## Spotify (optionnel)

L'API Spotify est désactivée tant que `SPOTIFY_CLIENT_ID` et
`SPOTIFY_REFRESH_TOKEN` sont absents. Dans ce cas le comportement reste celui
d'avant : MPRIS seul.

1. Ouvre <https://developer.spotify.com/dashboard>, crée une application.
2. Ajoute **exactement** cette Redirect URI (remplace le port si `API_PORT`
   diffère) :
   `http://127.0.0.1:8787/api/spotify/callback`.
   `localhost` n'est pas accepté par le flux PKCE de Night Light.
3. Renseigne dans `.env` :
   ```text
   SPOTIFY_CLIENT_ID=...
   SPOTIFY_REDIRECT_URI=http://127.0.0.1:8787/api/spotify/callback
   ```
4. Redémarre le serveur, puis ouvre
   `http://127.0.0.1:8787/api/spotify/login`.
5. Autorise le scope `user-read-playback-state`. Le callback affiche une ligne
   `SPOTIFY_REFRESH_TOKEN=...` à recopier dans `.env`, puis redémarre.

Le refresh token est renouvelé automatiquement. Aucun client secret n'est
utilisé.

### Vérifié / non vérifié

- **Vérifié en test simulé** : construction PKCE, URL d'autorisation sans
  secret, parsing de `/queue` avec ISRC, respect de `Retry-After` sur 429.
- **Non vérifié en réel** : création de l'application Spotify, consentement
  OAuth, disponibilité de `/v1/me/player/queue` selon le compte (Premium ou
  non), comportement de la file en lecture aléatoire. Aucune session Spotify
  réelle n'a été utilisée ici.

## Userscript Deezer

`userscripts/deezer-queue.user.js` (version 1.0.0) envoie le morceau courant et
les deux suivants à `POST /api/deezer-queue` sur `127.0.0.1:8787`.

- Les noms exacts des objets internes Deezer (`dzPlayer`, méthodes de file) ne
  sont **pas vérifiés** : le script sonde plusieurs candidats et journalise les
  clés `window` trouvées dans la console.
- Si aucune file n'est lisible, il envoie l'URL : le serveur retombe sur l'API
  publique Deezer pour une playlist ou un album.
- Flow et radio ne déclenchent aucun préchargement.

Le payload accepté est documenté dans l'en-tête du script.
