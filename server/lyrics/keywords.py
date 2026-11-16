"""Extraction des mots marquants d'un morceau, avec timings exacts.

Le modèle ne produit jamais d'horodatage : il renvoie un index de ligne et un
fragment de texte, que l'on remappe sur les timings du Lyricsfile. Un mot
inventé, ou absent de la ligne citée, est simplement écarté.
"""

from __future__ import annotations

import difflib
import json
import logging
import re
import unicodedata
from dataclasses import dataclass
from typing import Any

from server.retrieve.models import normalize_text

from .groq import GroqClient
from .models import LyricLine, Lyrics

PROMPT_VERSION = "2"
DEFAULT_MAX_KEYWORDS = 10
MIN_KEYWORDS = 4
# Longueur maximale d'un bloc de refrain, en lignes. Un refrain peut tenir bien
# plus de quatre lignes : s'arrêter à quatre coupait le bloc au milieu et ne
# gardait que sa queue la plus répétée.
MAX_CHORUS_LINES = 12
# Deux lignes portent la même phrase au-delà de cette ressemblance : sert à
# rattacher une variante du refrain où un mot change.
SIMILAR_RATIO = 0.8
KINDS = {"image", "action", "emotion", "lieu", "nom"}
# Type réservé aux cues produites localement, jamais demandé au modèle.
TITLE_KIND = "titre"

_LOGGER = logging.getLogger(__name__)

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
    """Résultat complet : mots marquants, refrain et lignes criées."""

    keywords: tuple[KeywordCue, ...] = ()
    chorus_lines: tuple[int, ...] = ()
    shout_lines: tuple[int, ...] = ()
    source: str = "heuristic"
    model: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "keywords": [cue.as_dict() for cue in self.keywords],
            "chorusLines": list(self.chorus_lines),
            "shoutLines": list(self.shout_lines),
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
        '"chorus": [12, 13, 14], "shout": [27, 31]}\n\n'
        "Contraintes :\n"
        "- `text` doit être une sous-chaîne exacte de la ligne citée, sans la modifier.\n"
        "- 1 à 3 mots par entrée, jamais une phrase entière.\n"
        "- `impact` entre 0 et 1 : force visuelle du mot.\n"
        f"- `kind` parmi {sorted(KINDS)}.\n"
        "- `chorus` : numéros des lignes du refrain, même s'il se répète.\n"
        "- `shout` : lignes que le public crie en concert (punchline, hook), "
        "au-delà du refrain, 2 à 4 lignes.\n"
        "- Les adlibs entre parenthèses ne sont pas des paroles : ne les choisis "
        "pas comme mots marquants et ne les compte ni dans `chorus` ni dans `shout`.\n"
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

    return LyricCues(
        keywords=tuple(cues),
        chorus_lines=_sane_chorus(lyrics, _line_indices(payload.get("chorus"), lyrics)),
        shout_lines=tuple(
            index
            for index in _line_indices(payload.get("shout"), lyrics)
            if strip_adlibs(lyrics.lines[index].text)
        ),
        source="llm",
    )


def _line_indices(raw: Any, lyrics: Lyrics) -> tuple[int, ...]:
    """Numéros de lignes valides, dédoublonnés."""
    if not isinstance(raw, list):
        return ()
    keep = {item for item in raw if isinstance(item, int) and 0 <= item < len(lyrics.lines)}
    return tuple(sorted(keep))


def _sane_chorus(lyrics: Lyrics, indices: tuple[int, ...]) -> tuple[int, ...]:
    """Nettoie un refrain fourni par le modèle.

    On écarte les adlibs, qui ne sont pas des paroles, sauf une ligne entre
    parenthèses qui reprend mot pour mot une parole chantée (un écho du
    refrain). On refuse aussi un refrain qui couvrirait presque tout le
    morceau : le modèle confond alors refrain et chanson entière.
    """
    sung_keys = {
        _chorus_key(strip_adlibs(line.text)) for line in lyrics.lines if strip_adlibs(line.text)
    }

    def usable(index: int) -> bool:
        line = lyrics.lines[index]
        return bool(strip_adlibs(line.text)) or _chorus_key(line.text) in sung_keys

    kept = tuple(index for index in indices if usable(index))
    candidates = sum(1 for index in range(len(lyrics.lines)) if usable(index))
    if candidates == 0:
        return ()
    # Un morceau très court n'a pas assez de lignes pour juger ; sur un vrai
    # morceau, un refrain qui couvre presque tout est une erreur du modèle.
    if candidates >= 8 and len(kept) > 0.75 * candidates:
        return ()
    return kept


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
    # Un mot qui ne vit que dans un adlib n'est pas une parole chantée.
    if _inside_adlib(line.text, text.strip()):
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


_PARENTHETICAL = re.compile(r"[\(\[\{][^\)\]\}]*[\)\]\}]")


def strip_adlibs(text: str) -> str:
    """Retire les adlibs entre parenthèses et resserre les espaces.

    Un adlib double la voix ou la ponctue : ce n'est pas la parole chantée.
    Il ne doit donc compter ni dans le refrain ni dans les mots marquants.
    """
    return " ".join(_PARENTHETICAL.sub(" ", text).split())


def _chorus_key(text: str) -> str:
    """Clé de comparaison d'une ligne de paroles.

    La ponctuation, les apostrophes et les espaces ne comptent pas : « j'la »,
    « j la » et « jla » sont la même parole. Les accents et les ligatures sont
    ramenés à l'ASCII pour que « cœur » et « coeur » se comparent.
    """
    folded = unicodedata.normalize("NFKD", text).casefold()
    folded = folded.replace("œ", "oe").replace("æ", "ae")
    folded = "".join(char for char in folded if not unicodedata.combining(char))
    return re.sub(r"[^a-z0-9]+", "", folded)


def _inside_adlib(text: str, fragment: str) -> bool:
    """Vrai si `fragment` ne se trouve que dans un adlib de la ligne."""
    spans = [match.span() for match in _PARENTHETICAL.finditer(text)]
    if not spans:
        return False
    start = text.lower().find(fragment.lower())
    if start < 0:
        return False
    end = start + len(fragment)
    return any(left <= start and end <= right for left, right in spans)


def _title_tokens(track_name: str) -> tuple[str, ...]:
    """Mots normalisés du titre, sans mention entre parenthèses (Remix, Explicit)."""
    cleaned = _PARENTHETICAL.sub(" ", track_name)
    return tuple(normalize_text(cleaned).split())


def _find_title(line: LyricLine, tokens: tuple[str, ...]) -> tuple[int, int] | None:
    """Bornes du titre dans une ligne, par correspondance de mots entiers."""
    if not tokens:
        return None
    wanted = " ".join(tokens)
    count = len(tokens)
    if line.words:
        for index in range(len(line.words) - count + 1):
            chunk = line.words[index : index + count]
            if normalize_text("".join(word.text for word in chunk)) == wanted:
                return chunk[0].start_ms, chunk[-1].end_ms
    # Repli sans timings de mots : répartition proportionnelle dans la ligne.
    normalized = normalize_text(line.text)
    position = normalized.find(wanted)
    if position < 0:
        return None
    span = max(1, len(normalized))
    duration = max(0, line.end_ms - line.start_ms)
    start = line.start_ms + round(duration * position / span)
    end = line.start_ms + round(duration * (position + len(wanted)) / span)
    return start, max(end, start)


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
    """Repère le refrain par répétition de blocs de lignes, sans modèle.

    Les adlibs entre parenthèses ne comptent pas : une ligne qui n'est qu'un
    adlib est écartée de la comparaison, et le reste de la ligne est comparé
    sans ses parenthèses. Une ligne purement adlib ne crée donc jamais de bloc
    de refrain et ne casse pas non plus celui de ses voisines.

    Un refrain tient souvent bien plus de quatre lignes : on cherche donc le
    plus long bloc répété, puis on rattache ses variantes (une phrase qui change
    d'une occurrence à l'autre) pour que le refrain ne s'arrête pas au milieu.
    """
    # Une ligne purement adlib est écartée, sauf si elle reprend mot pour mot
    # une parole chantée ailleurs : c'est alors un écho du refrain, pas un
    # adlib différent, et il compte comme la même ligne.
    spoken_keys = {
        _chorus_key(strip_adlibs(line.text)) for line in lines if strip_adlibs(line.text)
    }
    indexable: list[tuple[int, str]] = []
    for index, line in enumerate(lines):
        spoken = _chorus_key(strip_adlibs(line.text))
        if spoken:
            indexable.append((index, spoken))
            continue
        echo = _chorus_key(line.text)
        if echo and echo in spoken_keys:
            indexable.append((index, echo))
    if not indexable:
        return ()
    normalized = [text for _, text in indexable]
    total = len(normalized)

    best: tuple[int, int, int, int, tuple[str, ...]] | None = None
    for size in range(1, min(MAX_CHORUS_LINES, total) + 1):
        first_seen: dict[tuple[str, ...], int] = {}
        counts: dict[tuple[str, ...], int] = {}
        for index in range(total - size + 1):
            window = tuple(normalized[index : index + size])
            if not all(window):
                continue
            counts[window] = counts.get(window, 0) + 1
            first_seen.setdefault(window, index)
        for window, count in counts.items():
            if count < min_repeats:
                continue
            # Priorité à la couverture (répétitions × longueur) : un bloc long
            # chanté deux fois est un vrai refrain, alors qu'une seule ligne
            # répétée quatre fois n'en est souvent qu'un tic. À couverture
            # égale, le bloc le plus long gagne : c'est le refrain entier, pas
            # le motif qui le termine.
            candidate = (count * size, size, count, -first_seen[window], window)
            if best is None or candidate > best:
                best = candidate

    if best is None:
        return ()
    _coverage, size, _count, _first, window = best
    starts = [
        index
        for index in range(total - size + 1)
        if tuple(normalized[index : index + size]) == window
    ]
    window, starts = _extend_block(normalized, window, starts)
    size = len(window)
    chorus: set[int] = set()
    for start in starts:
        chorus.update(range(start, start + size))

    # Variantes : une occurrence du refrain dont une ou deux phrases changent
    # n'est pas reconnue par la répétition exacte. On rattache chaque passage
    # qui suit la même trame sur assez de lignes consécutives.
    chorus.update(_variant_positions(normalized, window))
    return tuple(sorted(indexable[position][0] for position in chorus))


def _majority_line(values: list[tuple[int, str]]) -> tuple[str, int]:
    """Ligne qui ressemble au plus grand nombre d'occurrences, et son support."""
    best_line = values[0][1]
    best_support = 0
    for _, line in values:
        support = sum(1 for _, other in values if _similar(line, other))
        if support > best_support:
            best_line, best_support = line, support
    return best_line, best_support


def _extend_block(
    normalized: list[str],
    window: tuple[str, ...],
    starts: list[int],
) -> tuple[tuple[str, ...], list[int]]:
    """Prolonge un bloc répété quand une ligne voisine varie d'une fois à l'autre.

    La répétition exacte s'arrête dès qu'une occurrence change un mot. Si la
    majorité des occurrences partagent tout de même la ligne suivante (ou
    précédente), elle appartient au refrain : on l'ajoute au bloc et on ne garde
    que les occurrences qui la portent. Les autres seront rattrapées comme
    variantes.
    """
    active = sorted(starts)
    if len(active) < 2:
        return window, active

    # Vers l'avant.
    while len(active) >= 2:
        size = len(window)
        values: list[tuple[int, str]] = []
        for position, start in enumerate(active):
            at = start + size
            following = active[position + 1] if position + 1 < len(active) else len(normalized)
            if at >= following:
                continue
            values.append((start, normalized[at]))
        if len(values) < 2:
            break
        line, support = _majority_line(values)
        if support < 2 or support * 2 < len(values):
            break
        window = window + (line,)
        active = [start for start, other in values if _similar(other, line)]

    # Vers l'arrière.
    while len(active) >= 2:
        size = len(window)
        values = []
        for position, start in enumerate(active):
            at = start - 1
            previous_end = active[position - 1] + size if position > 0 else 0
            if at < previous_end:
                continue
            values.append((start, normalized[at]))
        if len(values) < 2:
            break
        line, support = _majority_line(values)
        if support < 2 or support * 2 < len(values):
            break
        window = (line,) + window
        active = [start for start, other in values if _similar(other, line)]

    return window, active


def _variant_positions(
    normalized: list[str],
    window: tuple[str, ...],
) -> set[int]:
    """Positions des occurrences approximatives du refrain, en indices normalisés.

    Un passage est une variante quand il suit le bloc sur au moins un tiers de
    sa longueur (trois lignes minimum), à partir de n'importe quel décalage.
    Une ligne peut différer tant qu'elle reste proche : les choristes changent
    un mot, pas la phrase.
    """
    size = len(window)
    if size < 2:
        return set()
    # Trois lignes suffisent pour reconnaître un passage ; un long refrain
    # tolère de s'arrêter sur un fragment final.
    minimum = max(3, size // 3)
    found: set[int] = set()
    for start in range(len(normalized)):
        best_run = 0
        for offset in range(size):
            run = 0
            while (
                offset + run < size
                and start + run < len(normalized)
                and _similar(normalized[start + run], window[offset + run])
            ):
                run += 1
            best_run = max(best_run, run)
        if best_run >= minimum:
            found.update(range(start, start + best_run))
    return found


def _similar(left: str, right: str) -> bool:
    """Deux lignes portent la même phrase, à quelques mots près."""
    if left == right:
        return True
    if not left or not right:
        return False
    return difflib.SequenceMatcher(None, left, right).ratio() >= SIMILAR_RATIO


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
        words = re.findall(r"[0-9A-Za-zÀ-ÖØ-öø-ÿ'’-]+", strip_adlibs(line.text))
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


def title_cues(
    lyrics: Lyrics,
    *,
    cooldown_ms: int = 10_000,
    max_cues: int = 8,
) -> tuple[KeywordCue, ...]:
    """Repère les moments où le titre du morceau est chanté.

    Déterministe et gratuit : le titre vient des métadonnées, on le cherche dans
    les mots datés. Un intervalle minimal évite de le réafficher en boucle quand
    il revient à chaque phrase (cas d'un refrain-titre).
    """
    tokens = _title_tokens(lyrics.track_name)
    if len(" ".join(tokens)) < 3:
        return ()
    display = _PARENTHETICAL.sub(" ", lyrics.track_name).strip() or lyrics.track_name
    cues: list[KeywordCue] = []
    last_start: int | None = None
    for index, line in enumerate(lyrics.lines):
        window = _find_title(line, tokens)
        if window is None:
            continue
        start_ms, end_ms = window
        if last_start is not None and start_ms - last_start < cooldown_ms:
            continue
        cues.append(
            KeywordCue(
                text=display,
                line_index=index,
                start_ms=start_ms,
                end_ms=end_ms,
                impact=1.0,
                kind=TITLE_KIND,
            )
        )
        last_start = start_ms
        if len(cues) >= max_cues:
            break
    return tuple(cues)


def _merge_title_cues(lyrics: Lyrics, keywords: tuple[KeywordCue, ...]) -> tuple[KeywordCue, ...]:
    """Insère les cues de titre et retire un mot marquant au même instant."""
    titles = title_cues(lyrics)
    if not titles:
        return keywords
    merged = list(titles)
    for cue in keywords:
        if any(abs(cue.start_ms - title.start_ms) < 400 for title in titles):
            continue
        merged.append(cue)
    merged.sort(key=lambda cue: cue.start_ms)
    return tuple(merged)


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
            payload = llm.complete_json(
                build_messages(lyrics, max_keywords=max_keywords), temperature=0.0
            )
            cues = parse_cues(payload, lyrics)
            if cues.keywords:
                return LyricCues(
                    keywords=_merge_title_cues(lyrics, cues.keywords),
                    # Le refrain local (répétition réelle) prime : le modèle
                    # ne voit pas la musique et se trompe plus facilement.
                    chorus_lines=chorus or cues.chorus_lines,
                    shout_lines=cues.shout_lines,
                    source="llm",
                    model=llm.model,
                )
        except Exception as error:  # noqa: BLE001 - un modèle indisponible ne casse pas le show
            _LOGGER.warning("Extraction Groq en échec (%s), repli local", error)

    return LyricCues(
        keywords=_merge_title_cues(lyrics, heuristic_keywords(lyrics, max_keywords=max_keywords)),
        chorus_lines=chorus,
        shout_lines=(),
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
        shout_lines=tuple(int(value) for value in payload.get("shoutLines", [])),
        source=str(payload.get("source", "cache")),
        model=str(payload.get("model", "")),
    )


def cues_to_json(cues: LyricCues) -> str:
    return json.dumps(cues.as_dict(), ensure_ascii=False)
