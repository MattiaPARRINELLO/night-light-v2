"""Helpers expérimentaux de récupération audio par métadonnées."""

from .cache import AudioCache, AudioCacheError, audio_cache_key
from .deezer import DeezerProvider, DeezerProviderError
from .match import MatchResult, MatchThresholds, score_candidate, validate_match
from .models import Candidate, TrackQuery, normalize_text
from .providers import AudioProvider
from .resolver import RetrievalError, RetrievalResult, RetrievalTimings, resolve_track

__all__ = [
    "AudioCache",
    "AudioCacheError",
    "AudioProvider",
    "Candidate",
    "DeezerProvider",
    "DeezerProviderError",
    "MatchResult",
    "MatchThresholds",
    "RetrievalError",
    "RetrievalResult",
    "RetrievalTimings",
    "TrackQuery",
    "audio_cache_key",
    "normalize_text",
    "resolve_track",
    "score_candidate",
    "validate_match",
]
