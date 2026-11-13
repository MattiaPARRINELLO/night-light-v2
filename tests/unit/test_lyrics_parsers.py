from server.lyrics.models import LyricLine, Lyrics, LyricWord
from server.lyrics.parsers import parse_lrc, parse_lyricsfile

LYRICSFILE = """\
version: '1.0'
metadata:
  title: Otto
  artist: SCH
  album: JVLIVS
  duration_ms: 290000
  instrumental: false
  language: fr
lines:
- text: J'connais des tueurs que tu trouves adorables
  start_ms: 3360
  end_ms: 5077
  words:
  - text: 'J''connais '
    start_ms: 3360
  - text: 'des '
    start_ms: 3600
  - text: adorables
    start_ms: 4350
- text: Un ennemi mort
  start_ms: 8810
  end_ms: 11414
"""


def test_parse_lyricsfile_word_timings() -> None:
    metadata, lines = parse_lyricsfile(LYRICSFILE)

    assert metadata["title"] == "Otto"
    assert metadata["duration_ms"] == 290000
    assert metadata["instrumental"] is False
    assert len(lines) == 2

    first = lines[0]
    assert first.text == "J'connais des tueurs que tu trouves adorables"
    assert first.start_ms == 3360
    assert first.end_ms == 5077
    assert first.word_synced
    assert [word.text for word in first.words] == ["J'connais ", "des ", "adorables"]
    # Une fin de mot implicite vaut le début du mot suivant.
    assert first.words[0].end_ms == 3600
    assert first.words[1].end_ms == 4350
    # Le dernier mot finit avec la ligne.
    assert first.words[2].end_ms == 5077

    # Sans end_ms, la ligne se termine au début de la suivante.
    assert lines[1].end_ms == 11414


def test_parse_lyricsfile_single_quote_escape() -> None:
    text = (
        "lines:\n"
        "- text: 'J''connais '\n"
        "  start_ms: 10\n"
        "  words:\n"
        "  - text: 'J''connais '\n"
        "    start_ms: 10\n"
    )
    _, lines = parse_lyricsfile(text)
    assert lines[0].text == "J'connais"
    assert lines[0].words[0].text == "J'connais "


def test_parse_lrc_lines_and_metadata() -> None:
    text = "\n".join(
        [
            "[ar:SCH]",
            "[ti:Otto]",
            "[00:03.36]J'connais des tueurs",
            "[00:08.81][00:20.00]Un ennemi mort",
            "[00:11.99]",
        ]
    )
    lines = parse_lrc(text)

    assert [line.text for line in lines] == [
        "J'connais des tueurs",
        "Un ennemi mort",
        "Un ennemi mort",
    ]
    assert lines[0].start_ms == 3360
    assert lines[0].end_ms == 8810
    assert lines[1].start_ms == 8810
    assert lines[2].start_ms == 20000
    assert not any(line.word_synced for line in lines)


def test_parse_lrc_enhanced_has_words() -> None:
    text = "[00:03.36]<00:03.36>J'connais <00:03.60>des <00:03.72>tueurs"
    lines = parse_lrc(text)

    assert len(lines) == 1
    line = lines[0]
    assert line.text == "J'connais des tueurs"
    assert line.word_synced
    assert [word.text for word in line.words] == ["J'connais ", "des ", "tueurs"]
    assert line.words[0].start_ms == 3360
    assert line.words[0].end_ms == 3600
    assert line.words[2].end_ms == line.end_ms


def test_lyrics_lookup_helpers() -> None:
    lines = (
        LyricLine(
            text="un deux",
            start_ms=1000,
            end_ms=2000,
            words=(
                LyricWord("un ", 1000, 1500),
                LyricWord("deux", 1500, 2000),
            ),
        ),
    )
    lyrics = Lyrics(record_id=1, track_name="T", artist_name="A", lines=lines)

    assert lyrics.timed
    assert lyrics.word_synced
    assert lyrics.line_at(500) is None
    assert lyrics.line_at(1200) is lines[0]
    assert lyrics.word_at(1600).text == "deux"
    assert lyrics.as_dict()["lines"][0]["words"][1]["startMs"] == 1500
