#!/usr/bin/env python3
"""
Enrich catalogue books from a Calibre library (metadata.db + cover.jpg per book).

What it does, for each book in data/catalogue.json that matches a Calibre book (by ISBN, else by title):
  - fills/corrects ISBN, publisher, publication year and authors from Calibre
  - marks isbnVerified = true when the ISBN came from your own library metadata
  - optionally copies the cover as a small JPEG thumbnail to frontend/covers/<id>.jpg and sets "logo"
It never copies Calibre's "comments" (publisher blurbs) into the site - descriptions stay in our own words.
It opens metadata.db read-only and never modifies your Calibre library.

Usage:
  python3 scripts/import_calibre.py "/path/to/Calibre Library"            # preview only
  python3 scripts/import_calibre.py "/path/to/Calibre Library" --apply    # write data/catalogue.json
  python3 scripts/import_calibre.py "/path/to/Calibre Library" --apply --covers   # also copy cover thumbnails
  python3 scripts/import_calibre.py "/path/to/Calibre Library" --apply --add-missing  # also add Calibre books not yet listed (tagged later by the refresh job)

Covers: thumbnails are resized to 240px wide if Pillow is installed (pip install pillow); otherwise copied as-is.
Book covers belong to their publishers; small thumbnails used to identify a book are common practice, but
it's your call - without --covers the site uses Open Library's cover images keyed by ISBN instead.
"""
import json, re, shutil, sqlite3, sys, unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CAT = ROOT / "data" / "catalogue.json"
COVERS = ROOT / "frontend" / "covers"

# Map publisher name variants to one label so the publisher filter doesn't split (e.g. "Packt Publishing" -> "Packt").
PUBLISHERS = [
    (r"packt", "Packt"), (r"no starch", "No Starch Press"), (r"wiley|sybex", "Wiley"), (r"o.?reilly", "O'Reilly Media"),
    (r"addison", "Addison-Wesley"), (r"pearson it cert", "Pearson IT Certification"), (r"cisco press", "Cisco Press"),
    (r"^pearson", "Pearson"), (r"microsoft press", "Microsoft Press"), (r"mcgraw", "McGraw Hill"), (r"apress", "Apress"),
    (r"manning", "Manning"), (r"crc press|taylor", "CRC Press"), (r"mit press", "MIT Press"), (r"bpb", "BPB Publications"),
]
def canon_publisher(name):
    if not name: return None
    for pat, label in PUBLISHERS:
        if re.search(pat, name, re.I): return label
    return re.sub(r",?\s+(inc|ltd|llc|limited|publishing|publishers)\.?$", "", name.strip(), flags=re.I)

def norm(s):
    s = unicodedata.normalize("NFKD", str(s or "")).lower()
    s = re.sub(r"\(.*?\)|\.(mobi|epub|pdf|azw3?)$", "", s)
    s = re.split(r":|;|/|\s[-\u2013\u2014]\s|,\s*(second|third|fourth|\d+(st|nd|rd|th))\s+edition", s)[0]
    s = re.sub(r"\b(\d+(st|nd|rd|th)|second|third|fourth|fifth)\s+edition\b|\bedition\b", "", s)
    s = re.sub(r"[\u00ae\u2122]", "", s)
    s = re.sub(r"^(the|a)\s+", "", s.strip())
    return re.sub(r"[^a-z0-9]+", " ", s).strip()

def find(item_key, by_key):
    """Exact normalised title, else a prefix match of at least three words (handles subtitles glued on without a colon)."""
    if item_key in by_key: return by_key[item_key]
    if len(item_key.split()) < 3: return None
    for k, c in by_key.items():
        if len(k.split()) >= 3 and (k.startswith(item_key + " ") or item_key.startswith(k + " ")): return c
    return None

def isbn13(raw):
    s = re.sub(r"[-\s]", "", str(raw or "")).upper()
    if re.fullmatch(r"\d{13}", s):
        return s if sum(int(d) * (3 if i % 2 else 1) for i, d in enumerate(s)) % 10 == 0 else None
    if re.fullmatch(r"\d{9}[\dX]", s):  # convert ISBN-10 to ISBN-13
        if sum((10 if d == "X" else int(d)) * (10 - i) for i, d in enumerate(s)) % 11: return None
        core = "978" + s[:9]
        return core + str((10 - sum(int(d) * (3 if i % 2 else 1) for i, d in enumerate(core)) % 10) % 10)
    return None

def slug(s):
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", unicodedata.normalize("NFKD", s.lower()))).strip("-")[:60]

def read_calibre(lib):
    db = lib / "metadata.db"
    if not db.exists(): sys.exit(f"metadata.db not found in {lib} - point at the folder that contains it.")
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    q = """
      SELECT b.id, b.title, b.path, b.has_cover, substr(b.pubdate,1,4) AS year,
        (SELECT group_concat(a.name, ' & ') FROM books_authors_link ba JOIN authors a ON a.id = ba.author WHERE ba.book = b.id) AS authors,
        (SELECT p.name FROM books_publishers_link bp JOIN publishers p ON p.id = bp.publisher WHERE bp.book = b.id) AS publisher,
        (SELECT group_concat(i.type || ':' || i.val, '|') FROM identifiers i WHERE i.book = b.id) AS ids
      FROM books b"""
    out = []
    for r in con.execute(q):
        ids = dict(x.split(":", 1) for x in (r["ids"] or "").split("|") if ":" in x)
        isbn = isbn13(ids.get("isbn"))
        year = r["year"] if r["year"] and r["year"] > "0101" else None  # Calibre uses 0101 for unknown
        out.append({"title": r["title"], "authors": r["authors"], "publisher": canon_publisher(r["publisher"]), "year": year, "isbn": isbn,
                    "cover": (lib / r["path"] / "cover.jpg") if r["has_cover"] else None, "key": norm(r["title"])})
    con.close()
    return out

def save_cover(src, dest):
    COVERS.mkdir(parents=True, exist_ok=True)
    try:
        from PIL import Image
        with Image.open(src) as im:
            im = im.convert("RGB"); im.thumbnail((240, 360))
            im.save(dest, "JPEG", quality=78, optimize=True, progressive=True)
    except ImportError:
        shutil.copyfile(src, dest)

def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args: sys.exit(__doc__)
    apply, covers, add_missing = "--apply" in sys.argv, "--covers" in sys.argv, "--add-missing" in sys.argv
    lib = Path(args[0]).expanduser()
    cal = read_calibre(lib)
    by_isbn = {c["isbn"]: c for c in cal if c["isbn"]}
    by_key = {}
    for c in sorted(cal, key=lambda c: (bool(c["isbn"]), c["year"] or ""), reverse=True):
        by_key.setdefault(c["key"], c)

    cat = json.loads(CAT.read_text(encoding="utf-8"))
    used, report = set(), {"matched": 0, "isbn_added": 0, "isbn_changed": [], "publisher_set": 0, "covers": 0, "unmatched": []}
    for item in (i for i in cat["items"] if i["type"] == "book"):
        c = by_isbn.get(item.get("isbn"))
        # Title matching is skipped for bundle entries (a specific edition you may not own in Calibre).
        if not c and not item.get("bundle"): c = find(norm(item["name"]), by_key)
        if not c:
            report["unmatched"].append(item["name"]); continue
        used.add(id(c)); report["matched"] += 1
        if c["isbn"]:
            if not item.get("isbn"): report["isbn_added"] += 1
            elif item["isbn"] != c["isbn"]: report["isbn_changed"].append(f'{item["name"]}: {item["isbn"]} -> {c["isbn"]} (your edition)')
            if item.get("isbn") and item["isbn"] != c["isbn"]:
                item["isbnAlt"] = sorted(set(item.get("isbnAlt", [])) | {item["isbn"]})  # e.g. the print ISBN; still searchable
            item["isbn"], item["isbnVerified"] = c["isbn"], True
        if c["publisher"] and item.get("publisher") != c["publisher"]:
            item["publisher"] = c["publisher"]; report["publisher_set"] += 1
        if c["year"] and not item.get("published"): item["published"] = c["year"]
        if c["authors"] and not item.get("by"): item["by"] = c["authors"]
        if covers and c["cover"] and c["cover"].exists():
            if apply: save_cover(c["cover"], COVERS / f'{item["id"]}.jpg')
            item["logo"] = f'covers/{item["id"]}.jpg'; report["covers"] += 1

    missing = [c for c in cal if id(c) not in used and c["key"]]
    if add_missing:
        ids = {i["id"] for i in cat["items"]}
        cat["sourceLists"].setdefault("calibre", {"label": "MCL curator's Calibre library", "url": None})
        for c in missing:
            iid = "book-" + slug(norm(c["title"]))
            if iid in ids: continue
            ids.add(iid)
            item = {"id": iid, "type": "book", "name": c["title"], "by": c["authors"] or "", "desc": "Description pending - edit in the admin panel.",
                    "domains": [], "level": ["intermediate"], "published": c["year"], "publisher": c["publisher"], "isbn": c["isbn"],
                    "isbnVerified": bool(c["isbn"]), "format": ["ebook"], "rating": None, "curator": True, "sources": ["calibre"], "verified": False}
            if covers and c["cover"] and c["cover"].exists():
                if apply: save_cover(c["cover"], COVERS / f"{iid}.jpg")
                item["logo"] = f"covers/{iid}.jpg"
            cat["items"].append({k: v for k, v in item.items() if v is not None})

    print(f'Calibre books: {len(cal)} | catalogue books matched: {report["matched"]} | ISBNs added: {report["isbn_added"]} | '
          f'publishers set/corrected: {report["publisher_set"]} | covers: {report["covers"]}')
    for line in report["isbn_changed"]: print("  ISBN changed:", line)
    if report["unmatched"]: print(f'  Not in Calibre ({len(report["unmatched"])}):', "; ".join(report["unmatched"][:15]), "..." if len(report["unmatched"]) > 15 else "")
    print(f'  In Calibre but not in the catalogue: {len(missing)}' + ("" if add_missing else " (use --add-missing to add them)"))
    if apply:
        CAT.write_text(json.dumps(cat, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print("Wrote data/catalogue.json. Next: npm run build, then `npm run seed -- --overwrite` to update the live site.")
    else:
        print("Preview only - add --apply to write changes.")

if __name__ == "__main__":
    main()
