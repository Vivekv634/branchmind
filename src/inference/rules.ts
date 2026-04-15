import { BranchSummary } from 'simple-git';
import { StaleBranch } from '../core/git';

export interface ConsistencyReport {
  consistent: boolean;
  dominantPrefix: string;
  violations: string[];
  complianceRate: number;
}

export interface Suggestion {
  type: string;
  message: string;
  action?: string;
  confidence: number;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Branch naming helpers
// ---------------------------------------------------------------------------

const COMMIT_TYPE_SIGNALS: Record<string, string[]> = {
  feat: ['add', 'implement', 'create', 'new', 'feature', 'build', 'introduce'],
  fix: ['fix', 'bug', 'patch', 'resolve', 'correct', 'repair', 'hotfix'],
  // 'update' removed — it is too generic and caused "update readme" to be classified
  // as chore instead of docs. The function defaults to 'chore' at the end anyway.
  chore: ['chore', 'bump', 'upgrade', 'dependency', 'deps', 'version'],
  docs: ['doc', 'docs', 'readme', 'comment', 'changelog', 'jsdoc', 'docstring'],
  refactor: ['refactor', 'clean', 'restructure', 'reorganize', 'move', 'rename'],
  test: ['test', 'spec', 'coverage', 'unit', 'integration', 'e2e'],
  style: ['style', 'format', 'lint', 'prettier', 'css', 'ui', 'ux'],
};

const FILE_PATH_SIGNALS: Record<string, string> = {
  'test': 'test',
  'spec': 'test',
  '__test__': 'test',
  'docs': 'docs',
  'doc': 'docs',
  'readme': 'docs',
  'style': 'style',
  'css': 'style',
  'scss': 'style',
  'less': 'style',
};

/**
 * Score every commit type against the message, return the highest-scoring winner.
 * Ties are broken by the iteration order of COMMIT_TYPE_SIGNALS (most specific first).
 * Falls back to 'chore' when no signal matches.
 *
 * Scoring catches mixed-signal messages like "refactor and fix login bug" (both
 * 'refactor' and 'fix' score 1 each; 'fix' wins because it appears earlier than
 * 'refactor' in the signal map and we sort stably with Array.sort).
 */
function detectTypeFromText(text: string): string {
  const lower = text.toLowerCase();
  const scores: Record<string, number> = {};

  for (const [type, signals] of Object.entries(COMMIT_TYPE_SIGNALS)) {
    for (const signal of signals) {
      if (lower.includes(signal)) {
        scores[type] = (scores[type] ?? 0) + 1;
      }
    }
  }

  if (Object.keys(scores).length === 0) return 'chore';

  // Pick the type with the most signal hits; preserve insertion order on ties
  // (COMMIT_TYPE_SIGNALS is ordered from most-specific to least-specific).
  let best = '';
  let bestScore = 0;
  for (const [type, score] of Object.entries(scores)) {
    if (score > bestScore) { best = type; bestScore = score; }
  }
  return best;
}

function detectTypeFromFiles(files: string[]): string {
  for (const file of files) {
    const lower = file.toLowerCase();
    for (const [signal, type] of Object.entries(FILE_PATH_SIGNALS)) {
      if (lower.includes(signal)) return type;
    }
  }
  return 'feat';
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

function extractScope(files: string[]): string {
  if (files.length === 0) return '';
  // Find the most common top-level directory
  const dirs = files
    .map(f => f.split('/')[0])
    .filter(d => d && d !== '.' && !d.includes('.'));
  if (dirs.length === 0) return '';
  const counts: Record<string, number> = {};
  for (const d of dirs) counts[d] = (counts[d] ?? 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function suggestBranchName(changedFiles: string[], commitDraft: string): string {
  const typeFromText = commitDraft ? detectTypeFromText(commitDraft) : null;
  const typeFromFiles = detectTypeFromFiles(changedFiles);
  const type = typeFromText ?? typeFromFiles;

  const scope = extractScope(changedFiles);
  const description = commitDraft
    ? slugify(commitDraft.replace(/^(feat|fix|chore|docs|refactor|test|style)[:(].*?[):]\s*/i, ''))
    : slugify(changedFiles[0]?.replace(/\.[^.]+$/, '') ?? 'changes');

  const parts = [type, scope, description].filter(Boolean);
  return parts.join('/');
}

export function checkStale(
  branches: BranchSummary,
  thresholdDays: number
): StaleBranch[] {
  // This is a lightweight version — full age computation happens in git.ts
  // Here we use the branch label as a proxy when age data isn't precomputed
  return Object.keys(branches.branches)
    .filter(name => name !== 'HEAD' && !name.startsWith('remotes/'))
    .map(name => ({
      name,
      ageDays: 0, // caller should use git.getStaleBranches() for real age
      lastCommit: branches.branches[name]?.label ?? '',
      hasRemote: false,
    }));
}

export function checkNamingConsistency(branches: string[]): ConsistencyReport {
  const localBranches = branches.filter(
    b => b !== 'HEAD' && !b.startsWith('remotes/')
  );

  if (localBranches.length === 0) {
    return { consistent: true, dominantPrefix: '', violations: [], complianceRate: 1 };
  }

  const convention = detectConvention(localBranches);
  const prefixes = convention.split(' ').filter(Boolean);

  const violations = prefixes.length > 0
    ? localBranches.filter(b => !prefixes.some(p => b.startsWith(p)))
    : [];

  const complianceRate = violations.length === 0
    ? 1
    : (localBranches.length - violations.length) / localBranches.length;

  return {
    consistent: violations.length === 0,
    dominantPrefix: convention,
    violations,
    complianceRate,
  };
}

export function suggestMerge(
  _branch: string,
  ageDays: number,
  commitCount: number
): boolean {
  // Suggest merge if branch is old enough and has meaningful commits
  return ageDays >= 7 && commitCount >= 3;
}

export function detectConvention(branches: string[]): string {
  const KNOWN_PREFIXES = ['feat/', 'fix/', 'chore/', 'docs/', 'refactor/', 'test/', 'hotfix/', 'release/'];
  const counts: Record<string, number> = {};

  for (const branch of branches) {
    for (const prefix of KNOWN_PREFIXES) {
      if (branch.startsWith(prefix)) {
        counts[prefix] = (counts[prefix] ?? 0) + 1;
      }
    }
  }

  const used = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([prefix]) => prefix);

  return used.join(' ');
}

export function getRuleSuggestions(params: {
  currentBranch: string;
  stagedFiles: string[];
  commitDraft: string;
  branchAgeDays: number;
  uncommittedChanges: boolean;
}): Suggestion[] {
  const { currentBranch, stagedFiles, commitDraft, branchAgeDays, uncommittedChanges } = params;
  const suggestions: Suggestion[] = [];
  const now = Date.now();

  // Suggest a better branch name if current one looks generic
  const genericPatterns = /^(main|master|dev|develop|temp|test|wip|branch\d*)$/i;
  if (genericPatterns.test(currentBranch) && stagedFiles.length > 0) {
    const suggested = suggestBranchName(stagedFiles, commitDraft);
    suggestions.push({
      type: 'naming',
      message: `Branch name "${currentBranch}" is too generic. Consider: ${suggested}`,
      action: `git checkout -b ${suggested}`,
      confidence: 0.85,
      createdAt: now,
    });
  }

  // Warn about long-running branches
  if (branchAgeDays >= 7) {
    suggestions.push({
      type: 'age',
      message: `Branch is ${branchAgeDays} days old. Consider merging or rebasing onto main.`,
      confidence: branchAgeDays >= 14 ? 0.9 : 0.75,
      createdAt: now,
    });
  }

  // Stash reminder
  if (uncommittedChanges && currentBranch === 'main' || currentBranch === 'master') {
    suggestions.push({
      type: 'workflow',
      message: 'You have uncommitted changes on the default branch. Create a feature branch first.',
      action: `git checkout -b ${suggestBranchName(stagedFiles, commitDraft)}`,
      confidence: 0.95,
      createdAt: now,
    });
  }

  // Suggest commit type from staged files
  if (stagedFiles.length > 0 && !commitDraft) {
    const type = detectTypeFromFiles(stagedFiles);
    const scope = extractScope(stagedFiles);
    suggestions.push({
      type: 'commit',
      message: `Staged files suggest a ${type} commit${scope ? ` in ${scope}` : ''}.`,
      confidence: 0.72,
      createdAt: now,
    });
  }

  return suggestions.filter(s => s.confidence > 0.7).slice(0, 3);
}
