import sys
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
        "Playing|Σ. MOROSE (LIVE)||QALF (Live|703033333|https://www.deezer.com/track/3152150703"
    )
    assert info["title"] == "Σ. MOROSE (LIVE)"
    assert info["duration_sec"] == 703.033333
    assert info["deezer_id"] == "3152150703"


def test_parse_info_ignores_local_tracks_and_other_players() -> None:
    local = mpris._parse_info(
        "Playing|Titre|Artiste|Album|200000000|https://www.deezer.com/track/-3152150703"
    )
    assert local["deezer_id"] == ""
    youtube = mpris._parse_info(
        "Playing|Titre|Artiste|Album|200000000|https://music.youtube.com/watch?v=abc"
    )
    assert youtube["deezer_id"] == ""
    # Une ligne sans URL (ancien format) ne casse pas l'analyse.
    assert mpris._parse_info("Playing|Titre|||200000000")["deezer_id"] == ""
