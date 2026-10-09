#!/usr/bin/env python3
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import zipfile
from xml.etree import ElementTree
from pathlib import Path


ROOT = Path(__file__).resolve().parent
E2E = ROOT.parent.parent
WEB = E2E.parent.parent
MANIFEST = ROOT / "manifest.json"
FORMATS = {
    "document": "txt md markdown pdf doc docx xls xlsx csv".split(),
    "image": "jpg jpeg png gif webp bmp svg".split(),
    "audio": "mp3 mpeg mpga wav ogg oga opus m4a aac flac webm".split(),
    "video": "mp4 m4v mov webm mkv avi mpeg mpg wmv flv f4v 3gp 3g2 m2ts ogv vob asf".split(),
    "archive": ["zip"],
    "native-map": ["kml", "kmz"],
    "converted-map": "gpx geojson ldk trk are rte wpt set fit".split(),
}
ACTIONS = {
    "document": ["read", "download-original"],
    "image": ["view", "zoom", "pan", "download-original"],
    "audio": ["play", "pause", "seek", "volume", "download-original"],
    "video": ["view", "play", "pause", "seek", "volume", "download-original"],
    "archive": ["list-members", "download-member", "download-original"],
    "native-map": ["view-map", "zoom", "pan", "download-original"],
    "converted-map": ["prepare", "view-map", "zoom", "pan", "download-original"],
}
MIMES = {
    "txt": "text/plain", "md": "text/markdown", "markdown": "text/markdown",
    "pdf": "application/pdf", "doc": "application/msword",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xls": "application/vnd.ms-excel",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "csv": "text/csv", "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
    "gif": "image/gif", "webp": "image/webp", "bmp": "image/bmp", "svg": "image/svg+xml",
    "zip": "application/zip", "kml": "application/vnd.google-earth.kml+xml",
    "kmz": "application/vnd.google-earth.kmz", "gpx": "application/gpx+xml",
    "geojson": "application/geo+json",
}
AUDIO = {
    "mp3": ("libmp3lame", "mp3", "audio/mpeg"),
    "wav": ("pcm_s16le", "wav", "audio/wav"),
    "ogg": ("libopus", "ogg", "audio/ogg"),
    "m4a": ("aac", "ipod", "audio/mp4"),
    "aac": ("aac", "adts", "audio/aac"),
    "flac": ("flac", "flac", "audio/flac"),
    "webm": ("libopus", "webm", "audio/webm"),
}
VIDEO = {
    "mp4": ("libx264", "aac", "mp4", "video/mp4"),
    "m4v": ("libx264", "aac", "ipod", "video/mp4"),
    "mov": ("libx264", "aac", "mov", "video/quicktime"),
    "webm": ("libvpx", "libopus", "webm", "video/webm"),
    "mkv": ("libx264", "aac", "matroska", "video/x-matroska"),
    "avi": ("mpeg4", "pcm_s16le", "avi", "video/x-msvideo"),
    "mpeg": ("mpeg2video", "mp2", "mpeg", "video/mpeg"),
    "wmv": ("wmv2", "wmav2", "asf", "video/x-ms-wmv"),
    "flv": ("flv", "libmp3lame", "flv", "video/x-flv"),
    "f4v": ("libx264", "aac", "f4v", "video/mp4"),
    "3gp": ("libx264", "aac", "3gp", "video/3gpp"),
    "3g2": ("libx264", "aac", "3g2", "video/3gpp2"),
    "m2ts": ("libx264", "ac3", "mpegts", "video/mp2t"),
    "ogv": ("libtheora", "libvorbis", "ogg", "video/ogg"),
    "vob": ("mpeg2video", "ac3", "vob", "video/mpeg"),
    "asf": ("wmv2", "wmav2", "asf", "video/x-ms-asf"),
}


def run(*args):
    result = subprocess.run(args, capture_output=True, timeout=60)
    if result.returncode:
        raise RuntimeError(f"{args[0]} failed: {result.stderr.decode()[-1200:]}")
    return result.stdout


def write(name, data):
    (ROOT / name).write_bytes(data.encode() if isinstance(data, str) else data)


def archive(name, members):
    with zipfile.ZipFile(ROOT / name, "w", zipfile.ZIP_DEFLATED) as output:
        for member, data in members.items():
            info = zipfile.ZipInfo(member, (2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            output.writestr(info, data.encode() if isinstance(data, str) else data)


def make_documents_and_maps():
    write("document.txt", "Контрольний файл Echo\nРядок із українським текстом: Київ, Львів, Харків.\nВерсія: поточна.\n")
    write("historical.txt", "Контрольний файл Echo\nРядок із українським текстом: Київ, Львів, Харків.\nВерсія: історична.\n")
    write("document.md", "# Контрольний документ Echo\n\n**Український текст** і *курсив*.\n\n- Київ\n- Львів\n\n[Посилання](https://example.test/echo)\n\n<script>window.fixtureScriptRan=true</script>\n")
    write("document.csv", 'Місто,Кількість,Примітка\nКиїв,2,"Текст, із комою"\nЛьвів,3,"Другий рядок"\n')
    for extension in ["pdf", "docx"]:
        shutil.copyfile(E2E / "fixtures" / f"device-file-content.{extension}", ROOT / f"document.{extension}")
    for extension, name in [("doc", "structured-document.doc"), ("xls", "formatted-workbook.xls")]:
        shutil.copyfile(WEB / "tests" / "fixtures" / "legacy-office" / name, ROOT / f"document.{extension}")
    archive("document.xlsx", {
        "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
        "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        "xl/workbook.xml": '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Міста" sheetId="1" r:id="rId1"/><sheet name="Підсумок" sheetId="2" r:id="rId2"/></sheets></workbook>',
        "xl/_rels/workbook.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
        "xl/worksheets/sheet1.xml": '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Місто</t></is></c><c r="B1" t="inlineStr"><is><t>Кількість</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Київ</t></is></c><c r="B2"><v>2</v></c></row></sheetData></worksheet>',
        "xl/worksheets/sheet2.xml": '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Усього</t></is></c><c r="B1"><v>5</v></c></row></sheetData></worksheet>',
    })
    existing = (E2E / "message-card-media-preview.fixtures.ts").read_text()
    kml = re.search(r"export const KML_PREVIEW_FIXTURE = `([^`]+)`;", existing).group(1)
    write("map.kml", kml)
    archive("map.kmz", {"doc.kml": kml})
    write("map.gpx", '<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="Echo fixture" xmlns="http://www.topografix.com/GPX/1/1"><wpt lat="50.45" lon="30.52"><name>Київ</name></wpt><trk><name>Контрольний маршрут</name><trkseg><trkpt lat="50.4" lon="30.5"/><trkpt lat="50.5" lon="30.6"/></trkseg></trk></gpx>')
    write("map.geojson", json.dumps({"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"name": "Київ"}, "geometry": {"type": "Point", "coordinates": [30.52, 50.45]}},
        {"type": "Feature", "properties": {"name": "Контрольний маршрут"}, "geometry": {"type": "LineString", "coordinates": [[30.5, 50.4], [30.6, 50.5]]}},
        {"type": "Feature", "properties": {"name": "Контрольний полігон"}, "geometry": {"type": "Polygon", "coordinates": [[[30.45, 50.4], [30.6, 50.4], [30.6, 50.55], [30.45, 50.4]]]}}
    ]}, ensure_ascii=False))
    archive("archive.zip", {"Звіт.txt": (ROOT / "document.txt").read_bytes(), "nested/Дані.csv": (ROOT / "document.csv").read_bytes(), "Мапа.kml": kml})


def make_images():
    run("magick", "-size", "80x64", "xc:none", "-fill", "#336699", "-draw", "rectangle 8,8 64,48", "-fill", "#ff8800", "-draw", "circle 40,32 40,12", str(ROOT / "image.png"))
    for extension in ["jpg", "bmp"]:
        run("magick", str(ROOT / "image.png"), "-background", "white", "-alpha", "remove", str(ROOT / f"image.{extension}"))
    for extension in ["gif", "webp"]:
        run("magick", "-delay", "60", str(ROOT / "image.png"), "(", str(ROOT / "image.png"), "-rotate", "180", ")", "-loop", "0", str(ROOT / f"image.{extension}"))
    write("image.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="64" viewBox="0 0 80 64"><rect x="8" y="8" width="56" height="40" fill="#336699"/><circle cx="40" cy="32" r="20" fill="#ff8800"/></svg>')


def make_media():
    for extension, (codec, container, _) in AUDIO.items():
        run("ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=3", "-c:a", codec, "-f", container, str(ROOT / f"audio.{extension}"))
    for extension, (video, audio, container, _) in VIDEO.items():
        if extension == "ogv" and b"libtheora" not in run("ffmpeg", "-hide_banner", "-encoders"):
            continue
        extra = ["-mpegts_m2ts_mode", "1"] if extension == "m2ts" else []
        run("ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=96x64:rate=10:duration=3", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=3", "-map", "0:v", "-map", "1:a", "-c:v", video, "-pix_fmt", "yuv420p", "-c:a", audio, "-shortest", *extra, "-f", container, str(ROOT / f"video.{extension}"))


def probe(path):
    return json.loads(run("ffprobe", "-v", "error", "-show_entries", "stream=codec_name,codec_type,width,height:format=format_name,duration", "-of", "json", str(path)))


def source(extension, category):
    aliases = {("image", "jpeg"): "jpg", ("document", "markdown"): "md", ("audio", "mpeg"): "mp3", ("audio", "mpga"): "mp3", ("audio", "oga"): "ogg", ("audio", "opus"): "ogg", ("video", "mpg"): "mpeg"}
    actual = aliases.get((category, extension), extension)
    stem = "map" if "map" in category else "archive" if category == "archive" else category
    return f"{stem}.{actual}"


def fixture(identifier, extension, category, asset=None, **overrides):
    asset = asset or source(extension, category)
    path = ROOT / asset
    available = path.is_file()
    mime = MIMES.get(extension, AUDIO.get(extension, (None, None, None))[2] if category == "audio" else VIDEO.get(extension, (None, None, None, None))[3] if category == "video" else "application/octet-stream")
    media_probe = probe(path) if available and category in ["audio", "video"] else None
    note = "Duty/Analysis browser reference has not run; byte/container checks are not preview parity."
    if category == "converted-map":
        note += " Real Alpine conversion has not run."
    if not available:
        note += " No authentic local fixture is available; this format is absent, not a passing fallback."
    viewer = "md" if extension == "markdown" else "map" if "map" in category else "zip" if category == "archive" else extension if category == "document" else category
    actions = ACTIONS[category].copy()
    if extension in ["pdf", "doc", "docx"]:
        actions.append("zoom")
    if extension == "pdf":
        actions.append("pages")
    if extension in ["xls", "xlsx"]:
        actions.append("select-sheet")
    item = {
        "id": identifier, "scenario": "format", "fileName": f"echo-{identifier}.{extension}",
        "extension": extension, "mimeType": mime, "category": category,
        "assetPath": asset if available else None,
        "sizeBytes": path.stat().st_size if available else None,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest() if available else None,
        "codec": ",".join(s["codec_name"] for s in media_probe["streams"]) if media_probe else None,
        "mediaProbe": media_probe, "expectedViewer": viewer, "expectedActions": actions,
        "availability": "present" if available else "absent", "byteRecipe": None,
        "reference": {"status": "not-run", "hosts": ["duty", "analysis"], "sameBytes": True, "note": note},
    }
    item.update(overrides)
    return item


def make_negatives():
    write("empty.txt", b"")
    write("unsupported.bin", bytes(range(32)))
    write("corrupt.pdf", b"%PDF-1.7\ntruncated fixture\n")
    write("unsafe.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="64"><script>window.fixtureScriptRan=true</script><rect width="80" height="64" fill="red"/><image href="https://example.test/echo-external.png" width="80" height="64"/></svg>')
    archive("unsafe-members.zip", {"../escape.txt": "do not save", "/absolute.txt": "do not save", "safe.txt": "allowed member"})
    password_zip = ROOT / "password.zip"
    password_zip.unlink(missing_ok=True)
    run("zip", "-q", "-j", "-P", "fixture-only", str(password_zip), str(ROOT / "document.txt"))


def make_manifest():
    items = [fixture(f"{category}-{extension}", extension, category) for category, extensions in FORMATS.items() for extension in extensions]
    items += [
        fixture("uppercase-pdf", "PDF", "document", "document.pdf", scenario="metadata", fileName="ПЕРЕВІРКА.PDF", mimeType="application/octet-stream", expectedViewer="pdf", expectedActions=["read", "zoom", "pages", "download-original"]),
        fixture("extension-only-docx", "docx", "document", scenario="metadata", fileName="Документ без суфікса", mimeType=None),
        fixture("mime-only-image", "", "image", "image.png", scenario="metadata", fileName="Зображення без суфікса", mimeType="image/png"),
        fixture("mime-only-audio", "", "audio", "audio.wav", scenario="metadata", fileName="Аудіо без суфікса", mimeType="audio/wav"),
        fixture("mime-only-video", "", "video", "video.mp4", scenario="metadata", fileName="Відео без суфікса", mimeType="video/mp4"),
        fixture("mime-only-pdf", "", "document", "document.pdf", scenario="metadata", fileName="Документ без суфікса", mimeType="application/pdf", expectedViewer="pdf", expectedActions=["read", "zoom", "pages", "download-original"]),
        fixture("docx-zip-mime", "docx", "document", scenario="metadata", mimeType="application/zip"),
        fixture("xlsx-zip-mime", "xlsx", "document", scenario="metadata", mimeType="application/zip"),
        fixture("kmz-zip-mime", "kmz", "native-map", scenario="metadata", mimeType="application/zip"),
        fixture("misleading-pdf-zip", "pdf", "archive", "archive.zip", scenario="metadata", mimeType="application/zip", expectedViewer="zip"),
        fixture("conflicting-image-name", "txt", "image", "image.png", scenario="metadata", fileName="Насправді зображення.txt", mimeType="image/png"),
        fixture("image-video-suffix", "mp4", "image", "image.png", scenario="metadata", fileName="Насправді зображення.mp4", mimeType="image/png"),
        fixture("image-audio-suffix", "mp3", "image", "image.png", scenario="metadata", fileName="Насправді зображення.mp3", mimeType="image/png"),
        fixture("historical-text", "txt", "document", "historical.txt", scenario="revision", fileName="echo-history.txt", revisionPair="text-history", expectedText="Версія: історична."),
        fixture("current-text", "txt", "document", "document.txt", scenario="revision", fileName="echo-history.txt", revisionPair="text-history", expectedText="Версія: поточна."),
        fixture("empty-text", "txt", "document", "empty.txt", scenario="negative", expectedViewer="empty", expectedActions=["download-original"]),
        fixture("unsupported-binary", "bin", "document", "unsupported.bin", scenario="negative", expectedViewer="unsupported", expectedActions=["download-original"]),
        fixture("corrupt-pdf", "pdf", "document", "corrupt.pdf", scenario="negative", expectedViewer="error", expectedActions=["download-original"]),
        fixture("password-zip", "zip", "archive", "password.zip", scenario="negative", expectedViewer="protected", expectedActions=["download-original"]),
        fixture("unsafe-zip-names", "zip", "archive", "unsafe-members.zip", scenario="negative", expectedViewer="zip", expectedActions=["list-members", "download-safe-member", "download-original"]),
        fixture("svg-script-inert", "svg", "image", "unsafe.svg", scenario="negative", expectedViewer="image", expectedActions=["view", "zoom", "pan", "download-original"], expectedScriptExecution=False),
        fixture("missing-content", "txt", "document", "intentionally-missing.txt", scenario="negative", expectedViewer="missing", expectedActions=[]),
    ]
    for identifier, extension, category, size in [("oversized-text", "txt", "document", 1024**2 + 1), ("oversized-document", "docx", "document", 10 * 1024**2 + 1), ("oversized-zip", "zip", "archive", 25 * 1024**2 + 1)]:
        item = fixture(identifier, extension, category, "not-stored-on-disk", scenario="negative", availability="present", expectedViewer="limit", expectedActions=["download-original"])
        item.update(assetPath=None, sizeBytes=size, sha256=hashlib.sha256(b"A" * size).hexdigest(), byteRecipe={"kind": "repeat", "byte": 65, "sizeBytes": size})
        item["reference"]["note"] = "Deterministic oversized bytes for the pre-parser size limit; not a valid document. Duty/Analysis reference has not run."
        items.append(item)
    MANIFEST.write_text(json.dumps(items, ensure_ascii=False, indent=2) + "\n")


def verify():
    items = json.loads(MANIFEST.read_text())
    formats = [item for item in items if item["scenario"] == "format"]
    assert len({item["extension"] for item in formats}) == 54
    assert len({item["id"] for item in items}) == len(items)
    for item in items:
        if item["availability"] == "absent":
            assert item["assetPath"] is None and item["sizeBytes"] is None and item["sha256"] is None
            continue
        recipe = item["byteRecipe"]
        data = bytes([recipe["byte"]]) * recipe["sizeBytes"] if recipe else (ROOT / item["assetPath"]).read_bytes()
        assert len(data) == item["sizeBytes"] and hashlib.sha256(data).hexdigest() == item["sha256"], item["id"]
        if item["scenario"] == "format" and item["category"] in ["audio", "video"]:
            assert probe(ROOT / item["assetPath"]) == item["mediaProbe"], item["id"]
            stream_types = {stream["codec_type"] for stream in item["mediaProbe"]["streams"]}
            assert stream_types == ({"audio", "video"} if item["category"] == "video" else {"audio"}), item["id"]
            assert float(item["mediaProbe"]["format"]["duration"]) >= 2.9, item["id"]
            run("ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(ROOT / item["assetPath"]), "-f", "null", "-")
    for name in ["document.docx", "document.xlsx", "map.kmz", "archive.zip", "unsafe-members.zip"]:
        with zipfile.ZipFile(ROOT / name) as source_zip:
            assert source_zip.testzip() is None, name
            for member in source_zip.namelist():
                if member.endswith((".xml", ".rels", ".kml")):
                    ElementTree.fromstring(source_zip.read(member))
    for name in ["map.kml", "map.gpx", "image.svg"]:
        ElementTree.parse(ROOT / name)
    assert "Polygon" in (ROOT / "map.kml").read_text()
    assert {feature["geometry"]["type"] for feature in json.loads((ROOT / "map.geojson").read_text())["features"]} == {"Point", "LineString", "Polygon"}
    for name in ["document.doc", "document.xls"]:
        assert (ROOT / name).read_bytes().startswith(bytes.fromhex("d0cf11e0a1b11ae1")), name
    assert (ROOT / "document.pdf").read_bytes().startswith(b"%PDF-")
    for name in ["image.jpg", "image.png", "image.gif", "image.webp", "image.bmp"]:
        run("magick", "identify", str(ROOT / name))
    print(json.dumps({"entries": len(items), "explicitExtensions": 54, "formatEntries": len(formats), "presentFormatEntries": sum(i["availability"] == "present" for i in formats), "absentFormatIds": [i["id"] for i in formats if i["availability"] == "absent"], "reference": "not-run", "realAlpine": "not-run"}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--verify", action="store_true")
    options = parser.parse_args()
    if not options.verify:
        make_documents_and_maps()
        make_images()
        make_media()
        make_negatives()
        make_manifest()
    verify()
