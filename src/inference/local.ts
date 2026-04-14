const CALL_TIMEOUT_MS = 5000;
const PROMPT_CHAR_CAP = 8000;

export type InferenceMode = 'commit' | 'suggest';

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens: number;
  temperature: number;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string };
  }>;
}

/**
 * Cap prompt at PROMPT_CHAR_CAP characters.
 * Truncates the diff/context block first, preserving metadata at the top.
 */
function capPrompt(prompt: string): string {
  if (prompt.length <= PROMPT_CHAR_CAP) return prompt;

  // Find where the diff starts (first occurrence of "diff --git" or "@@")
  const diffStart = (() => {
    const idx1 = prompt.indexOf('diff --git');
    const idx2 = prompt.indexOf('@@');
    if (idx1 === -1 && idx2 === -1) return -1;
    if (idx1 === -1) return idx2;
    if (idx2 === -1) return idx1;
    return Math.min(idx1, idx2);
  })();

  if (diffStart === -1) {
    // No diff section found — truncate from the end
    return prompt.slice(0, PROMPT_CHAR_CAP) + '\n[truncated]';
  }

  const header = prompt.slice(0, diffStart);
  const remaining = PROMPT_CHAR_CAP - header.length - 20; // 20 chars for truncation notice
  const diffSection = prompt.slice(diffStart, diffStart + Math.max(remaining, 0));
  return header + diffSection + '\n[diff truncated at 8000 chars]';
}

async function fetchWithTimeout(
  url: string,
  body: ChatCompletionRequest,
  ms: number
): Promise<string> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(id);

    if (!res.ok) return '';

    const data = await res.json() as ChatCompletionResponse;
    return data.choices?.[0]?.message?.content?.trim() ?? '';
  } catch {
    clearTimeout(id);
    return '';
  }
}

/**
 * Call the local model. Never throws — returns '' on any failure.
 * @param prompt   The full prompt string (will be capped at 8000 chars)
 * @param endpoint Base URL of the provider e.g. "http://localhost:11434"
 * @param modelId  Explicit model ID from user selection e.g. "mistral:7b"
 * @param mode     'commit' = short output (150 tokens), 'suggest' = multi-item (400 tokens)
 */
export async function callLocalModel(
  prompt: string,
  endpoint: string,
  modelId: string,
  mode: InferenceMode = 'suggest'
): Promise<string> {
  const cappedPrompt = capPrompt(prompt);
  const maxTokens = mode === 'commit' ? 150 : 400;

  const body: ChatCompletionRequest = {
    model: modelId,
    messages: [{ role: 'user', content: cappedPrompt }],
    max_tokens: maxTokens,
    temperature: 0.3,
  };

  return fetchWithTimeout(`${endpoint}/v1/chat/completions`, body, CALL_TIMEOUT_MS);
}

/**
 * Build a suggestion prompt from structured context.
 */
export function buildSuggestionPrompt(params: {
  currentBranch: string;
  stagedFiles: string[];
  commitDraft: string;
  branchAgeDays: number;
  recentCommits: string[];
  diff: string;
}): string {
  const { currentBranch, stagedFiles, commitDraft, branchAgeDays, recentCommits, diff } = params;

  return `You are a Git branch advisor. Analyze the current development context and suggest up to 3 actionable branch management recommendations.

Current branch: ${currentBranch}
Branch age: ${branchAgeDays} days
Staged files: ${stagedFiles.length > 0 ? stagedFiles.join(', ') : 'none'}
Commit draft: ${commitDraft || '(none)'}

Recent commits:
${recentCommits.slice(0, 10).map(c => `- ${c}`).join('\n')}

Code diff (with context):
${diff}

Respond with a JSON array of suggestions:
[
  { "type": "feat|fix|chore|refactor|docs", "message": "concise advice", "action": "optional command", "confidence": 0.0-1.0 }
]
Only include suggestions with confidence > 0.7. Maximum 3 items.`;
}

/**
 * Build a commit message prompt.
 */
export function buildCommitPrompt(params: {
  currentBranch: string;
  stagedFiles: string[];
  diff: string;
}): string {
  const { currentBranch, stagedFiles, diff } = params;

  return `Write a conventional commit message for the following changes.

Branch: ${currentBranch}
Changed files: ${stagedFiles.join(', ')}

Diff:
${diff}

Format: <type>(<scope>): <description>
Types: feat, fix, chore, docs, refactor, test, style
Keep the description under 72 characters. Output only the commit message, nothing else.`;
}
