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

export function getHealthHTML(audit: AuditResult): string {
  const color = scoreColor(audit.healthScore);

  const staleBranchRows = audit.staleBranches.length > 0
    ? audit.staleBranches.map(b => `
      <div class="stale-row">
        <div class="stale-info">
          <span class="branch-name">${escapeHtml(b.name)}</span>
          <span class="muted">${b.ageDays} days stale</span>
        </div>
        <div class="stale-actions">
          <button class="action-btn merge-btn" data-branch="${escapeHtml(b.name)}">Merge</button>
          <button class="action-btn delete-btn" data-branch="${escapeHtml(b.name)}">Delete</button>
          <button class="action-btn revive-btn" data-branch="${escapeHtml(b.name)}">Revive</button>
        </div>
      </div>`).join('')
    : '<p class="muted">No stale branches. Well done.</p>';

  const namingIssuesHTML = audit.namingIssues.length > 0
    ? `<div class="section">
        <div class="section-label">Naming issues</div>
        ${audit.namingIssues.map(b => `
          <div class="naming-row">
            <span class="branch-name">${escapeHtml(b)}</span>
            <span class="muted">→ expected: ${escapeHtml(audit.inferredConvention || 'feat/ fix/ chore/')}</span>
          </div>`).join('')}
      </div>`
    : '';

  const secretsBanner = audit.secretsWarning
    ? `<div class="banner banner-warning">
        $(warning) Possible secrets detected in recent commit history. Review and rotate affected keys.
      </div>`
    : '';

  return `
<div class="panel health-panel">
  ${secretsBanner}

  <div class="score-card score-${color}">
    <div class="score-number">${audit.healthScore}<span class="score-max">/100</span></div>
    <div class="score-reason">${escapeHtml(audit.healthReason)}</div>
  </div>

  <div class="active-branch-card">
    <div class="section-label">Active branch</div>
    <div class="active-branch-name">$(git-branch) ${escapeHtml(audit.activeBranch.name)}</div>
    <div class="active-branch-meta">
      <span>${audit.activeBranch.ageDays} days old</span>
      <span>·</span>
      <span>${audit.activeBranch.divergenceFromMain} commits ahead of main</span>
    </div>
    <div class="last-commit muted">"${escapeHtml(audit.activeBranch.lastCommitMessage)}"</div>
  </div>

  <div class="section">
    <div class="section-label">Stale branches</div>
    ${staleBranchRows}
  </div>

  ${namingIssuesHTML}

  <div class="section muted convention">
    <div class="section-label">Detected convention</div>
    <code>${escapeHtml(audit.inferredConvention || 'none detected')}</code>
  </div>
</div>`;
}
