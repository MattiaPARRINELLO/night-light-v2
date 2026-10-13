import json
import os
import subprocess
from pathlib import Path
from unittest.mock import patch

from server.retrieve.match import MatchThresholds
from server.retrieve.models import TrackQuery, Candidate
from server.retrieve.youtube import (
    YouTubeProvider,
    YouTubeProviderError,
)
from tests.make_fixture import write_synthetic_track


def _proc(stdout="", stderr="", returncode=0):
    return subprocess.CompletedProcess(args=[], returncode=returncode, stdout=stdout, stderr=stderr)


def _metadata_line(**overrides):
    base = {
        "id": "vid123",
        "title": "Canon in D Major",
        "uploader": "Kevin MacLeod",
        "channel": "Kevin MacLeod",
        "artist": "Kevin MacLeod",
        "duration": 356,
        "webpage_url": "https://www.youtube.com/watch?v=vid123",
        "ext": "webm",
        "acodec": "opus",
        "vcodec": "av01",
        "view_count": 1000000,
        "live_status": "not_live",
    }
    base.update(overrides)
    return json.dumps(base)


def test_build_query_and_parse_search() -> None:
    provider = YouTubeProvider()
    stdout = _metadata_line() + "\n" + _metadata_line(id="badlive", title="Canon (live)", live_status="is_live") + "\n"
    with patch("server.retrieve.youtube._run_command", return_value=_proc(stdout)):
        candidates = provider.search(TrackQuery(title="Canon in D Major", artist="Kevin MacLeod", duration_sec=355.628))
    assert len(candidates) == 1
    assert candidates[0].provider == "youtube"
    assert candidates[0].title == "Canon in D Major"
    assert candidates[0].artist == "Kevin MacLeod"
    assert candidates[0].duration_sec == 356


def test_search_rejects_unwanted_versions() -> None:
    provider = YouTubeProvider()
    stdout = _metadata_line(title="Canon in D Major (slowed + reverb)") + "\n"
    with patch("server.retrieve.youtube._run_command", return_value=_proc(stdout)):
        candidates = provider.search(TrackQuery(title="Canon", artist="Kevin", duration_sec=355.0))
    assert candidates == []


def test_search_no_results() -> None:
    provider = YouTubeProvider()
    with patch("server.retrieve.youtube._run_command", return_value=_proc("")):
        candidates = provider.search(TrackQuery(title="Unknown", artist="Nobody", duration_sec=10.0))
    assert candidates == []


def test_search_http_or_process_error() -> None:
    provider = YouTubeProvider()
    with patch("server.retrieve.youtube._run_command", side_effect=YouTubeProviderError("boom")):
        try:
            provider.search(TrackQuery(title="Canon", artist="Kevin", duration_sec=10.0))
        except YouTubeProviderError:
            pass
        else:
            raise AssertionError("expected error")


def test_search_timeout() -> None:
    provider = YouTubeProvider()
    with patch("server.retrieve.youtube._run_command", side_effect=YouTubeProviderError("timeout")):
        try:
            provider.search(TrackQuery(title="Canon", artist="Kevin", duration_sec=10.0))
        except YouTubeProviderError:
            pass
        else:
            raise AssertionError("expected error")


def test_search_invalid_json() -> None:
    provider = YouTubeProvider()
    with patch("server.retrieve.youtube._run_command", return_value=_proc("not json\n")):
        try:
            provider.search(TrackQuery(title="Canon", artist="Kevin", duration_sec=10.0))
        except YouTubeProviderError:
            pass
        else:
            raise AssertionError("expected error")


def test_search_second_pass_official() -> None:
    provider = YouTubeProvider()
    # Première passe : uniquement un remix filtré -> aucun candidat; seconde passe renvoie un candidat officiel.
    first = _proc(_metadata_line(title="Canon (remix)") + "\n")
    second = _proc(_metadata_line(id="official", title="Canon in D Major (Official Audio)") + "\n")

    def side_effect(command, timeout, operation):
        if command[-1].endswith("official audio"):
            return second
        return first

    with patch("server.retrieve.youtube._run_command", side_effect=side_effect):
        candidates = provider.search(TrackQuery(title="Canon in D Major", artist="Kevin MacLeod", duration_sec=355.628))
    assert len(candidates) == 1
    assert candidates[0].source_id == "official"


def test_download_validates_file(tmp_path: Path) -> None:
    fixture = tmp_path / "truth.wav"
    write_synthetic_track(fixture, duration=5.0)
    content = fixture.read_bytes()
    dest = tmp_path / "downloads"

    def fake_run(command, timeout, operation):
        path = dest / "vid123.webm"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return _proc(str(path) + "\n")

    candidate = Candidate(
        provider="youtube",
        source_id="vid123",
        title="Canon",
        artist="Kevin",
        duration_sec=5.0,
        url="https://www.youtube.com/watch?v=vid123",
        container="webm",
    )
    provider = YouTubeProvider()
    with patch("server.retrieve.youtube._run_command", side_effect=fake_run):
        path = provider.download(candidate, dest)
    assert path.is_file()
    assert path.read_bytes() == content


def test_download_rejects_corrupted_file(tmp_path: Path) -> None:
    dest = tmp_path / "downloads"

    def fake_run(command, timeout, operation):
        path = dest / "vid123.webm"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"not audio")
        return _proc(str(path) + "\n")

    candidate = Candidate(
        provider="youtube",
        source_id="vid123",
        title="Canon",
        artist="Kevin",
        duration_sec=5.0,
        url="https://www.youtube.com/watch?v=vid123",
        container="webm",
    )
    provider = YouTubeProvider()
    with patch("server.retrieve.youtube._run_command", side_effect=fake_run):
        try:
            provider.download(candidate, dest)
        except YouTubeProviderError:
            pass
        else:
            raise AssertionError("expected YouTubeProviderError")


def test_download_rejects_duration_mismatch(tmp_path: Path) -> None:
    fixture = tmp_path / "truth.wav"
    write_synthetic_track(fixture, duration=5.0)
    content = fixture.read_bytes()
    dest = tmp_path / "downloads"

    def fake_run(command, timeout, operation):
        path = dest / "vid123.webm"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return _proc(str(path) + "\n")

    candidate = Candidate(
        provider="youtube",
        source_id="vid123",
        title="Canon",
        artist="Kevin",
        duration_sec=100.0,
        url="https://www.youtube.com/watch?v=vid123",
        container="webm",
    )
    provider = YouTubeProvider()
    with patch("server.retrieve.youtube._run_command", side_effect=fake_run):
        try:
            provider.download(candidate, dest)
        except YouTubeProviderError as error:
            assert "incompatible" in str(error) or "durée" in str(error)
        else:
            raise AssertionError("expected YouTubeProviderError")


def test_download_process_error() -> None:
    dest = Path("/tmp/does-not-matter")

    def fake_run(command, timeout, operation):
        raise YouTubeProviderError("yt-dlp failed")

    candidate = Candidate(
        provider="youtube",
        source_id="vid123",
        title="Canon",
        artist="Kevin",
        duration_sec=5.0,
        url="https://www.youtube.com/watch?v=vid123",
        container="webm",
    )
    provider = YouTubeProvider()
    with patch("server.retrieve.youtube._run_command", side_effect=fake_run):
        try:
            provider.download(candidate, dest)
        except YouTubeProviderError:
            pass
        else:
            raise AssertionError("expected YouTubeProviderError")


def test_cache_integration_with_youtube(tmp_path: Path) -> None:
    fixture = tmp_path / "truth.wav"
    write_synthetic_track(fixture, duration=3.0)
    content = fixture.read_bytes()
    dest = tmp_path / "downloads"

    def fake_run(command, timeout, operation):
        path = dest / "vid123.webm"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return _proc(str(path) + "\n")

    from server.retrieve.cache import AudioCache
    from server.retrieve.models import TrackQuery, audio_cache_key
    from server.analysis import analyze_file
    from server.config import load_settings

    candidate = Candidate(
        provider="youtube",
        source_id="cache-test",
        title="Synthetic",
        artist="Test",
        duration_sec=3.0,
        url="https://www.youtube.com/watch?v=cache-test",
        container="webm",
    )
    provider = YouTubeProvider()
    with patch("server.retrieve.youtube._run_command", side_effect=fake_run):
        downloaded = provider.download(candidate, dest)
    assert downloaded.is_file()

    cache = AudioCache(tmp_path / "cache")
    query = TrackQuery(title="Synthetic", artist="Test", duration_sec=3.0)
    entry = cache.put_for_query(query, downloaded, candidate_provider=provider.name)
    loaded = cache.get(audio_cache_key(query), validate_hash=True)
    assert loaded is not None
    assert loaded.path == entry.path
    result = analyze_file(loaded.path, load_settings())
    assert result.duration > 0


def test_resolver_with_mocked_provider(tmp_path: Path) -> None:
    fixture = tmp_path / "truth.wav"
    write_synthetic_track(fixture, duration=4.0)
    content = fixture.read_bytes()

    class FakeProvider:
        name = "youtube"

        def search(self, query):
            return [
                Candidate(
                    provider="youtube",
                    source_id="one",
                    title=query.title,
                    artist=query.artist,
                    duration_sec=query.duration_sec,
                    url="https://www.youtube.com/watch?v=one",
                    container="webm",
                )
            ]

        def download(self, candidate, destination):
            destination.mkdir(parents=True, exist_ok=True)
            path = destination / "audio.webm"
            path.write_bytes(content)
            return path

    from server.retrieve.cache import AudioCache
    from server.retrieve.models import TrackQuery
    from server.retrieve.resolver import resolve_track

    provider = FakeProvider()
    cache = AudioCache(tmp_path / "cache2")
    query = TrackQuery(title="Synthetic", artist="Test", duration_sec=4.0)
    result = resolve_track(query, provider, cache)
    assert result.from_cache is False
    assert result.cache_entry_path.is_file()
    result2 = resolve_track(query, provider, cache)
    assert result2.from_cache is True


def test_network_integration_optional() -> None:
    if os.environ.get("NIGHT_LIGHT_NETWORK_TESTS") != "1":
        import pytest

        pytest.skip("test réseau optionnel (NIGHT_LIGHT_NETWORK_TESTS=1)")
    import time

    from server.retrieve.models import TrackQuery
    from server.retrieve.youtube import YouTubeProvider

    provider = YouTubeProvider(search_limit=5)
    query = TrackQuery(title="Canon in D Major", artist="Kevin MacLeod", duration_sec=355.628)
    started = time.monotonic()
    candidates = provider.search(query)
    search_elapsed = time.monotonic() - started
    assert candidates, "aucun candidat YouTube"
    print(f"NETWORK youtube search elapsed={search_elapsed:.3f}s candidates={len(candidates)} best={candidates[0].title!r}")
    candidate = candidates[0]
    dest = Path("/tmp/night-light-youtube-test")
    dest.mkdir(parents=True, exist_ok=True)
    path = provider.download(candidate, dest)
    print(f"NETWORK downloaded={path} size={path.stat().st_size}")
    assert path.is_file()
