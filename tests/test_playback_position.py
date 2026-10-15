from unittest.mock import patch

import server.playback_position as pp
from server.playback_position import (
    get_playback_state,
    match_playback,
    normalize_text,
)


def test_normalize_text_strips_accents_and_versions() -> None:
    assert (
        normalize_text("Daft Punk — Get Lucky (feat. Pharrell) [Remastered]")
        == "daft punk get lucky"
    )


def test_match_accepts_title_and_duration() -> None:
    state = pp.PlaybackState(
        source="mpris",
        available=True,
        title="Get Lucky",
        artist="Daft Punk",
        status="playing",
        position_ms=1000,
        duration_ms=240000,
        captured_at=0.0,
    )
    result = match_playback(state, title="Get Lucky", artist="Daft Punk", duration_sec=239.0)
    assert result["accepted"] is True


def test_get_playback_state_none_without_playerctl() -> None:
    with patch.object(pp, "_playerctl_available", return_value=False):
        state = get_playback_state(title="x", artist="y")
    assert state.source == "none"
    assert state.status == "stopped"


def test_choose_prefers_playing_player() -> None:
    with (
        patch.object(pp, "_playerctl_available", return_value=True),
        patch.object(pp, "_list_players", return_value=["dead", "live"]),
        patch.object(
            pp,
            "_metadata_for",
            side_effect=lambda p: {
                "dead": {
                    "status": "paused",
                    "title": "Song",
                    "artist": "A",
                    "album": "",
                    "duration_ms": 1000,
                    "position_sec": 0.0,
                },
                "live": {
                    "status": "playing",
                    "title": "Song",
                    "artist": "A",
                    "album": "",
                    "duration_ms": 1000,
                    "position_sec": 1.0,
                },
            }[p],
        ),
    ):
        state = get_playback_state(title="Song", artist="A")
    assert state.source == "mpris"
    assert state.status == "playing"
    assert state.position_ms == 1000


def test_text_similarity_handles_accents() -> None:
    assert pp.text_similarity("Café", "cafe") == 1.0
