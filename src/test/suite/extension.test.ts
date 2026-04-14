import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import simpleGit from 'simple-git';

// ── Helpers ────────────────────────────────────────────────────────────────

async function createTempRepo(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'branchmind-test-'));
  const sg = simpleGit(dir);
  await sg.init();
  await sg.addConfig('user.email', 'test@branchmind.dev');
  await sg.addConfig('user.name', 'BranchMind Test');
  return dir;
}

async function addCommit(repoPath: string, message: string, filePath = 'file.txt'): Promise<void> {
  const full = path.join(repoPath, filePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `${message}\n${Date.now()}`);
  const sg = simpleGit(repoPath);
  await sg.add('.');
  await sg.commit(message);
}

async function createStaleBranch(repoPath: string, name: string): Promise<void> {
  const sg = simpleGit(repoPath);
  await sg.checkoutLocalBranch(name);
  await addCommit(repoPath, `work on ${name}`);
  await sg.checkout('main');
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Test suite ────────────────────────────────────────────────────────────

suite('BranchMind Extension Tests', () => {
  let repoPath: string;

  suiteSetup(async function () {
    this.timeout(30_000);

    // Create a temp repo with 20 commits and 3 stale branches
    repoPath = await createTempRepo();
    const sg = simpleGit(repoPath);

    // Rename initial branch to main
    await addCommit(repoPath, 'feat: initial commit');
    try { await sg.branch(['-m', 'master', 'main']); } catch { /* already main */ }

    for (let i = 2; i <= 20; i++) {
      await addCommit(repoPath, `feat: commit ${i}`, `src/file${i}.ts`);
    }

    await createStaleBranch(repoPath, 'feat/old-auth');
    await createStaleBranch(repoPath, 'fix/stale-login');
    await createStaleBranch(repoPath, 'chore/old-deps');
  });

  suiteTeardown(() => {
    try { fs.rmSync(repoPath, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ── 1. Extension activates ─────────────────────────────────────────────

  test('extension is present', () => {
    const ext = vscode.extensions.getExtension('vivek.branchmind');
    assert.ok(ext, 'Extension vivek.branchmind should be registered');
  });

  // ── 2. Core git module ─────────────────────────────────────────────────

  test('getCommitHistory returns 20 commits', async function () {
    this.timeout(10_000);
    const { getCommitHistory } = await import('../../core/git');
    const history = await getCommitHistory(20, repoPath);
    assert.strictEqual(history.length, 20, 'Should return 20 commits');
    assert.ok(history[0].message, 'Each commit should have a message');
    assert.ok(history[0].hash, 'Each commit should have a hash');
  });

  test('getCurrentBranch returns main', async function () {
    this.timeout(5_000);
    const { getCurrentBranch } = await import('../../core/git');
    const branch = await getCurrentBranch(repoPath);
    assert.strictEqual(branch, 'main');
  });

  test('getBranches lists stale branches', async function () {
    this.timeout(5_000);
    const { getBranches } = await import('../../core/git');
    const summary = await getBranches(repoPath);
    const names = Object.keys(summary.branches);
    assert.ok(names.some(b => b === 'feat/old-auth'), 'Should include feat/old-auth');
    assert.ok(names.some(b => b === 'fix/stale-login'), 'Should include fix/stale-login');
    assert.ok(names.some(b => b === 'chore/old-deps'), 'Should include chore/old-deps');
  });

  test('getDiff returns a capped string', async function () {
    this.timeout(5_000);
    const { getDiff } = await import('../../core/git');
    const diff = await getDiff('main', 15, repoPath);
    assert.ok(typeof diff === 'string', 'getDiff should return a string');
    assert.ok(diff.length <= 8200, 'getDiff should not exceed ~8000 chars');
  });

  test('isMonorepo returns false for simple repo', async function () {
    const { isMonorepo } = await import('../../core/git');
    assert.strictEqual(isMonorepo(repoPath), false);
  });

  test('isMonorepo returns true when turbo.json present', async function () {
    const { isMonorepo } = await import('../../core/git');
    const turboPath = path.join(repoPath, 'turbo.json');
    fs.writeFileSync(turboPath, '{}');
    assert.strictEqual(isMonorepo(repoPath), true);
    fs.unlinkSync(turboPath);
  });

  // ── 3. Config module ───────────────────────────────────────────────────

  test('readConfig creates defaults when missing', async function () {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-config-'));
    const sg = simpleGit(tmpDir);
    await sg.init();
    await addCommit(tmpDir, 'init');

    const { readConfig } = await import('../../core/config');
    const config = readConfig(tmpDir);
    assert.strictEqual(config.version, 1);
    assert.strictEqual(config.selectedModelId, null);
    assert.ok(Array.isArray(config.projectKeywords));

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('writeConfig and readConfig round-trips correctly', async function () {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-rw-'));
    const { readConfig, writeConfig } = await import('../../core/config');
    const config = readConfig(tmpDir);
    writeConfig({ ...config, projectKeywords: ['auth', 'payments'] }, tmpDir);
    const reread = readConfig(tmpDir);
    assert.deepStrictEqual(reread.projectKeywords, ['auth', 'payments']);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── 4. Secret redaction ────────────────────────────────────────────────

  test('redactSecrets removes AWS key', async function () {
    const { redactSecrets } = await import('../../core/secrets');
    const input = 'key = AKIAIOSFODNN7EXAMPLE';
    const result = redactSecrets(input);
    assert.ok(!result.includes('AKIAIOSFODNN7EXAMPLE'), 'AWS key should be redacted');
    assert.ok(result.includes('[REDACTED]'));
  });

  test('redactSecrets removes GitHub PAT', async function () {
    const { redactSecrets } = await import('../../core/secrets');
    const input = 'token: ghp_abcdefghijklmnopqrstuvwxyz1234567890';
    const result = redactSecrets(input);
    assert.ok(!result.includes('ghp_'), 'GitHub PAT should be redacted');
  });

  test('redactSecrets removes Razorpay key', async function () {
    const { redactSecrets } = await import('../../core/secrets');
    const input = 'RAZORPAY_KEY=rzp_live_abcdefghijklmno';
    const result = redactSecrets(input);
    assert.ok(!result.includes('rzp_live_'), 'Razorpay key should be redacted');
  });

  test('redactSecrets removes Stripe key', async function () {
    const { redactSecrets } = await import('../../core/secrets');
    const input = 'const stripe = Stripe("sk_live_abcdefghijklmnopqrstu")';
    const result = redactSecrets(input);
    assert.ok(!result.includes('sk_live_'), 'Stripe key should be redacted');
  });

  test('redactSecrets preserves localhost IPs', async function () {
    const { redactSecrets } = await import('../../core/secrets');
    const input = 'db: localhost:5432 or 127.0.0.1:5432';
    const result = redactSecrets(input);
    assert.ok(result.includes('localhost'), 'localhost should not be redacted');
    assert.ok(result.includes('127.0.0.1'), '127.x.x.x should not be redacted');
  });

  test('hasSecrets detects connection string', async function () {
    const { hasSecrets } = await import('../../core/secrets');
    assert.ok(hasSecrets('postgresql://user:pass@host:5432/db'));
    assert.ok(!hasSecrets('no secrets here'));
  });

  // ── 5. Rules engine ────────────────────────────────────────────────────

  test('suggestBranchName produces feat/ prefix for new files', async function () {
    const { suggestBranchName } = await import('../../inference/rules');
    const name = suggestBranchName(['src/auth/login.ts'], 'add login');
    assert.ok(name.startsWith('feat/'), `Expected feat/ prefix, got: ${name}`);
    assert.ok(name.toLowerCase().includes('auth') || name.toLowerCase().includes('login'));
  });

  test('suggestBranchName produces fix/ prefix for fix commit', async function () {
    const { suggestBranchName } = await import('../../inference/rules');
    const name = suggestBranchName(['src/auth/login.ts'], 'fix login bug');
    assert.ok(name.startsWith('fix/'), `Expected fix/ prefix, got: ${name}`);
  });

  test('detectConvention identifies feat/fix/chore pattern', async function () {
    const { detectConvention } = await import('../../inference/rules');
    const branches = ['feat/auth', 'feat/payments', 'fix/login', 'chore/deps'];
    const convention = detectConvention(branches);
    assert.ok(convention.includes('feat/'), 'Should detect feat/ convention');
    assert.ok(convention.includes('fix/'), 'Should detect fix/ convention');
  });

  test('getRuleSuggestions flags generic branch name', async function () {
    const { getRuleSuggestions } = await import('../../inference/rules');
    const suggestions = getRuleSuggestions({
      currentBranch: 'dev',
      stagedFiles: ['src/auth/login.ts'],
      commitDraft: '',
      branchAgeDays: 0,
      uncommittedChanges: true,
    });
    assert.ok(suggestions.length > 0, 'Should produce at least one suggestion');
    assert.ok(
      suggestions.some(s => s.message.toLowerCase().includes('generic') || s.message.toLowerCase().includes('branch')),
      'Should warn about generic branch name'
    );
  });

  // ── 6. Audit module ────────────────────────────────────────────────────

  test('runAudit produces a health score < 100 for repo with stale branches', async function () {
    this.timeout(20_000);
    const { runAudit } = await import('../../audit/audit');
    const result = await runAudit(repoPath);

    assert.ok(typeof result.healthScore === 'number', 'healthScore should be a number');
    assert.ok(result.healthScore >= 0 && result.healthScore <= 100, 'healthScore should be 0–100');
    assert.ok(result.healthScore < 100, 'Should deduct points for stale branches');
    assert.ok(typeof result.healthReason === 'string', 'healthReason should be a string');
    assert.ok(result.activeBranch.name === 'main', 'activeBranch should be main');
  });

  test('runAudit creates audit.json cache', async function () {
    this.timeout(20_000);
    const { runAudit } = await import('../../audit/audit');
    await runAudit(repoPath);
    const auditPath = path.join(repoPath, '.branchmind', 'audit.json');
    assert.ok(fs.existsSync(auditPath), 'audit.json should be created');
    const cached = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
    assert.ok(cached.timestamp > 0, 'Cached audit should have a timestamp');
  });

  test('runAudit returns cached result without re-running', async function () {
    this.timeout(20_000);
    const { runAudit } = await import('../../audit/audit');
    const first = await runAudit(repoPath);
    const second = await runAudit(repoPath);
    assert.strictEqual(first.timestamp, second.timestamp, 'Should return cached result');
  });

  // ── 7. getSuggestions falls back to rules when no router ─────────────

  test('getSuggestions returns rule-based suggestions when tier is rules', async function () {
    this.timeout(10_000);
    const { getSuggestions } = await import('../../sidebar/suggestions');

    const mockRouter = { tier: 'rules' as const, availableProviders: [] };
    const suggestions = await getSuggestions({
      currentBranch: 'feat/auth',
      stagedFiles: ['src/auth/login.ts'],
      commitDraft: '',
      branchAgeDays: 0,
      uncommittedChanges: true,
      router: mockRouter,
      workspacePath: repoPath,
    });

    assert.ok(Array.isArray(suggestions), 'Should return an array');
  });

  test('getSuggestions for auth file contains auth in suggestion', async function () {
    this.timeout(10_000);
    const { getSuggestions } = await import('../../sidebar/suggestions');

    // Stage a mock auth file
    const authFile = path.join(repoPath, 'src', 'auth', 'login.ts');
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, 'export function login() {}');
    const sg = simpleGit(repoPath);
    await sg.add('src/auth/login.ts');

    const mockRouter = { tier: 'rules' as const, availableProviders: [] };
    const suggestions = await getSuggestions({
      currentBranch: 'dev',
      stagedFiles: ['src/auth/login.ts'],
      commitDraft: 'add login',
      branchAgeDays: 0,
      uncommittedChanges: true,
      router: mockRouter,
      workspacePath: repoPath,
    });

    // At least one suggestion should mention auth or branch naming
    const hasAuthHint = suggestions.some(s =>
      s.message.toLowerCase().includes('auth') ||
      s.message.toLowerCase().includes('feat') ||
      s.message.toLowerCase().includes('branch')
    );
    assert.ok(hasAuthHint, `Expected auth/feat hint in suggestions: ${JSON.stringify(suggestions)}`);

    // Clean up staged file
    await sg.reset(['HEAD']);
    fs.rmSync(authFile);
  });

  // ── 8. Scanner ─────────────────────────────────────────────────────────

  test('scanWorkspace returns sensible defaults for plain repo', async function () {
    const { scanWorkspace } = await import('../../core/scanner');
    const signal = scanWorkspace(repoPath);
    assert.ok(typeof signal.language === 'string');
    assert.ok(Array.isArray(signal.framework));
    assert.ok(typeof signal.projectType === 'string');
  });

  test('scanWorkspace detects TypeScript project', async function () {
    const { scanWorkspace } = await import('../../core/scanner');
    // Write a tsconfig to the temp repo
    fs.writeFileSync(path.join(repoPath, 'tsconfig.json'), '{"compilerOptions":{}}');
    const signal = scanWorkspace(repoPath);
    assert.strictEqual(signal.language, 'typescript');
    fs.unlinkSync(path.join(repoPath, 'tsconfig.json'));
  });
});
