// Settings page logic extracted for CSP compliance
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const getToken = () => localStorage.getItem("token") || "";
  const withAuth = (opts = {}) => ({
    ...opts,
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      ...(opts.headers || {}),
      ...(getToken() ? { Authorization: "Bearer " + getToken() } : {}),
    },
  });

  async function logout() {
    const token = getToken();
    try {
      await fetch("/api/v1/auth/logout", {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    } catch {}
    try {
      localStorage.removeItem("token");
      localStorage.removeItem("user");
    } catch {}
    try {
      window.location.assign("/login");
    } catch {
      window.location.href = "/login";
    }
  }

  const API = {
    get: "/api/v1/user/settings",
    save: "/api/v1/user/settings",
  };

  const saveMsg = $("#saveMsg");
  const btnSave = $("#btnSave");
  const btnReset = $("#btnReset");
  const logoutBtn = document.getElementById("logoutBtn");

  const themeBtns = document.querySelectorAll("[data-theme]");
  const setCompact = $("#setCompact");
  const setAutoplay = $("#setAutoplay");
  const setQuality = $("#setQuality");
  const setSpeed = $("#setSpeed");
  const setEmail = $("#setEmail");
  const setDigest = $("#setDigest");
  const setPrivate = $("#setPrivate");
  const setPersonalize = $("#setPersonalize");

  function localGet() {
    try {
      return JSON.parse(localStorage.getItem("user.settings") || "{}");
    } catch {
      return {};
    }
  }
  function localSet(v) {
    try {
      localStorage.setItem("user.settings", JSON.stringify(v));
    } catch {}
  }

  let state = {
    theme: "system",
    compact: false,
    autoplay: false,
    quality: "auto",
    speed: "1.0",
    email_updates: false,
    weekly_digest: false,
    private_profile: false,
    personalize: true,
  };

  // ----- THEME HANDLING -----
  const THEME_KEY = "ui.theme"; // used by layout.js
  const prefersDark = () => window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  function applyEffectiveTheme(effective) {
    const html = document.documentElement;
    const body = document.body;
    const isDark = effective === "dark";
    html.classList.toggle("dark", isDark);
    body.classList.toggle("dark", isDark);
    html.setAttribute("data-theme", isDark ? "dark" : "light");
    body.setAttribute("data-theme", isDark ? "dark" : "light");
  }
  function setThemeChoice(choice) {
    // choice: 'light' | 'dark' | 'system'
    if (choice === "system") {
      try { localStorage.removeItem(THEME_KEY); } catch {}
      applyEffectiveTheme(prefersDark() ? "dark" : "light");
    } else {
      try { localStorage.setItem(THEME_KEY, choice); } catch {}
      applyEffectiveTheme(choice);
    }
    // reflect button state
    themeBtns.forEach((b) => b.setAttribute("aria-pressed", String(b.getAttribute("data-theme") === choice)));
  }
  function applyToUI(s) {
    setThemeChoice(s.theme || "system");
    setCompact.checked = !!s.compact;
    setAutoplay.checked = !!s.autoplay;
    setQuality.value = s.quality || "auto";
    setSpeed.value = String(s.speed || "1.0");
    setEmail.checked = !!s.email_updates;
    setDigest.checked = !!s.weekly_digest;
    setPrivate.checked = !!s.private_profile;
    setPersonalize.checked = !!s.personalize;
  }

  function readFromUI() {
    const activeTheme = [...themeBtns].find((b) => b.getAttribute("aria-pressed") === "true");
    return {
      theme: activeTheme ? activeTheme.getAttribute("data-theme") : "system",
      compact: !!setCompact.checked,
      autoplay: !!setAutoplay.checked,
      quality: setQuality.value || "auto",
      speed: setSpeed.value || "1.0",
      email_updates: !!setEmail.checked,
      weekly_digest: !!setDigest.checked,
      private_profile: !!setPrivate.checked,
      personalize: !!setPersonalize.checked,
    };
  }

  async function load() {
    saveMsg.textContent = "Loading your settings…";
    try {
      const res = await fetch(API.get, withAuth({ method: "GET" }));
      if (res.status === 401) return (location.href = "/login");
      if (!res.ok) throw new Error("http " + res.status);
      const s = await res.json();
      state = { ...state, ...s };
      applyToUI(state);
      localSet(state);
      saveMsg.textContent = "Loaded ✓";
    } catch (e) {
      state = { ...state, ...localGet() };
      applyToUI(state);
      saveMsg.textContent = "Offline mode: using saved device preferences.";
      console.warn(e);
    }
  }

  async function save() {
    const payload = readFromUI();
    saveMsg.textContent = "Saving…";
    btnSave.disabled = true;
    try {
      const res = await fetch(API.save, withAuth({ method: "PUT", body: JSON.stringify(payload) }));
      if (res.status === 401) return (location.href = "/login");
      if (!res.ok) throw new Error("http " + res.status);
      state = payload;
      localSet(state);
      applyToUI(state);
      saveMsg.textContent = "Settings saved ✓";
    } catch (e) {
      state = payload;
      localSet(state);
      applyToUI(state);
      saveMsg.textContent = "Saved locally (network error).";
      console.error(e);
    } finally {
      btnSave.disabled = false;
    }
  }

  function reset() {
    state = {
      theme: "system",
      compact: false,
      autoplay: false,
      quality: "auto",
      speed: "1.0",
      email_updates: false,
      weekly_digest: false,
      private_profile: false,
      personalize: true,
    };
    applyToUI(state);
    saveMsg.textContent = "Defaults restored. Click Save to keep.";
  }

  themeBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const choice = btn.getAttribute("data-theme") || "system";
      setThemeChoice(choice);
    });
  });
  btnSave?.addEventListener("click", save);
  btnReset?.addEventListener("click", reset);
  if (logoutBtn) logoutBtn.addEventListener("click", (e) => { e.preventDefault(); logout(); });

  load();
})();
