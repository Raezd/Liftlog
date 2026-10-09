#!/usr/bin/env python3
"""Generates the rest timer alert sound, rest_alert.wav.

The sound is original: three rising bell tones, played twice, synthesized
from sine waves here with no samples or outside sources. It belongs to this
project (see docs/rest-alert-sound.md). Rerun to regenerate:

    python3 scripts/make-rest-sound.py frontend/app/android/app/src/main/res/raw/rest_alert.wav

Changing the sound later needs a new channel id (rest-timer-v2), because
Android locks a channel's sound once the channel exists on a phone.
"""

import math
import struct
import sys
import wave

RATE = 44100
# A5, D6, A6: a bright rising fourth then fifth, easy to hear over gym music.
NOTES = [880.0, 1174.66, 1760.0]
NOTE_GAP = 0.14  # seconds between note starts
NOTE_LEN = 0.55  # each note rings this long
ROUND_GAP = 0.30  # silence between the two rounds
ROUNDS = 2


def bell(t: float, f: float) -> float:
    # A few inharmonic partials with fast decay sound like a small bell.
    env = math.exp(-t * 7.0) * min(1.0, t / 0.004)
    return env * (
        math.sin(2 * math.pi * f * t)
        + 0.45 * math.sin(2 * math.pi * f * 2.0 * t)
        + 0.25 * math.sin(2 * math.pi * f * 2.76 * t) * math.exp(-t * 6.0)
        + 0.12 * math.sin(2 * math.pi * f * 5.4 * t) * math.exp(-t * 12.0)
    )


def main(out: str) -> None:
    round_len = NOTE_GAP * (len(NOTES) - 1) + NOTE_LEN
    total = ROUNDS * round_len + (ROUNDS - 1) * ROUND_GAP
    samples = [0.0] * int(total * RATE)
    for r in range(ROUNDS):
        r0 = r * (round_len + ROUND_GAP)
        for i, f in enumerate(NOTES):
            start = int((r0 + i * NOTE_GAP) * RATE)
            for n in range(int(NOTE_LEN * RATE)):
                if start + n < len(samples):
                    samples[start + n] += bell(n / RATE, f)
    # Normalize to -1 dBFS peak: loud, but no clipping.
    peak = max(abs(s) for s in samples)
    gain = (10 ** (-1 / 20)) / peak
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(b"".join(struct.pack("<h", int(s * gain * 32767)) for s in samples))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "rest_alert.wav")
