from server.lyrics.sections import apply_chorus_sections, chorus_ranges


def _payload(lines, chorus):
    return {"lines": lines, "chorusLines": chorus}


def _line(start_ms: int, end_ms: int) -> dict:
    return {"text": "x", "startMs": start_ms, "endMs": end_ms, "words": []}


def test_chorus_ranges_merge_adjacent_lines() -> None:
    lines = [
        _line(9_000, 11_000),
        _line(11_000, 13_000),
        _line(20_000, 21_000),
        _line(40_000, 42_000),
    ]
    ranges = chorus_ranges(_payload(lines, [0, 1, 3]))

    assert ranges == [(9.0, 13.0), (40.0, 42.0)]


def test_chorus_ranges_without_data() -> None:
    assert chorus_ranges({}) == []
    assert chorus_ranges({"lines": [], "chorusLines": [0]}) == []


def test_apply_marks_covered_sections_only() -> None:
    schema = {
        "sections": [
            {"start": 0.0, "end": 20.0, "label": "calme", "kind": "intro"},
            {"start": 20.0, "end": 40.0, "label": "intense", "kind": "section"},
            {"start": 40.0, "end": 60.0, "label": "calme"},
        ]
    }
    payload = _payload([_line(21_000, 39_000)], [0])

    marked = apply_chorus_sections(schema, payload)

    assert marked == 1
    assert schema["sections"][0]["kind"] == "intro"
    assert schema["sections"][1]["kind"] == "refrain"
    assert "kind" not in schema["sections"][2]


def test_partial_overlap_below_threshold_is_ignored() -> None:
    schema = {"sections": [{"start": 0.0, "end": 100.0, "label": "intense"}]}
    payload = _payload([_line(0, 30_000)], [0])

    # 30 % de la section, sous le seuil de 40 %.
    assert apply_chorus_sections(schema, payload) == 0
    assert schema["sections"][0].get("kind") is None


def test_section_exactly_at_threshold_is_marked() -> None:
    schema = {"sections": [{"start": 0.0, "end": 100.0, "label": "intense"}]}
    payload = _payload([_line(0, 40_000)], [0])

    assert apply_chorus_sections(schema, payload) == 1


def test_no_chorus_means_no_change() -> None:
    schema = {"sections": [{"start": 0.0, "end": 10.0, "label": "calme"}]}
    assert apply_chorus_sections(schema, _payload([_line(0, 5_000)], [])) == 0
