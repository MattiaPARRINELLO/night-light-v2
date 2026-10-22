import sys
import time
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import pytest
from fastapi.testclient import TestClient

from server import main
from server.retrieve.models import Candidate, TrackQuery
from server.retrieve.resolver import RetrievalResult, RetrievalTimings
from tests.support.make_fixture import write_synthetic_track


@pytest.fixture()
def client(tmp_path: Path):
    previous_state = main.state
    previous_settings = main.settings
    main.settings = replace(
        previous_settings,
        session_dir=str(tmp_path / "night-light-sessions"),
        cache_dir=str(tmp_path / "night-light-cache"),
        deezer_arl="arl-test",
    )
    main.state = main.AppState(main.settings)
    with TestClient(main.app) as test_client:
        yield test_client
    main.state.executor.shutdown(wait=False)
    main.state = previous_state
    main.settings = previous_settings


def _wait_for_job(client: TestClient, job_id: str, timeout: float = 10.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        response = client.get(f"/api/jobs/{job_id}")
        if response.status_code == 200:
            job = response.json()
            if job["status"] in {"done", "error"}:
                return job
        time.sleep(0.1)
    raise AssertionError("job did not finish before timeout")


def test_resolve_requires_title(client: TestClient) -> None:
    response = client.post("/api/resolve", json={"title": "   "})
    assert response.status_code in {400, 422}


def test_resolve_endpoint_runs_and_produces_track(
    client: TestClient, tmp_path: Path, monkeypatch
) -> None:
    audio = tmp_path / "resolved.wav"
    write_synthetic_track(audio, duration=4.0)

    fake_result = RetrievalResult(
        query=TrackQuery(title="Synthetic", artist="Test", duration_sec=4.0),
        candidate=Candidate(
            provider="cache", source_id="x", title="Synthetic", artist="Test", duration_sec=4.0
        ),
        cache_entry_path=audio,
        timings=RetrievalTimings(0.1, 0.1, 0.1, 0.0, 0.3),
        from_cache=False,
    )

    def fake_resolve(*args, **kwargs):
        progress = kwargs.get("progress")
        if progress is not None:
            progress("Recherche", 1.0, "ok")
        return fake_result

    monkeypatch.setattr("server.main.resolve_track", fake_resolve)

    response = client.post(
        "/api/resolve",
        json={"title": "Synthetic", "artist": "Test", "duration_sec": 4.0},
    )
    assert response.status_code == 202, response.text
    job_id = response.json()["jobId"]

    job = _wait_for_job(client, job_id)
    assert job["status"] == "done", job
    track_response = client.get(f"/api/track/{job_id}")
    assert track_response.status_code == 200


def test_resolve_handles_retrieval_error(client: TestClient, monkeypatch) -> None:
    from server.retrieve.resolver import RetrievalError

    def fake_resolve(*args, **kwargs):
        raise RetrievalError("no_match", "aucun candidat")

    monkeypatch.setattr("server.main.resolve_track", fake_resolve)

    response = client.post(
        "/api/resolve",
        json={"title": "Unknown", "artist": "Nobody", "duration_sec": 4.0},
    )
    assert response.status_code == 202
    job_id = response.json()["jobId"]
    job = _wait_for_job(client, job_id)
    assert job["status"] == "error"
    assert job["error"]["code"] == "no_match"


def test_resolve_without_deezer_arl_is_reported(client: TestClient) -> None:
    previous = main.state.settings
    main.state.settings = replace(previous, deezer_arl="")
    try:
        response = client.post(
            "/api/resolve",
            json={"title": "Get Lucky", "artist": "Daft Punk", "duration_sec": 369.0},
        )
        assert response.status_code == 202
        job = _wait_for_job(client, response.json()["jobId"])
    finally:
        main.state.settings = previous
    assert job["status"] == "error"
    assert job["error"]["code"] == "deezer_not_configured"
    assert "DEEZER_ARL" in job["error"]["detail"]


def test_resolve_stack_prioritises_latest_and_keeps_skipped(
    client: TestClient, tmp_path: Path, monkeypatch
) -> None:
    """Le dernier morceau passe devant ; les morceaux sautés restent en stock."""
    import threading

    audio = tmp_path / "resolved.wav"
    write_synthetic_track(audio, duration=3.0)

    resolved_order: list[str] = []
    first_started = threading.Event()
    release_first = threading.Event()

    def fake_resolve(query, provider, cache, **kwargs):
        resolved_order.append(query.title)
        if query.title == "A":
            # Le premier morceau est déjà en cours quand on saute au suivant.
            first_started.set()
            release_first.wait(timeout=5.0)
        return RetrievalResult(
            query=query,
            candidate=Candidate(
                provider="cache", source_id=query.title, title=query.title, artist=query.artist
            ),
            cache_entry_path=audio,
            timings=RetrievalTimings(0.0, 0.0, 0.0, 0.0, 0.0),
            from_cache=False,
        )

    monkeypatch.setattr("server.main.resolve_track", fake_resolve)

    job_a = client.post("/api/resolve", json={"title": "A", "artist": "Z"}).json()["jobId"]
    assert first_started.wait(timeout=5.0)
    job_b = client.post("/api/resolve", json={"title": "B", "artist": "Z"}).json()["jobId"]
    job_c = client.post("/api/resolve", json={"title": "C", "artist": "Z"}).json()["jobId"]

    release_first.set()

    done_a = _wait_for_job(client, job_a)
    done_b = _wait_for_job(client, job_b)
    done_c = _wait_for_job(client, job_c)

    # A (déjà lancé) puis C (le dernier demandé) avant B : une pile, pas une file.
    assert resolved_order == ["A", "C", "B"], resolved_order
    # Les morceaux sautés ont bien été téléchargés (en stock) mais pas analysés
    # ni affichés : ils sont marqués périmés.
    assert done_a["status"] == "error" and done_a["error"]["code"] == "stale_result"
    assert done_b["status"] == "error" and done_b["error"]["code"] == "stale_result"
    assert done_c["status"] == "done", done_c


def _fake_resolve_result(query, audio: Path) -> RetrievalResult:
    return RetrievalResult(
        query=query,
        candidate=Candidate(
            provider="cache",
            source_id=query.title,
            title=query.title,
            artist=query.artist,
            duration_sec=query.duration_sec,
        ),
        cache_entry_path=audio,
        timings=RetrievalTimings(0.01, 0.01, 0.02, 0.0, 0.04),
        from_cache=True,
    )


def _resolve_until_done(client: TestClient, payload: dict) -> dict:
    response = client.post("/api/resolve", json=payload)
    assert response.status_code == 202, response.text
    return _wait_for_job(client, response.json()["jobId"])


def test_second_listen_skips_analysis(
    client: TestClient, tmp_path: Path, monkeypatch
) -> None:
    audio = tmp_path / "resolved.wav"
    write_synthetic_track(audio, duration=4.0)
    monkeypatch.setattr(
        "server.main.resolve_track",
        lambda query, *args, **kwargs: _fake_resolve_result(query, audio),
    )
    calls: list[str] = []
    original = main.AppState.run_analysis

    def counted(self, job_id, **kwargs):
        calls.append(job_id)
        return original(self, job_id, **kwargs)

    monkeypatch.setattr(main.AppState, "run_analysis", counted)

    payload = {"title": "Cache Me", "artist": "Test", "duration_sec": 4.0}
    first = _resolve_until_done(client, payload)
    assert first["status"] == "done", first
    assert len(calls) == 1
    assert first["timings"]["analysisCache"] is False

    second = _resolve_until_done(client, payload)
    assert second["status"] == "done", second
    assert len(calls) == 1, "run_analysis a été relancé malgré le cache"
    assert second["timings"]["analysisCache"] is True
    assert second["timings"]["analyzedMs"] >= 0


def test_corrupted_analysis_cache_triggers_reanalysis(
    client: TestClient, tmp_path: Path, monkeypatch
) -> None:
    audio = tmp_path / "resolved.wav"
    write_synthetic_track(audio, duration=4.0)
    monkeypatch.setattr(
        "server.main.resolve_track",
        lambda query, *args, **kwargs: _fake_resolve_result(query, audio),
    )
    calls: list[str] = []
    original = main.AppState.run_analysis

    def counted(self, job_id, **kwargs):
        calls.append(job_id)
        return original(self, job_id, **kwargs)

    monkeypatch.setattr(main.AppState, "run_analysis", counted)

    payload = {"title": "Broken Cache", "artist": "Test", "duration_sec": 4.0}
    assert _resolve_until_done(client, payload)["status"] == "done"
    assert len(calls) == 1

    key = main.audio_cache_key(TrackQuery(title="Broken Cache", artist="Test", duration_sec=4.0))
    main.state.analysis_cache.path_for(key).write_text("{ corrompu", encoding="utf-8")

    third = _resolve_until_done(client, payload)
    assert third["status"] == "done", third
    assert len(calls) == 2, "un JSON corrompu doit provoquer une réanalyse"
    assert third["timings"]["analysisCache"] is False


def test_analyzer_version_change_invalidates_cache(
    client: TestClient, tmp_path: Path, monkeypatch
) -> None:
    from server.analysis_cache import AnalysisCache
    from server.retrieve.models import audio_cache_key

    audio = tmp_path / "resolved.wav"
    write_synthetic_track(audio, duration=4.0)
    monkeypatch.setattr(
        "server.main.resolve_track",
        lambda query, *args, **kwargs: _fake_resolve_result(query, audio),
    )
    calls: list[str] = []
    original = main.AppState.run_analysis

    def counted(self, job_id, **kwargs):
        calls.append(job_id)
        return original(self, job_id, **kwargs)

    monkeypatch.setattr(main.AppState, "run_analysis", counted)

    payload = {"title": "Versioned", "artist": "Test", "duration_sec": 4.0}
    assert _resolve_until_done(client, payload)["status"] == "done"
    assert len(calls) == 1

    key = audio_cache_key(TrackQuery(title="Versioned", artist="Test", duration_sec=4.0))
    assert main.state.analysis_cache.get(key) is not None
    # Simule un redémarrage avec un analyseur dont la version a changé.
    main.state.analysis_cache = AnalysisCache(
        tmp_path / "night-light-cache" / "analysis",
        version="next-version",
        max_bytes=main.settings.analysis_cache_max_bytes,
    )

    third = _resolve_until_done(client, payload)
    assert third["status"] == "done", third
    assert len(calls) == 2, "un changement d'ANALYZER_VERSION doit provoquer une réanalyse"
    assert third["timings"]["analysisCache"] is False
