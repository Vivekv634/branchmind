import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import simpleGit from 'simple-git';
import * as git from './core/git';
import { readConfig, writeConfig } from './core/config';
import { scanWorkspace } from './core/scanner';
import { probe, getCachedResult, startReprobeLoop, stopReprobeLoop, onSelectionLost, RouterResult, DiscoveredProvider } from './inference/router';
import { createStatusBar, updateStatusBar, setOffline, disposeStatusBar } from './statusbar';
import { runAudit } from './audit/audit';
import { getFreshRepoHTML } from './sidebar/fresh';
import { getHealthHTML } from './sidebar/health';
import { getSuggestions, getSuggestionsHTML, getCachedSuggestions, buildSuggestionContext } from './sidebar/suggestions';
import { BranchMindSidebarProvider } from './sidebar/provider';

// ── Debounce utility ──────────────────────────────────────────────────────────

function debounce<T extends unknown[]>(fn: (...args: T) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout>;
  return (...args: T) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// ── State ─────────────────────────────────────────────────────────────────────

let sidebarProvider: BranchMindSidebarProvider | null = null;
let headWatcher: fs.FSWatcher | null = null;
let staleCheckTimer: ReturnType<typeof setInterval> | null = null;
let lastKnownBranch = '';
let lastGitEventTime = Date.now();

const STALE_SUGGESTION_MS = 5 * 60 * 1000; // 5 minutes

// ── Activation ────────────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspacePath) return;

  // Register sidebar provider
  sidebarProvider = new BranchMindSidebarProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      BranchMindSidebarProvider.viewType,
      sidebarProvider
    )
  );

  // Status bar
  const statusBar = createStatusBar();
  context.subscriptions.push(statusBar);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('branchmind.selectModel', () =>
      selectModelCommand(workspacePath)
    ),
    vscode.commands.registerCommand('branchmind.rescan', async () => {
      const result = await probe(workspacePath);
      updateStatusBar(result);
      await refreshSidebar(result, workspacePath);
    })
  );

  // Wire sidebar message handler
  sidebarProvider.onMessage(msg => handleWebviewMessage(msg as Record<string, unknown>, workspacePath));

  // Initial probe
  const routerResult = await probe(workspacePath);
  updateStatusBar(routerResult);

  // Auto-show model picker on first run if providers found but nothing selected
  if (routerResult.availableProviders.length > 0 && !routerResult.selected) {
    await selectModelCommand(workspacePath);
  }

  // Initial sidebar render
  await refreshSidebar(routerResult, workspacePath);

  // Start re-probe loop
  onSelectionLost((providerName) => {
    setOffline();
    vscode.window.showWarningMessage(
      `BranchMind: "${providerName}" went offline. Click the status bar to re-select a model.`
    );
  });

  startReprobeLoop(async (result) => {
    updateStatusBar(result);
    await refreshSidebar(result, workspacePath);
  }, workspacePath);

  // File watchers
  registerWatchers(context, workspacePath);

  // Branch change detection via fs.watch on .git/HEAD
  watchHeadFile(workspacePath);

  // Suggestion decay timer — mark stale after 5 min of no git activity
  staleCheckTimer = setInterval(() => {
    if (Date.now() - lastGitEventTime > STALE_SUGGESTION_MS) {
      sidebarProvider?.postMessage({ type: 'markSuggestionsStale' });
    }
  }, 30_000);

  // Store current branch
  try {
    lastKnownBranch = await git.getCurrentBranch(workspacePath);
  } catch { /* fresh repo with no commits */ }
}

// ── Sidebar rendering ─────────────────────────────────────────────────────────

async function refreshSidebar(router: RouterResult, workspacePath?: string): Promise<void> {
  if (!sidebarProvider) return;

  try {
    const commitHistory = await git.getCommitHistory(5, workspacePath);
    const isFreshRepo = commitHistory.length < 5;

    if (isFreshRepo) {
      const signals = scanWorkspace(workspacePath);
      const config = readConfig(workspacePath);
      const html = getFreshRepoHTML(signals, config.projectKeywords);
      sidebarProvider.setHTML(html);
      return;
    }

    // Monorepo: scope analysis to the active editor's package root
    let analysisRoot = workspacePath;
    if (git.isMonorepo(workspacePath)) {
      const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
      if (activeFile) {
        analysisRoot = git.getActivePackageRoot(activeFile, workspacePath);
      }
    }

    // Mid-progress repo
    const audit = await runAudit(analysisRoot);
    const healthHTML = getHealthHTML(audit);

    const context = await buildSuggestionContext(router, analysisRoot);
    const suggestions = await getSuggestions(context);
    const suggestHTML = getSuggestionsHTML(suggestions);

    sidebarProvider.setHTML(healthHTML + suggestHTML);
  } catch (err) {
    sidebarProvider.setHTML(
      `<div class="panel"><p class="muted">Error loading BranchMind: ${String(err)}</p></div>`
    );
  }
}

// ── Suggestion refresh (debounced) ─────────────────────────────────────────────

const debouncedSuggestionRefresh = debounce(async (workspacePath: string) => {
  const router = getCachedResult();
  if (!router) return;

  lastGitEventTime = Date.now();
  sidebarProvider?.postMessage({ type: 'gitEvent' });

  // When offline (selected provider gone), show cached suggestions with badge
  if (router.tier === 'rules' && getCachedSuggestions().length > 0) {
    const cached = getCachedSuggestions();
    const html = getSuggestionsHTML(cached, false, true);
    sidebarProvider?.postMessage({ type: 'updateSuggestions', html });
    return;
  }

  try {
    // Monorepo: scope analysis to the active editor's package root
    let analysisRoot = workspacePath;
    if (git.isMonorepo(workspacePath)) {
      const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
      if (activeFile) {
        analysisRoot = git.getActivePackageRoot(activeFile, workspacePath);
      }
    }

    // Signal the webview to show the inference spinner
    sidebarProvider?.postMessage({ type: 'inferenceStart' });

    const context = await buildSuggestionContext(router, analysisRoot);
    const suggestions = await getSuggestions(context);
    const suggestHTML = getSuggestionsHTML(suggestions);
    sidebarProvider?.postMessage({ type: 'updateSuggestions', html: suggestHTML });
  } catch { /* silent — spinner auto-clears on next updateSuggestions */ }
}, 1200);

// ── File watchers ──────────────────────────────────────────────────────────────

function registerWatchers(context: vscode.ExtensionContext, workspacePath: string): void {
  // Watch .git/index for staged file changes
  const gitIndexPath = path.join(workspacePath, '.git', 'index');
  if (fs.existsSync(gitIndexPath)) {
    const indexWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspacePath, '.git/index')
    );
    indexWatcher.onDidChange(() => debouncedSuggestionRefresh(workspacePath));
    context.subscriptions.push(indexWatcher);
  }

  // Watch active editor saves
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(() => {
      debouncedSuggestionRefresh(workspacePath);
    })
  );
}

// ── Branch change detection via fs.watch ──────────────────────────────────────

function watchHeadFile(workspacePath: string): void {
  const headPath = path.join(workspacePath, '.git', 'HEAD');
  if (!fs.existsSync(headPath)) return;

  headWatcher = fs.watch(headPath, async () => {
    try {
      const newBranch = await git.getCurrentBranch(workspacePath);
      if (newBranch === lastKnownBranch) return;

      const oldBranch = lastKnownBranch;
      lastKnownBranch = newBranch;

      // Check for uncommitted changes on old branch
      const changed = await git.getChangedFiles(workspacePath);
      if (changed.length > 0 && oldBranch) {
        const action = await vscode.window.showWarningMessage(
          `You have uncommitted changes on "${oldBranch}". Stash or commit before switching.`,
          'Stash now',
          'Dismiss'
        );
        if (action === 'Stash now') {
          const sg = simpleGit(workspacePath);
          await sg.stash(['push', '-m', 'branchmind-autostash']);
          vscode.window.showInformationMessage('BranchMind: Changes stashed as "branchmind-autostash".');
        }
      }

      // Refresh sidebar for new branch
      const router = getCachedResult();
      if (router) await refreshSidebar(router, workspacePath);
    } catch { /* silent */ }
  });
}

// ── Model selector command ─────────────────────────────────────────────────────

async function selectModelCommand(workspacePath?: string): Promise<void> {
  const router = getCachedResult() ?? await probe(workspacePath);

  if (router.availableProviders.length === 0) {
    const action = await vscode.window.showInformationMessage(
      'No local LLM found. Start Ollama, LM Studio, or Jan.ai first, then click Re-scan.',
      'Re-scan'
    );
    if (action === 'Re-scan') {
      const result = await probe(workspacePath);
      updateStatusBar(result);
      if (result.availableProviders.length > 0) {
        await selectModelCommand(workspacePath);
      } else {
        vscode.window.showInformationMessage('BranchMind: Still no providers found. Running in rule-based mode.');
      }
    }
    return;
  }

  // Step 1 — pick provider (skip if only one)
  let chosenProvider: DiscoveredProvider;
  if (router.availableProviders.length === 1) {
    chosenProvider = router.availableProviders[0];
  } else {
    const providerItems = router.availableProviders.map(p => ({
      label: p.name,
      description: p.endpoint,
      detail: p.models.length > 0
        ? `${p.models.length} model(s) available`
        : '$(warning) No models downloaded',
      provider: p,
      disabled: p.models.length === 0,
    }));

    const picked = await vscode.window.showQuickPick(providerItems, {
      title: 'BranchMind — Select Provider',
      placeHolder: 'Choose a local LLM provider',
    });

    if (!picked || picked.disabled) return;
    chosenProvider = picked.provider;
  }

  if (chosenProvider.models.length === 0) {
    vscode.window.showWarningMessage(
      `BranchMind: No models found in ${chosenProvider.name}. Download a model first.`
    );
    return;
  }

  // Step 2 — pick model
  const modelItems = chosenProvider.models.map(m => ({
    label: m.id,
    description: m.displayName !== m.id ? m.displayName : undefined,
    modelId: m.id,
  }));

  const pickedModel = await vscode.window.showQuickPick(modelItems, {
    title: `BranchMind — Select Model (${chosenProvider.name})`,
    placeHolder: 'Choose a model',
  });

  if (!pickedModel) return;

  // Save selection
  const config = readConfig(workspacePath);
  writeConfig({
    ...config,
    selectedProvider: chosenProvider.name,
    selectedEndpoint: chosenProvider.endpoint,
    selectedModelId: pickedModel.modelId,
  }, workspacePath);

  // Update router cache and status bar
  const updatedResult = await probe(workspacePath);
  updateStatusBar(updatedResult);
  await refreshSidebar(updatedResult, workspacePath);

  vscode.window.showInformationMessage(
    `BranchMind: Using ${chosenProvider.name} / ${pickedModel.modelId}`
  );
}

// ── Webview message handler ────────────────────────────────────────────────────

async function handleWebviewMessage(
  msg: Record<string, unknown>,
  workspacePath: string
): Promise<void> {
  switch (msg.type) {
    case 'updateKeywords': {
      const keywords = msg.keywords as string[];
      const config = readConfig(workspacePath);
      writeConfig({ ...config, projectKeywords: keywords }, workspacePath);
      break;
    }

    case 'mergeBranch': {
      const branch = msg.branch as string;
      try {
        const sg = simpleGit(workspacePath);
        await sg.merge([branch]);
        vscode.window.showInformationMessage(`BranchMind: Merged "${branch}".`);
        const router = getCachedResult();
        if (router) await refreshSidebar(router, workspacePath);
      } catch (e) {
        vscode.window.showErrorMessage(`BranchMind: Merge failed — ${String(e)}`);
      }
      break;
    }

    case 'deleteBranch': {
      const branch = msg.branch as string;
      const confirm = await vscode.window.showInputBox({
        prompt: `Type the branch name to confirm deletion: "${branch}"`,
        placeHolder: branch,
      });
      if (confirm !== branch) {
        vscode.window.showInformationMessage('BranchMind: Deletion cancelled.');
        return;
      }
      try {
        const sg = simpleGit(workspacePath);
        await sg.branch(['-d', branch]);
        vscode.window.showInformationMessage(`BranchMind: Deleted "${branch}".`);
        const router = getCachedResult();
        if (router) await refreshSidebar(router, workspacePath);
      } catch (e) {
        vscode.window.showErrorMessage(`BranchMind: Delete failed — ${String(e)}`);
      }
      break;
    }

    case 'reviveBranch': {
      const branch = msg.branch as string;
      const terminal = vscode.window.createTerminal('BranchMind: Revive');
      terminal.sendText(`git checkout -b ${branch}-revived`);
      terminal.show();
      break;
    }
  }
}

// ── Deactivation ──────────────────────────────────────────────────────────────

export function deactivate(): void {
  stopReprobeLoop();
  disposeStatusBar();
  headWatcher?.close();
  headWatcher = null;
  if (staleCheckTimer) { clearInterval(staleCheckTimer); staleCheckTimer = null; }
}
