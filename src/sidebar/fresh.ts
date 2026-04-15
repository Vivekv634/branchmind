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
      return `<span class="chip inferred${selected ? ' sel' : ''}" data-value="${escapeHtml(chip)}" role="checkbox" aria-checked="${selected}">${escapeHtml(chip)} <span class="chip-remove" role="button" tabindex="0" aria-label="Remove ${escapeHtml(chip)}">×</span></span>`;
    })
    .join('');

  const userChipsHTML = savedKeywords
    .filter(k => !inferredChips.includes(k))
    .map(k => `<span class="chip user sel" data-value="${escapeHtml(k)}" role="checkbox" aria-checked="true">${escapeHtml(k)} <span class="chip-remove" role="button" tabindex="0" aria-label="Remove ${escapeHtml(k)}">×</span></span>`)
    .join('');

  return `
<div class="panel fresh-panel">

  <!-- ── Tip banner ──────────────────────────────────── -->
  <div class="bm-tip-row">
    <span class="bm-tip-icon">◎</span>
    <div>
      <div class="bm-tip-title">Fresh repo detected</div>
      <div class="bm-tip-desc">Inferred from workspace files. Select what applies to your project.</div>
    </div>
  </div>

  <!-- ── Inferred context ────────────────────────────── -->
  <div class="bm-section">
    <div class="bm-section-header">
      <span class="bm-section-icon">⊙</span>
      Inferred Context
    </div>
    <div class="chips-container" id="inferred-chips">
      ${inferredChipsHTML || '<span class="bm-empty" style="padding-left:0">No signals detected</span>'}
    </div>
  </div>

  <!-- ── Your keywords ───────────────────────────────── -->
  <div class="bm-section">
    <div class="bm-section-header">
      <span class="bm-section-icon">✎</span>
      Your Keywords
    </div>
    <div class="chips-container" id="user-chips">
      ${userChipsHTML}
    </div>
    <div class="input-row">
      <input
        type="text"
        id="keyword-input"
        placeholder="e.g. auth, payments, solo dev"
        autocomplete="off"
      />
    </div>
    <div class="hint">Separate with commas or press Enter</div>
  </div>

  <!-- ── Suggested first branch ──────────────────────── -->
  <div class="bm-section">
    <div class="bm-section-header">
      <span class="bm-section-icon">⎇</span>
      Suggested First Branch
    </div>
    <div class="branch-suggestion" id="branch-suggestion">
      <span class="branch-prefix">feat/</span><span id="branch-slug">setup</span>
    </div>
    <button class="copy-btn" id="copy-branch-btn">⎘ Copy</button>
  </div>

</div>`;
}
