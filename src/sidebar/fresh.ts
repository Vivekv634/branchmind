import { ProjectSignal } from '../core/scanner';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function getFreshRepoHTML(signals: ProjectSignal, savedKeywords: string[] = []): string {
  const inferredChips = [
    signals.language !== 'unknown' ? signals.language : null,
    ...signals.framework,
    signals.projectType !== 'generic' ? signals.projectType : null,
  ].filter((v): v is string => v !== null && v.length > 0);

  const allKeywords = [...new Set([...inferredChips, ...savedKeywords])];

  const inferredChipsHTML = inferredChips
    .map(chip => {
      const selected = allKeywords.includes(chip);
      return `<span class="chip inferred${selected ? ' sel' : ''}" data-value="${escapeHtml(chip)}">${escapeHtml(chip)} <span class="chip-remove" data-value="${escapeHtml(chip)}">×</span></span>`;
    })
    .join('');

  const userChipsHTML = savedKeywords
    .filter(k => !inferredChips.includes(k))
    .map(k => `<span class="chip user sel" data-value="${escapeHtml(k)}">${escapeHtml(k)} <span class="chip-remove" data-value="${escapeHtml(k)}">×</span></span>`)
    .join('');

  return `
<div class="panel fresh-panel">
  <div class="tip-card">
    <span class="tip-icon">$(rocket)</span>
    <div>
      <strong>Fresh repo detected</strong>
      <p>Inferred from workspace files. Select what applies to your project.</p>
    </div>
  </div>

  <div class="section">
    <div class="section-label">Inferred context</div>
    <div class="chips-container" id="inferred-chips">
      ${inferredChipsHTML || '<span class="muted">No signals detected</span>'}
    </div>
  </div>

  <div class="section">
    <div class="section-label">Your keywords</div>
    <div class="chips-container" id="user-chips">
      ${userChipsHTML}
    </div>
    <div class="input-row">
      <input
        type="text"
        id="keyword-input"
        placeholder="e.g. solo dev, auth, payments"
        autocomplete="off"
      />
    </div>
    <div class="hint">Separate with commas or press Enter</div>
  </div>

  <div class="section suggestion-section">
    <div class="section-label">Suggested first branch</div>
    <div class="branch-suggestion" id="branch-suggestion">
      <span class="branch-prefix">feat/</span><span id="branch-slug">setup</span>
    </div>
    <button class="copy-btn" id="copy-branch-btn">$(copy) Copy</button>
  </div>
</div>`;
}
