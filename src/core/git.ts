import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import simpleGit, { BranchSummary, DefaultLogFields, SimpleGit } from 'simple-git';

export interface CommitSummary {
  hash: string;
  message: string;
  author: string;
  date: string;
}

export interface StaleBranch {
  name: string;
  ageDays: number;
  lastCommit: string;
  hasRemote: boolean;
}

function getWorkspaceRoot(override?: string): string {
  if (override) return override;
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) throw new Error('No workspace open');
  return folders[0].uri.fsPath;
}

function git(root: string): SimpleGit {
  return simpleGit(root);
}

/** Returns all branches (local + remote) for the given workspace. */
export async function getBranches(workspacePath?: string): Promise<BranchSummary> {
  const root = getWorkspaceRoot(workspacePath);
  return git(root).branch(['-a']);
}

/** Returns the last `n` commits as a flat summary array. */
export async function getCommitHistory(
  n: number,
  workspacePath?: string
): Promise<CommitSummary[]> {
  const root = getWorkspaceRoot(workspacePath);
  const log = await git(root).log({ maxCount: n });
  return (log.all as ReadonlyArray<DefaultLogFields>).map(c => ({
    hash: c.hash,
    message: c.message,
    author: c.author_name,
    date: c.date,
  }));
}

/** Returns the name of the currently checked-out branch. */
export async function getCurrentBranch(workspacePath?: string): Promise<string> {
  const root = getWorkspaceRoot(workspacePath);
  return git(root).revparse(['--abbrev-ref', 'HEAD']);
}

/** Returns the number of days since the last commit on the given branch. Returns 9999 on error. */
export async function getBranchAge(branch: string, workspacePath?: string): Promise<number> {
  const root = getWorkspaceRoot(workspacePath);
  try {
    const log = await git(root).log({ maxCount: 1 });
    if (!log.latest) return 9999;
    const lastCommitDate = new Date((log.latest as DefaultLogFields).date);
    const now = new Date();
    return Math.floor((now.getTime() - lastCommitDate.getTime()) / (1000 * 60 * 60 * 24));
  } catch {
    return 9999;
  }
}

/**
 * Returns the diff for the current working tree against `branch`,
 * with `contextLines` lines of surrounding context per hunk (default 15).
 * Hard-caps output at 8000 characters — truncates diff hunks, never file metadata.
 */
export async function getDiff(
  branch: string,
  contextLines = 15,
  workspacePath?: string
): Promise<string> {
  const root = getWorkspaceRoot(workspacePath);
  const CHAR_CAP = 8000;
  try {
    const raw = await git(root).diff([`-U${contextLines}`, branch]);
    if (raw.length <= CHAR_CAP) return raw;
    // Truncate hunk by hunk, always keeping the header intact
    const lines = raw.split('\n');
    let result = '';
    for (const line of lines) {
      if (result.length + line.length + 1 > CHAR_CAP) {
        result += '\n[diff truncated at 8000 chars]';
        break;
      }
      result += line + '\n';
    }
    return result;
  } catch {
    return '';
  }
}

/** Returns all files with uncommitted changes (modified, created, deleted, renamed, staged). */
export async function getChangedFiles(workspacePath?: string): Promise<string[]> {
  const root = getWorkspaceRoot(workspacePath);
  const status = await git(root).status();
  return [
    ...status.modified,
    ...status.created,
    ...status.deleted,
    ...status.renamed.map(r => r.to),
    ...status.staged,
  ].filter((v, i, a) => a.indexOf(v) === i);
}

/** Returns only the currently staged files. */
export async function getStagedFiles(workspacePath?: string): Promise<string[]> {
  const root = getWorkspaceRoot(workspacePath);
  const status = await git(root).status();
  return status.staged;
}

/**
 * Returns all local branches with no commits in the last `thresholdDays` days.
 * Excludes HEAD and remote-tracking branches.
 */
export async function getStaleBranches(
  thresholdDays: number,
  workspacePath?: string
): Promise<StaleBranch[]> {
  const root = getWorkspaceRoot(workspacePath);
  const branches = await git(root).branch(['-v', '--no-merged']);
  const stale: StaleBranch[] = [];
  for (const [name, b] of Object.entries(branches.branches)) {
    if (name === 'HEAD') continue;
    const age = await getBranchAge(name, root);
    if (age >= thresholdDays) {
      stale.push({
        name,
        ageDays: age,
        lastCommit: b.label,
        hasRemote: name.startsWith('remotes/'),
      });
    }
  }
  return stale;
}

/**
 * Returns the number of commits `branch` is ahead of main/master.
 * Tries `main` first, falls back to `master`. Returns 0 on any error.
 */
export async function getDivergenceFromMain(
  branch: string,
  workspacePath?: string
): Promise<number> {
  const root = getWorkspaceRoot(workspacePath);
  try {
    const result = await git(root).raw(['rev-list', '--count', `main..${branch}`]);
    return parseInt(result.trim(), 10) || 0;
  } catch {
    try {
      const result = await git(root).raw(['rev-list', '--count', `master..${branch}`]);
      return parseInt(result.trim(), 10) || 0;
    } catch {
      return 0;
    }
  }
}

/**
 * Returns true if the workspace is a monorepo.
 * Checks for nx.json, turbo.json, lerna.json, pnpm-workspace.yaml,
 * or multiple package.json files in immediate subdirectories.
 */
export function isMonorepo(workspacePath?: string): boolean {
  const root = getWorkspaceRoot(workspacePath);
  const monorepoFiles = ['nx.json', 'turbo.json', 'lerna.json', 'pnpm-workspace.yaml'];
  if (monorepoFiles.some(f => fs.existsSync(path.join(root, f)))) return true;

  // Detect via multiple package.json in subdirs
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    const pkgCount = entries.filter(
      e => e.isDirectory() && fs.existsSync(path.join(root, e.name, 'package.json'))
    ).length;
    return pkgCount >= 2;
  } catch {
    return false;
  }
}

/**
 * Returns the nearest ancestor directory containing a package.json,
 * starting from the given file path and walking up to the repo root.
 * Falls back to the repo root if no package.json ancestor is found.
 */
export function getActivePackageRoot(filePath: string, workspacePath?: string): string {
  const root = getWorkspaceRoot(workspacePath);
  let dir = path.dirname(filePath);
  while (dir.startsWith(root) && dir !== root) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return root;
}
