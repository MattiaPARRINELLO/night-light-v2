"""Validation de correspondance d'un candidat audio à une requête."""

from __future__ import annotations

from dataclasses import dataclass
from difflib import SequenceMatcher

from .models import Candidate, MatchResult, MatchScore, TrackQuery, normalize_text


@dataclass(frozen=True)
class MatchThresholds:
    """Seuils de validation des correspondances."""

    min_score: float = 70.0
    max_duration_delta_sec: float = 2.0
    max_duration_delta_ratio: float = 0.005
    min_title_ratio: float = 0.70
    reject_previews: bool = True
    allow_missing_duration: bool = False


_OFFICIAL_TITLE_TOKENS = {
    "official",
    "audio",
    "video",
    "clip",
    "officiel",
    "originale",
    "provided",
    "youtube",
    "topic",
    "original",
    "(official",
    "album",
}


def _text_ratio(left: str, right: str) -> float:
    if not left or not right:
        return 0.0
    if left == right:
        return 1.0
    # Les marqueurs officiels peuvent être présents d'un côté sans indiquer
    # une version différente. Les termes additionnels non officiels sont
    # pénalisés plutôt que considérés comme identiques.
    if left in right or right in left:
        long_value, short_value = (
            (right, left) if len(right) >= len(left) else (left, right)
        )
        extra = [
            token for token in long_value.split() if token not in short_value.split()
        ]
        if not extra:
            return 1.0
        if extra[0] in {"feat", "ft", "featuring"}:
            return 1.0
        if all(token in _OFFICIAL_TITLE_TOKENS for token in extra):
            return 1.0
        # Un candidat plus long conserve une bonne note, mais n'est plus traité
        # comme une correspondance mot-à-mot exacte.
        return max(0.85, min(0.95, max(len(short_value), 1) / max(len(long_value), 1)))
    return SequenceMatcher(None, left, right).ratio()


def duration_tolerance_sec(query: TrackQuery, thresholds: MatchThresholds) -> float:
    base = max(
        thresholds.max_duration_delta_sec,
        query.duration_sec * thresholds.max_duration_delta_ratio,
    )
    return base


def duration_delta_sec(query: TrackQuery, candidate: Candidate) -> float | None:
    if query.duration_sec <= 0 or candidate.duration_sec is None:
        return None
    return abs(candidate.duration_sec - query.duration_sec)


def score_candidate(
    query: TrackQuery,
    candidate: Candidate,
    thresholds: MatchThresholds = MatchThresholds(),
) -> MatchScore:
    """Score 0..100 fondé sur le titre, l'artiste et la durée."""
    title_ratio = _text_ratio(query.normalized_title, candidate.normalized_title)
    artist_ratio = _text_ratio(query.normalized_artist, candidate.normalized_artist)

    title_score = title_ratio * 50.0
    # Un artiste absent dans la requête ne pénalise pas le score.
    artist_score = (
        artist_ratio * 30.0
        if query.normalized_artist
        else 30.0
        if candidate.normalized_artist
        else 0.0
    )

    duration_score = 0.0
    delta = duration_delta_sec(query, candidate)
    if delta is not None:
        tolerance = duration_tolerance_sec(query, thresholds)
        if tolerance > 0 and delta <= tolerance:
            duration_score = 20.0 * (1.0 - (delta / tolerance))

    return MatchScore(title=title_score, artist=artist_score, duration=duration_score)


_PREVIEW_MARKERS = ("snippet", "preview", "teaser", "excerpt", "sample")
_INCOMPATIBLE_VERSION_MARKERS = (
    "remix",
    "live",
    "nightcore",
    "slowed",
    "speed up",
    "8d",
    "bass boosted",
    "cover",
    "mashup",
    "edit",
    "react",
    "commentary",
    "instrumental",
    "karaoke",
    "paroles",
    "lyrics",
    "lyric",
    "sped up",
    "slowed down",
    "extended",
    "radio edit",
    "remaster",
)


def validate_match(
    query: TrackQuery,
    candidate: Candidate,
    thresholds: MatchThresholds = MatchThresholds(),
) -> MatchResult:
    """Valide une correspondance et retourne les raisons de refus."""
    reasons: list[str] = []
    score = score_candidate(query, candidate, thresholds)

    if thresholds.reject_previews and candidate.is_preview:
        reasons.append("preview")

    candidate_title = candidate.normalized_title
    if query.normalized_title and not candidate_title:
        reasons.append("missing_title")
    elif query.normalized_title and (query.normalized_title not in candidate_title):
        ratio = _text_ratio(query.normalized_title, candidate_title)
        if ratio < thresholds.min_title_ratio:
            reasons.append("weak_title")

    if query.normalized_artist and candidate.normalized_artist:
        artist_ratio = _text_ratio(query.normalized_artist, candidate.normalized_artist)
        if artist_ratio < thresholds.min_title_ratio:
            reasons.append("weak_artist")
    elif query.normalized_artist and not candidate.normalized_artist:
        reasons.append("missing_artist")

    delta = duration_delta_sec(query, candidate)
    if query.duration_sec > 0:
        if delta is None:
            if not thresholds.allow_missing_duration:
                reasons.append("missing_duration")
        else:
            tolerance = duration_tolerance_sec(query, thresholds)
            if delta > tolerance:
                reasons.append("duration_mismatch")

    if query.normalized_title and candidate.normalized_title:
        candidate_text = normalize_text(candidate.title)
        if any(
            marker in candidate_text and marker not in query.normalized_title
            for marker in _INCOMPATIBLE_VERSION_MARKERS
        ):
            reasons.append("incompatible_version")
    if candidate.title and any(
        marker in normalize_text(candidate.title) for marker in _PREVIEW_MARKERS
    ):
        reasons.append("preview_title")

    accepted = (not reasons) and score.total >= thresholds.min_score
    if not accepted and not reasons:
        reasons.append("low_score")

    return MatchResult(
        accepted=accepted,
        score=round(score.total, 3),
        max_score=100.0,
        duration_delta_sec=delta,
        reasons=tuple(reasons),
    )
