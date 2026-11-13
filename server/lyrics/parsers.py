"""Analyse des paroles : LRC (ligne) et Lyricsfile YAML (mot à mot).

Les deux formats viennent de LRCLIB. Le LRC enrichi (balises `<mm:ss.xx>`) est
aussi accepté, auquel cas les mots sont extraits.
"""

from __future__ import annotations

import json
import re
from typing import Any

from .models import DEFAULT_LAST_LINE_MS, LyricLine, LyricWord

# [01:23.45] ou [01:23:45] ou [01:23]
_LRC_TIME_RE = re.compile(r"\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]")
# Balise de mot du LRC enrichi : <01:23.45>
_LRC_WORD_RE = re.compile(r"<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>")


def _ms(minutes: str, seconds: str, fraction: str | None) -> int:
    frac = (fraction or "0").ljust(3, "0")[:3]
    return int(minutes) * 60_000 + int(seconds) * 1_000 + int(frac)


def parse_lrc(text: str, *, last_line_ms: int = DEFAULT_LAST_LINE_MS) -> tuple[LyricLine, ...]:
    """Convertit un LRC en lignes triées, avec mots si le LRC est enrichi."""
    entries: list[tuple[int, str]] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        stamps = list(_LRC_TIME_RE.finditer(line))
        if not stamps:
            continue
        # Une même ligne peut porter plusieurs horodatages (refrain).
        body = line[stamps[-1].end() :].strip()
        for stamp in stamps:
            start = _ms(stamp.group(1), stamp.group(2), stamp.group(3))
            entries.append((start, body))
    entries.sort(key=lambda item: item[0])

    lines: list[LyricLine] = []
    for index, (start_ms, body) in enumerate(entries):
        end_ms = entries[index + 1][0] if index + 1 < len(entries) else start_ms + last_line_ms
        end_ms = max(end_ms, start_ms)
        words = _parse_lrc_words(body, start_ms, end_ms)
        text_value = _strip_lrc_words(body).strip()
        if not text_value and words:
            text_value = "".join(word.text for word in words).strip()
        if not text_value:
            continue
        lines.append(LyricLine(text=text_value, start_ms=start_ms, end_ms=end_ms, words=words))
    return tuple(lines)


def _parse_lrc_words(body: str, line_start: int, line_end: int) -> tuple[LyricWord, ...]:
    """Extrait les mots d'un LRC enrichi ; vide si aucune balise de mot."""
    marks = list(_LRC_WORD_RE.finditer(body))
    if not marks:
        return ()
    words: list[LyricWord] = []
    for index, mark in enumerate(marks):
        start = _ms(mark.group(1), mark.group(2), mark.group(3))
        if index + 1 < len(marks):
            following = marks[index + 1]
            stop = _ms(following.group(1), following.group(2), following.group(3))
            content = body[mark.end() : following.start()]
        else:
            stop = line_end
            content = body[mark.end() :]
        if not content:
            continue
        words.append(LyricWord(text=content, start_ms=start, end_ms=max(stop, start)))
    if words:
        first = words[0]
        words[0] = LyricWord(first.text, min(first.start_ms, line_start), first.end_ms)
    return tuple(words)


def _strip_lrc_words(body: str) -> str:
    return _LRC_WORD_RE.sub("", body)


def parse_lyricsfile(text: str) -> tuple[dict[str, Any], tuple[LyricLine, ...]]:
    """Analyse un document Lyricsfile et renvoie ses métadonnées et ses lignes.

    Le format est un sous-ensemble très régulier de YAML produit par LRCLIB,
    donc un analyseur dédié suffit et évite une dépendance à PyYAML.
    """
    metadata: dict[str, Any] = {}
    records: list[dict[str, Any]] = []
    section = ""
    current: dict[str, Any] | None = None
    current_word: dict[str, Any] | None = None
    base_indent: int | None = None

    for raw_line in text.replace("\ufeff", "").splitlines():
        if not raw_line.strip() or raw_line.lstrip().startswith("#"):
            continue
        indent = len(raw_line) - len(raw_line.lstrip(" "))
        stripped = raw_line.strip()

        if indent == 0 and stripped.endswith(":"):
            name = stripped[:-1].strip()
            if name in {"metadata", "lines"}:
                section = name
                continue

        if section == "metadata":
            key, value = _split_key(stripped)
            if key:
                metadata[key] = _parse_value(key, value)
            continue

        if section != "lines":
            continue

        if stripped.startswith("- "):
            body = stripped[2:]
            if base_indent is None:
                base_indent = indent
            if indent <= base_indent:
                current = {"text": "", "start_ms": 0, "end_ms": None, "words": []}
                records.append(current)
                current_word = None
            else:
                if current is None:
                    continue
                current_word = {"text": "", "start_ms": 0, "end_ms": None}
                current["words"].append(current_word)
            key, value = _split_key(body)
            target = current_word if indent > base_indent else current
            if key and target is not None:
                target[key] = _parse_value(key, value)
            continue

        key, value = _split_key(stripped)
        if not key or key == "words":
            continue
        if indent >= (base_indent or 0) + 4 and current_word is not None:
            current_word[key] = _parse_value(key, value)
        elif current is not None:
            current[key] = _parse_value(key, value)

    return metadata, _lines_from_records(records)


def _lines_from_records(records: list[dict[str, Any]]) -> tuple[LyricLine, ...]:
    """Calcule les bornes manquantes, puis construit les lignes finales."""
    clean = [record for record in records if record.get("text") or record.get("words")]
    clean.sort(key=lambda record: int(record.get("start_ms") or 0))

    lines: list[LyricLine] = []
    for index, record in enumerate(clean):
        start_ms = int(record.get("start_ms") or 0)
        end_ms = record.get("end_ms")
        if end_ms is None:
            following = clean[index + 1] if index + 1 < len(clean) else None
            end_ms = (
                int(following.get("start_ms") or 0)
                if following
                else start_ms + DEFAULT_LAST_LINE_MS
            )
        end_ms = max(int(end_ms), start_ms)

        raw_words = record.get("words") or []
        words: list[LyricWord] = []
        for word_index, word in enumerate(raw_words):
            word_start = int(word.get("start_ms") or start_ms)
            if word_index + 1 < len(raw_words):
                word_end = int(raw_words[word_index + 1].get("start_ms") or word_start)
            else:
                word_end = int(word.get("end_ms") or end_ms)
            words.append(
                LyricWord(
                    text=str(word.get("text") or ""),
                    start_ms=word_start,
                    end_ms=max(word_end, word_start),
                )
            )

        text_value = str(record.get("text") or "").strip()
        if not text_value and words:
            text_value = "".join(word.text for word in words).strip()
        if not text_value:
            continue
        lines.append(
            LyricLine(text=text_value, start_ms=start_ms, end_ms=end_ms, words=tuple(words))
        )
    return tuple(lines)


def _split_key(body: str) -> tuple[str, str]:
    if ":" not in body:
        return "", ""
    key, _, value = body.partition(":")
    return key.strip(), value.strip()


def _parse_value(key: str, value: str) -> Any:
    if key.endswith("_ms"):
        try:
            return int(float(_parse_scalar(value)))
        except (TypeError, ValueError):
            return 0
    parsed = _parse_scalar(value)
    if parsed in {"true", "True"}:
        return True
    if parsed in {"false", "False"}:
        return False
    return parsed


def _parse_scalar(raw: str) -> str:
    """Lit un scalaire YAML simple : mono-quote, double-quote ou brut."""
    raw = raw.strip()
    if len(raw) >= 2 and raw.startswith("'") and raw.endswith("'"):
        return raw[1:-1].replace("''", "'")
    if len(raw) >= 2 and raw.startswith('"') and raw.endswith('"'):
        try:
            return str(json.loads(raw))
        except (ValueError, TypeError):
            return raw[1:-1]
    return raw
