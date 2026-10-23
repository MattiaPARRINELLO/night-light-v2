from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from server.queue import deezer
from server.queue.models import QueueTrack
from server.queue.spotify import SpotifyConfig, SpotifyQueueProvider, pkce_pair


def test_queue_track_key_prefers_deezer_then_isrc() -> None:
    assert QueueTrack(source="deezer", deezer_id="42", title="X").key == "deezer:42"
    assert QueueTrack(source="spotify", isrc="FR123", title="X").key == "isrc:FR123"
    assert QueueTrack(source="mpris", title="X", artist="Y").key == "text:x|y"


def test_deezer_id_skips_search_and_isrc_is_used(monkeypatch) -> None:
    direct = deezer.lookup_for_queue_track(
        QueueTrack(source="spotify", deezer_id="99", title="T", artist="A")
    )
    assert direct.method == "deezer_id"
    assert direct.candidate is not None and direct.candidate.source_id == "99"

    monkeypatch.setattr(
        deezer,
        "_get_json",
        lambda url, timeout=8.0: {
            "id": 123,
            "title": "Titre",
            "duration": 200,
            "artist": {"name": "Art"},
        },
    )
    by_isrc = deezer.lookup_for_queue_track(
        QueueTrack(source="spotify", isrc="FR123", title="T", artist="A", duration_ms=200_000)
    )
    assert by_isrc.method == "isrc"
    assert by_isrc.candidate is not None and by_isrc.candidate.source_id == "123"


def test_isrc_duration_mismatch_falls_back_to_search(monkeypatch) -> None:
    monkeypatch.setattr(
        deezer,
        "_get_json",
        lambda url, timeout=8.0: {
            "id": 123,
            "title": "Titre",
            "duration": 300,
            "artist": {"name": "Art"},
        },
    )
    lookup = deezer.lookup_for_queue_track(
        QueueTrack(source="spotify", isrc="FR123", title="T", artist="A", duration_ms=200_000)
    )
    assert lookup.candidate is None
    assert lookup.method == "search"


def test_isrc_missing_falls_back_to_search(monkeypatch) -> None:
    monkeypatch.setattr(deezer, "_get_json", lambda url, timeout=8.0: {"error": {"code": 800}})
    lookup = deezer.lookup_for_queue_track(
        QueueTrack(source="spotify", isrc="FR000", title="T", artist="A")
    )
    assert lookup.candidate is None and lookup.method == "search"


def test_spotify_queue_parses_isrc_and_next(monkeypatch) -> None:
    provider = SpotifyQueueProvider(
        SpotifyConfig(client_id="id", refresh_token="refresh", redirect_uri="http://127.0.0.1:8787/cb")
    )
    monkeypatch.setattr(provider, "_token", lambda: "token")
    queue = {
        "currently_playing": {
            "id": "s1",
            "name": "Current",
            "artists": [{"name": "A"}],
            "duration_ms": 1000,
            "external_ids": {"isrc": "FR111"},
        },
        "queue": [
            {
                "id": "s2",
                "name": "Next",
                "artists": [{"name": "B"}],
                "duration_ms": 2000,
                "external_ids": {"isrc": "FR222"},
            },
            {"id": "s3", "name": "Later", "artists": [{"name": "C"}], "duration_ms": 3000},
        ],
    }
    monkeypatch.setattr(provider, "_get", lambda path: queue if "queue" in path else None)
    snapshot = provider.refresh_snapshot()
    assert snapshot.current is not None and snapshot.current.isrc == "FR111"
    assert [track.title for track in snapshot.next] == ["Next", "Later"]
    assert snapshot.next[0].isrc == "FR222"


def test_spotify_authorization_url_uses_pkce_and_loopback() -> None:
    provider = SpotifyQueueProvider(
        SpotifyConfig(
            client_id="client",
            refresh_token="refresh",
            redirect_uri="http://127.0.0.1:8787/api/spotify/callback",
        )
    )
    verifier, _challenge = pkce_pair()
    url = provider.authorization_url("state", verifier)
    assert "code_challenge_method=S256" in url
    assert "code_challenge=" in url
    assert "127.0.0.1" in url
    assert "client_secret" not in url


def test_deezer_queue_endpoint_accepts_userscript_payload(tmp_path, monkeypatch) -> None:
    from dataclasses import replace

    from fastapi.testclient import TestClient

    from server import main

    previous_state = main.state
    previous_settings = main.settings
    main.settings = replace(
        previous_settings,
        session_dir=str(tmp_path / "night-light-sessions"),
        cache_dir=str(tmp_path / "cache"),
    )
    main.state = main.AppState(main.settings)
    try:
        with TestClient(main.app) as client:
            response = client.post(
                "/api/deezer-queue",
                json={
                    "current": {"deezerId": "1", "title": "A", "artist": "B", "durationMs": 1000},
                    "next": [{"deezerId": "2", "title": "C", "artist": "D", "durationMs": 2000}],
                },
            )
            assert response.status_code == 200
            status = client.get("/api/queue").json()
            assert status["provider"] == "deezer_userscript"
            assert status["current"]["title"] == "A"
    finally:
        main.state.executor.shutdown(wait=False)
        main.state = previous_state
        main.settings = previous_settings


def test_queue_manager_without_spotify_falls_back_to_mpris(tmp_path, monkeypatch) -> None:
    from dataclasses import replace
    from types import SimpleNamespace

    from server.config import load_settings
    from server.queue.manager import QueueManager

    monkeypatch.delenv("SPOTIFY_CLIENT_ID", raising=False)
    monkeypatch.delenv("SPOTIFY_REFRESH_TOKEN", raising=False)
    settings = replace(
        load_settings(),
        session_dir=str(tmp_path / "night-light-sessions"),
        cache_dir=str(tmp_path / "cache"),
        deezer_arl="",
    )
    state = SimpleNamespace(
        now_playing_key="Titre|Artiste",
        resolve_pending=False,
        active_analyses=0,
        analysis_cache=None,
    )
    manager = QueueManager(settings, state)
    snapshot = manager.refresh()
    assert snapshot.provider == "mpris"
    assert snapshot.current is not None and snapshot.current.title == "Titre"


def test_preselected_candidate_skips_search(tmp_path) -> None:
    import shutil

    from server.retrieve.cache import AudioCache
    from server.retrieve.match import MatchThresholds
    from server.retrieve.models import Candidate, TrackQuery
    from server.retrieve.resolver import resolve_track
    from tests.support.make_fixture import write_synthetic_track

    source = tmp_path / "source.wav"
    write_synthetic_track(source, duration=3.0)

    class Provider:
        name = "deezer"
        thresholds = MatchThresholds()

        def search(self, query):
            raise AssertionError("la recherche ne doit pas être appelée")

        def download(self, candidate, destination):
            target = destination / "audio.wav"
            shutil.copyfile(source, target)
            return target

    cache = AudioCache(tmp_path / "cache")
    query = TrackQuery(title="Titre", artist="Artiste", duration_sec=3.0)
    candidate = Candidate(
        provider="deezer", source_id="123", title="Titre", artist="Artiste", duration_sec=3.0
    )
    result = resolve_track(query, Provider(), cache, preselected=[candidate])
    assert result.timings.search_sec == 0.0
    assert result.candidate.source_id == "123"
