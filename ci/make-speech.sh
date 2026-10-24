#!/bin/bash
# Makes spoken test lectures with macOS text-to-speech:
#   - two short ones for the end-to-end test (English, and Arabic when a voice is available);
#   - two longer, noisy ones (about two minutes each, air conditioning-like noise and mains hum)
#     for the background test.
# Usage: make-speech.sh <output folder>. Prints KEY=path lines for $GITHUB_ENV.
set -uo pipefail
OUT=$1; mkdir -p "$OUT"
HERE=$(cd "$(dirname "$0")" && pwd)
EN="Today we will study the anterior abdominal wall. [[slnc 2500]] This is very important for the exam. [[slnc 2500]] The inguinal ligament is formed by the external oblique aponeurosis. [[slnc 1500]] Remember the boundaries of the inguinal canal."
AR="اليوم سوف ندرس جدار البطن الأمامي. [[slnc 2500]] هذه النقطة مهمة جدا للامتحان. [[slnc 2500]] الرباط الإربي يتكون من صفاق العضلة المائلة الخارجية."
VOICES=$(say -v '?')
# A natural voice. The first en_US voice in the list is often "Albert", a croaky novelty voice that
# neither noise removal nor speech recognition treats as a person.
EN_VOICE=""
for v in Samantha Alex Allison Ava Susan Tom Daniel Karen Moira Serena Fred; do
  if grep -qE "^$v +en_" <<<"$VOICES"; then EN_VOICE=$v; break; fi
done
if [ -z "$EN_VOICE" ]; then
  EN_VOICE=$(grep -E ' en_[A-Z]' <<<"$VOICES" \
    | grep -vE '^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox) ' \
    | head -1 | sed -E 's/ +[a-z]{2}_[A-Z0-9]{2,3} .*//' | sed -E 's/ +$//')
fi
AR_VOICE=$(grep -E ' ar_' <<<"$VOICES" | head -1 | sed -E 's/ +[a-z]{2}_[A-Z0-9]{2,3} .*//' | sed -E 's/ +$//')
echo "English voice: ${EN_VOICE:-Samantha}; Arabic voice: ${AR_VOICE:-none (gTTS)}" >&2
say -v "${EN_VOICE:-Samantha}" -o "$OUT/en.aiff" "$EN" && afconvert "$OUT/en.aiff" "$OUT/english-lecture.m4a" -d aac -f m4af \
  && echo "TEST_RUNNER_MENTALITY_E2E_EN=$OUT/english-lecture.m4a"
if [ -n "$AR_VOICE" ] && say -v "$AR_VOICE" -o "$OUT/ar.aiff" "$AR"; then
  afconvert "$OUT/ar.aiff" "$OUT/arabic-lecture.m4a" -d aac -f m4af && echo "TEST_RUNNER_MENTALITY_E2E_AR=$OUT/arabic-lecture.m4a"
else
  # macOS runners usually lack an Arabic voice: use Google's text-to-speech (gTTS) instead.
  echo "No Arabic macOS voice; trying gTTS." >&2
  python3 -m pip install --quiet --user gTTS >&2 || python3 -m pip install --quiet --break-system-packages gTTS >&2
  AR_PLAIN=$(echo "$AR" | sed -E 's/\[\[slnc [0-9]+\]\]//g')
  if AR_TEXT="$AR_PLAIN" AR_OUT="$OUT/ar.mp3" python3 -c 'import os; from gtts import gTTS; gTTS(os.environ["AR_TEXT"], lang="ar").save(os.environ["AR_OUT"])' >&2; then
    afconvert "$OUT/ar.mp3" "$OUT/arabic-lecture.m4a" -d aac -f m4af && echo "TEST_RUNNER_MENTALITY_E2E_AR=$OUT/arabic-lecture.m4a"
  else
    echo "::warning::No Arabic speech could be generated; the Arabic end-to-end test will be skipped (not counted as Arabic coverage)." >&2
  fi
fi

# Background-test lectures: different sentences each (repeated text would trip the quality check).
LECTURE_1=(
  "Good morning everyone, today we continue with the anterior abdominal wall."
  "The wall is made of skin, superficial fascia, three flat muscles and the transversalis fascia."
  "The external oblique is the largest and most superficial of the flat muscles."
  "Its fibers run downward and forward, like hands in your pockets."
  "This is very important for the exam, so write it down."
  "The internal oblique lies deep to it, and its fibers run upward and forward."
  "The transversus abdominis is the deepest muscle, with fibers that run horizontally."
  "Together their aponeuroses form the rectus sheath around the rectus abdominis."
  "Above the arcuate line, the sheath has both an anterior and a posterior layer."
  "Below the arcuate line, all the aponeuroses pass in front of the rectus muscle."
  "So below this line, the rectus lies directly on the transversalis fascia."
  "The linea alba is a fibrous band in the midline, between the two rectus muscles."
  "Surgeons often use it for incisions, because it has very few blood vessels."
  "The superior epigastric artery comes from the internal thoracic artery."
  "The inferior epigastric artery comes from the external iliac artery."
  "The two vessels meet inside the rectus sheath, a classic exam question."
  "Nerve supply comes from the lower six thoracic nerves and the first lumbar nerve."
  "The umbilicus lies at the level of the tenth thoracic dermatome."
  "Remember that dermatome, because it explains referred pain from the appendix."
  "Next week we will look at clinical examples of these layers."
)
LECTURE_2=(
  "Today we will talk about the inguinal canal and hernias."
  "The inguinal canal is about four centimeters long in adults."
  "It runs above the medial half of the inguinal ligament."
  "The deep ring is an opening in the transversalis fascia."
  "The superficial ring is a triangular gap in the external oblique aponeurosis."
  "In males the canal carries the spermatic cord, in females the round ligament."
  "The ilioinguinal nerve also passes through the canal, but not through the deep ring."
  "Pay attention here, this always comes in the exam."
  "The anterior wall is formed mainly by the external oblique aponeurosis."
  "The posterior wall is formed by the transversalis fascia and the conjoint tendon."
  "The roof is made by arching fibers of the internal oblique and transversus muscles."
  "The floor is the inguinal ligament, reinforced medially by the lacunar ligament."
  "An indirect hernia enters the deep ring, lateral to the inferior epigastric vessels."
  "A direct hernia pushes through the posterior wall, medial to those vessels."
  "The area where direct hernias appear is called Hesselbach's triangle."
  "Its borders are the rectus abdominis, the inferior epigastric vessels and the inguinal ligament."
  "Indirect hernias are more common, especially in young males."
  "During surgery, the mesh is placed to strengthen the posterior wall."
  "Make sure you can draw the canal and label every wall."
  "That is all for today, thank you for your attention."
)
make_long() {  # name, sentences...
  local name=$1; shift
  local text=""
  for sentence in "$@"; do text+="$sentence [[slnc 1400]] "; done
  say -v "${EN_VOICE:-Samantha}" -r 165 -o "$OUT/$name.aiff" "$text" || return 1
  afconvert "$OUT/$name.aiff" "$OUT/$name-clean.wav" -d LEI16@48000 -c 1 -f WAVE || return 1
  python3 "$HERE/mix-noise.py" "$OUT/$name-clean.wav" "$OUT/$name-noisy.wav" 8 >&2 || return 1
  afconvert "$OUT/$name-noisy.wav" "$OUT/$name.m4a" -d aac -b 96000 -f m4af || return 1
}
if make_long "Abdominal wall" "${LECTURE_1[@]}" && make_long "Inguinal canal" "${LECTURE_2[@]}"; then
  echo "TEST_RUNNER_MENTALITY_BACKGROUND_LECTURES=$OUT/Abdominal wall.m4a|$OUT/Inguinal canal.m4a"
else
  echo "::warning::Could not make the background-test lectures; the background test will be skipped." >&2
fi
