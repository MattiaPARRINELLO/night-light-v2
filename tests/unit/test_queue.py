from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from server.queue import deezer
from server.queue.models import QueueTrack


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


def test_queue_manager_without_deezer_falls_back_to_mpris(tmp_path, monkeypatch) -> None:
    from dataclasses import replace
    from types import SimpleNamespace

    from server.config import load_settings
    from server.queue.manager import QueueManager

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
