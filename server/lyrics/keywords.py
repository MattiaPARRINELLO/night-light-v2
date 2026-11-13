"""Extraction des mots marquants d'un morceau, avec timings exacts.

Le modèle ne produit jamais d'horodatage : il renvoie un index de ligne et un
fragment de texte, que l'on remappe sur les timings du Lyricsfile. Un mot
inventé, ou absent de la ligne citée, est simplement écarté.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

from server.retrieve.models import normalize_text

from .groq import GroqClient
from .models import LyricLine, Lyrics

PROMPT_VERSION = "1"
DEFAULT_MAX_KEYWORDS = 10
MIN_KEYWORDS = 4
KINDS = {"image", "action", "emotion", "lieu", "nom"}

_SYSTEM_PROMPT = (
    "Tu prépares un light show pour un morceau de musique. Tu choisis les mots "
    "les plus marquants des paroles, ceux qui produisent une image forte à l'écran. "
    "Tu réponds uniquement en JSON, sans texte autour."
)


@dataclass(frozen=True)
class KeywordCue:
    """Un mot marquant, avec ses bornes réelles dans le morceau."""

    text: str
    line_index: int
    start_ms: int
    end_ms: int
    impact: float
    kind: str = "image"

    def as_dict(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "lineIndex": self.line_index,
            "startMs": self.start_ms,
            "endMs": self.end_ms,
            "impact": round(self.impact, 3),
            "kind": self.kind,
        }


@dataclass(frozen=True)
class LyricCues:
    """Résultat complet : mots marquants et lignes de refrain."""

    keywords: tuple[KeywordCue, ...] = ()
    chorus_lines: tuple[int, ...] = ()
    source: str = "heuristic"
    model: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "keywords": [cue.as_dict() for cue in self.keywords],
            "chorusLines": list(self.chorus_lines),
            "source": self.source,
            "model": self.model,
        }


def build_messages(
    lyrics: Lyrics, *, max_keywords: int = DEFAULT_MAX_KEYWORDS
) -> list[dict[str, str]]:
    """Construit la conversation envoyée au modèle, lignes numérotées."""
    lines = "\n".join(
        f"[{index}] {line.text}" for index, line in enumerate(lyrics.lines) if line.text.strip()
    )
    user_prompt = (
        f"Morceau : {lyrics.track_name} — {lyrics.artist_name}\n\n"
        f"Paroles numérotées :\n{lines}\n\n"
        f"Choisis entre {MIN_KEYWORDS} et {max_keywords} mots. Réponds en JSON :\n"
        '{"keywords": [{"line": 12, "text": "tueurs", "impact": 0.9, "kind": "image"}], '
        '"chorus": [12, 13, 14]}\n\n'
        "Contraintes :\n"
        "- `text` doit être une sous-chaîne exacte de la ligne citée, sans la modifier.\n"
        "- 1 à 3 mots par entrée, jamais une phrase entière.\n"
        "- `impact` entre 0 et 1 : force visuelle du mot.\n"
        f"- `kind` parmi {sorted(KINDS)}.\n"
        "- `chorus` : numéros des lignes du refrain, même s'il se répète.\n"
        "- Aucun commentaire, aucun texte hors JSON."
    )
    return [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {"role": "user", "content": user_prompt},
    ]


def parse_cues(payload: dict[str, Any], lyrics: Lyrics) -> LyricCues:
    """Valide la réponse du modèle et la remappe sur les timings réels."""
    cues: list[KeywordCue] = []
    seen_starts: set[int] = set()
    raw_keywords = payload.get("keywords")
    if isinstance(raw_keywords, list):
        for item in raw_keywords:
            cue = _cue_from_item(item, lyrics)
            if cue is None or cue.start_ms in seen_starts:
                continue
            seen_starts.add(cue.start_ms)
            cues.append(cue)
    cues.sort(key=lambda cue: cue.start_ms)

    chorus: list[int] = []
    raw_chorus = payload.get("chorus")
    if isinstance(raw_chorus, list):
        for item in raw_chorus:
            if isinstance(item, int) and 0 <= item < len(lyrics.lines):
                chorus.append(item)
    return LyricCues(
        keywords=tuple(cues),
        chorus_lines=tuple(sorted(set(chorus))),
        source="llm",
    )


def _cue_from_item(item: Any, lyrics: Lyrics) -> KeywordCue | None:
    if not isinstance(item, dict):
        return None
    line_index = item.get("line")
    text = item.get("text")
    if not isinstance(line_index, int) or not 0 <= line_index < len(lyrics.lines):
        return None
    if not isinstance(text, str) or not text.strip():
        return None
    line = lyrics.lines[line_index]
    window = _locate(line, text.strip())
    if window is None:
        return None
    start_ms, end_ms = window
    impact = item.get("impact")
    impact_value = float(impact) if isinstance(impact, (int, float)) else 0.5
    kind = item.get("kind")
    kind_value = kind if isinstance(kind, str) and kind in KINDS else "image"
    return KeywordCue(
        text=text.strip(),
        line_index=line_index,
        start_ms=start_ms,
        end_ms=max(end_ms, start_ms),
        impact=min(max(impact_value, 0.0), 1.0),
        kind=kind_value,
    )


def _locate(line: LyricLine, needle: str) -> tuple[int, int] | None:
    """Retrouve une sous-chaîne dans une ligne et renvoie ses bornes en ms."""
    position = line.text.lower().find(needle.lower())
    if position < 0:
        return None
    end_char = position + len(needle)
    if line.words:
        offset = 0
        hits = []
        for word in line.words:
            word_start = offset
            word_end = offset + len(word.text)
            if word_end > position and word_start < end_char:
                hits.append(word)
            offset = word_end
        if not hits:
            return None
        return hits[0].start_ms, hits[-1].end_ms
    span = max(1, len(line.text))
    duration = max(0, line.end_ms - line.start_ms)
    start_ms = line.start_ms + round(duration * position / span)
    end_ms = line.start_ms + round(duration * end_char / span)
    return start_ms, end_ms


def detect_chorus(lines: tuple[LyricLine, ...], *, min_repeats: int = 2) -> tuple[int, ...]:
    """Repère le refrain par répétition de blocs de lignes, sans modèle."""
    normalized = [normalize_text(line.text) for line in lines]
    if not any(normalized):
        return ()

    best: tuple[int, int, int, tuple[str, ...]] | None = None
    for size in (1, 2, 3, 4):
        first_seen: dict[tuple[str, ...], int] = {}
        counts: dict[tuple[str, ...], int] = {}
        for index in range(len(normalized) - size + 1):
            window = tuple(normalized[index : index + size])
            if not all(window):
                continue
            counts[window] = counts.get(window, 0) + 1
            first_seen.setdefault(window, index)
        for window, count in counts.items():
            if count < min_repeats:
                continue
            # Priorité aux blocs les plus répétés, puis les plus longs.
            candidate = (count, size, -first_seen[window], window)
            if best is None or candidate > best:
                best = candidate

    if best is None:
        return ()
    _count, size, _first, window = best
    chorus: set[int] = set()
    for index in range(len(normalized) - size + 1):
        if tuple(normalized[index : index + size]) == window:
            chorus.update(range(index, index + size))
    return tuple(sorted(chorus))


_STOPWORDS = {
    "alors",
    "appelle",
    "après",
    "aujourd",
    "aussi",
    "autre",
    "avant",
    "avec",
    "avoir",
    "beaucoup",
    "bien",
    "c'est",
    "cette",
    "comme",
    "comment",
    "dans",
    "depuis",
    "derrière",
    "dessus",
    "deux",
    "dire",
    "donc",
    "elle",
    "encore",
    "entre",
    "être",
    "faire",
    "faut",
    "femme",
    "gens",
    "jamais",
    "jour",
    "juste",
    "leur",
    "laisse",
    "maison",
    "même",
    "mieux",
    "moins",
    "monde",
    "nous",
    "notre",
    "nuit",
    "parce",
    "parler",
    "passer",
    "pendant",
    "petit",
    "peut",
    "plus",
    "pour",
    "pourquoi",
    "prendre",
    "presque",
    "quand",
    "quelque",
    "rien",
    "sans",
    "seulement",
    "soir",
    "sont",
    "sous",
    "souvent",
    "temps",
    "toujours",
    "toute",
    "toutes",
    "tous",
    "trop",
    "venir",
    "vers",
    "vouloir",
    "vraiment",
}


def heuristic_keywords(
    lyrics: Lyrics, *, max_keywords: int = DEFAULT_MAX_KEYWORDS
) -> tuple[KeywordCue, ...]:
    """Repli sans modèle : les mots les plus longs des lignes les plus denses."""
    candidates: list[KeywordCue] = []
    seen: set[str] = set()
    for index, line in enumerate(lyrics.lines):
        words = re.findall(r"[0-9A-Za-zÀ-ÖØ-öø-ÿ'’-]+", line.text)
        if not words:
            continue
        best = max(words, key=len)
        normalized = normalize_text(best)
        if len(normalized) < 5 or normalized in _STOPWORDS or normalized in seen:
            continue
        window = _locate(line, best)
        if window is None:
            continue
        seen.add(normalized)
        start_ms, end_ms = window
        candidates.append(
            KeywordCue(
                text=best,
                line_index=index,
                start_ms=start_ms,
                end_ms=end_ms,
                impact=min(1.0, len(normalized) / 12.0),
                kind="image",
            )
        )
    candidates.sort(key=lambda cue: (-cue.impact, cue.start_ms))
    selected = candidates[:max_keywords]
    return tuple(sorted(selected, key=lambda cue: cue.start_ms))


def extract_cues(
    lyrics: Lyrics,
    *,
    client: GroqClient | None = None,
    max_keywords: int = DEFAULT_MAX_KEYWORDS,
) -> LyricCues:
    """Mots marquants + refrain, avec repli local si le modèle est absent."""
    chorus = detect_chorus(lyrics.lines)
    if not lyrics.lines:
        return LyricCues(source="empty")

    llm = client or GroqClient()
    if llm.configured:
        try:
            payload = llm.complete_json(build_messages(lyrics, max_keywords=max_keywords))
            cues = parse_cues(payload, lyrics)
            if cues.keywords:
                return LyricCues(
                    keywords=cues.keywords,
                    chorus_lines=cues.chorus_lines or chorus,
                    source="llm",
                    model=llm.model,
                )
        except Exception:  # noqa: BLE001 - un modèle indisponible ne casse pas le show
            pass

    return LyricCues(
        keywords=heuristic_keywords(lyrics, max_keywords=max_keywords),
        chorus_lines=chorus,
        source="heuristic",
    )


def cues_from_json(payload: dict[str, Any]) -> LyricCues:
    """Relit un cache disque (déjà validé)."""
    keywords = tuple(
        KeywordCue(
            text=str(item["text"]),
            line_index=int(item["lineIndex"]),
            start_ms=int(item["startMs"]),
            end_ms=int(item["endMs"]),
            impact=float(item.get("impact", 0.5)),
            kind=str(item.get("kind", "image")),
        )
        for item in payload.get("keywords", [])
        if isinstance(item, dict) and "text" in item
    )
    return LyricCues(
        keywords=keywords,
        chorus_lines=tuple(int(value) for value in payload.get("chorusLines", [])),
        source=str(payload.get("source", "cache")),
        model=str(payload.get("model", "")),
    )


def cues_to_json(cues: LyricCues) -> str:
    return json.dumps(cues.as_dict(), ensure_ascii=False)
