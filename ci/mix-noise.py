"""Adds steady room noise to a spoken test lecture: an air conditioning-like rumble and hiss
(pink noise) plus mains hum, at a chosen level below the speech.

Usage: mix-noise.py input.wav output.wav [speech-to-noise ratio in dB, default 10]
Input and output are 16-bit mono WAV files.
"""
import array
import math
import random
import sys
import wave

source, target = sys.argv[1], sys.argv[2]
snr = float(sys.argv[3]) if len(sys.argv) > 3 else 10.0

with wave.open(source, "rb") as w:
    rate, channels, width = w.getframerate(), w.getnchannels(), w.getsampwidth()
    if width != 2 or channels != 1:
        sys.exit("mix-noise.py expects 16-bit mono WAV")
    samples = array.array("h", w.readframes(w.getnframes()))
if sys.byteorder == "big":
    samples.byteswap()

speech = [s / 32768.0 for s in samples]
voiced = [x * x for x in speech if abs(x) > 0.01]
speech_power = sum(voiced) / max(1, len(voiced))

rng = random.Random(7)
noise = []
b0 = b1 = b2 = 0.0
for i in range(len(speech)):
    white = rng.uniform(-1.0, 1.0)
    # Paul Kellet's economy pink noise filter.
    b0 = 0.99765 * b0 + white * 0.0990460
    b1 = 0.96300 * b1 + white * 0.2965164
    b2 = 0.57000 * b2 + white * 1.0526913
    pink = (b0 + b1 + b2 + white * 0.1848) * 0.2
    hum = 0.25 * math.sin(2 * math.pi * 50 * i / rate) + 0.08 * math.sin(2 * math.pi * 150 * i / rate)
    noise.append(pink + hum)
noise_power = sum(x * x for x in noise) / max(1, len(noise))
gain = math.sqrt(speech_power / noise_power / (10 ** (snr / 10)))

mixed = array.array("h", (max(-32768, min(32767, int(round((s + gain * n) * 32768)))) for s, n in zip(speech, noise)))
if sys.byteorder == "big":
    mixed.byteswap()
with wave.open(target, "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(rate)
    w.writeframes(mixed.tobytes())
print(f"{target}: {len(speech) / rate:.0f} s, noise {snr:.0f} dB below the speech")
