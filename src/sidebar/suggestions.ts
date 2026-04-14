import { RouterResult } from '../inference/router';
import { callLocalModel, buildSuggestionPrompt } from '../inference/local';
import { getRuleSuggestions, Suggestion } from '../inference/rules';
import { redactSecrets } from '../core/secrets';
import { getDiff, getStagedFiles, getCommitHistory, getCurrentBranch, getBranchAge } from '../core/git';

export { Suggestion };

export interface SuggestionContext {
  currentBranch: string;
  stagedFiles: string[];
  commitDraft: string;
  branchAgeDays: number;
  uncommittedChanges: boolean;
  router: RouterResult;
  workspacePath?: string;
}

// In-memory cache of last 5 suggestion sets for offline fallback
const suggestionCache: Suggestion[][] = [];
const MAX_CACHE = 5;

function cacheSuggestions(suggestions: Suggestion[]): void {
  if (suggestions.length === 0) return;
  suggestionCache.unshift(suggestions);
  if (suggestionCache.length > MAX_CACHE) suggestionCache.pop();
}

export function getCachedSuggestions(): Suggestion[] {
  return suggestionCache[0] ?? [];
}

function parseSuggestionsFromLLM(raw: string): Suggestion[] {
  try {
    // Extract JSON array from response (model may wrap it in markdown)
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]) as Array<Partial<Suggestion>>;
    const now = Date.now();
    return parsed
      .filter(s => typeof s.message === 'string' && typeof s.confidence === 'number')
      .filter(s => (s.confidence ?? 0) > 0.7)
      .slice(0, 3)
      .map(s => ({
        type: s.type ?? 'info',
        message: s.message ?? '',
        action: s.action,
        confidence: s.confidence ?? 0.8,
        createdAt: now,
      }));
  } catch {
    return [];
  }
}

export async function getSuggestions(context: SuggestionContext): Promise<Suggestion[]> {
  const { router, workspacePath } = context;

  // Rules tier — no inference needed
  if (router.tier === 'rules' || !router.selected) {
    const suggestions = getRuleSuggestions({
      currentBranch: context.currentBranch,
      stagedFiles: context.stagedFiles,
      commitDraft: context.commitDraft,
      branchAgeDays: context.branchAgeDays,
      uncommittedChanges: context.uncommittedChanges,
    });
    cacheSuggestions(suggestions);
    return suggestions;
  }

  // Local tier
  try {
    const diff = await getDiff(context.currentBranch, 15, workspacePath);
    const redactedDiff = redactSecrets(diff);
    const recentCommits = await getCommitHistory(10, workspacePath);
    const commitMessages = recentCommits.map(c => c.message);

    const prompt = buildSuggestionPrompt({
      currentBranch: context.currentBranch,
      stagedFiles: context.stagedFiles,
      commitDraft: context.commitDraft,
      branchAgeDays: context.branchAgeDays,
      recentCommits: commitMessages,
      diff: redactedDiff,
    });

    const raw = await callLocalModel(
      prompt,
      router.selected.provider.endpoint,
      router.selected.modelId,
      'suggest'
    );

    if (!raw) throw new Error('Empty response from local model');

    const suggestions = parseSuggestionsFromLLM(raw);
    if (suggestions.length > 0) {
      cacheSuggestions(suggestions);
      return suggestions;
    }
    throw new Error('No valid suggestions parsed');
  } catch {
    // Silent fallback to rules
    const fallback = getRuleSuggestions({
      currentBranch: context.currentBranch,
      stagedFiles: context.stagedFiles,
      commitDraft: context.commitDraft,
      branchAgeDays: context.branchAgeDays,
      uncommittedChanges: context.uncommittedChanges,
    });
    cacheSuggestions(fallback);
    return fallback;
  }
}

export function getSuggestionsHTML(
  suggestions: Suggestion[],
  isStale = false,
  isCached = false
): string {
  if (suggestions.length === 0) {
    return '<div class="panel suggestions-panel"><p class="muted">No suggestions right now.</p></div>';
  }

  const badge = isCached
    ? '<span class="badge badge-cached">cached</span>'
    : isStale
    ? '<span class="badge badge-stale">stale</span>'
    : '';

  const cards = suggestions.map(s => `
    <div class="suggestion-card${isStale ? ' stale' : ''}" data-type="${s.type}">
      <div class="suggestion-header">
        <span class="suggestion-type">${s.type}</span>
        ${badge}
      </div>
      <div class="suggestion-message">${s.message}</div>
      ${s.action ? `<div class="suggestion-action"><code>${s.action}</code></div>` : ''}
    </div>`).join('');

  return `<div class="panel suggestions-panel">${cards}</div>`;
}

export async function buildSuggestionContext(
  router: RouterResult,
  workspacePath?: string
): Promise<SuggestionContext> {
  const [currentBranch, stagedFiles] = await Promise.all([
    getCurrentBranch(workspacePath),
    getStagedFiles(workspacePath),
  ]);
  const branchAgeDays = await getBranchAge(currentBranch, workspacePath);

  return {
    currentBranch,
    stagedFiles,
    commitDraft: '',
    branchAgeDays,
    uncommittedChanges: stagedFiles.length > 0,
    router,
    workspacePath,
  };
}
