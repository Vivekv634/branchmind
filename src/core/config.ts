import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface CloudContextScope {
  includeBranches: boolean;
  includeCommitMessages: boolean;
  includeFilePaths: boolean;
  includeDiff: boolean;
  commitDepth: number;
}

export interface BranchMindConfig {
  version: 1;
  projectKeywords: string[];
  inferencePreference: 'local' | 'rules';
  selectedProvider: string | null;
  selectedEndpoint: string | null;
  selectedModelId: string | null;
  cloudContextScope: CloudContextScope;
  customModelEndpoint?: string;
}

const DEFAULTS: BranchMindConfig = {
  version: 1,
  projectKeywords: [],
  inferencePreference: 'local',
  selectedProvider: null,
  selectedEndpoint: null,
  selectedModelId: null,
  cloudContextScope: {
    includeBranches: true,
    includeCommitMessages: true,
    includeFilePaths: false,
    includeDiff: false,
    commitDepth: 10,
  },
};

function getConfigDir(workspacePath?: string): string {
  const root = workspacePath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  return path.join(root, '.branchmind');
}

function getConfigPath(workspacePath?: string): string {
  return path.join(getConfigDir(workspacePath), 'config.json');
}

export function readConfig(workspacePath?: string): BranchMindConfig {
  const configPath = getConfigPath(workspacePath);
  if (!fs.existsSync(configPath)) {
    writeConfig(DEFAULTS, workspacePath);
    return { ...DEFAULTS };
  }
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<BranchMindConfig>;
    return mergeConfig(parsed);
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeConfig(config: BranchMindConfig, workspacePath?: string): void {
  const dir = getConfigDir(workspacePath);
  const isNew = !fs.existsSync(dir);
  if (isNew) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getConfigPath(workspacePath), JSON.stringify(config, null, 2), 'utf8');

  // Always ignore the entire .branchmind/ folder — it contains local machine
  // state (selected model, cached audit) that should never be committed.
  if (isNew) guardGitignore(workspacePath);
}

export function mergeConfig(partial: Partial<BranchMindConfig>): BranchMindConfig {
  return {
    ...DEFAULTS,
    ...partial,
    cloudContextScope: {
      ...DEFAULTS.cloudContextScope,
      ...(partial.cloudContextScope ?? {}),
    },
  } as BranchMindConfig;
}

function guardGitignore(workspacePath?: string): void {
  const root = workspacePath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  const gitignorePath = path.join(root, '.gitignore');
  const entry = '.branchmind/';

  try {
    const existing = fs.existsSync(gitignorePath)
      ? fs.readFileSync(gitignorePath, 'utf8')
      : '';

    // Match the folder entry with or without a trailing slash to avoid duplicates.
    if (!existing.split('\n').some(line => line.trim() === '.branchmind/' || line.trim() === '.branchmind')) {
      fs.appendFileSync(gitignorePath, `\n# BranchMind local state (machine-specific, do not commit)\n${entry}\n`, 'utf8');
      vscode.window.showInformationMessage(
        'BranchMind: Added .branchmind/ to .gitignore — local model config and cache are machine-specific.'
      );
    }
  } catch { /* non-fatal */ }
}
