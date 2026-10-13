"""Helpers expérimentaux de récupération audio par métadonnées."""

from .cache import AudioCache, AudioCacheError, audio_cache_key
from .match import MatchResult, MatchThresholds, score_candidate, validate_match
from .models import Candidate, TrackQuery, normalize_text
from .providers import AudioProvider
from .resolver import RetrievalError, RetrievalResult, RetrievalTimings, resolve_track
from .youtube import YouTubeProvider, YouTubeProviderError

__all__ = [
    "AudioCache",
    "AudioCacheError",
    "AudioProvider",
    "Candidate",
    "MatchResult",
    "MatchThresholds",
    "RetrievalError",
    "RetrievalResult",
    "RetrievalTimings",
    "TrackQuery",
    "YouTubeProvider",
    "YouTubeProviderError",
    "audio_cache_key",
    "normalize_text",
    "resolve_track",
    "score_candidate",
    "validate_match",
]
