import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  getBranches,
  getBranchAge,
  getCommitHistory,
  getCurrentBranch,
  getDivergenceFromMain,
  getStaleBranches,
} from '../core/git';
import { checkNamingConsistency, detectConvention } from '../inference/rules';
import { hasSecrets } from '../core/secrets';
import { getDiff } from '../core/git';

/**
 * Full audit result for a repository.
 * Cached to `.branchmind/audit.json` and re-run only when newer commits exist.
 */
export interface AuditResult {
  /** 0–100 health score. Deductions: stale branches, naming issues, secrets, untracked remotes. */
  healthScore: number;
  /** One-line plain-English explanation of the score. */
  healthReason: string;
  staleBranches: import('../core/git').StaleBranch[];
  /** Branch names that violate the inferred naming convention. */
  namingIssues: string[];
  activeBranch: {
    name: string;
    ageDays: number;
    lastCommitMessage: string;
    /** Commits ahead of main/master. */
    divergenceFromMain: number;
  };
  /** Detected prefix convention, e.g. "feat/ fix/ chore/". Empty string if none detected. */
  inferredConvention: string;
  /** True if a secret pattern was found in the last 5 commit diffs. */
  secretsWarning: boolean;
  /** Unix ms timestamp of when this audit was computed. */
  timestamp: number;
}

const STALE_THRESHOLD_DAYS = 7;

function getAuditPath(workspacePath?: string): string {
  const root = workspacePath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  return path.join(root, '.branchmind', 'audit.json');
}

function readCachedAudit(workspacePath?: string): AuditResult | null {
  const auditPath = getAuditPath(workspacePath);
  if (!fs.existsSync(auditPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(auditPath, 'utf8')) as AuditResult;
  } catch {
    return null;
  }
}

async function getLastCommitTimestamp(workspacePath?: string): Promise<number> {
  try {
    const history = await getCommitHistory(1, workspacePath);
    if (history.length === 0) return 0;
    return new Date(history[0].date).getTime();
  } catch {
    return 0;
  }
}

function computeScore(params: {
  staleBranches: AuditResult['staleBranches'];
  hasNamingIssues: boolean;
  secretsWarning: boolean;
  branchesWithoutRemote: number;
}): { score: number; reason: string } {
  let score = 100;
  const reasons: string[] = [];

  // Deduct for stale branches (max -40)
  const staleDeduction = Math.min(params.staleBranches.length * 10, 40);
  if (staleDeduction > 0) {
    score -= staleDeduction;
    reasons.push(`${params.staleBranches.length} stale branch${params.staleBranches.length > 1 ? 'es' : ''}`);
  }

  // Deduct for naming inconsistency
  if (params.hasNamingIssues) {
    score -= 15;
    reasons.push('inconsistent branch naming');
  }

  // Deduct for secrets in recent commits
  if (params.secretsWarning) {
    score -= 10;
    reasons.push('possible secrets in commit history');
  }

  // Deduct for branches without remote tracking (max -20)
  const remoteDeduction = Math.min(params.branchesWithoutRemote * 5, 20);
  if (remoteDeduction > 0) {
    score -= remoteDeduction;
    reasons.push(`${params.branchesWithoutRemote} untracked branch${params.branchesWithoutRemote > 1 ? 'es' : ''}`);
  }

  const reason = reasons.length === 0
    ? 'Repository looks healthy'
    : reasons.join(', ');

  return { score: Math.max(score, 0), reason };
}

/**
 * Run a full repository audit and return the result.
 * Uses a file cache (`.branchmind/audit.json`) — re-runs only if newer commits exist.
 * Scoring: starts at 100, deducts for stale branches (max −40), naming inconsistency (−15),
 * secrets in recent diffs (−10), and branches without remote tracking (max −20).
 */
export async function runAudit(workspacePath?: string): Promise<AuditResult> {
  // Check cache freshness
  const cached = readCachedAudit(workspacePath);
  const lastCommitTs = await getLastCommitTimestamp(workspacePath);
  if (cached && cached.timestamp >= lastCommitTs && lastCommitTs > 0) {
    return cached;
  }

  // Fetch all data
  const [branches, stale, currentBranch, recentCommits] = await Promise.all([
    getBranches(workspacePath),
    getStaleBranches(STALE_THRESHOLD_DAYS, workspacePath),
    getCurrentBranch(workspacePath),
    getCommitHistory(10, workspacePath),
  ]);

  const allBranchNames = Object.keys(branches.branches).filter(
    b => b !== 'HEAD' && !b.startsWith('remotes/')
  );

  // Naming consistency
  const convention = detectConvention(allBranchNames);
  const consistency = checkNamingConsistency(allBranchNames);
  const namingIssues = consistency.violations;
  const hasNamingIssues = consistency.complianceRate < 0.7 && allBranchNames.length >= 3;

  // Secrets check — scan recent 5 commit diffs
  let secretsWarning = false;
  for (let i = 0; i < Math.min(recentCommits.length, 5); i++) {
    const diff = await getDiff(recentCommits[i].hash, 3, workspacePath);
    if (hasSecrets(diff)) {
      secretsWarning = true;
      break;
    }
  }

  // Active branch details
  const activeBranchAge = await getBranchAge(currentBranch, workspacePath);
  const divergence = await getDivergenceFromMain(currentBranch, workspacePath);
  const lastMessage = recentCommits[0]?.message ?? '';

  // Branches without remote
  const branchesWithoutRemote = stale.filter(b => !b.hasRemote).length;

  const { score, reason } = computeScore({
    staleBranches: stale,
    hasNamingIssues,
    secretsWarning,
    branchesWithoutRemote,
  });

  const result: AuditResult = {
    healthScore: score,
    healthReason: reason,
    staleBranches: stale,
    namingIssues,
    activeBranch: {
      name: currentBranch,
      ageDays: activeBranchAge,
      lastCommitMessage: lastMessage,
      divergenceFromMain: divergence,
    },
    inferredConvention: convention,
    secretsWarning,
    timestamp: Date.now(),
  };

  // Write cache
  try {
    const dir = path.dirname(getAuditPath(workspacePath));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(getAuditPath(workspacePath), JSON.stringify(result, null, 2), 'utf8');
  } catch { /* non-fatal */ }

  return result;
}
