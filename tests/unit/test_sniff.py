"""Détection du format audio réel."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from server import sniff


def head(signature: bytes, filler: bytes = b"\x00" * 40) -> bytes:
    return signature + filler


def test_wav_pcm() -> None:
    result = sniff.sniff(head(b"RIFF" + b"\x00\x00\x00\x00" + b"WAVE"))
    assert result.supported
    assert result.extension_hint == "wav"


def test_mp3_id3() -> None:
    result = sniff.sniff(head(b"ID3\x03\x00\x00\x00"))
    assert result.supported
    assert result.extension_hint == "mp3"


def test_mp3_frame_sync() -> None:
    result = sniff.sniff(head(b"\xff\xfb\x90\x00"))
    assert result.supported
    assert result.extension_hint == "mp3"


def test_ogg_vorbis() -> None:
    result = sniff.sniff(head(b"OggS\x00\x02"))
    assert result.supported
    assert result.extension_hint == "ogg"


def test_flac() -> None:
    result = sniff.sniff(head(b"fLaC\x00\x00"))
    assert result.supported
    assert result.extension_hint == "flac"


def test_m4a_ftyp() -> None:
    result = sniff.sniff(head(b"\x00\x00\x00\x20ftypM4A "))
    assert result.supported
    assert result.extension_hint == "m4a"


def test_extension_menteuse() -> None:
    # Un MP3 renommé .wav doit être reconnu comme MP3.
    result = sniff.sniff(head(b"ID3\x04\x00\x00\x00"))
    assert result.supported
    assert result.extension_hint == "mp3"


def test_fichier_trop_court() -> None:
    assert not sniff.sniff(b"RIFF").supported


def test_format_inconnu() -> None:
    assert not sniff.sniff(head(b"PK\x03\x04 ceci est un zip")).supported


def test_contenu_texte() -> None:
    assert not sniff.sniff(head(b"ceci n'est pas de l'audio du tout !")).supported


def test_mp4_isom_accepte() -> None:
    # Un conteneur MP4/M4A est accepté : c'est ffmpeg qui décide s'il contient
    # de l'audio lisible, et un "isom" peut parfaitement être un M4A.
    result = sniff.sniff(head(b"\x00\x00\x00\x18ftypisom"))
    assert result.supported
    assert result.extension_hint == "m4a"
