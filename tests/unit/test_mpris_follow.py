import sys
import threading
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from server import main, mpris


def test_publish_notifies_sse_subscribers_and_listeners() -> None:
    subscriber = mpris.subscribe_now_playing()
    seen: list[mpris.NowPlaying] = []
    mpris.add_now_playing_listener(seen.append)
    try:
        mpris._publish(mpris.NowPlaying(available=True, title="Neon", artist="Sky"))
        payload = subscriber.get(timeout=1.0)
        assert payload["title"] == "Neon"
        assert seen[-1].artist == "Sky"
    finally:
        mpris.unsubscribe_now_playing(subscriber)
        mpris.remove_now_playing_listener(seen.append)


def test_cancellation_stops_analysis_when_mpris_changes() -> None:
    state = SimpleNamespace(
        now_playing_key="Titre A|Artiste", _same_track=main.AppState._same_track
    )
    should_cancel = main.AppState._cancellation_check(state, "Titre A|Artiste")
    assert should_cancel(0.2) is False
    state.now_playing_key = "Titre B|Artiste"
    assert should_cancel(0.2) is True
    # Au-delà de 80 %, on laisse finir pour alimenter le cache d'analyse.
    assert should_cancel(0.85) is False


def test_cancellation_ignores_unrelated_manual_analysis() -> None:
    state = SimpleNamespace(
        now_playing_key="Titre A|Artiste", _same_track=main.AppState._same_track
    )
    should_cancel = main.AppState._cancellation_check(state, "Autre|Morceau")
    state.now_playing_key = "Titre B|Artiste"
    assert should_cancel(0.1) is False


def test_parse_info_reads_the_deezer_track_from_the_mpris_url() -> None:
    info = mpris._parse_info(
        "deezer|Playing|Σ. MOROSE (LIVE)||QALF (Live)|703033333|https://www.deezer.com/track/3152150703"
    )
    assert info["player"] == "deezer"
    assert info["title"] == "Σ. MOROSE (LIVE)"
    assert info["duration_sec"] == 703.033333
    assert info["deezer_id"] == "3152150703"


def test_parse_info_ignores_local_tracks_and_other_players() -> None:
    local = mpris._parse_info(
        "deezer|Playing|Titre|Artiste|Album|200000000|https://www.deezer.com/track/-3152150703"
    )
    assert local["deezer_id"] == ""
    youtube = mpris._parse_info(
        "chromium|Playing|Titre|Artiste|Album|200000000|https://music.youtube.com/watch?v=abc"
    )
    assert youtube["deezer_id"] == ""
    # Une ligne sans URL (ancien format) ne casse pas l'analyse.
    assert mpris._parse_info("deezer|Playing|Titre|||200000000")["deezer_id"] == ""


class _FakeFollowProcess:
    """Processus `playerctl --follow` qui débite des lignes puis s'arrête."""

    def __init__(self, lines: list[str]) -> None:
        self.stdout = iter(lines)
        self._alive = True

    def poll(self) -> int | None:
        return None if self._alive else 0

    def terminate(self) -> None:
        self._alive = False

    def wait(self, timeout: float | None = None) -> int:
        self._alive = False
        return 0


def test_follow_ignore_les_metadonnees_des_autres_lecteurs(monkeypatch) -> None:
    """Un onglet Chromium ne doit pas se faire passer pour le morceau suivi."""
    deezer = mpris.NowPlaying(
        available=True,
        player="deezer",
        status="playing",
        title="Les sirènes",
        artist="Lili Poe",
    )
    lines = [
        "chromium|Paused|night-light-v2 / Startup Calibration|",
        "deezer|Playing|Les sirènes|Lili Poe",
    ]
    published: list[mpris.NowPlaying] = []
    # Un test précédent a pu arrêter le moniteur global : `_follow_once` lit
    # `_STOP` et ignorerait toutes les lignes.
    monkeypatch.setattr(mpris, "_STOP", threading.Event())
    monkeypatch.setattr(mpris.subprocess, "Popen", lambda *a, **k: _FakeFollowProcess(lines))
    # Le lecteur réélu reste Deezer : aucune republication pour l'onglet.
    monkeypatch.setattr(mpris, "_snapshot", lambda previous: deezer)
    monkeypatch.setattr(mpris, "_position_for", lambda player: 12.0)
    monkeypatch.setattr(mpris, "_publish", published.append)

    mpris._follow_once(deezer)

    assert all(state.player == "deezer" for state in published)
    assert all("Calibration" not in state.title for state in published)
    assert published[-1].position_sec == 12.0


def test_follow_republie_quand_un_autre_lecteur_prend_la_main(monkeypatch) -> None:
    deezer = mpris.NowPlaying(
        available=True, player="deezer", status="paused", title="Ancien morceau"
    )
    chromium = mpris.NowPlaying(
        available=True,
        player="chromium",
        status="playing",
        title="Nouvelle vidéo",
        artist="Chaîne",
    )
    lines = ["chromium|Playing|Nouvelle vidéo|Chaîne"]
    published: list[mpris.NowPlaying] = []
    # Premier instantané : Deezer. Réélection sur l'événement Chromium : il joue.
    snapshots = iter([deezer, chromium])
    monkeypatch.setattr(mpris, "_STOP", threading.Event())
    monkeypatch.setattr(mpris.subprocess, "Popen", lambda *a, **k: _FakeFollowProcess(lines))
    monkeypatch.setattr(mpris, "_snapshot", lambda previous: next(snapshots))
    monkeypatch.setattr(mpris, "_position_for", lambda player: 0.0)
    monkeypatch.setattr(mpris, "_publish", published.append)

    mpris._follow_once(deezer)

    assert published[0].player == "deezer"
    assert published[-1].player == "chromium"
    assert published[-1].title == "Nouvelle vidéo"
