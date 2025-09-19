// Profile page script extracted for CSP compliance
(function () {
  const BASE = '/video';
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
      await fetch(BASE + "/api/v1/auth/logout", {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    } catch {}
    try {
      localStorage.removeItem("token");
      localStorage.removeItem("user");
    } catch {}
    try {
      window.location.assign(BASE + "/login");
    } catch {
      window.location.href = BASE + "/login";
    }
  }

  const API = {
    me: BASE + "/api/v1/auth/me",
    stats: BASE + "/api/v1/video/stats",
  };

  const profName = $("#profName");
  const profSub = $("#profSub");
  const avatarImg = $("#avatarImg");
  const avatarFallback = $("#avatarFallback");
  const statFaves = $("#statFaves");
  const statWatched = $("#statWatched");
  const infoEmail = $("#infoEmail");
  const infoUsername = $("#infoUsername");
  const infoMobile = $("#infoMobile");
  const infoRoles = $("#infoRoles");

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  async function loadProfile() {
    try {
      const res = await fetch(API.me, withAuth({ method: "GET" }));
      if (res.status === 401) return (location.href = BASE + "/login");
      const data = await res.json();
      const u = data.logged_in_as || data.user || data;
      profName.textContent = u.name || u.username || "Your Profile";
      profSub.textContent = u.email || "";
      if (u.avatarUrl) {
        avatarImg.src = u.avatarUrl;
        avatarImg.classList.remove("hidden");
        avatarFallback.classList.add("hidden");
      } else {
        avatarFallback.textContent = (u.name || u.username || "U").slice(0, 1).toUpperCase();
        avatarImg.classList.add("hidden");
        avatarFallback.classList.remove("hidden");
      }
      infoEmail.textContent = u.email || "—";
      infoUsername.textContent = u.username || "—";
      infoMobile.textContent = u.mobile || "—";
      if (Array.isArray(u.roles) && u.roles.length) {
        infoRoles.innerHTML = u.roles
          .map((r) => {
            const clean = String(r).replace(/^Role\./, "");
            return `<span class="chip inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-[color:var(--brand-50)] text-[color:var(--brand-700)] mr-1 mb-1">${escapeHtml(clean)}</span>`;
          })
          .join("");
      } else {
        infoRoles.innerHTML = `<span class="muted">—</span>`;
      }
    } catch (e) {
      profSub.textContent = "Could not load profile.";
      console.error(e);
    }
  }

  async function loadStats() {
    try {
      const res = await fetch(API.stats, withAuth({ method: "GET" }));
      if (!res.ok) throw new Error("stats http " + res.status);
      const s = await res.json();
      statFaves.textContent = s.favorites ?? s.favourites ?? "0";
      statWatched.textContent = s.watched ?? "0";
    } catch {
      statFaves.textContent = "—";
      statWatched.textContent = "—";
    }
  }

  // Attach handlers
  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) logoutBtn.addEventListener("click", (e) => { e.preventDefault(); logout(); });

  // Init
  loadProfile();
  loadStats();
})();
