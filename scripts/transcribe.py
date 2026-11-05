#!/usr/bin/env python3
"""Speech-to-text for the daily briefing's core shows, run in GitHub Actions before scripts/news.mjs.

    python3 -I scripts/transcribe.py <plan.json> <out_dir>

plan.json comes from `node scripts/news.mjs --plan`. Each episode's audio is downloaded to a temporary file,
transcribed on the CPU with faster-whisper (an open-source Whisper model, run locally: no audio or text leaves
the runner), and written to out_dir/<file>. Transcripts are only input for the summaries: they are never
committed, published or emailed. The step runs without secrets, and every failure just skips that episode,
so the briefing falls back to the show notes.

Environment: WHISPER_MODEL (default base.en), TRANSCRIBE_BUDGET_MIN (default 20: stop starting new episodes
after this many minutes), TRANSCRIBE_MAX_EPISODE_MIN (default 75: skip longer episodes).
"""
import json, os, sys, tempfile, time, urllib.request

MAX_BYTES = 200 * 1024 * 1024
MODEL = os.environ.get("WHISPER_MODEL", "base.en")
BUDGET = float(os.environ.get("TRANSCRIBE_BUDGET_MIN", "20")) * 60
MAX_EP_MIN = float(os.environ.get("TRANSCRIBE_MAX_EPISODE_MIN", "75"))


def safe_name(name):
    # Plan files are named by news.mjs (24 hex chars + .txt); refuse anything else so nothing is written outside out_dir.
    return isinstance(name, str) and len(name) == 28 and name.endswith(".txt") and all(c in "0123456789abcdef" for c in name[:24])


def download(url, dest):
    if not (isinstance(url, str) and url.startswith("https://")):
        raise ValueError("audio link is not https")
    req = urllib.request.Request(url, headers={"User-Agent": "MyCyberLearning-briefing/1.0 (+https://mycyberlearning.co.uk)"})
    with urllib.request.urlopen(req, timeout=60) as r:
        if not r.geturl().startswith("https://"):
            raise ValueError("audio redirected to a non-https address")
        size = 0
        with open(dest, "wb") as f:
            while chunk := r.read(1 << 20):
                size += len(chunk)
                if size > MAX_BYTES:
                    raise ValueError("audio file larger than 200 MB")
                f.write(chunk)
    return size


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    plan_path, out_dir = sys.argv[1], sys.argv[2]
    with open(plan_path, encoding="utf-8") as f:
        plan = json.load(f)
    os.makedirs(out_dir, exist_ok=True)
    if not plan:
        print("Nothing to transcribe")
        return

    from faster_whisper import WhisperModel  # imported here so --help and empty plans work without the package
    t0 = time.monotonic()
    model = WhisperModel(MODEL, device="cpu", compute_type="int8")
    print(f"Loaded {MODEL} in {time.monotonic() - t0:.0f}s")

    # Shortest first, so a tight time budget still covers as many shows as possible.
    for ep in sorted(plan, key=lambda e: e.get("minutes") or 30):
        label = f"{ep.get('show')}: {str(ep.get('title'))[:60]}"
        if not safe_name(ep.get("file")):
            print(f"  skip {label} (bad file name)")
            continue
        if (ep.get("minutes") or 0) > MAX_EP_MIN:
            print(f"  skip {label} ({ep['minutes']} min is over the {MAX_EP_MIN:.0f} min limit)")
            continue
        if time.monotonic() - t0 > BUDGET:
            print(f"  skip {label} (time budget used)")
            continue
        start = time.monotonic()
        with tempfile.TemporaryDirectory() as tmp:
            audio = os.path.join(tmp, "episode.audio")
            try:
                size = download(ep.get("audio"), audio)
                segments, info = model.transcribe(audio, language="en", beam_size=1, vad_filter=True, condition_on_previous_text=False)
                text = " ".join(s.text.strip() for s in segments if s.text.strip())
            except Exception as e:  # one bad episode must not stop the others
                print(f"  failed {label} ({type(e).__name__}: {str(e)[:120]})")
                continue
        with open(os.path.join(out_dir, ep["file"]), "w", encoding="utf-8") as f:
            f.write(text)
        print(f"  done {label}: {info.duration / 60:.0f} min audio ({size / 1e6:.0f} MB) in {time.monotonic() - start:.0f}s, {len(text.split())} words")
    print(f"Transcription finished in {(time.monotonic() - t0) / 60:.1f} min")


if __name__ == "__main__":
    main()
