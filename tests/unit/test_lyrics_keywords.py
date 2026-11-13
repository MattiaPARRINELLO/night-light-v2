import json

import pytest

from server.lyrics.cache import CueCache, cue_cache_key
from server.lyrics.groq import GroqClient, GroqError
from server.lyrics.keywords import (
    build_messages,
    detect_chorus,
    extract_cues,
    parse_cues,
)
from server.lyrics.models import LyricLine, Lyrics, LyricWord

LINES = (
    LyricLine(
        text="J'connais des tueurs que tu trouves adorables",
        start_ms=3360,
        end_ms=5077,
        words=(
            LyricWord("J'connais ", 3360, 3600),
            LyricWord("des ", 3600, 3720),
            LyricWord("tueurs ", 3720, 3920),
            LyricWord("que ", 3920, 4070),
            LyricWord("tu ", 4070, 4170),
            LyricWord("trouves ", 4170, 4350),
            LyricWord("adorables", 4350, 5077),
        ),
    ),
    LyricLine(text="Un ennemi mort, c'est la tranquillité", start_ms=8810, end_ms=11414),
)

LYRICS = Lyrics(record_id=1, track_name="Otto", artist_name="SCH", lines=LINES)


def test_build_messages_indexes_lines() -> None:
    messages = build_messages(LYRICS, max_keywords=8)
    prompt = messages[-1]["content"]

    assert "[0] J'connais des tueurs" in prompt
    assert "[1] Un ennemi mort" in prompt
    assert "entre 4 et 8 mots" in prompt


def test_parse_cues_maps_text_to_word_timings() -> None:
    payload = {
        "keywords": [
            {"line": 0, "text": "tueurs", "impact": 0.9, "kind": "image"},
            {"line": 1, "text": "ennemi mort", "impact": 2.0, "kind": "inconnu"},
        ]
    }
    cues = parse_cues(payload, LYRICS)

    assert cues.source == "llm"
    first, second = cues.keywords
    assert first.text == "tueurs"
    assert first.start_ms == 3720
    assert first.end_ms == 3920
    assert first.kind == "image"
    # Impact borné, kind inconnu ramené au défaut.
    assert second.impact == 1.0
    assert second.kind == "image"
    # Ligne sans mots : bornes réparties proportionnellement dans la ligne.
    assert 8810 < second.start_ms < second.end_ms < 11414


def test_parse_cues_drops_invented_text_and_bad_indexes() -> None:
    payload = {
        "keywords": [
            {"line": 0, "text": "mot qui n'existe pas", "impact": 0.8},
            {"line": 99, "text": "tueurs", "impact": 0.8},
            {"line": 0, "text": "des tueurs", "impact": 0.6},
            {"line": 0, "text": "des tueurs", "impact": 0.9},
        ]
    }
    cues = parse_cues(payload, LYRICS)

    assert len(cues.keywords) == 1
    assert cues.keywords[0].text == "des tueurs"
    assert cues.keywords[0].start_ms == 3600


def test_detect_chorus_finds_repeated_block() -> None:
    lines = tuple(
        LyricLine(text=text, start_ms=index * 1000, end_ms=index * 1000 + 900)
        for index, text in enumerate(
            [
                "premier couplet",
                "une phrase",
                "refrain ici",
                "deuxieme ligne du refrain",
                "autre couplet",
                "refrain ici",
                "deuxieme ligne du refrain",
            ]
        )
    )
    chorus = detect_chorus(lines)

    assert chorus == (2, 3, 5, 6)


def test_detect_chorus_without_repetition() -> None:
    lines = tuple(
        LyricLine(text=f"ligne unique {index}", start_ms=index * 1000, end_ms=index * 1000 + 900)
        for index in range(3)
    )
    assert detect_chorus(lines) == ()


def test_extract_cues_uses_llm_when_configured() -> None:
    def poster(url, headers, body):
        return {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {
                                "keywords": [
                                    {"line": 0, "text": "tueurs", "impact": 0.9, "kind": "image"}
                                ],
                                "chorus": [0],
                            }
                        )
                    }
                }
            ]
        }

    client = GroqClient(api_key="test", poster=poster)
    cues = extract_cues(LYRICS, client=client)

    assert cues.source == "llm"
    assert cues.model == "openai/gpt-oss-20b"
    assert cues.keywords[0].start_ms == 3720
    assert cues.chorus_lines == (0,)


def test_extract_cues_falls_back_without_key() -> None:
    cues = extract_cues(LYRICS, client=GroqClient(api_key=""))

    assert cues.source == "heuristic"
    assert cues.keywords


def test_extract_cues_falls_back_on_model_error() -> None:
    def poster(url, headers, body):
        raise GroqError("boom")

    cues = extract_cues(LYRICS, client=GroqClient(api_key="test", poster=poster))
    assert cues.source == "heuristic"


def test_groq_client_rejects_non_json_content() -> None:
    def poster(url, headers, body):
        return {"choices": [{"message": {"content": "pas du json"}}]}

    client = GroqClient(api_key="test", poster=poster)
    with pytest.raises(GroqError):
        client.complete_json([{"role": "user", "content": "salut"}])


def test_groq_client_requires_key() -> None:
    with pytest.raises(GroqError):
        GroqClient(api_key="").complete_json([{"role": "user", "content": "salut"}])


def test_cue_cache_roundtrip(tmp_path) -> None:
    cues = parse_cues({"keywords": [{"line": 0, "text": "tueurs", "impact": 0.9}]}, LYRICS)
    key = cue_cache_key(1, model="llama-3.1-8b-instant", max_keywords=10)
    cache = CueCache(tmp_path)

    assert cache.get(key) is None
    cache.put(key, cues)
    restored = cache.get(key)

    assert restored is not None
    assert restored.keywords[0].start_ms == 3720
    assert restored.keywords[0].text == "tueurs"


def test_cue_cache_key_changes_with_model() -> None:
    a = cue_cache_key(1, model="a", max_keywords=10)
    b = cue_cache_key(1, model="b", max_keywords=10)
    assert a != b
