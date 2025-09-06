/* ==========================================================================
   RPC Surgical Video Library — Layout & Theme Utilities (no dependencies)
   - Light/Dark theme toggle with persistence
   - Simple auth area rendering (progressively enhanced)
   - Tiny helpers + search handler stub
   ========================================================================== */

(() => {
  // ------------------ Theme ------------------
  const THEME_KEY = "ui.theme"; // "light" | "dark"
  const htmlEl = document.documentElement;
  const bodyEl = document.body;

  const getSystemPrefersDark = () =>
    window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;

  function applyTheme(theme) {
    const isDark = theme === "dark";
    // Keep Tailwind dark: variants + CSS variables in sync by putting .dark on both
    htmlEl.classList.toggle("dark", isDark);
    bodyEl.classList.toggle("dark", isDark);

    // For libraries that read data-theme
    htmlEl.setAttribute("data-theme", isDark ? "dark" : "light");
    bodyEl.setAttribute("data-theme", isDark ? "dark" : "light");

    updateThemeToggleIcon(isDark);
  }

  function updateThemeToggleIcon(isDark) {
    const btn = document.getElementById("themeToggle");
    if (!btn) return;
    // Use emoji to avoid any icon libs
    btn.textContent = isDark ? "☀️" : "🌙";
    btn.setAttribute("aria-label", isDark ? "Switch to light theme" : "Switch to dark theme");
    btn.setAttribute("title", isDark ? "Switch to light theme" : "Switch to dark theme");
  }

  function readStoredTheme() {
    const v = localStorage.getItem(THEME_KEY);
    return v === "dark" || v === "light" ? v : null;
  }

  function initTheme() {
    const stored = readStoredTheme();
    const initial = stored ?? (getSystemPrefersDark() ? "dark" : "light");
    applyTheme(initial);
    // Keep in storage to avoid flicker on next navigation
    if (!stored) localStorage.setItem(THEME_KEY, initial);

    // Respond if user changes OS theme (only when user hasn't explicitly chosen)
    if (!stored && window.matchMedia) {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      try {
        mq.addEventListener("change", (e) => {
          const sys = e.matches ? "dark" : "light";
          applyTheme(sys);
          localStorage.setItem(THEME_KEY, sys);
        });
      } catch {
        // Safari <14
        mq.addListener((e) => {
          const sys = e.matches ? "dark" : "light";
          applyTheme(sys);
          localStorage.setItem(THEME_KEY, sys);
        });
      }
    }
  }

  function toggleTheme() {
    const current = readStoredTheme() ?? (getSystemPrefersDark() ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  }
  function safeParse(json) {
    try { return JSON.parse(json); } catch { return null; }
  }

  // ------------------ Auth area (progressive enhancement) ------------------
  /**
   * Server can inject:
   *   <script>window.__USER__ = { name: "Ravi", avatarUrl: "/static/img/u.png" };</script>
   * If not present, we render a Login button.
   */
  // ------------------ Auth area ------------------
  /**
   * Priority:
   * 1) window.__USER__ (server-injected)
   * 2) localStorage "user" (set by login.js)
   * 3) If we have a token but no user, fetch /api/v1/auth/me to hydrate and cache
   */
  async function renderAuthArea() {
    const mount = document.getElementById("authArea");
    if (!mount) return;

    // Try server-injected user first
    let user = window.__USER__ || null;

    // Fall back to localStorage
    if (!user) {
      const cached = safeParse(localStorage.getItem("user"));
      if (cached && (cached.username || cached.email)) {
        user = toDisplayUser(cached);
      }
    }

    // If we have a token but no user, try /me
    if (!user) {
      const token = localStorage.getItem("token");
      if (token) {
        try {
          const me = await fetch("/api/v1/auth/me", {
            headers: {
              "Accept": "application/json",
              "Authorization": `Bearer ${token}`,
            },
          });
          if (me.ok) {
            const data = await me.json();
            const u = data.logged_in_as || data.user || data;
            if (u) {
              localStorage.setItem("user", JSON.stringify(u));
              user = toDisplayUser(u);
            }
          } else if (me.status === 401 || me.status === 403) {
            // Token invalid/expired — clear it
            clearAuthStorage();
          }
        } catch {
          // network issues -> ignore; we'll show Login
        }
      }
    }

    if (!user) {
      mount.innerHTML = `<a class="btn btn-primary" href="/login">Login</a>`;
      return;
    }

    const safeName = escapeHtml(user.name || user.username || "User");
    const rawUser = safeParse(localStorage.getItem('user')) || {};
    // Normalize roles: handle forms like 'role.viewer', 'ROLE_ADMIN', etc.
    const roles = (rawUser.roles || []).map(r => {
      const v = String(r).toLowerCase();
      return v.replace(/^role[._-]/,''); // strip leading 'role.' / 'role-' / 'role_'
    });
    const isUploader = roles.includes('uploader') || roles.includes('admin') || roles.includes('superadmin');
    const isAdmin = roles.includes('admin') || roles.includes('superadmin');

    // Grouped links for automatic divider insertion between sections
  const groups = [
      [ // Account
        { href: '/settings', label: 'Settings' },
        { href: '/change-password', label: 'Change Password' }
      ],
      [ // Activity
        { href: '/history', label: 'History' },
        { href: '/favourites', label: 'Favourites' }
      ],
      isUploader ? [ { href: '/upload', label: 'Upload Video' } ] : null,
      [ // Legal
        { href: '/privacy', label: 'Privacy' },
        { href: '/terms', label: 'Terms' }
      ]
    ].filter(Boolean);

    const linksHtml = groups
      .map(g => g.map(l => `<a class="block px-3 py-2 rounded hover:bg-[color:var(--brand-50)] no-underline" href="${escapeAttr(l.href)}">${escapeHtml(l.label)}</a>`).join(''))
      .join('<hr class="hr" />');

    let adminSection = '';
    if (isAdmin) {
      const adminLinks = [
        { href: '/admin/dashboard', label: 'Dashboard' },
        { href: '/admin/unverified', label: 'Verify Users' },
        { href: '/admin/link-surgeons', label: 'Link Surgeons' }
      ];
      const adminLinksHtml = adminLinks.map(l => `<a class="block px-3 py-2 rounded hover:bg-[color:var(--brand-50)] no-underline" href="${escapeAttr(l.href)}">${escapeHtml(l.label)}</a>`).join('');
      adminSection = `
        <hr class=\"hr\" />
        <div class=\"mt-1\">
          <button id=\"adminMenuToggle\" class=\"w-full flex items-center justify-between px-3 py-2 rounded hover:bg-[color:var(--brand-50)] text-sm font-semibold\" aria-expanded=\"false\" aria-controls=\"adminMenuPanel\">
            <span>Admin</span>
            <span id=\"adminChevron\" class=\"transition-transform text-xs\">▸</span>
          </button>
          <div id=\"adminMenuPanel\" class=\"hidden pt-1 border-l border-[color:var(--border)] ml-2 pl-2\" role=\"group\">${adminLinksHtml}</div>
        </div>`;
    }

    mount.innerHTML = `
      <div class="relative group">
        <button class="btn btn-ghost flex items-center gap-2" id="userBtn" aria-haspopup="menu" aria-expanded="false">
          <span class="sm:inline">${safeName}</span>
        </button>
        <div id="userMenu" class="hidden absolute right-0 mt-2 w-60 card group-hover:block" role="menu" aria-labelledby="userBtn">
          <a href="/profile" class="block px-3 py-2 rounded hover:bg-[color:var(--brand-50)] no-underline" role="menuitem">
            <div class="text-sm font-semibold">${safeName}</div>
            <div class="text-xs muted truncate">${escapeHtml(user.email || "")}</div>
          </a>
          <hr class="hr" />
          ${linksHtml}
          ${adminSection}
          <hr class="hr" />
          <button class="block w-full text-left px-3 py-2 rounded text-[color:var(--danger)] hover:bg-[color:var(--brand-50)]" id="logoutBtn">Logout</button>
        </div>
      </div>
    `;
    const btn = document.getElementById("userBtn");
    const menu = document.getElementById("userMenu");


    function openMenu() {
      menu.classList.remove("hidden");
      btn.setAttribute("aria-expanded", "true");
    }
    function closeMenu() {
      menu.classList.add("hidden");
      btn.setAttribute("aria-expanded", "false");
    }
    function toggleMenu() {
      if (menu.classList.contains("hidden")) openMenu(); else closeMenu();
    }
    function handleOutside(e) {
      if (!menu.contains(e.target) && !btn.contains(e.target)) closeMenu();
    }
    function handleEsc(e) {
      if (e.key === "Escape") closeMenu();
    }

    btn.addEventListener("click", toggleMenu);
    document.addEventListener("click", handleOutside);
    document.addEventListener("keydown", handleEsc);

    // Clean up listeners on navigation (best-effort)
    window.addEventListener("beforeunload", () => {
      document.removeEventListener("click", handleOutside);
      document.removeEventListener("keydown", handleEsc);
    });


    // Wire logout
    const logoutBtn = document.getElementById("logoutBtn");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", onLogoutClick);
    }

    // Admin submenu toggle
    const adminToggle = document.getElementById('adminMenuToggle');
    const adminPanel = document.getElementById('adminMenuPanel');
    const adminChevron = document.getElementById('adminChevron');
    if (adminToggle && adminPanel) {
      adminToggle.addEventListener('click', (e) => {
        e.preventDefault();
        const open = !adminPanel.classList.contains('hidden');
        if (open) {
          adminPanel.classList.add('hidden');
          adminToggle.setAttribute('aria-expanded','false');
          if(adminChevron) adminChevron.style.transform='rotate(0deg)';
        } else {
          adminPanel.classList.remove('hidden');
          adminToggle.setAttribute('aria-expanded','true');
          if(adminChevron) adminChevron.style.transform='rotate(90deg)';
        }
      });
    }
  }



  function toDisplayUser(u) {
    return {
      name: u.name || u.full_name || u.username || "",
      username: u.username || "",
      email: u.email || "",
      avatarUrl: u.avatarUrl || u.avatar_url || u.avatar || "",
    };
  }

  async function onLogoutClick() {
    // Try to notify server; ignore failures
    const token = localStorage.getItem("token");
    try {
      await fetch("/api/v1/auth/logout", {
        method: "POST",
        headers: token ? { "Authorization": `Bearer ${token}` } : {},
      });
    } catch {
      // ignore
    }
    clearAuthStorage();
    // Redirect to login (or home if you prefer)
    try { window.location.assign("/login"); } catch { window.location.href = "/login"; }
  }

  function clearAuthStorage() {
    try {
      localStorage.removeItem("token");
      localStorage.removeItem("user");
      localStorage.removeItem("refresh_token");
    } catch { /* ignore */ }
  }

  // ------------------ Toast System ------------------
  function showToast(message, type = 'info', timeout = 4000) {
    const host = document.getElementById('toastHost');
    if (!host) return;
    const el = document.createElement('div');
    el.className = `px-4 py-2 rounded shadow text-sm animate-fade-in pointer-events-auto bg-[color:var(--surface)] border border-[color:var(--border)] ${type === 'error' ? 'text-red-600 dark:text-red-400' : type === 'warn' ? 'text-yellow-600 dark:text-yellow-400' : 'text-[color:var(--text)]'}`;
    el.textContent = message;
    host.appendChild(el);
    if (timeout > 0) setTimeout(() => { el.classList.add('opacity-0','transition'); setTimeout(()=> el.remove(), 400); }, timeout);
  }

  // Inject minimal keyframes if not present (idempotent)
  if (!document.getElementById('__toast_style')) {
    const style = document.createElement('style');
    style.id = '__toast_style';
    style.textContent = `.animate-fade-in{animation:fade-in .25s ease-out} @keyframes fade-in{from{opacity:0;transform:translateY(-4px)} to{opacity:1;transform:translateY(0)}}`;
    document.head.appendChild(style);
  }

  // ------------------ Global 401 Auto-Redirect ------------------
  // Intercept fetch & XHR responses; on 401/403 clear auth + redirect to /login?next=<current>
  // Avoid infinite loops by: (a) skipping on /login routes, (b) one-time session lock.
  async function tryRefreshToken() {
    const refresh = localStorage.getItem('refresh_token');
    if (!refresh) return false;
    try {
      const resp = await fetch('/api/v1/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({ refresh_token: refresh }) });
      if (!resp.ok) return false;
      const data = await resp.json().catch(()=>({}));
      if (data.access_token) {
        localStorage.setItem('token', data.access_token);
        if (data.refresh_token) localStorage.setItem('refresh_token', data.refresh_token);
        showToast('Session refreshed. Continuing…','info',2500);
        return true;
      }
    } catch { /* ignore */ }
    return false;
  }

  async function handleAuthFailure(resp, retryFn) {
    if (!resp || !(resp.status === 401 || resp.status === 403)) return;
    const status = resp.status;
    const path = window.location.pathname;

    // Special case: forced password change (403 with error=password_change_required)
    if (status === 403) {
      try {
        const ct = resp.headers.get('content-type') || '';
        if (ct.includes('application/json')) {
          const clone = resp.clone();
          const data = await clone.json().catch(()=>null);
          if (data && data.error === 'password_change_required') {
            if (!path.startsWith('/change-password')) {
              showToast('Password update required. Redirecting…','info',3000);
              setTimeout(()=>{ try { window.location.replace('/change-password'); } catch { window.location.href='/change-password'; } }, 500);
            }
            return; // Do not treat as auth expiry
          }
        }
      } catch { /* ignore parse errors */ }
    }

    if (path.startsWith('/login')) return; // already on login
    // Attempt refresh once per navigation
    if (!sessionStorage.getItem('__refresh_attempted')) {
      sessionStorage.setItem('__refresh_attempted','1');
      const ok = await tryRefreshToken();
      if (ok && typeof retryFn === 'function') {
        try { await retryFn(); return; } catch {/* swallow and fallback */}
      }
    }
    if (sessionStorage.getItem('__auth_redirect_lock')) return;
    sessionStorage.setItem('__auth_redirect_lock','1');
    showToast('Session expired. Redirecting to login…','warn',3500);
    clearAuthStorage();
    const ret = encodeURIComponent(path + window.location.search);
    setTimeout(()=>{ try { window.location.replace(`/login?next=${ret}`); } catch { window.location.href = `/login?next=${ret}`; } }, 1200);
  }

  // Patch fetch once
  if (!window.__FETCH_401_PATCHED) {
    window.__FETCH_401_PATCHED = true;
    const origFetch = window.fetch;
    window.fetch = async function patchedFetch(input, init) {
      const attempt = async () => origFetch(input, init);
      try {
        let resp = await attempt();
        if (resp.status === 401 || resp.status === 403) {
          await handleAuthFailure(resp, async () => { resp = await attempt(); });
        }
        return resp;
      } catch (e) { throw e; }
    };
  }

  // Patch XHR once
  if (!window.__XHR_401_PATCHED) {
    window.__XHR_401_PATCHED = true;
    const OrigSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function patchedSend(...args) {
      const xhr = this;
      xhr.addEventListener('load', () => {
        if (xhr.status === 401 || xhr.status === 403) {
          // Build a faux response-like object for unified handler
          let faux = { status: xhr.status, headers: { get: () => xhr.getResponseHeader('Content-Type') }, clone: () => ({ json: async () => { try { return JSON.parse(xhr.responseText); } catch { return null; } } }) };
          handleAuthFailure(faux);
        }
      });
      return OrigSend.apply(xhr, args);
    };
  }


  // ------------------ Search ------------------
  // Minimal stub: redirects to /search?q=...
  function searchVideos() {
    const input = document.getElementById("searchInput");
    if (!input) return;
    const q = input.value.trim();
    if (!q) return;
    window.location.href = `/search?q=${encodeURIComponent(q)}`;
  }
  // Bind search button (CSP-safe)
  function bindSearchButton() {
    const btn = document.getElementById("searchBtn");
    if (btn) btn.addEventListener("click", searchVideos);
  }

  // Submit on Enter
  function bindSearchEnter() {
    const input = document.getElementById("searchInput");
    if (!input) return;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") searchVideos();
    });
  }

  // ------------------ Small helpers ------------------
  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }
  function escapeAttr(s) {
    // Keep it simple; escape quotes at minimum
    return String(s).replaceAll('"', "&quot;");
  }

  // ------------------ Init ------------------
  function init() {
    initTheme();
    renderAuthArea();
  bindSearchEnter();
  bindSearchButton();

    // Theme toggle click
    const themeBtn = document.getElementById("themeToggle");
    if (themeBtn) themeBtn.addEventListener("click", toggleTheme);

    // Avoid FOUC: ensure icon matches applied theme
    updateThemeToggleIcon(bodyEl.classList.contains("dark"));
  }

  // Run after DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
