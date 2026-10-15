import hashlib
from pathlib import Path

from server.retrieve.cache import AudioCache, AudioCacheError
from server.retrieve.models import TrackQuery, audio_cache_key


def test_put_get_round_trip(tmp_path: Path) -> None:
    cache = AudioCache(tmp_path / "cache")
    source = tmp_path / "source.ogg"
    source.write_bytes(b"fake-audio-payload-123")
    key = "abc123"

    entry = cache.put(
        key,
        source,
        duration_sec=12.5,
        provider="wikimedia",
        title="Demo",
        artist="Artist",
    )
    assert entry.path.is_file()
    assert entry.size_bytes == source.stat().st_size
    assert entry.content_hash == hashlib.sha256(source.read_bytes()).hexdigest()

    loaded = cache.get(key)
    assert loaded is not None
    assert loaded.path == entry.path
    assert loaded.duration_sec == 12.5
    assert loaded.provider == "wikimedia"


def test_get_missing_returns_none(tmp_path: Path) -> None:
    cache = AudioCache(tmp_path / "cache")
    assert cache.get("does-not-exist") is None


def test_persistence_across_instances(tmp_path: Path) -> None:
    root = tmp_path / "cache"
    source = tmp_path / "source.ogg"
    source.write_bytes(b"persistent")
    cache1 = AudioCache(root)
    cache1.put("stable-key", source)
    cache2 = AudioCache(root)
    assert cache2.get("stable-key") is not None


def test_integrity_failure_invalidates_entry(tmp_path: Path) -> None:
    root = tmp_path / "cache"
    source = tmp_path / "source.ogg"
    source.write_bytes(b"initial")
    cache = AudioCache(root)
    entry = cache.put("integrity", source)
    entry.path.write_bytes(b"corrupted")
    assert cache.get("integrity", validate_hash=True) is None
    assert not entry.path.parent.exists()


def test_query_helpers_and_remove(tmp_path: Path) -> None:
    cache = AudioCache(tmp_path / "cache")
    source = tmp_path / "source.ogg"
    source.write_bytes(b"payload")
    query = TrackQuery(title="Demo", artist="Artist", duration_sec=10.0)
    key = audio_cache_key(query)
    cache.put_for_query(query, source, candidate_provider="wikimedia", metadata={"x": 1})
    loaded = cache.get_entry_for_query(query)
    assert loaded is not None
    assert loaded.key == key
    assert loaded.metadata == {"x": 1}
    cache.remove(key)
    assert cache.get(key) is None


def test_clear(tmp_path: Path) -> None:
    cache = AudioCache(tmp_path / "cache")
    source = tmp_path / "source.ogg"
    source.write_bytes(b"payload")
    cache.put("a", source)
    cache.put("b", source)
    assert cache.clear() >= 2
    assert cache.get("a") is None
    assert cache.get("b") is None


def test_put_requires_existing_source(tmp_path: Path) -> None:
    cache = AudioCache(tmp_path / "cache")
    try:
        cache.put("missing", tmp_path / "nope.ogg")
    except AudioCacheError:
        return
    raise AssertionError("expected AudioCacheError")


def test_lock_for_same_key_is_stable(tmp_path: Path) -> None:
    cache = AudioCache(tmp_path / "cache")
    assert cache.lock_for("k") is cache.lock_for("k")
