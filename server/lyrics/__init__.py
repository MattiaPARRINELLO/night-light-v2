"""Paroles synchronisées (LRCLIB), avec timings mot à mot quand disponibles."""

from .lrclib import (
    LrclibClient,
    LrclibError,
    LrclibRateLimited,
    fetch_lyrics,
)
from .models import LyricLine, Lyrics, LyricWord
from .parsers import parse_lrc, parse_lyricsfile

__all__ = [
    "LrclibClient",
    "LrclibError",
    "LrclibRateLimited",
    "LyricLine",
    "LyricWord",
    "Lyrics",
    "fetch_lyrics",
    "parse_lrc",
    "parse_lyricsfile",
]
