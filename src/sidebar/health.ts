import { AuditResult } from '../audit/audit';

function scoreColor(score: number): string {
  if (score > 75) return 'green';
  if (score >= 50) return 'amber';
  return 'red';
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Abbreviate commit message to fit a compact row. */
function abbreviate(msg: string, max = 52): string {
  if (msg.length <= max) return msg;
  return msg.slice(0, max - 1) + '…';
}

export function getHealthHTML(audit: AuditResult): string {
  const color = scoreColor(audit.healthScore);
  const pct   = Math.max(0, Math.min(100, audit.healthScore));

  // ── Secrets banner ────────────────────────────────────────────────────────
  const secretsBanner = audit.secretsWarning
    ? `<div class="banner banner-warning">
        <span class="banner-icon">⚠</span>
        <span>Possible secrets detected in recent commit history. Review and rotate affected keys.</span>
       </div>`
    : '';

  // ── Stale branch rows ─────────────────────────────────────────────────────
  const staleBranchRows = audit.staleBranches.length > 0
    ? audit.staleBranches.map(b => `
      <div class="bm-row stale-row" tabindex="0">
        <span class="bm-row-icon" aria-hidden="true">⎇</span>
        <div class="bm-row-body">
          <span class="bm-row-label">
            <span class="bm-branch-ref branch-name">${escapeHtml(b.name)}</span>
          </span>
        </div>
        <span class="bm-row-meta">${b.ageDays}d stale</span>
        <div class="bm-row-actions stale-actions" aria-label="Branch actions">
          <button class="bm-btn merge-btn  action-btn" data-branch="${escapeHtml(b.name)}" title="Merge">⊕</button>
          <button class="bm-btn delete-btn action-btn" data-branch="${escapeHtml(b.name)}" title="Delete">⊗</button>
          <button class="bm-btn revive-btn action-btn" data-branch="${escapeHtml(b.name)}" title="Revive">↩</button>
        </div>
      </div>`).join('')
    : `<div class="bm-empty">No stale branches. Well done.</div>`;

  // ── Naming issues ─────────────────────────────────────────────────────────
  const namingSection = audit.namingIssues.length > 0
    ? `<div class="bm-section">
        <div class="bm-section-header">
          <span class="bm-section-icon">✎</span>
          Naming Issues
          <span class="bm-section-count">${audit.namingIssues.length}</span>
        </div>
        ${audit.namingIssues.map(b => `
          <div class="bm-row naming-row" tabindex="0">
            <span class="bm-row-icon" aria-hidden="true">⎇</span>
            <div class="bm-row-body">
              <span class="bm-row-label bm-branch-ref branch-name">${escapeHtml(b)}</span>
              <span class="bm-row-sublabel">expected: ${escapeHtml(audit.inferredConvention || 'feat/ fix/ chore/')}</span>
            </div>
            <span class="bm-row-meta">rename</span>
            <div class="bm-row-actions" aria-label="Branch actions">
              <button
                class="bm-btn rename-btn"
                data-branch="${escapeHtml(b)}"
                data-convention="${escapeHtml(audit.inferredConvention || 'feat/')}"
                title="Rename to follow convention"
              >✎</button>
            </div>
          </div>`).join('')}
      </div>`
    : '';

  // ── Convention row ────────────────────────────────────────────────────────
  const conventionContent = audit.inferredConvention
    ? `<span class="bm-convention-tag">${escapeHtml(audit.inferredConvention)}</span>`
    : `<span class="bm-convention-tag undetected">none detected</span>`;

  return `
<div class="panel health-panel">
  ${secretsBanner}

  <!-- ── Score Strip ─────────────────────────────────── -->
  <div class="bm-score-strip score-${color}" role="status" aria-label="Health score ${audit.healthScore} of 100">
    <span class="bm-score-dot"></span>
    <span class="bm-score-value">${audit.healthScore}<span class="bm-score-denom">/100</span></span>
    <div class="bm-score-bar" aria-hidden="true">
      <div class="bm-score-fill" style="width:${pct}%"></div>
    </div>
    <span class="bm-score-reason">${escapeHtml(audit.healthReason)}</span>
  </div>

  <!-- ── Active Branch ───────────────────────────────── -->
  <div class="bm-section">
    <div class="bm-section-header">
      <span class="bm-section-icon">⎇</span>
      Active Branch
    </div>

    <div class="bm-row">
      <span class="bm-row-icon" aria-hidden="true" style="color:var(--bm-branch);opacity:0.9">⎇</span>
      <div class="bm-row-body">
        <span class="bm-row-label">
          <span class="bm-branch-ref">${escapeHtml(audit.activeBranch.name)}</span>
        </span>
      </div>
      <span class="bm-row-meta">
        ${audit.activeBranch.ageDays}d
        &nbsp;·&nbsp;
        <span class="bm-ahead">↑${audit.activeBranch.divergenceFromMain}</span>
      </span>
    </div>

    <div class="bm-row">
      <span class="bm-row-icon" aria-hidden="true" style="opacity:0.25">◎</span>
      <div class="bm-row-body">
        <span class="bm-row-label bm-commit-msg">&ldquo;${escapeHtml(abbreviate(audit.activeBranch.lastCommitMessage))}&rdquo;</span>
      </div>
    </div>
  </div>

  <!-- ── Stale Branches ──────────────────────────────── -->
  <div class="bm-section">
    <div class="bm-section-header">
      <span class="bm-section-icon">⏱</span>
      Stale Branches
      ${audit.staleBranches.length > 0 ? `<span class="bm-section-count">${audit.staleBranches.length}</span>` : ''}
    </div>
    ${staleBranchRows}
  </div>

  ${namingSection}

  <!-- ── Convention ──────────────────────────────────── -->
  <div class="bm-section convention">
    <div class="bm-section-header">
      <span class="bm-section-icon">◈</span>
      Detected Convention
    </div>
    <div class="bm-row">
      <span class="bm-row-icon" aria-hidden="true" style="opacity:0.3">◉</span>
      <div class="bm-row-body">
        <span class="bm-row-label">${conventionContent}</span>
      </div>
    </div>
  </div>
</div>`;
}
