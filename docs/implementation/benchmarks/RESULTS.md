# Measured results

Environment: Linux x86-64, effective CPU quota 2, AMD EPYC 9V45 host. These are short-clip screening results, not Windows or full-lecture performance claims. Model: pinned large-v3-turbo q8_0; persistent CPU worker with OpenBLAS. Each public fixture was run three times in a separate cold worker.

| Public fixture | Audio seconds | Median processing seconds | Median RTF | Normalized WER |
|---|---:|---:|---:|---:|
| en_us-1904 | 10.56 | 14.05 | 1.331 | 10.5% |
| en_us-1675 | 8.76 | 10.72 | 1.224 | 9.5% |
| ar_eg-1993 | 8.16 | 9.97 | 1.221 | 6.7% |
| ar_eg-1730 | 14.16 | 10.53 | 0.744 | 23.3% |

Four unique clips: 12/85 word errors (14.1% normalized WER); repeated runs are not counted as extra reference words. The dataset supplies human transcripts, not an independent review in this session. This tiny sample cannot establish medical or code-switching accuracy.

## PDF screening and shipped default

Two English clips were screened once in audio-only, matched-glossary and wrong-glossary modes. Matched vocabulary worsened one clip from 10.5% to 47.4% WER. No configured forbidden terms were inserted in these six runs, which is not sufficient to prove hallucination safety. Consequently PDF bias is disabled by default. Attached PDFs provide vocabulary and page references; explicit passage retries produce reviewable suggestions. The CLI experimental bias flag remains opt-in.

The PDF screening was performed before this default-off gate was added. `pdfContext: true` in that screening enabled prompt vocabulary; the current runner additionally requires `options.pdfBias: true` to reproduce that experiment.

## Limitations and failures

The initial tiny CLI run completed the English clips but crashed on an Arabic clip in upstream whisper.cpp, including a retry without VAD. Do not declare tiny/Arabic supported from this evidence. The default turbo native worker completed all 12 runs.

The earlier 12-second private-sample CLI/worker comparison is exploratory: results vary, and a retained worker could consume idle OpenMP resources. OMP_WAIT_POLICY=PASSIVE was added afterward. Those numbers do not demonstrate a 2× end-to-end speedup. No full 41-minute before/after run or GPU benchmark was performed.

Tests demonstrate that a 47-second suspect interval needs a 53-second padded retry window rather than a five-minute retry. That is a work-reduction example, not a measured whole-job speedup.
