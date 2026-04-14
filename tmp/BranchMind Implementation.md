# BranchMind — Implementation Plan for Claude Code

> AI-powered Git branch advisor VS Code extension  
> Local-first inference · Privacy by architecture · Zero cold-start

---

## Project overview

BranchMind is a VS Code sidebar extension that acts as a passive AI advisor for Git branch
management. It auto-detects local inference runtimes (Ollama, LM Studio, Jan.ai,
llama.cpp), routes all analysis locally when possible, and falls back to rule-based
heuristics. No data leaves the machine by default.

**Target user:** Solo Indian developers — students, freshers, early-career engineers  
**Core value:** Fills the "senior dev advice" gap with zero cost and zero privacy risk

---

## Repository structure

```
branchmind/
├── package.json                  # VS Code extension manifest
├── tsconfig.json
├── .eslintrc.js
├── src/
│   ├── extension.ts              # Entry point — activate() / deactivate()
│   ├── core/
│   │   ├── git.ts                # Git introspection (simple-git wrapper)
│   │   ├── scanner.ts            # Workspace file scanner (project type detection)
│   │   ├── secrets.ts            # Secret redaction (regex patterns)
│   │   └── config.ts             # .branchmind/config.json read/write
│   ├── inference/
│   │   ├── router.ts             # Tier detection and routing logic
│   │   ├── local.ts              # Local model HTTP client (Ollama / OpenAI-compat)
│   │   └── rules.ts              # Rule-based heuristics (no LLM)
│   ├── sidebar/
│   │   ├── provider.ts           # WebviewViewProvider registration
│   │   ├── fresh.ts              # Fresh repo onboarding panel
│   │   ├── health.ts             # Branch health snapshot panel
│   │   └── suggestions.ts        # Live suggestion cards
│   ├── audit/
│   │   └── audit.ts              # One-time repo audit on first open
│   └── statusbar.ts              # Status bar item (tier badge + health score)
├── webview/
│   ├── index.html
│   ├── main.ts                   # Webview JS (compiled)
│   └── styles.css
└── .branchmind/
    ├── config.json               # Per-repo config (gitignored if contains API key)
    └── audit.json                # Cached audit results
```

---

## Phase 1 — Scaffold and Git core (Week 1)

### Goal
Working extension that reads a repo and renders a basic sidebar. No AI yet.

### Tasks

```
claude "scaffold a VS Code extension with TypeScript, ESLint, and esbuild bundler.
Extension name: branchmind. Publisher: vivek. Register a sidebar WebviewViewProvider
in package.json with viewType branchmind.sidebar. Activate on workspaceContains:.git"
```

```
claude "install simple-git. Create src/core/git.ts that exports:
- getBranches(): Promise<BranchSummary>
- getCommitHistory(n: number): Promise<CommitSummary[]>
- getCurrentBranch(): Promise<string>
- getBranchAge(branch: string): Promise<number>  // days since last commit
- getDiff(branch: string, contextLines?: number): Promise<string>
  // returns git diff -U{contextLines} output; default contextLines = 15
  // hard-caps output at 8000 characters — truncates diff hunks, never metadata
- getChangedFiles(): Promise<string[]>
All functions take an optional workspacePath param, defaulting to vscode workspace root."
```

```
claude "create src/core/scanner.ts that scans the workspace root for project type signals.
Read: package.json, requirements.txt, pyproject.toml, Cargo.toml, go.mod, pom.xml,
build.gradle, Makefile. Return a ProjectSignal object:
{ language: string, framework: string[], projectType: string, keywords: string[] }
Use file presence and key field values (e.g. package.json dependencies) to infer.
Return sensible defaults when files are missing."
```

```
claude "create src/core/config.ts. Config lives at .branchmind/config.json in workspace root.
Schema:
{
  version: 1,
  projectKeywords: string[],
  inferencePreference: 'local' | 'rules',
  selectedProvider: string | null,    // e.g. 'ollama' — null until user picks
  selectedEndpoint: string | null,    // e.g. 'http://localhost:11434'
  selectedModelId: string | null,     // e.g. 'mistral:7b' — null until user picks
  cloudContextScope: {
    includeBranches: boolean,         // default true
    includeCommitMessages: boolean,   // default true
    includeFilePaths: boolean,        // default false
    includeDiff: boolean,             // default false
    commitDepth: number               // default 10
  },
  customModelEndpoint?: string
}
Export readConfig(), writeConfig(), and mergeConfig() functions.
Create with defaults if file does not exist.
selectedProvider, selectedEndpoint, selectedModelId all default to null."
```

**Checkpoint:** `npm run compile` passes. Extension activates on a git repo. Sidebar panel renders with static HTML "BranchMind loading…".

---

## Phase 2 — Inference router and local model detection (Week 1–2)

### Goal
Auto-detect running local models. Route inference through the correct tier. Show
the right status bar badge.

### Tasks

```
claude "create src/inference/router.ts with the following types and logic.

Types:
  interface ProviderModel { id: string, displayName: string }
  interface DiscoveredProvider {
    name: 'ollama' | 'lmstudio' | 'jan' | 'llamacpp' | 'custom'
    endpoint: string
    models: ProviderModel[]
  }
  interface RouterResult {
    tier: 'local' | 'rules'
    availableProviders: DiscoveredProvider[]
    selected?: { provider: DiscoveredProvider, modelId: string }
  }

On activation, probe ALL of these endpoints in parallel with 800ms timeout:
- Ollama:    GET http://localhost:11434/api/tags        → parse .models[].name
- LM Studio: GET http://localhost:1234/v1/models        → parse .data[].id
- Jan.ai:    GET http://localhost:1337/v1/models        → parse .data[].id
- llama.cpp: GET http://localhost:8080/v1/models        → parse .data[].id
- Custom:    GET {config.customModelEndpoint}/v1/models → parse .data[].id if set

Collect ALL responding providers (not first-wins). A provider with zero models
is included in availableProviders but marked as having an empty models array.

If config.selectedProvider and config.selectedModelId are already set:
  → validate the selected provider is still in availableProviders
  → if valid: use it, set tier 'local'
  → if gone: set tier 'rules', clear selection from config, fire onSelectionLost callback

If no selection exists yet:
  → set tier based on whether any providers were found
  → do not auto-select — selection is always user-driven

Cache full RouterResult for 60 seconds. Re-probe every 60s via setInterval.
Export getRouter() singleton. Export onProbeComplete(cb) event hook."
```

```
claude "create src/inference/local.ts. Export callLocalModel(prompt: string, endpoint: string,
modelId: string, mode: 'commit' | 'suggest' = 'suggest'): Promise<string>.
Use fetch to POST to {endpoint}/v1/chat/completions with:
- model: modelId  // always use the user-selected model explicitly, never auto-pick
- messages: [{ role: 'user', content: prompt }]
- max_tokens: mode === 'commit' ? 150 : 400
- temperature: 0.3
Hard-cap the prompt string at 8000 characters before sending — always truncate the
diff/context section first, never branch name or file metadata.
Handle timeout (5s), network errors, and malformed JSON gracefully.
Return empty string on any failure — never throw."
```

```
claude "create src/inference/rules.ts. Implement pure rule-based heuristics with no LLM:
- suggestBranchName(changedFiles: string[], commitDraft: string): string
  → detect feat/fix/chore/docs/refactor from file paths and commit text
- checkStale(branches: BranchSummary[], thresholdDays: number): StaleBranch[]
- checkNamingConsistency(branches: string[]): ConsistencyReport
- suggestMerge(branch: string, ageDays: number, commitCount: number): boolean
- detectConvention(branches: string[]): string  // inferred prefix like 'feat/'
Export all as named functions. No async."
```

```
claude "create src/statusbar.ts. Register a VS Code status bar item (left side, priority 100).
Show:
- '$(circle-filled) {providerName} / {modelId}' in green when a model is selected and active
  e.g. 'ollama / mistral:7b'
- '$(search) select model' in blue when providers were found but no model is selected yet
- '$(circle-outline) rule-based' in gray when no providers found
- '$(warning) offline' in amber when selected provider has gone offline
Clicking the status bar item always opens the model selector quickPick
(see selectModel command). Update badge whenever router re-probes."
```

```
claude "register a VS Code command 'branchmind.selectModel' in extension.ts.
When invoked, read RouterResult from getRouter().

Step 1 — provider pick (skip if only one provider available):
  Show vscode.window.showQuickPick with one item per DiscoveredProvider:
  - label: provider.name  (e.g. 'ollama')
  - description: provider.endpoint
  - detail: '{n} model(s) available' or 'No models downloaded' if empty
  Providers with empty models[] are shown but marked as disabled (canPickMany: false,
  render them with a $(warning) prefix so the user understands why they can't pick).

Step 2 — model pick:
  Show vscode.window.showQuickPick with one item per model in selected provider:
  - label: model.id  (e.g. 'mistral:7b')
  - description: model.displayName if different from id

On selection:
  - Call writeConfig({ selectedProvider, selectedEndpoint, selectedModelId })
  - Update RouterResult.selected
  - Refresh status bar immediately

If router has no availableProviders at all:
  Show vscode.window.showInformationMessage:
  'No local LLM found. Start Ollama, LM Studio, or Jan.ai first, then click here again.'
  with a 'Re-scan' button that re-probes immediately.

Register this command in package.json contributes.commands.
Auto-invoke on first activation when providers are found but no selection exists in config."
```

**Checkpoint:** Install extension on a machine with Ollama running (2 models downloaded) and
LM Studio running (1 model). Status bar shows blue "select model". Click it — quickPick shows
both providers. Select Ollama → second quickPick shows 2 models → select one → status bar
turns green "ollama / mistral:7b". Close and reopen VS Code — selection persists from config.json.
On a machine with no LLM running, status bar shows gray "rule-based" and quickPick shows
the informational message with Re-scan button.

---

## Phase 3 — Secret redaction layer (Week 2)

### Goal
No sensitive data ever leaves the machine, even in local mode.

### Tasks

```
claude "create src/core/secrets.ts. Export redactSecrets(text: string): string.
Detect and replace with [REDACTED] the following patterns:
- API keys: AKIA*, sk-*, ghp_*, gho_*, github_pat_*, xoxb-*, xoxp-*
- Generic secrets: any word matching /(?:password|passwd|secret|api_key|token|auth)[\s]*[=:]\s*\S+/i
- Connection strings: postgresql://, mysql://, mongodb://, redis://
- .env style assignments: KEY=value where value length > 8 and contains mix of chars
- IP addresses in non-localhost form (preserve localhost and 127.x.x.x)
- Firebase service account JSON keys (any JSON object with "private_key" field)
- Supabase anon/service keys (ey* base64 strings > 100 chars)
- Stripe secret keys: sk_live_*, sk_test_*
- Razorpay API keys: rzp_live_*, rzp_test_* (India-specific)
Test with a fixture file containing 14 known secret patterns.
Redaction must run on ALL diff content before it reaches any inference call,
even local models — defence in depth.
IMPORTANT: the extended ±15-line context window (getDiff with contextLines=15)
increases secret surface area — surrounding lines may contain variable assignments
and hardcoded values not visible in a minimal diff. Always pass the full extended
diff string through redactSecrets(), not just the changed lines."
```

**Checkpoint:** Unit tests pass for all 10 secret patterns. Run `redactSecrets()` on a fixture diff containing a real-looking AWS key and confirm it is replaced.

---

## Phase 4 — Fresh repo onboarding (Week 2)

### Goal
When a repo has fewer than 5 commits, show the inference-first chip onboarding panel.

### Tasks

```
claude "create src/sidebar/fresh.ts. Export getFreshRepoHTML(signals: ProjectSignal): string.
Returns HTML for the fresh repo panel:
- Tip card: 'Fresh repo — inferred from workspace files'
- Inferred chips section: chips pre-selected from ProjectSignal, each toggleable
- Keyword input: text input, placeholder 'e.g. solo dev, auth, payments'
  - Splits on comma in real time, each token becomes a green chip
  - Enter key also commits current input
  - Each chip has an × remove button
- Suggested first branch: computed from selected chips + inferred signals
  - Updates live as chips change
  - Format: feat/{first-keyword}-setup
- All selections are posted back to extension via vscode.postMessage
  and saved to config.json"
```

```
claude "in the webview main.ts, wire up the chip interactions for the fresh repo panel:
- On comma or Enter in keyword input: split, trim, deduplicate, render green chips
- On chip × click: remove chip, re-compute branch suggestion
- On inferred chip toggle: toggle .sel class, re-compute branch suggestion
- On any change: postMessage({ type: 'updateKeywords', keywords: string[] })
Branch suggestion formula:
  slugify(chips[0]) + (chips[1] ? '-' + slugify(chips[1]) : '') + '-setup'
  prefixed with 'feat/'"
```

**Checkpoint:** Open VS Code on an empty folder with `git init`. Sidebar shows chip panel. Type `auth, postgres` — two green chips appear. Branch suggestion updates to `feat/auth-postgres-setup`. Close and reopen — config.json persists the keywords.

---

## Phase 5 — Mid-progress repo audit (Week 3)

### Goal
On first open of a repo with existing history, run a one-time audit and show the
branch health snapshot.

### Tasks

```
claude "create src/audit/audit.ts. Export runAudit(workspacePath: string): Promise<AuditResult>.
AuditResult shape:
{
  healthScore: number,          // 0–100
  healthReason: string,         // one-line explanation
  staleBranches: StaleBranch[], // branches with no commits in 7+ days
  namingIssues: string[],       // branches that break the inferred convention
  activeBranch: {
    name: string,
    ageDays: number,
    lastCommitMessage: string,
    divergenceFromMain: number  // commit count
  },
  inferredConvention: string,   // e.g. 'feat/ fix/ chore/'
  secretsWarning: boolean       // true if secrets found in recent 5 commits
}
Score formula: start at 100, deduct 10 per stale branch (max -40),
deduct 15 for inconsistent naming (>30% branches break convention),
deduct 10 for any secrets warning, deduct 5 per branch with no remote tracking (max -20).
Cache result to .branchmind/audit.json with a timestamp. Re-run only if cache is
older than last commit timestamp."
```

```
claude "create src/sidebar/health.ts. Export getHealthHTML(audit: AuditResult): string.
Renders the branch health snapshot panel:
- Score card: large number (healthScore/100) with one-line reason below
- Active branch card: name, age in days, last commit message, divergence count
- Stale branches list: each entry shows branch name, days stale, and three action
  buttons — Merge, Delete, Revive — each posts a command back to extension
- Naming issues: compact list, each with suggested rename
- Secrets warning banner: amber, only shown when secretsWarning is true
Health score color: green >75, amber 50–75, red <50"
```

```
claude "in extension.ts, wire the stale branch action buttons from the webview:
Handle postMessage types: mergeBranch, deleteBranch.
For mergeBranch: run git merge {branchName} via simple-git, show VS Code info message.
For deleteBranch: show a confirmation input box first, then run git branch -d {branchName}.
For reviveBranch: open a new VS Code terminal with git checkout -b {branchName}-revived.
After any action, re-run audit and refresh the sidebar."
```

**Checkpoint:** Open VS Code on a repo with 3 stale branches (no commits in 10+ days). Sidebar shows health score below 80, stale branches listed. Click Delete on one — confirmation dialog appears, branch deleted, sidebar refreshes with updated score.

---

## Phase 6 — Live suggestion engine (Week 3)

### Goal
As the dev works, the sidebar updates in real time with contextual branch advice.

### Tasks

```
claude "create src/sidebar/suggestions.ts. Export getSuggestions(context: SuggestionContext):
Promise<Suggestion[]>.
SuggestionContext:
{
  currentBranch: string,
  stagedFiles: string[],
  commitDraft: string,
  branchAgeDays: number,
  uncommittedChanges: boolean,
  router: RouterResult
}
Suggestion shape: { type: string, message: string, action?: string, confidence: number }
Logic:
1. Build prompt based on router tier:
   - Local: full context (branch name, staged files, commit draft, age, recent commits)
   - Rules: call rules.ts directly, no prompt
   - Cloud: scrubbed context per config.cloudContextScope
2. For local/cloud: call inference, parse response into Suggestion[]
3. Only surface suggestions with confidence > 0.7
4. Return max 3 suggestions at a time
5. If inference fails for any reason, fall back to rules.ts silently"
```

```
claude "register a VS Code file system watcher in extension.ts that triggers suggestion
refresh on:
- git index changes (watch .git/index)
- active editor file save
- terminal command that matches /git (commit|checkout|merge|branch)/
Debounce all triggers to 1200ms to avoid rapid re-firing.
After each trigger, call getSuggestions() and post results to the webview."
```

```
claude "add a pre-switch check to extension.ts. When the active git branch changes
(detected via fs.watch on .git/HEAD — event-driven, zero CPU when idle):
- Read the previous HEAD value before the watch fires, compare after
- If there are uncommitted changes, show a VS Code warning notification:
  'You have uncommitted changes on {oldBranch}. Stash or commit before switching.'
- Notification has two action buttons: 'Stash now' and 'Dismiss'
- Stash now runs git stash push -m 'branchmind-autostash' via simple-git
DO NOT use setInterval polling for branch change detection. fs.watch is
event-driven and costs zero CPU between branch switches, unlike 3s polling
which fires ~29,000 times per day regardless of activity."
```

**Checkpoint:** On a working repo, stage a file in `src/auth/`. Sidebar within 1–2 seconds shows a branch suggestion containing `feat/auth-...`. Write `fix login` as commit message — suggestion type changes to `fix/`.

---

## Phase 8 — Polish, edge cases, and config.json portability (Week 4)

### Goal
Handle the edge cases that cause mid-journey churn. Harden the full flow.

### Tasks

```
claude "implement suggestion decay in src/sidebar/suggestions.ts.
Each Suggestion has a createdAt timestamp. In the webview, suggestions older
than the most recent git event (last commit or last file save) are rendered with
50% opacity and a 'stale' badge. They are automatically removed after 5 minutes
of no new git activity. Never show stale suggestions as primary advice."
```

```
claude "implement monorepo support in src/core/git.ts.
Detect monorepo by checking for: nx.json, turbo.json, lerna.json, pnpm-workspace.yaml,
or multiple package.json files in subdirectories.
When detected, scope all git analysis to the subdirectory containing the active editor
file, not the repo root. Export getActivePackageRoot(filePath: string): string.
All git.ts functions accept an optional rootOverride parameter."
```

```
claude "add offline / degraded mode to src/inference/router.ts.
When a local model probe succeeds then subsequently fails (model stopped mid-session),
fall through to rules tier immediately without showing an error.
Cache the last 5 suggestion results in memory. When all inference is unavailable,
show cached suggestions with a 'cached' badge in the sidebar.
Status bar shows amber '$(warning) offline' badge in this state."
```

```
claude "add a .gitignore guard to src/core/config.ts. When writeConfig() is called
and the written config contains a non-empty apiKey field, check if .branchmind/
is listed in the workspace .gitignore. If not, append '.branchmind/config.json'
to .gitignore automatically and show a one-time VS Code info notification:
'BranchMind: Added config.json to .gitignore to protect your API key.'"
```

```
claude "write an end-to-end test in src/test/suite/extension.test.ts that:
1. Opens a temp git repo with 20 mock commits and 3 stale branches
2. Activates the extension
3. Asserts status bar badge is 'rule-based' (no local model in CI)
4. Asserts audit.json is created with healthScore < 100
5. Asserts the sidebar webview renders without errors
6. Stages a mock file at src/auth/login.ts
7. Asserts getSuggestions() returns at least one suggestion containing 'feat/auth'
Use @vscode/test-electron runner."
```

**Checkpoint:** All tests pass. Open on a monorepo — analysis is scoped to active package. Kill Ollama mid-session — status bar switches to amber offline, cached suggestions remain visible. Git commit with config.json staged — API key guard fires.

---

## Phase 9 — Claude Code workflow commands (Week 4 / ongoing)

Utility prompts to run throughout development:

```
# Debug a specific module in isolation
claude "explain what src/inference/router.ts is doing and identify any race conditions
in the parallel probe logic or the 60s re-probe setInterval"

# Generate JSDoc for the public API surface
claude "add JSDoc comments to all exported functions in src/core/git.ts,
src/inference/router.ts, and src/audit/audit.ts"

# Review the secrets redaction coverage
claude "review src/core/secrets.ts. Are there common secret patterns it misses?
Add patterns for: Firebase service account JSON keys, Supabase anon keys,
Stripe secret keys, and Razorpay API keys (India-specific)"

# Package for marketplace
claude "update package.json with all required VS Code marketplace fields:
displayName, description, categories, keywords, icon, repository, bugs.
Add an CHANGELOG.md with v0.1.0 entry. Run vsce package and report any errors."
```

---

## File: .branchmind/config.json (reference schema)

```json
{
  "version": 1,
  "projectKeywords": ["Python", "Flask", "REST API", "solo dev"],
  "inferencePreference": "local",
  "selectedProvider": "ollama",
  "selectedEndpoint": "http://localhost:11434",
  "selectedModelId": "mistral:7b",
  "cloudContextScope": {
    "includeBranches": true,
    "includeCommitMessages": true,
    "includeFilePaths": false,
    "includeDiff": false,
    "commitDepth": 10
  },
  "customModelEndpoint": null
}
```

`selectedProvider`, `selectedEndpoint`, `selectedModelId` are null until the user picks
a model via the quickPick. Once set, they persist across VS Code sessions.
Add to `.gitignore` only if `apiKey` field is present. Otherwise safe to commit.

---

## Inference tier decision tree (runtime)

```
Extension activates
  └─ Probe ALL endpoints in parallel (800ms timeout)
       ├─ None respond → Tier 2: Rules — status bar grey "rule-based"
       └─ One or more respond → collect DiscoveredProvider[]
            ├─ config has selectedModelId + provider still alive
            │    └─ Tier 1: Local — status bar green "{provider} / {modelId}"
            └─ No selection in config (first run or selection was wiped)
                 ├─ One provider, one model → auto-select silently, Tier 1: Local
                 └─ Otherwise → status bar blue "select model"
                      └─ User clicks → showQuickPick (provider → model)
                           └─ Selection saved to config.json → Tier 1: Local

Every 60s: re-probe all endpoints
  └─ If selected provider gone → amber "offline", fall to rules, clear selection
  └─ If new providers appeared → update availableProviders silently (no interrupt)
  └─ If tier changes for any reason → update status bar, refresh sidebar
```

---

## Payload contract (what each tier sends)

| Data field | Local (Tier 1) | Rules (Tier 2) |
|---|---|---|
| Branch names | Full | N/A |
| Commit messages | Full, all depth | N/A |
| File paths | Full | Used in-process |
| Diff content | Full (post-redact) | Used in-process |
| Source context | ±15 lines/hunk (post-redact), hard-capped at 8000 chars | Never |
| Source code | Never (full files) | Never |
| API keys / secrets | Redacted always — full extended diff | Redacted always |

---

## Token cost per local inference call

> Local inference has no monetary cost per token. "Cost" here means
> prompt size (determines prefill latency) and output size (determines
> generation latency). All figures assume the 8000-char prompt cap.

### Prompt token breakdown — suggestion call (typical)

| Prompt section | Tokens (approx) |
|---|---|
| System instruction + output format | ~50 |
| Branch name + file paths (3–5 files) | ~30 |
| Recent commit messages (10 commits × ~10 words) | ~150 |
| Diff with ±15-line context — small (500 chars) | ~125 |
| Diff with ±15-line context — medium (2 KB) | ~500 |
| Diff with ±15-line context — at cap (8000 chars) | ~2000 |
| **Total — small diff** | **~355 tokens** |
| **Total — medium diff** | **~730 tokens** |
| **Total — at cap** | **~2230 tokens** |

### Output token breakdown

| Call type | max_tokens | Typical actual output |
|---|---|---|
| Commit message (`mode='commit'`) | 150 | 30–60 tokens |
| Suggestions × 3 (`mode='suggest'`) | 400 | 120–200 tokens |

### Expected wall-clock latency per call

Latency depends on the local model and hardware. Representative figures:

| Model | Hardware | Prefill (2230 tok) | Generate (200 tok) | Total (at cap) |
|---|---|---|---|---|
| Mistral 7B | RTX 3060 (GPU) | ~0.5s | ~4s | ~4.5s |
| Llama 3.1 8B | RTX 3060 (GPU) | ~0.6s | ~5s | ~5.6s |
| Phi-3 Mini 3.8B | M1 Mac (CPU) | ~1.2s | ~4s | ~5.2s |
| Mistral 7B | CPU only (i7) | ~3s | ~20s | ~23s |

**Implication:** The 1200ms debounce is the minimum viable debounce.
On CPU-only machines, inference takes 20s+ at cap — users should be
informed the model is thinking (spinner in sidebar) and suggestions should
not block the UI thread.

### Practical token budget at 8000-char cap

```
8000 chars ÷ 4 chars/token ≈ 2000 tokens of diff content
+ ~230 tokens of metadata overhead
= ~2230 tokens input total (worst case)
+ 400 tokens output
= ~2630 tokens per suggestion call at the absolute cap
```

For the target user (solo dev, 3–10 files changed per commit), the
realistic case is a medium diff at ~730 input + 200 output = ~930 tokens.
The cap is only hit on large refactoring commits.

---

## Week-by-week summary

| Week | Deliverable |
|---|---|
| 1 | Scaffold + Git core + inference router + status bar badge |
| 2 | Secret redaction + fresh repo onboarding + local model calls |
| 3 | Mid-progress audit + live suggestion engine + pre-switch check |
| 4 | edge cases + e2e tests + package |

---

## Notes for Claude Code sessions

- Always run `npm run compile` after each phase before starting the next
- Keep `src/core/secrets.ts` as a pure function module — no VS Code imports, fully unit-testable
- The webview and extension process communicate only via `postMessage` — never share state directly
- All git operations go through `src/core/git.ts` — never call `child_process.exec('git ...')` directly
- `config.json` is the single source of truth for per-repo state — never store repo config in VS Code globalState
- Test on both a fresh empty repo and a repo with 100+ commits before each phase sign-off
- Write the whole codebase in modules that support high code-reusability
- Branch change detection MUST use `fs.watch('.git/HEAD')` — never `setInterval` polling.
  Polling at 3s = ~29,000 redundant calls/day; fs.watch fires only on actual branch switches
- `getDiff()` always uses `contextLines=15` for local inference calls. The 8000-char cap
  is enforced inside `getDiff()` by truncating hunks, not metadata — branch name and file
  paths must always reach the model intact
- `redactSecrets()` receives the full extended diff string (not just changed lines).
  The ±15-line context window exposes surrounding variable assignments and hardcoded values
- Show a spinner/loading state in the sidebar whenever a local inference call is in flight.
  On CPU-only machines inference can take 20s+ — the UI must never appear frozen
- The model selector (branchmind.selectModel) is the only place config.selectedModelId
  is written. Never auto-select a model without user intent, except the one-provider
  one-model case. User choice must always be explicit
- `callLocalModel()` receives `modelId` as a parameter — it never reads config directly.
  The caller (suggestions.ts, audit.ts) reads config and passes it in. This keeps
  local.ts a pure HTTP client with no side effects
