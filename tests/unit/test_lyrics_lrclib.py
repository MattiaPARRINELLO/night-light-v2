import json
import urllib.parse

import pytest

from server.lyrics import lrclib
from server.lyrics.lrclib import LrclibClient, LrclibError

LYRICSFILE = """\
version: '1.0'
metadata:
  title: Otto
  artist: SCH
  duration_ms: 290000
lines:
- text: J'connais des tueurs
  start_ms: 3360
  end_ms: 5077
  words:
  - text: 'J''connais '
    start_ms: 3360
  - text: tueurs
    start_ms: 4350
"""


def _record(
    *,
    record_id: int,
    track: str,
    artist: str,
    duration: float = 290.0,
    word_sync: bool = True,
    synced: str = "[00:03.36]J'connais des tueurs\n",
) -> dict:
    return {
        "id": record_id,
        "trackName": track,
        "artistName": artist,
        "albumName": "JVLIVS",
        "duration": duration,
        "instrumental": False,
        "hasWordSync": word_sync,
        "plainLyrics": "J'connais des tueurs",
        "syncedLyrics": synced,
        "lyricsfile": LYRICSFILE if word_sync else "version: '1.0'\nlines: []\n",
    }


def _fetcher(payload):
    def fetch(url: str):
        return payload

    return fetch


def _url_fetcher(payload, seen: list[str]):
    def fetch(url: str):
        seen.append(url)
        return payload

    return fetch


def test_fetch_prefers_exact_artist_and_word_sync() -> None:
    payload = [
        _record(record_id=1, track="Otto", artist="Cover Band", word_sync=False),
        _record(record_id=2, track="Otto", artist="SCH"),
    ]
    client = LrclibClient(fetcher=_fetcher(payload))

    lyrics = client.fetch("Otto", "SCH", 290.0)

    assert lyrics is not None
    assert lyrics.record_id == 2
    assert lyrics.word_synced
    assert lyrics.lines[0].words[0].text == "J'connais "


def test_fetch_rejects_wrong_artist() -> None:
    payload = [_record(record_id=1, track="Otto", artist="Autre Artiste")]
    client = LrclibClient(fetcher=_fetcher(payload))

    assert client.fetch("Otto", "SCH", 290.0) is None


def test_fetch_falls_back_to_synced_lrc_without_lyricsfile() -> None:
    payload = [
        {
            "id": 5,
            "trackName": "Otto",
            "artistName": "SCH",
            "albumName": "",
            "duration": 290.0,
            "instrumental": False,
            "hasWordSync": False,
            "plainLyrics": "J'connais",
            "syncedLyrics": "[00:03.36]J'connais des tueurs",
            "lyricsfile": "version: '1.0'\nlines: []\n",
        }
    ]
    client = LrclibClient(fetcher=_fetcher(payload))

    lyrics = client.fetch("Otto", "SCH")

    assert lyrics is not None
    assert lyrics.timed
    assert not lyrics.word_synced
    assert lyrics.lines[0].start_ms == 3360


def test_search_builds_query_and_limits() -> None:
    seen: list[str] = []
    payload = [_record(record_id=index, track="Otto", artist="SCH") for index in range(1, 5)]
    client = LrclibClient(fetcher=_url_fetcher(payload, seen))

    results = client.search("Otto", "SCH", limit=2)

    assert len(results) == 2
    parsed = urllib.parse.urlparse(seen[0])
    assert parsed.path == "/api/search"
    assert urllib.parse.parse_qs(parsed.query) == {"track_name": ["Otto"], "artist_name": ["SCH"]}


def test_get_by_id() -> None:
    payload = _record(record_id=42, track="Otto", artist="SCH")
    client = LrclibClient(fetcher=_fetcher(payload))

    lyrics = client.get(42)

    assert lyrics is not None
    assert lyrics.record_id == 42


def test_rate_limit_is_retried(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    def fetch(url: str):
        calls.append(url)
        if len(calls) == 1:
            raise lrclib.LrclibRateLimited("trop de requêtes", 0.0)
        return [_record(record_id=1, track="Otto", artist="SCH")]

    monkeypatch.setattr(lrclib.time, "sleep", lambda _seconds: None)
    client = LrclibClient(fetcher=fetch)

    lyrics = client.fetch("Otto", "SCH")

    assert lyrics is not None
    assert len(calls) == 2


def test_http_error_becomes_lrclib_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(url: str):
        raise LrclibError("réseau")

    client = LrclibClient(fetcher=boom)

    with pytest.raises(LrclibError):
        client.search("Otto")


def test_as_dict_json_serialisable() -> None:
    client = LrclibClient(fetcher=_fetcher([_record(record_id=1, track="Otto", artist="SCH")]))
    lyrics = client.fetch("Otto", "SCH")

    assert lyrics is not None
    json.dumps(lyrics.as_dict())
