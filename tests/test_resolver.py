import threading
from pathlib import Path

from server.retrieve.cache import AudioCache
from server.retrieve.models import Candidate, TrackQuery
from server.retrieve.resolver import RetrievalError, resolve_track


def test_ambiguous_match_is_reported(tmp_path: Path) -> None:
    fixture = tmp_path / "truth.wav"
    fixture.write_bytes(b"placeholder")

    class FakeProvider:
        name = "fake"

        def search(self, query):
            return [
                Candidate(provider="fake", source_id="a", title="Canon in D major", artist="Kevin", duration_sec=355.0, url="https://x/a"),
                Candidate(provider="fake", source_id="b", title="Canon in D minor", artist="Kevin", duration_sec=355.0, url="https://x/b"),
            ]

        def download(self, candidate, destination):
            raise AssertionError("should not download on ambiguity")

    cache = AudioCache(tmp_path / "cache")
    query = TrackQuery(title="Canon", artist="Kevin", duration_sec=355.0)
    try:
        resolve_track(query, FakeProvider(), cache)
    except RetrievalError as error:
        assert error.code == "ambiguous_match"
    else:
        raise AssertionError("expected ambiguous_match")


def test_concurrent_same_track_downloads_once(tmp_path: Path) -> None:
    fixture = tmp_path / "truth.wav"
    fixture.write_bytes(b"payload")
    content = fixture.read_bytes()
    downloads = {"count": 0}
    lock = threading.Lock()

    class FakeProvider:
        name = "fake"

        def search(self, query):
            return [
                Candidate(provider="fake", source_id="one", title=query.title, artist=query.artist, duration_sec=query.duration_sec, url="https://x/a", container="wav")
            ]

        def download(self, candidate, destination):
            with lock:
                downloads["count"] += 1
            destination.mkdir(parents=True, exist_ok=True)
            path = destination / "audio.wav"
            path.write_bytes(content)
            return path

    cache = AudioCache(tmp_path / "cache")
    query = TrackQuery(title="Song", artist="Artist", duration_sec=4.0)
    errors = []

    def worker():
        try:
            resolve_track(query, FakeProvider(), cache)
        except Exception as error:  # noqa: BLE001
            errors.append(error)

    threads = [threading.Thread(target=worker) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert not errors
    assert downloads["count"] == 1
