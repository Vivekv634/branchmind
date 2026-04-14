// BranchMind webview script
// Runs inside the VS Code webview context.
// Communicates with the extension via acquireVsCodeApi().postMessage()

(function () {
  const vscode = acquireVsCodeApi();

  // ── Chip interactions (fresh repo panel) ──────────────────────────────────

  function slugify(text) {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  }

  function getSelectedKeywords() {
    return Array.from(document.querySelectorAll('.chip.sel'))
      .map(el => el.dataset.value)
      .filter(Boolean);
  }

  function updateBranchSuggestion() {
    const slugEl = document.getElementById('branch-slug');
    if (!slugEl) return;
    const keywords = getSelectedKeywords();
    if (keywords.length === 0) { slugEl.textContent = 'setup'; return; }
    const slug = keywords.slice(0, 2).map(slugify).join('-') + '-setup';
    slugEl.textContent = slug;
  }

  function notifyKeywordChange() {
    vscode.postMessage({ type: 'updateKeywords', keywords: getSelectedKeywords() });
  }

  function addUserChip(value) {
    const trimmed = value.trim();
    if (!trimmed) return;
    const container = document.getElementById('user-chips');
    if (!container) return;
    if (document.querySelector(`.chip[data-value="${CSS.escape(trimmed)}"]`)) return;
    const chip = document.createElement('span');
    chip.className = 'chip user sel';
    chip.dataset.value = trimmed;
    chip.innerHTML = `${trimmed} <span class="chip-remove" data-value="${trimmed}">×</span>`;
    container.appendChild(chip);
    updateBranchSuggestion();
    notifyKeywordChange();
  }

  function removeChip(value) {
    const chip = document.querySelector(`.chip[data-value="${CSS.escape(value)}"]`);
    if (chip) chip.remove();
    updateBranchSuggestion();
    notifyKeywordChange();
  }

  // Delegated click handler for all interactive elements
  document.addEventListener('click', (e) => {
    const target = e.target;
    if (!target) return;

    if (target.classList.contains('chip-remove')) {
      const value = target.dataset.value;
      if (value) removeChip(value);
      return;
    }

    if (target.classList.contains('chip') && target.classList.contains('inferred')) {
      target.classList.toggle('sel');
      updateBranchSuggestion();
      notifyKeywordChange();
      return;
    }

    if (target.id === 'copy-branch-btn') {
      const slugEl = document.getElementById('branch-slug');
      if (slugEl) {
        const branch = 'feat/' + slugEl.textContent;
        navigator.clipboard?.writeText(branch);
        target.textContent = 'Copied!';
        setTimeout(() => { target.textContent = 'Copy'; }, 1500);
      }
      return;
    }

    if (target.classList.contains('merge-btn'))
      vscode.postMessage({ type: 'mergeBranch', branch: target.dataset.branch });
    if (target.classList.contains('delete-btn'))
      vscode.postMessage({ type: 'deleteBranch', branch: target.dataset.branch });
    if (target.classList.contains('revive-btn'))
      vscode.postMessage({ type: 'reviveBranch', branch: target.dataset.branch });
  });

  // Keyword input — comma or Enter commits tokens as chips
  const keywordInput = document.getElementById('keyword-input');
  if (keywordInput) {
    keywordInput.addEventListener('input', (e) => {
      const val = e.target.value;
      if (val.endsWith(',')) {
        val.slice(0, -1).split(',').map(t => t.trim()).filter(Boolean).forEach(addUserChip);
        e.target.value = '';
      }
    });
    keywordInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.target.value.split(',').map(t => t.trim()).filter(Boolean).forEach(addUserChip);
        e.target.value = '';
      }
    });
  }

  // ── Suggestion panel helpers ───────────────────────────────────────────────

  /** Find or create the suggestions panel inside #bm-root. */
  function getSuggestionsPanel() {
    return document.querySelector('.suggestions-panel');
  }

  /**
   * Replace the suggestions panel with new HTML, or append it if absent.
   * Preserves stale/cached state: any existing stale badges are kept until
   * the next gitEvent resets them.
   */
  function updateSuggestionsPanel(html) {
    const root = document.getElementById('bm-root');
    if (!root) return;

    const existing = getSuggestionsPanel();
    const temp = document.createElement('div');
    temp.innerHTML = html;
    const incoming = temp.querySelector('.suggestions-panel');
    if (!incoming) return;

    if (existing) {
      existing.replaceWith(incoming);
    } else {
      root.appendChild(incoming);
    }
  }

  /** Show/hide the inference loading spinner inside the suggestions area. */
  function setInferenceLoading(active) {
    let indicator = document.getElementById('bm-inference-loading');
    if (active) {
      if (!indicator) {
        indicator = document.createElement('div');
        indicator.id = 'bm-inference-loading';
        indicator.className = 'inference-loading';
        indicator.innerHTML = '<div class="spinner"></div><span>Thinking…</span>';
        const panel = getSuggestionsPanel();
        if (panel) panel.prepend(indicator);
      }
    } else {
      indicator?.remove();
    }
  }

  // ── Suggestion decay ──────────────────────────────────────────────────────

  let lastGitEventTime = Date.now();

  function markStale() {
    document.querySelectorAll('.suggestion-card:not(.stale)').forEach(card => {
      card.classList.add('stale');
      const header = card.querySelector('.suggestion-header');
      if (header && !header.querySelector('.badge-stale')) {
        const badge = document.createElement('span');
        badge.className = 'badge badge-stale';
        badge.textContent = 'stale';
        header.appendChild(badge);
      }
    });
  }

  function clearStale() {
    document.querySelectorAll('.suggestion-card.stale').forEach(card => {
      card.classList.remove('stale');
      card.querySelector('.badge-stale')?.remove();
    });
  }

  // ── Message handler (from extension) ─────────────────────────────────────

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || !msg.type) return;

    switch (msg.type) {

      case 'gitEvent':
        lastGitEventTime = Date.now();
        clearStale();
        break;

      case 'markSuggestionsStale':
        markStale();
        break;

      // ── Fix: partial suggestion update without full HTML reload ──
      case 'updateSuggestions':
        setInferenceLoading(false);
        if (typeof msg.html === 'string') updateSuggestionsPanel(msg.html);
        break;

      // Show spinner while local inference is running
      case 'inferenceStart':
        setInferenceLoading(true);
        break;

      // Swap entire body content (used by full refreshSidebar calls)
      case 'setHTML':
        if (typeof msg.html === 'string') {
          const root = document.getElementById('bm-root');
          if (root) {
            root.innerHTML = msg.html;
            updateBranchSuggestion();
          }
        }
        break;
    }
  });

  // Mark suggestions stale after 5 min of no git activity (belt + suspenders
  // alongside the extension-side staleCheckTimer)
  setInterval(() => {
    if (Date.now() - lastGitEventTime > 5 * 60 * 1000) markStale();
  }, 30_000);

  updateBranchSuggestion();
})();
