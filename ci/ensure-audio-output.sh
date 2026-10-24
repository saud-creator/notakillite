#!/bin/bash
# The app keeps working in the background by playing silent audio, and the simulator plays audio
# through the Mac it runs on. GitHub's Mac runners are virtual machines that may have no sound
# output at all, so add the free BlackHole virtual output when there is none.
# Never fails the job: the background test itself reports whether the audio keep-alive ran.
set -uo pipefail

output_name() {
  system_profiler SPAudioDataType 2>/dev/null | awk '
    /^        [^ ].*:$/ { name = $0; sub(/^ +/, "", name); sub(/:$/, "", name) }
    /Default Output Device: Yes/ { print name; exit }'
}

NAME=$(output_name)
if [ -n "$NAME" ]; then
  echo "Sound output on this runner: $NAME"
  exit 0
fi

echo "No sound output on this runner; adding BlackHole (a virtual sound device)."
brew install --cask blackhole-2ch || echo "::warning::Installing BlackHole failed."
sudo killall coreaudiod 2>/dev/null || sudo launchctl kickstart -kp system/com.apple.audio.coreaudiod 2>/dev/null || true
for _ in $(seq 1 15); do
  NAME=$(output_name)
  [ -n "$NAME" ] && break
  sleep 2
done

if [ -z "$NAME" ] && brew install switchaudio-osx >/dev/null 2>&1; then
  SwitchAudioSource -t output -s "BlackHole 2ch" || true
  sleep 2
  NAME=$(output_name)
fi

if [ -n "$NAME" ]; then
  echo "Sound output on this runner: $NAME"
else
  echo "::warning::This runner still has no sound output. The background test will show whether the simulator could play the silent keep-alive audio."
  system_profiler SPAudioDataType 2>/dev/null || true
fi
exit 0
