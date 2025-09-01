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

    mount.innerHTML = `
      <div class="relative group">
        <button class="btn btn-ghost flex items-center gap-2" id="userBtn" aria-haspopup="menu" aria-expanded="false">
          <span class="sm:inline">${safeName}</span>
        </button>
        <div id="userMenu" class="hidden absolute right-0 mt-2 w-56 card p-2 group-hover:block" role="menu" aria-labelledby="userBtn">
          <div class="px-3 py-2 rounded hover:bg-[color:var(--brand-50)]">
            <div class="text-sm font-semibold">${safeName}</div>
            <div class="text-xs muted">${escapeHtml(user.email || "")}</div>
          </div>
          <hr class="hr" />
          <a class="block px-3 py-2 rounded hover:bg-[color:var(--brand-50)] no-underline" href="/profile">Profile</a>
          <a class="block px-3 py-2 rounded hover:bg-[color:var(--brand-50)] no-underline" href="/settings">Settings</a>
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
    } catch { /* ignore */ }
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
  // Expose for inline onclick in layout.html
  window.searchVideos = searchVideos;

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
