import json

from server.lyrics.models import LyricLine, Lyrics, LyricWord
from server.lyrics.service import LyricsService

LYRICS = Lyrics(
    record_id=7,
    track_name="Otto",
    artist_name="SCH",
    duration_ms=290_000,
    lines=(
        LyricLine(
            text="J'connais des tueurs",
            start_ms=3360,
            end_ms=5077,
            words=(
                LyricWord("J'connais ", 3360, 3600),
                LyricWord("des ", 3600, 3720),
                LyricWord("tueurs", 3720, 5077),
            ),
        ),
        LyricLine(text="Un ennemi mort", start_ms=8810, end_ms=11_414),
    ),
)


class FakeLrclib:
    def __init__(self, lyrics: Lyrics | None = LYRICS) -> None:
        self.lyrics = lyrics
        self.calls = 0

    def fetch(self, track_name: str, artist_name: str = "", duration_sec=None):
        self.calls += 1
        return self.lyrics


class FakeGroq:
    def __init__(self, *, configured: bool = True, payload: dict | None = None) -> None:
        self.model = "fake-model"
        self.configured = configured
        self.payload = payload or {
            "keywords": [{"line": 0, "text": "tueurs", "impact": 0.9, "kind": "image"}],
            "chorus": [0],
        }

    def complete_json(self, messages, **kwargs):
        return self.payload


def test_payload_contains_lines_and_keywords(tmp_path) -> None:
    service = LyricsService(tmp_path, client=FakeLrclib(), groq=FakeGroq())

    payload = service.for_track(_track())

    assert payload is not None
    assert payload["recordId"] == 7
    assert payload["source"] == "llm"
    assert payload["chorusLines"] == [0]
    assert payload["keywords"][0]["startMs"] == 3720
    assert len(payload["lines"]) == 2
    assert payload["lines"][0]["words"][2]["text"] == "tueurs"
    json.dumps(payload)


def test_payload_is_none_without_match(tmp_path) -> None:
    service = LyricsService(tmp_path, client=FakeLrclib(None), groq=FakeGroq())
    assert service.for_track(_track()) is None


def test_second_call_uses_memo(tmp_path) -> None:
    client = FakeLrclib()
    service = LyricsService(tmp_path, client=client, groq=FakeGroq())

    service.for_track(_track())
    service.for_track(_track())

    assert client.calls == 1


def test_network_is_skipped_when_disallowed(tmp_path) -> None:
    client = FakeLrclib()
    service = LyricsService(tmp_path, client=client, groq=FakeGroq())

    assert service.for_track(_track(), allow_network=False) is None
    assert client.calls == 0

    service.for_track(_track())
    assert service.for_track(_track(), allow_network=False) is not None


def test_llm_cues_are_cached_but_heuristic_are_not(tmp_path) -> None:
    llm_service = LyricsService(tmp_path / "llm", client=FakeLrclib(), groq=FakeGroq())
    llm_service.for_track(_track())
    assert list((tmp_path / "llm").glob("*.json"))

    fallback_service = LyricsService(
        tmp_path / "fallback", client=FakeLrclib(), groq=FakeGroq(configured=False)
    )
    payload = fallback_service.for_track(_track())
    assert payload is not None
    assert payload["source"] == "heuristic"
    assert list((tmp_path / "fallback").glob("*.json")) == []


def test_fetch_error_returns_none(tmp_path) -> None:
    class Broken:
        def fetch(self, *args, **kwargs):
            raise OSError("réseau")

    service = LyricsService(tmp_path, client=Broken(), groq=FakeGroq())
    assert service.for_track(_track()) is None


def _track():
    from server.retrieve.models import TrackQuery

    return TrackQuery(title="Otto", artist="SCH", duration_sec=290.0)
