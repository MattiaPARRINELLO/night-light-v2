from pathlib import Path

from server.retrieve.cache import audio_cache_key
from server.retrieve.match import (
    MatchThresholds,
    duration_delta_sec,
    score_candidate,
    validate_match,
)
from server.retrieve.models import Candidate, TrackQuery, normalize_text


def test_normalize_text() -> None:
    assert (
        normalize_text("Kevin MacLeod - Canon in D Major!")
        == "kevin macleod canon in d major"
    )
    assert normalize_text("  A-B/C ") == "a b c"


def test_track_query_requires_title_and_non_negative_duration() -> None:
    try:
        TrackQuery(title="   ")
    except ValueError:
        pass
    else:
        raise AssertionError("expected ValueError")

    query = TrackQuery(title="Canon", artist="Kevin MacLeod", duration_sec=355.6)
    assert query.normalized_title == "canon"
    assert query.normalized_artist == "kevin macleod"


def test_score_candidate_rewards_exact_match() -> None:
    query = TrackQuery(
        title="Canon in D Major", artist="Kevin MacLeod", duration_sec=355.628
    )
    candidate = Candidate(
        provider="wikimedia",
        source_id="1",
        title="Kevin MacLeod - Canon in D Major.ogg",
        artist="Kevin MacLeod",
        duration_sec=355.628,
    )
    score = score_candidate(query, candidate)
    assert score.total >= 90
    result = validate_match(query, candidate)
    assert result.accepted is True
    assert result.reasons == ()


def test_validate_match_rejects_duration_mismatch() -> None:
    query = TrackQuery(
        title="Canon in D Major", artist="Kevin MacLeod", duration_sec=355.628
    )
    candidate = Candidate(
        provider="wikimedia",
        source_id="2",
        title="Kevin MacLeod - Canon in D Major.ogg",
        artist="Kevin MacLeod",
        duration_sec=120.0,
    )
    result = validate_match(query, candidate)
    assert result.accepted is False
    assert "duration_mismatch" in result.reasons


def test_validate_match_rejects_preview() -> None:
    query = TrackQuery(
        title="Canon in D Major", artist="Kevin MacLeod", duration_sec=355.628
    )
    candidate = Candidate(
        provider="wikimedia",
        source_id="3",
        title="Canon in D Major (preview)",
        artist="Kevin MacLeod",
        duration_sec=355.628,
        is_preview=True,
    )
    result = validate_match(query, candidate)
    assert result.accepted is False
    assert "preview" in result.reasons


def test_duration_delta_and_tolerance() -> None:
    query = TrackQuery(title="x", artist="y", duration_sec=100.0)
    candidate = Candidate(
        provider="p", source_id="4", title="x", artist="y", duration_sec=101.5
    )
    assert duration_delta_sec(query, candidate) == 1.5
    thresholds = MatchThresholds(
        max_duration_delta_sec=2.0, max_duration_delta_ratio=0.01
    )
    result = validate_match(query, candidate, thresholds)
    assert result.accepted is True


def test_cache_key_stable() -> None:
    query = TrackQuery(title=" Canon! ", artist="Kevin MacLeod", duration_sec=355.62809)
    key = audio_cache_key(query)
    assert len(key) == 64
    assert (
        audio_cache_key(
            TrackQuery(title="canon", artist="KEVIN MACLEOD", duration_sec=355.628)
        )
        == key
    )


def test_gogo_official_candidate_is_accepted() -> None:
    query = TrackQuery(title="Gogo", artist="Laylow", duration_sec=256.0)
    candidate = Candidate(
        provider="youtube",
        source_id="official",
        title="GOGO .feat JOK'AIR",
        artist="LAYLOW feat JOK'AIR",
        duration_sec=256.0,
    )
    result = validate_match(query, candidate)
    assert result.accepted is True
    assert result.reasons == ()


def test_gogo_instrumental_candidate_is_rejected() -> None:
    query = TrackQuery(title="Gogo", artist="Laylow", duration_sec=245.0)
    candidate = Candidate(
        provider="youtube",
        source_id="inst",
        title="Gogo INSTRUMENTAL (Raw Version)",
        artist="Laylow feat. Jok'Air",
        duration_sec=177.0,
    )
    result = validate_match(query, candidate)
    assert result.accepted is False
    assert "duration_mismatch" in result.reasons


def test_matching_normalizes_punctuation_and_accents() -> None:
    query = TrackQuery(
        title="Café — Gogo!", artist="Laylow, Jok'Air", duration_sec=245.0
    )
    candidate = Candidate(
        provider="youtube",
        source_id="x",
        title="cafe gogo feat jok air",
        artist="laylow feat jok air",
        duration_sec=246.0,
    )
    result = validate_match(query, candidate)
    assert result.accepted is True
