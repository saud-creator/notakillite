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
  echo "No Arabic text-to-speech voice on this runner; the Arabic speech test will be skipped." >&2
fi
