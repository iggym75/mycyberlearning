# Temporary: renders the tour narration with Kokoro (Apache-2.0), British female voice.
import json, sys, numpy as np, soundfile as sf
from kokoro import KPipeline
import os
lines = json.load(open("tmp-voice/lines.json"))
only = os.environ.get("ONLY", "").split(",") if os.environ.get("ONLY") else None
if only: lines = {k: v for k, v in lines.items() if k in only}
for voice in sys.argv[1:]:
    pipe = KPipeline(lang_code="b")  # British English
    for name, text in lines.items():
        audio = np.concatenate([a for _, _, a in pipe(text, voice=voice, speed=0.97)])
        sf.write(f"tmp-voice/out/{voice}/{name}.wav", audio, 24000)
        print(voice, name, round(len(audio) / 24000, 2), "s")
