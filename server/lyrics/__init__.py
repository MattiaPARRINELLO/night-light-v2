"""Paroles synchronisées (LRCLIB) et mots marquants pour le show."""

from .cache import CueCache, cue_cache_key
from .groq import GroqClient, GroqError, GroqNotConfigured
from .keywords import (
    DEFAULT_MAX_KEYWORDS,
    KeywordCue,
    LyricCues,
    build_messages,
    cues_from_json,
    cues_to_json,
    detect_chorus,
    extract_cues,
    heuristic_keywords,
    parse_cues,
    title_cues,
)
from .lrclib import (
    LrclibClient,
    LrclibError,
    LrclibRateLimited,
    fetch_lyrics,
)
from .models import LyricLine, Lyrics, LyricWord
from .parsers import parse_lrc, parse_lyricsfile
from .sections import apply_chorus_sections, chorus_ranges
from .service import LyricsService

__all__ = [
    "DEFAULT_MAX_KEYWORDS",
    "CueCache",
    "GroqClient",
    "GroqError",
    "GroqNotConfigured",
    "KeywordCue",
    "LrclibClient",
    "LrclibError",
    "LrclibRateLimited",
    "LyricCues",
    "LyricLine",
    "LyricWord",
    "Lyrics",
    "LyricsService",
    "apply_chorus_sections",
    "build_messages",
    "chorus_ranges",
    "cue_cache_key",
    "cues_from_json",
    "cues_to_json",
    "detect_chorus",
    "extract_cues",
    "fetch_lyrics",
    "heuristic_keywords",
    "parse_cues",
    "parse_lrc",
    "parse_lyricsfile",
    "title_cues",
]
