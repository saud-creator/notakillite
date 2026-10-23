# REA investigation setup

The requested repository was cloned to `reference-rea` at commit
`c3d7d0aafc4943c82a5a8513cd3da7f4a7cfe643`, package version `6.7.0`.
REA was used to analyze the downloaded public Notability production scripts.
The app's authenticated export validation is separate from this static analysis.

## Actual execution result

The final escalated REA invocation completed with exit code `0` and no top-level
error. No MCP registration was changed. The first sandboxed attempt failed the
Windows native path self-test; rerunning outside that sandbox resolved it.

The actual static analysis command was:

```powershell
node '%USERPROFILE%\AppData\Local\npm-cache\_npx\a1722018f28f9df2\node_modules\rea-agents\scripts\rea.mjs' analyze-javascript-application '%USERPROFILE%\Documents\notakillite\research\notability-public' --json > 'research\rea-evidence.json' 2> 'research\rea-progress.log'
```

The result is preserved in `rea-evidence.json` (232,538,421 bytes). The compact
release artifact `rea-summary.json` (4,064 bytes) retains provenance, counts,
parameters, and all top-level/result limitations without the large raw graph.

- Evidence ID: `ev_24a85d5e4a55552f01054f69af6d243e3e33676cf18e34d69898c52db6fb01e1`.
- Root artifact SHA-256: `3aacfdf07a5d2b28efcc92431a4fdd9541419ce9661a508ad38a1072bc36b7cb`.
- Input: 12 relevant files, 7,014,828 text bytes read.
- Parsing: 10 JavaScript files parsed, 1 skipped, 0 syntax parse failures;
  1,818,249 AST nodes visited.
- Structural graph: 1,367 nodes and 3,734 edges, including 238 endpoint nodes,
  20 storage nodes, and 2 worker nodes.
- Findings: 3,712; integrity contradictions: 0.

Coverage remains partial: the worker exhausted its heap on
`main-Ve_jYu3O.js`. REA records that limitation explicitly. Its graph recovers
static relationships and candidates from inert syntax; it does not prove
runtime execution or successful authenticated requests. `NOTABILITY-ADAPTER.md`
also contains focused direct inspection of the same public scripts, including
the service singleton and recording asset reader used by the app.

## Running the requested tool

REA's dispatcher, `reference-rea/scripts/rea.mjs`, requires compiled `dist/`
artifacts. Node's TypeScript stripping is insufficient because source imports
use `.js` names and worker aliases point into `dist/`.

The supported source checkout workflow is:

```powershell
# In reference-rea; HUSKY=0 avoids installing this reference checkout's Git hooks.
$env:HUSKY = '0'
npm ci
npm run build:cached
node scripts/rea.mjs analyze-javascript-application '%USERPROFILE%\Documents\notakillite\research\notability-public' --json > '..\research\rea-evidence.json'
```

The repository's own skill also explicitly supports a package CLI fallback
without MCP registration or a native analysis engine:

```powershell
npx -y rea-agents@6.7.0 analyze-javascript-application '%USERPROFILE%\Documents\notakillite\research\notability-public' --json > 'research\rea-evidence.json'
```

Run the version-pinned package fallback from the app workspace. It downloads
dependencies into npm's cache but does not register MCP, alter Codex settings,
or install Hopper/Ghidra. Network acquisition uses the normal execution approval.
Do not run `rea setup` for this CLI-only investigation.

Use the complete evidence file for subsequent analysis. A compact summary can
be projected with `inspect-analysis-view` and this request in a JSON file:

```json
{
  "source": {
    "kind": "evidence-file",
    "path": "%USERPROFILE%\\Documents\\notakillite\\research\\rea-evidence.json"
  },
  "view": { "kind": "summary" }
}
```

The complete result can be much larger than its summary. Static endpoint names,
route strings, and code paths are candidates; they do not prove a successful
account login, recording download, or actual runtime use of that path.

## Inspecting a signed-in browser later

REA attaches to a caller-owned Chrome-family browser exposing a literal
loopback CDP endpoint. A selected tab must already have committed its HTTPS
navigation. A page stuck on `about:blank` is not a valid Notability target.

```powershell
rea list-browser-targets http://127.0.0.1:9222 --allowed-origins https://notability.com --json
rea inspect-web-page http://127.0.0.1:9222 ACTUAL_TARGET_ID --observation-ms 1000 --json
rea analyze-web-bundle http://127.0.0.1:9222 ACTUAL_TARGET_ID --json
rea observe-web-session http://127.0.0.1:9222 ACTUAL_TARGET_ID --observation-ms 10000 --json
```

The user performs login and playback in that browser. Passive REA observation
does not click, evaluate target code, capture earlier activity, or provide raw
authentication headers/storage values/response bodies. Thus REA alone cannot
implement recording download merely by observing a page. The app needs its own
explicit authenticated browser/network integration, separately verified.

An exported HAR can be inspected offline, without fetching its recorded URLs:

```powershell
rea inspect-web-network-capture 'C:\absolute\session.har' har --json
```

Keep authenticated HAR files private because their source may include account
data. The app should not log passwords, session cookies, bearer tokens, or
signed recording URLs in diagnostics.

## Inspected repository references

- `AGENTS.md` — source build workflow and evidence distinctions.
- `.agents/skills/reverse-engineer-anything/SKILL.md` — CLI fallback, no setup requirement.
- `.agents/skills/reverse-engineer-anything/references/runtime-observation.md` — passive observation boundaries.
- `docs/cli.md` — evidence-file projection and CLI usage.
- `docs/browser-observation.md` — CDP target and exact-origin boundaries.
- `docs/web-network-captures.md` — offline HAR inspection.
- `scripts/rea.mjs` — compiled-runtime requirement.
- `package.json` — package version, engine constraints, dependencies and build scripts.
