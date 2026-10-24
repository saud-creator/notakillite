#!/bin/bash
# Shows one device's results: failures as annotations, a table and the background test on the
# run's summary page, and every transcript in the log.
# Usage: summary.sh "<device title>" <results folder> <test log>...
set -uo pipefail
TITLE=$1; OUT=$2; shift 2
SUMMARY=${GITHUB_STEP_SUMMARY:-/dev/null}
WORKSPACE=${GITHUB_WORKSPACE:-$PWD}

count() { grep -ciE "Test case '[^']+' $1" "$2" || true; }

{
  echo "## $TITLE"
  echo
  echo "| Tests | Passed | Failed | Skipped |"
  echo "|---|---|---|---|"
} >> "$SUMMARY"

for log in "$@"; do
  name=$(basename "$log" .log)
  if [ ! -f "$log" ]; then
    echo "| $name | not run | | |" >> "$SUMMARY"
    continue
  fi
  echo "| $name | $(count passed "$log") | $(count failed "$log") | $(count skipped "$log") |" >> "$SUMMARY"
  # Failures as annotations on the test's source line.
  grep -E "^/.+:[0-9]+: error: " "$log" | sort -u | head -40 | while IFS= read -r line; do
    file=${line%%:*}; rest=${line#*:}; number=${rest%%:*}; message=${rest#*: error: }
    echo "::error file=${file#"$WORKSPACE"/},line=$number::$message"
  done
done

{
  failures=$(cat "$@" 2>/dev/null | grep -E "^/.+:[0-9]+: error: " | sed -E 's|^.*/||' | sort -u | head -20)
  if [ -n "$failures" ]; then
    echo
    echo "**Failures**"
    echo '```'
    echo "$failures"
    echo '```'
  fi
  skipped=$(cat "$@" 2>/dev/null | grep -E "Test skipped" | sed -E 's|^.*/||' | sort -u | head -20)
  if [ -n "$skipped" ]; then
    echo
    echo "<details><summary>Skipped tests and why</summary>"
    echo
    echo '```'
    echo "$skipped"
    echo '```'
    echo "</details>"
  fi
  for file in "$OUT"/*background-summary.txt "$OUT"/*without-keepalive.txt; do
    [ -f "$file" ] || continue
    echo
    case "$file" in
      *background-summary.txt) echo "**Background test** (Home pressed while the lectures were processing)";;
      *) echo "**Control test** (keep-alive switched off)";;
    esac
    echo '```'
    cat "$file"
    echo '```'
  done
  shopt -s nullglob
  transcripts=("$OUT"/transcripts/*.md)
  if [ ${#transcripts[@]} -gt 0 ]; then
    echo
    echo "**Transcripts written on this device**"
    echo
    for file in "${transcripts[@]}"; do
      echo "- $(basename "$file") · $(wc -w < "$file" | tr -d ' ') words"
    done
    for file in "${transcripts[@]}"; do
      case "$file" in *background*)
        echo
        echo "<details><summary>$(basename "$file")</summary>"
        echo
        echo '```markdown'
        head -60 "$file"
        echo '```'
        echo "</details>"
        break;;
      esac
    done
  fi
} >> "$SUMMARY"

# Everything in the log too.
for file in "$OUT"/*.txt "$OUT"/transcripts/*.md; do
  [ -f "$file" ] || continue
  echo "::group::$(basename "$file")"
  cat "$file"
  echo
  echo "::endgroup::"
done
exit 0
