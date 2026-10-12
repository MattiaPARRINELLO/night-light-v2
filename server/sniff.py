"""Détection du format audio réel, à partir des octets du fichier.

L'extension et le type MIME annoncés par le navigateur ne servent à rien :
seuls les octets décident.
"""

from __future__ import annotations

from dataclasses import dataclass

# (décalage, signature, nom lisible)
SIGNATURES: tuple[tuple[int, bytes, str], ...] = (
    (0, b"ID3", "MP3 (marque ID3)"),
    (0, b"\xff\xfb", "MP3 (MPEG couche III)"),
    (0, b"\xff\xf3", "MP3 (MPEG couche III)"),
    (0, b"\xff\xf2", "MP3 (MPEG couche III)"),
    (0, b"fLaC", "FLAC"),
    (0, b"OggS", "OGG Vorbis"),
    (0, b"\x1aE\xdf\xa3", "Matroska / WebM"),
    (0, b"FORM", "AIFF"),
    (0, b"\x30\x26\xb2\x75", "Windows Media Audio"),
)


@dataclass(frozen=True)
class SniffResult:
    format_name: str
    supported: bool
    extension_hint: str


UNKNOWN = SniffResult("format inconnu", False, "")


def _ext(hint: str) -> str:
    if "MP3" in hint:
        return "mp3"
    if "WAV" in hint:
        return "wav"
    if "FLAC" in hint:
        return "flac"
    if "OGG" in hint:
        return "ogg"
    if "M4A" in hint or "MP4" in hint:
        return "m4a"
    if "Matroska" in hint or "WebM" in hint:
        return "webm"
    if "AIFF" in hint:
        return "aiff"
    return ""


def sniff(head: bytes) -> SniffResult:
    """Identifie le format à partir des 64 premiers octets."""
    if len(head) < 12:
        return UNKNOWN

    # MPEG sans marqueur fixe : trame alignée sur 0xFF Ex/Fx.
    if head[0] == 0xFF and (head[1] & 0xE0) == 0xE0:
        return SniffResult("MP3 (MPEG audio)", True, "mp3")

    if head[:4] == b"RIFF":
        if head[8:12] == b"WAVE":
            return SniffResult("WAV (PCM)", True, "wav")
        return SniffResult("RIFF non audio", False, "")

    # Les conteneurs MP4/M4A/HE-AAC portent « ftyp » en offset 4.
    if head[4:8] == b"ftyp":
        brand = head[8:12]
        brands = {b"M4A ", b"M4B ", b"mp42", b"isom", b"iso2", b"dash", b"MSNV", b"avc1"}
        if brand in brands or brand[:3] == b"M4A":
            return SniffResult("MP4 / M4A (AAC)", True, "m4a")
        return SniffResult(f"MP4 ({brand.decode('ascii', 'ignore')})", False, "")

    for offset, signature, name in SIGNATURES:
        if head[offset : offset + len(signature)] == signature:
            return SniffResult(name, True, _ext(name))

    return UNKNOWN
