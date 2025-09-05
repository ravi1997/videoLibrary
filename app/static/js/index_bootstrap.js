// Lightweight bootstrap previously in inline <script> of index.html (CSP compliant)
// Handles initial tab switching before heavy index.js logic executes.
(function () {
  const tabs = document.querySelectorAll('.tab-btn');
  const panels = document.querySelectorAll('.tab-panel');
  function switchTab(id) {
    panels.forEach(p => p.classList.toggle('hidden', p.id !== id));
    tabs.forEach(t => {
      const active = t.getAttribute('data-tab') === id;
      t.classList.toggle('border-[color:var(--brand-600)]', active);
    });
    localStorage.setItem('index.activeTab', id);
  }
  // Expose early so HTML event handlers are unnecessary (removed inline handlers)
  window.indexPage = Object.assign(window.indexPage || {}, { switchTab });
  const saved = localStorage.getItem('index.activeTab') || 'trendingTab';
  switchTab(saved);

  // Bind removed inline handlers to elements (category, chips, pagination, view toggle)
  const catSelect = document.getElementById('categorySelect');
  if (catSelect) {
    catSelect.addEventListener('change', e => {
      window.indexPage?.onCategoryChange?.(e.target.value);
    });
  }
  // Static category chips (initial before dynamic replacement by index.js)
  document.getElementById('quickChips')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-category]');
    if (!btn) return;
    window.indexPage?.onCategoryChange?.(btn.dataset.category || '');
  });
  // Pagination + view toggle (early no-op if index.js not loaded yet)
  document.getElementById('prevBtn')?.addEventListener('click', () => window.indexPage?.changePage?.(-1));
  document.getElementById('nextBtn')?.addEventListener('click', () => window.indexPage?.changePage?.(1));
  document.getElementById('viewToggle')?.addEventListener('click', () => window.indexPage?.toggleView?.());
})();
