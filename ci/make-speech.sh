#!/bin/bash
# Makes short spoken "lectures" with macOS text-to-speech for the end-to-end test.
# Usage: make-speech.sh <output folder>. Prints KEY=path lines for $GITHUB_ENV.
set -uo pipefail
OUT=$1; mkdir -p "$OUT"
EN="Today we will study the anterior abdominal wall. [[slnc 2500]] This is very important for the exam. [[slnc 2500]] The inguinal ligament is formed by the external oblique aponeurosis. [[slnc 1500]] Remember the boundaries of the inguinal canal."
AR="اليوم سوف ندرس جدار البطن الأمامي. [[slnc 2500]] هذه النقطة مهمة جدا للامتحان. [[slnc 2500]] الرباط الإربي يتكون من صفاق العضلة المائلة الخارجية."
EN_VOICE=$(say -v '?' | awk '/en_US/ {print $1; exit}')
AR_VOICE=$(say -v '?' | grep -E 'ar_' | head -1 | sed -E 's/ +[a-z]{2}_[A-Z0-9]{2,3} .*//' | sed -E 's/ +$//')
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
