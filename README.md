# BranchMind

**AI-powered Git branch advisor for VS Code — local-first, privacy by architecture.**

BranchMind watches your repository and suggests branch names, flags stale branches, detects naming inconsistencies, and warns you before switching away from dirty working trees — all without sending a single byte to the cloud.

---

## Features

### Branch health score
A 0–100 health score is computed from your repository's branch state — stale branches, naming convention drift, and untracked remotes all affect the score. The score is cached and refreshed only when new commits appear, so it's always fast.

### AI-powered suggestions (local inference)
When a local LLM is running (Ollama, LM Studio, Jan.ai, or llama.cpp), BranchMind sends your recent diff (±15 lines of context, capped at 8 000 chars) plus staged file list to the model and shows commit message drafts and branch rename suggestions directly in the sidebar.

> **Privacy guarantee**: All inference happens on your machine. No API keys, no telemetry, no cloud calls.

### Automatic secret redaction
Before any diff reaches the model, 14 regex patterns strip credentials: AWS AKIA keys, OpenAI `sk-`, GitHub PATs, Slack tokens, Firebase private keys, Supabase JWTs, Stripe and Razorpay keys, generic `SECRET=value` assignments, connection strings, and non-localhost IPs.

### Rule-based fallback
No local model running? BranchMind's deterministic rules engine still gives you branch naming suggestions and convention checks at zero latency.

### Stale branch manager
For each stale branch (no commits in 30+ days) the panel shows:
- **Merge** — fast-forward merge into current branch
- **Delete** — confirmation-gated local branch deletion
- **Revive** — opens a terminal with `git checkout -b <name>-revived`

### Branch-switch guard
`fs.watch('.git/HEAD')` detects branch switches the instant they happen. If you have uncommitted changes, BranchMind offers to stash them with a single click.

### Monorepo support
BranchMind detects Turborepo, Nx, Lerna, and pnpm workspace layouts and scopes branch analysis to the active editor's package root.

---

## Requirements

- VS Code 1.85 or later
- A Git repository (`.git` folder must exist in the workspace root)
- *Optional*: Ollama, LM Studio, Jan.ai, or any llama.cpp-compatible local server for AI suggestions

---

## Getting started

1. Install the extension.
2. Open any Git repository in VS Code.
3. Click the **BranchMind** icon in the activity bar.
4. *(Optional)* Start a local LLM server and run **BranchMind: Select Local Model** from the Command Palette (`Ctrl+Shift+P`) to enable AI suggestions.

---

## Commands

| Command | Description |
|---------|-------------|
| `BranchMind: Select Local Model` | Discover running local LLM providers and pick a model |
| `BranchMind: Re-scan for Local Models` | Re-probe all providers and refresh the sidebar |

---

## Extension settings

BranchMind stores per-project state in a `.branchmind/` folder inside your repository (selected model, cached audit results, config). On first use, BranchMind automatically appends `.branchmind/` to your `.gitignore` — this folder contains machine-specific settings that should not be committed.

---

## Privacy

- No outbound HTTP calls except to `localhost` (local LLM endpoints).
- No telemetry or usage tracking of any kind.
- Secret redaction runs before every inference call — credentials in diffs are replaced with `[REDACTED]`.

---

## License

MIT — see [LICENSE](LICENSE).
