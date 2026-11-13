#!/usr/bin/env python3
"""Write film log data into the EXIF of lab scans.

Takes a roll exported from Film Log (Export -> Save .md, or the rolls/<id>.json
file from a folder backup or GitHub sync) and a folder
of scans, matches each scan to its frame and writes camera, lens, aperture,
shutter, ISO, date/time, GPS location and your subject/intention/notes into
the files with ExifTool. Lightroom, darktable, Google Photos, Immich etc. then
show the real shooting data instead of the lab scanner's.

Needs: Python 3.8+ and ExifTool (https://exiftool.org; on Windows put
exiftool.exe on your PATH, on Linux install libimage-exiftool-perl).

Examples:
  python tag_scans.py kodak-gold-200.md scans/ --dry-run   # show the plan only
  python tag_scans.py kodak-gold-200.md scans/             # write the tags
  python tag_scans.py kodak-gold-200.md scans/ --offset -1 # lab number 13 = frame 12
  python tag_scans.py kodak-gold-200.md scans/ --by-order  # 1st file = 1st logged frame

Matching: by default the last number in each file name is the frame number
(000012.jpg, R1-12A.jpg, IMG_0012.jpg -> 12). --offset shifts that number.
--by-order ignores numbers and pairs sorted files with logged frames in order
(use --start to skip frames, e.g. when the first frames were blank).

ExifTool keeps a backup of each file as <name>_original unless --no-backup.
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

EXTS = {".jpg", ".jpeg", ".tif", ".tiff"}


def split_row(line):
    line = line.strip()
    if line.startswith("|"):
        line = line[1:]
    if line.endswith("|") and not line.endswith("\\|"):
        line = line[:-1]
    return [c.strip().replace("\\|", "|") for c in re.split(r"(?<!\\)\|", line)]


def parse_roll(text):
    roll = {"stock": "", "camera": "", "iso": ""}
    frames, header = [], None
    for raw in text.splitlines():
        line = raw.strip()
        m = re.match(r"^#\s+(.+)", line)
        if m and not roll["stock"]:
            roll["stock"] = m.group(1).strip()
            continue
        m = re.match(r"^-\s*(Camera|ISO):\s*(.*)$", line, re.I)
        if m:
            roll[m.group(1).lower()] = m.group(2).strip()
            continue
        if not line.startswith("|"):
            if frames and line == "---":
                break  # only the first roll of a multi-roll export
            continue
        cells = split_row(line)
        if header is None:
            header = [c.lower() for c in cells]
            continue
        if all(re.fullmatch(r":?-{2,}:?", c) or c == "" for c in cells):
            continue

        def get(name):
            for i, h in enumerate(header):
                if h.startswith(name):
                    return cells[i] if i < len(cells) else ""
            return ""

        try:
            n = int(get("#"))
        except ValueError:
            continue
        frames.append({"n": n, "aperture": get("aperture"), "shutter": get("shutter"), "lens": get("lens"),
                       "metering": get("how metered"), "when": get("date"), "loc": get("location"),
                       "subject": get("subject"), "intention": get("intention"), "notes": get("notes")})
    if not roll["iso"]:
        m = re.search(r"(\d{2,4})\D*$", roll["stock"])
        roll["iso"] = m.group(1) if m else ""
    return roll, frames


def parse_json(text):
    """Read a rolls/<id>.json file as written by folder backup or GitHub sync."""
    b = json.loads(text)
    r = b.get("roll", {})
    roll = {"stock": r.get("stock", ""), "camera": r.get("camera", ""), "iso": str(r.get("iso") or "")}
    if not roll["iso"]:
        m = re.search(r"(\d{2,4})\D*$", roll["stock"])
        roll["iso"] = m.group(1) if m else ""
    frames = []
    for s in b.get("shots", []):
        met = s.get("metering", "") + (f" ({s['meteringNote']})" if s.get("meteringNote") else "")
        when = f"{s.get('date', '')} {s.get('time', '')}".strip()
        frames.append({"n": int(s.get("n") or 0), "aperture": s.get("aperture", ""), "shutter": s.get("shutter", ""),
                       "lens": s.get("lens", ""), "metering": met, "when": when, "loc": s.get("loc", ""),
                       "subject": s.get("subject", ""), "intention": s.get("intention", ""), "notes": s.get("notes", "")})
    return roll, frames


def f_number(a):
    nums = [float(x.replace(",", ".")) for x in re.findall(r"\d+(?:[.,]\d+)?", a or "")]
    return round(sum(nums) / len(nums), 1) if nums else None


def exposure_time(s):
    s = (s or "").strip()
    m = re.match(r"^1\s*/\s*(\d+(?:[.,]\d+)?)", s)
    if m:
        return "1/" + m.group(1).replace(",", ".")
    m = re.match(r"^(\d+(?:[.,]\d+)?)\s*(s|sec|\")", s, re.I)
    if m:
        return m.group(1).replace(",", ".")
    m = re.match(r"^(\d+(?:[.,]\d+)?)$", s)
    if m:
        v = float(m.group(1).replace(",", "."))
        return "1/" + m.group(1) if v >= 2 else m.group(1)
    return None  # "B" or unreadable


def parse_when(w):
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})\s*[~?]?\s*(\d{1,2}:\d{2})?", w or "")
    if not m:
        return None
    t = (m.group(4) or "12:00").zfill(5)
    return f"{m.group(1)}:{m.group(2)}:{m.group(3)} {t}:00"


def parse_loc(t):
    m = re.search(r"(-?\d+(?:\.\d+)?)\s*°?\s*([NS])?\s*[,; ]\s*(-?\d+(?:\.\d+)?)\s*°?\s*([EW])?", t or "", re.I)
    if not m:
        return None
    lat, lon = float(m.group(1)), float(m.group(3))
    if m.group(2) and m.group(2).upper() == "S":
        lat = -abs(lat)
    if m.group(4) and m.group(4).upper() == "W":
        lon = -abs(lon)
    return (lat, lon) if abs(lat) <= 90 and abs(lon) <= 180 else None


def tags_for(roll, f):
    t = []
    cam = roll["camera"]
    if cam:
        t += [f"-Make={cam.split()[0]}", f"-Model={cam}"]
    if f["lens"]:
        t += [f"-LensModel={f['lens']}", f"-XMP-aux:Lens={f['lens']}"]
        m = re.search(r"(\d+(?:\.\d+)?)\s*mm", f["lens"])
        if m:
            t.append(f"-FocalLength={m.group(1)}")
    fn = f_number(f["aperture"])
    if fn:
        t += [f"-FNumber={fn}", f"-ApertureValue={fn}"]
    et = exposure_time(f["shutter"])
    if et:
        t += [f"-ExposureTime={et}", f"-ShutterSpeedValue={et}"]
    if roll["iso"]:
        t.append(f"-ISO={roll['iso']}")
    when = parse_when(f["when"])
    if when:
        t += [f"-DateTimeOriginal={when}", f"-CreateDate={when}", f"-XMP-photoshop:DateCreated={when}"]
    loc = parse_loc(f["loc"])
    if loc:
        lat, lon = loc
        t += [f"-GPSLatitude={abs(lat)}", f"-GPSLatitudeRef={'S' if lat < 0 else 'N'}",
              f"-GPSLongitude={abs(lon)}", f"-GPSLongitudeRef={'W' if lon < 0 else 'E'}"]
    desc = f["subject"] or ""
    if desc:
        t += [f"-ImageDescription={desc}", f"-XMP-dc:Title={desc}"]
    comment = " | ".join(x for x in [
        f"{roll['stock']}, frame {f['n']}".strip(", "),
        f"Metered: {f['metering']}" if f["metering"] else "",
        f"Intention: {f['intention']}" if f["intention"] else "",
        f"Notes: {f['notes']}" if f["notes"] else ""] if x)
    t += [f"-UserComment={comment}", f"-XMP-dc:Description={comment}"]
    return t, {"fn": fn, "et": et or "-", "when": when or "-", "gps": "yes" if loc else "-"}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("markdown", help="roll exported from Film Log: the Markdown export (.md) or a rolls/<id>.json backup file")
    ap.add_argument("scans", help="folder with the lab scans (.jpg/.tif)")
    ap.add_argument("--dry-run", action="store_true", help="only show which scan gets which frame")
    ap.add_argument("--offset", type=int, default=0, help="add this to the number in the file name")
    ap.add_argument("--by-order", action="store_true", help="pair sorted files with logged frames in order")
    ap.add_argument("--start", type=int, default=1, help="with --by-order: first frame number to use")
    ap.add_argument("--no-backup", action="store_true", help="don't keep <name>_original backups")
    a = ap.parse_args()

    text = Path(a.markdown).read_text(encoding="utf-8")
    roll, frames = parse_json(text) if a.markdown.lower().endswith(".json") else parse_roll(text)
    if not frames:
        sys.exit("No frames found. Pass a roll exported from Film Log (.md) or a rolls/<id>.json backup file.")
    files = sorted(p for p in Path(a.scans).iterdir() if p.suffix.lower() in EXTS and not p.name.endswith("_original"))
    if not files:
        sys.exit(f"No .jpg or .tif scans in {a.scans}")
    by_n = {f["n"]: f for f in frames}

    pairs = []
    if a.by_order:
        todo = [f for f in sorted(frames, key=lambda f: f["n"]) if f["n"] >= a.start]
        pairs = list(zip(files, todo + [None] * max(0, len(files) - len(todo))))
    else:
        for p in files:
            nums = re.findall(r"\d+", p.stem)
            n = int(nums[-1]) + a.offset if nums else None
            pairs.append((p, by_n.get(n)))

    print(f"{roll['stock'] or 'Roll'} · {roll['camera']} · ISO {roll['iso'] or '?'} · {len(files)} scans, {len(frames)} logged frames\n")
    print(f"{'scan':<28} {'frame':>5}  {'f/':>5} {'shutter':>8}  {'taken':<19}  gps  subject")
    jobs = []
    for p, f in pairs:
        if not f:
            print(f"{p.name:<28} {'-':>5}  (no matching frame, skipped)")
            continue
        tags, info = tags_for(roll, f)
        print(f"{p.name:<28} {f['n']:>5}  {info['fn'] or '-':>5} {info['et']:>8}  {info['when']:<19}  {info['gps']:<4} {f['subject'][:40]}")
        jobs.append((p, tags))

    if a.dry_run:
        print("\nDry run, nothing written. Run again without --dry-run to tag the files.")
        return
    exe = shutil.which("exiftool") or shutil.which("exiftool.exe")
    if not exe:
        sys.exit("\nExifTool not found. Install it from https://exiftool.org and make sure 'exiftool' runs in a terminal.")
    ok = 0
    for p, tags in jobs:
        cmd = [exe, "-charset", "exif=utf8", "-codedcharacterset=utf8", "-m"] + tags
        if a.no_backup:
            cmd.append("-overwrite_original")
        r = subprocess.run(cmd + [str(p)], capture_output=True, text=True)
        if r.returncode == 0:
            ok += 1
        else:
            print(f"! {p.name}: {(r.stderr or r.stdout).strip()}")
    print(f"\nTagged {ok} of {len(jobs)} scans.")


if __name__ == "__main__":
    main()
