/* ==========================================================================
   RPC Surgical Video Library — Watch page logic (Video.js + UI)
   Applies user Settings from /api/v1/me/settings (theme, speed, quality, autoplay)
   IDs/hooks expected from templates/watch.html:
     #my-video, #video-id, #video-title, #video-meta, #video-meta-extra, #toggle-meta
     #watch-next, #recommendations, #gesture-overlay
   Server API (adjust if different):
     GET /api/v1/video/{id}
     GET /api/v1/video/{id}/watch-next?limit=12
     GET /api/v1/video/{id}/recommendations?limit=20
     POST /api/v1/video/progress
     GET  /api/v1/me/settings
   ========================================================================== */

(() => {
    // ------------------ DOM ------------------
    const $ = (s, r = document) => r.querySelector(s);
    const dom = {
        videoId: $("#video-id")?.textContent?.trim(),
        title: $("#video-title"),
        meta: $("#video-meta"),
        metaExtra: $("#video-meta-extra"),
        toggleMeta: $("#toggle-meta"),
        next: $("#watch-next"),
        recs: $("#recommendations"),
        gesture: $("#gesture-overlay"),
        playerEl: $("#my-video"),
    };
    if (!dom.videoId) { console.warn("No #video-id found; aborting watch page init."); return; }

    // ------------------ Config ------------------
    const VID = dom.videoId;
    const CFG = {
        META: `/api/v1/video/${encodeURIComponent(VID)}`,
        NEXT: `/api/v1/video/${encodeURIComponent(VID)}/watch-next?limit=12`,
        RECS: `/api/v1/video/${encodeURIComponent(VID)}/recommendations?limit=20`,
        PROGRESS: `/api/v1/video/progress`,
        SETTINGS: `/api/v1/user/settings`,
        SAVE_KEY: (k) => `vid.${VID}.${k}`,
        TIMEOUT_MS: 12000,

        PROGRESS_INTERVAL_MS: 15000,
        PROGRESS_ON_PAUSE: true,
        COMPLETE_THRESHOLD: 0.95,
        RESUME_THRESHOLD: 10, // seconds
    };

    // ------------------ Settings ------------------
    const DEFAULT_SETTINGS = {
        theme: "system",
        compact: false,
        autoplay: false,
        quality: "auto",           // "auto"|"480p"|"720p"|"1080p"|"2160p"
        speed: "1.0"               // "0.75"|"1.0"|...|"2.0"
    };

    function getToken() { return localStorage.getItem("token") || ""; }
    function withAuth(opts = {}) {
        return {
            ...opts,
            headers: {
                "Accept": "application/json",
                "Content-Type": "application/json",
                ...(opts.headers || {}),
                ...(getToken() ? { "Authorization": "Bearer " + getToken() } : {})
            }
        };
    }
    function localSettingsGet() {
        try { return JSON.parse(localStorage.getItem("user.settings") || "{}"); } catch { return {}; }
    }
    async function loadSettings() {
        // try API, fall back to localStorage, else defaults
        try {
            const res = await fetchWithTimeout(CFG.SETTINGS, withAuth({ method: "GET" }), CFG.TIMEOUT_MS);
            if (res.ok) {
                const s = await res.json();
                // keep a local cache for other pages too
                try { localStorage.setItem("user.settings", JSON.stringify(s)); } catch { }
                return { ...DEFAULT_SETTINGS, ...s };
            }
        } catch (e) { /* ignore */ }
        return { ...DEFAULT_SETTINGS, ...localSettingsGet() };
    }

    // ------------------ Player ------------------
    let player, lastProgressSentAt = 0, userSettings = DEFAULT_SETTINGS;

    async function initPage() {
        // 1) Load settings first and apply global bits
        userSettings = await loadSettings();
        applyGlobalSettings(userSettings);

        // 2) Init player with those settings
        initPlayer(userSettings);

        // 3) Wire meta toggle and load data
        wireMetaToggle();
        const [meta, next, recs] = await Promise.allSettled([
            safeGet(CFG.META),
            safeGet(CFG.NEXT),
            safeGet(CFG.RECS),
        ]);
        renderMeta(meta.value || {});
        renderNext(Array.isArray(next.value) ? next.value : (next.value?.items || mockList(6)));
        renderRecs(Array.isArray(recs.value) ? recs.value : (recs.value?.items || mockList(10)));
    }

    function applyGlobalSettings(s) {
        // Theme (layout should read html[data-theme])
        if (s.theme) document.documentElement.dataset.theme = s.theme;
        // Compact mode (toggle a class on html/body your CSS can use)
        document.documentElement.classList.toggle("is-compact", !!s.compact);
    }

    function initPlayer(s) {
        if (!window.videojs || !dom.playerEl) {
            console.warn("Video.js not loaded or #my-video missing.");
            return;
        }

        player = window.videojs(dom.playerEl, {
            fluid: true,
            controls: true,
            preload: "auto",
            playbackRates: [0.5, 1, 1.25, 1.5, 2],
            html5: {
                vhs: {
                    overrideNative: true,
                    withCredentials: false,
                    enableLowInitialPlaylist: true,
                    handlePartialData: true,
                },
                nativeAudioTracks: false,
                nativeVideoTracks: false
            },
        });

        // Quality selector plugin
        if (typeof player.hlsQualitySelector === "function") {
            player.hlsQualitySelector({ displayCurrentQuality: true });
        } else {
            player.on("loadedmetadata", () => { tryAttachSimpleQualityBadge(); });
        }

        // Restore last volume / rate (per-video), else apply settings.speed
        const lastVol = parseFloat(localStorage.getItem(CFG.SAVE_KEY("volume")) || "");
        if (!Number.isNaN(lastVol)) player.volume(Math.min(1, Math.max(0, lastVol)));

        const savedRate = parseFloat(localStorage.getItem(CFG.SAVE_KEY("rate")) || "");
        if (!Number.isNaN(savedRate)) {
            player.playbackRate(savedRate);
        } else if (s?.speed) {
            const sp = parseFloat(s.speed);
            if (!Number.isNaN(sp)) player.playbackRate(sp);
        }

        // When metadata is loaded, if user prefers quality != auto, try apply it
        player.on("loadedmetadata", () => {
            applyPreferredQuality(player, s?.quality || "auto");
            // Resume if meaningful
            const saved = parseInt(localStorage.getItem(CFG.SAVE_KEY("time")) || "0", 10);
            const dur = Math.max(0, parseInt(localStorage.getItem(CFG.SAVE_KEY("dur")) || "0", 10));
            if (saved > CFG.RESUME_THRESHOLD && saved < dur - 5) {
                try {
                    player.currentTime(saved);
                    flashGesture(`⏯ Resumed @ ${fmtTime(saved)}`);
                } catch { }
            }
        });

        player.on("volumechange", () => {
            localStorage.setItem(CFG.SAVE_KEY("volume"), String(player.volume()));
        });
        player.on("ratechange", () => {
            localStorage.setItem(CFG.SAVE_KEY("rate"), String(player.playbackRate()));
            flashGesture(`⚡ ${player.playbackRate()}x`);
        });

        // Progress persistence + resume
        player.on("timeupdate", throttle(() => {
            const t = Math.floor(player.currentTime() || 0);
            const d = Math.floor(player.duration() || 0);
            localStorage.setItem(CFG.SAVE_KEY("time"), String(t));
            localStorage.setItem(CFG.SAVE_KEY("dur"), String(d));
            onTick();
        }, 1000));

        // Autoplay next (from settings)
        player.on("ended", () => {
            sendProgress("ended", true);
            if (s?.autoplay) {
                // Find first "Watch Next" card link and navigate
                const first = dom.next?.querySelector("a[href]")?.getAttribute("href");
                if (first) {
                    flashGesture("⏭ Autoplay next");
                    location.href = first;
                }
            }
        });

        // Send progress on pause if enabled
        player.on("pause", () => {
            if (CFG.PROGRESS_ON_PAUSE) scheduleProgressImmediate();
        });

        // Keyboard controls
        document.addEventListener("keydown", (e) => {
            if (!player || isTypingInInput(e)) return;
            switch (e.key) {
                case " ":
                case "k":
                    e.preventDefault();
                    if (player.paused()) { player.play(); flashGesture("▶️"); }
                    else { player.pause(); flashGesture("⏸"); }
                    break;
                case "ArrowLeft": seekRelative(-5); flashGesture("⏪ 5s"); break;
                case "ArrowRight": seekRelative(5); flashGesture("⏩ 5s"); break;
                case "ArrowUp": player.volume(Math.min(1, player.volume() + 0.05)); flashGesture(`🔊 ${(player.volume() * 100) | 0}%`); break;
                case "ArrowDown": player.volume(Math.max(0, player.volume() - 0.05)); flashGesture(`🔉 ${(player.volume() * 100) | 0}%`); break;
                case "m": player.muted(!player.muted()); flashGesture(player.muted() ? "🔇" : "🔈"); break;
                case ">": player.playbackRate(Math.min(4, (player.playbackRate() + 0.25))); flashGesture(`⚡ ${player.playbackRate()}x`); break;
                case "<": player.playbackRate(Math.max(0.25, (player.playbackRate() - 0.25))); flashGesture(`🐢 ${player.playbackRate()}x`); break;
            }
        });

        // Page lifecycle snapshots
        window.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "hidden") sendProgress("visibilitychange");
        });
        window.addEventListener("pagehide", () => sendProgress("pagehide"));
        window.addEventListener("beforeunload", () => sendProgress("beforeunload"));
    }

    // Preferred quality application
    function applyPreferredQuality(player, pref = "auto") {
        if (!player?.tech_) return;
        // Only apply if specific, not auto
        if (!pref || pref === "auto") return;

        const vhs = player.tech(true)?.vhs;
        const reps = vhs?.representations?.();
        if (!reps || !reps.length) return;

        // Map pref -> min height heuristic
        const heightMap = { "360p": 360, "480p": 480, "720p": 720, "1080p": 1080, "1440p": 1440, "2160p": 2160 };
        const targetH = heightMap[pref] || 0;

        // Disable all, then enable only the best <= target; if none <=, pick the closest
        let chosen = null;
        reps.forEach(r => r.enabled(false));
        // Find candidates <= target height, choose highest of them
        const candidates = reps
            .map(r => ({ r, h: r?.height || r?.playlist?.attributes?.RESOLUTION?.height || 0 }))
            .sort((a, b) => b.h - a.h);

        if (targetH > 0) {
            chosen = candidates.find(c => c.h <= targetH)?.r || null;
        }
        // Fallback: choose closest by absolute diff
        if (!chosen && candidates.length) {
            chosen = candidates.slice().sort((a, b) => Math.abs((a.h || 0) - targetH) - Math.abs((b.h || 0) - targetH))[0].r;
        }
        // Enable chosen (let ABR stay off; this pins quality)
        if (chosen?.enabled) chosen.enabled(true);
    }

    // ------------------ Progress ------------------
    function onTick() {
        const now = Date.now();
        if (player.paused()) return;
        if (now - lastProgressSentAt >= CFG.PROGRESS_INTERVAL_MS) {
            sendProgress("tick");
        }
    }
    function buildProgressPayload(forceCompleted = false) {
        const position = Math.floor(player?.currentTime?.() || 0);
        const duration = Math.floor(player?.duration?.() || 0);
        const rate = Number(player?.playbackRate?.() || 1);
        const muted = !!player?.muted?.();
        let completed = false;

        if (forceCompleted) completed = true;
        else if (duration > 0) completed = (position / duration) >= CFG.COMPLETE_THRESHOLD;

        return { position, duration, completed, rate, muted, video_id: VID };
    }
    async function sendProgress(reason = "manual", forceCompleted = false) {
        try {
            const payload = buildProgressPayload(forceCompleted);
            if (!forceCompleted && !shouldSend(payload)) return;
            lastProgressSentAt = Date.now();
            const token = getToken();
            // If we have a token, prefer fetch with Authorization so we don't get 401 from missing headers.
            if (token) {
                await fetchWithTimeout(CFG.PROGRESS, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Accept": "application/json",
                        "Authorization": "Bearer " + token
                    },
                    body: JSON.stringify(payload),
                    keepalive: true,
                }, CFG.TIMEOUT_MS);
                return;
            }
            // Anonymous user path: attempt sendBeacon (no headers possible), fallback to fetch without auth.
            const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
            const ok = navigator.sendBeacon?.(CFG.PROGRESS, blob);
            if (!ok) {
                await fetchWithTimeout(CFG.PROGRESS, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                    keepalive: true,
                }, CFG.TIMEOUT_MS);
            }
        } catch (e) { console.warn("progress failed", e); }
    }
    let lastSent = { position: -1, duration: -1, completed: false, rate: 1, muted: false };
    function shouldSend(p) {
        const changed =
            p.completed !== lastSent.completed ||
            p.rate !== lastSent.rate ||
            p.muted !== lastSent.muted ||
            Math.abs(p.position - lastSent.position) >= 3 ||
            p.duration !== lastSent.duration;
        if (changed) lastSent = p;
        return changed;
    }
    function scheduleProgressImmediate() {
        const now = Date.now();
        if (now - lastProgressSentAt > 2000) sendProgress("immediate");
    }

    // ------------------ Data loads ------------------
    async function safeGet(url) {
        try {
            const res = await fetchWithTimeout(url, { headers: { Accept: "application/json" } }, CFG.TIMEOUT_MS);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (e) {
            console.warn("GET failed (using mock):", url, e);
            return null;
        }
    }
    async function fetchWithTimeout(resource, options = {}, timeout = 8000) {
        const ctrl = new AbortController();
        const id = setTimeout(() => ctrl.abort(), timeout);
        try {
            const res = await fetch(resource, { ...options, signal: ctrl.signal });
            return res;
        } finally { clearTimeout(id); }
    }

    // ------------------ Render helpers ------------------
    function renderMeta(m) {
        const title = m.title || m.name || "Untitled";
        if (dom.title) dom.title.textContent = title;

        const parts = [];
        if (typeof m.views === "number") parts.push(`${formatCompact(m.views)} views`);
        if (m.created_at || m.date) parts.push(formatAge(m.created_at || m.date));
        if (m.duration) parts.push(fmtTime(m.duration));
        if (dom.meta) dom.meta.textContent = parts.join(" • ");

        const extra = [];
        if (m.category) extra.push(`<strong>Category: </strong> ${escapeHtml(m.category.name)}`);
        if (m.tags?.length) {
            const tagChips = m.tags.map(t => `<span class="chip inline-block">${escapeHtml(t.name || t)}</span>`).join(" ");
            extra.push(`<div><strong>Tags: </strong> ${tagChips}</div>`);
        }
        if (m.description) extra.push(`<strong>Description: </strong> ${escapeHtml(m.description)}`);
        if (m.surgeons?.length) {
            const tagChips = m.surgeons
                .map(t => `<span class="chip inline-block">${escapeHtml(t.name || t)} : ${escapeHtml(t.type || t)}</span>`)
                .join(" ");
            extra.push(`<div><strong>Surgeons: </strong> ${tagChips}</div>`);
        }

        if (dom.metaExtra) {
            dom.metaExtra.innerHTML = extra.map(line => `<div>${line}</div>`).join("");
            if (extra.length === 0 && dom.toggleMeta) dom.toggleMeta.classList.add("hidden");
            else dom.toggleMeta?.classList.remove("hidden");
        }
    }

    function wireMetaToggle() {
        if (!dom.toggleMeta || !dom.metaExtra) return;
        dom.toggleMeta.addEventListener("click", () => {
            const isHidden = dom.metaExtra.classList.contains("hidden");
            dom.metaExtra.classList.toggle("hidden", !isHidden);
            dom.toggleMeta.textContent = isHidden ? "Show less" : "Show more";
        });
    }

    function renderNext(items) {
        if (!dom.next) return;
        const frag = document.createDocumentFragment();
        items.forEach(v => frag.appendChild(nextCard(v)));
        dom.next.replaceChildren(frag);
    }
    function renderRecs(items) {
        if (!dom.recs) return;
        const frag = document.createDocumentFragment();
        items.forEach(v => frag.appendChild(recRow(v)));
        dom.recs.replaceChildren(frag);
    }
    function nextCard(v) {
        const a = document.createElement("a");
        a.href = v.url || `/${encodeURIComponent(v.uuid || v.slug || "")}`;
        a.className = "min-w-[260px] w-[260px] shrink-0 card p-2 hover:shadow-xl transition-shadow no-underline";
        a.style.scrollSnapAlign = "start";
        a.innerHTML = `
      <div class="rounded-lg aspect-video bg-[color:var(--border)] overflow-hidden">
        <img class="w-full h-full object-cover block" src='/api/v1/video/thumbnails/${encodeURIComponent(v.uuid || v.slug || "")}.jpg' alt="${escapeAttr(v.title || "Video")}" />
      </div>
      <div class="mt-2">
        <div class="font-semibold text-[color:var(--text)] line-clamp-2">${escapeHtml(v.title || "Untitled")}</div>
        <div class="text-xs muted mt-1">${escapeHtml((v.category && v.category.name) || v.channel || "Unknown")} • ${compactMeta(v)}</div>
      </div>
    `;
        return a;
    }
    function recRow(v) {
        const a = document.createElement("a");
        a.href = v.url || `/${encodeURIComponent(v.uuid || v.slug || "")}`;
        a.className = "card p-2 grid grid-cols-[128px,1fr] gap-2 items-center hover:shadow-xl transition-shadow no-underline";
        a.innerHTML = `
      <div class="rounded-lg w-full bg-[color:var(--border)] overflow-hidden">
        <img class="w-full h-full object-cover block" src='/api/v1/video/thumbnails/${encodeURIComponent(v.uuid || v.slug || "")}.jpg' alt="${escapeAttr(v.title || "Video")}" />
      </div>
      <div class="min-w-0">
        <div class="font-semibold text-[color:var(--text)] line-clamp-2">${escapeHtml(v.title || "Untitled")}</div>
        <div class="text-xs muted mt-1">${escapeHtml((v.category && v.category.name) || v.channel || "Unknown")} • ${compactMeta(v)}</div>
      </div>
    `;
        return a;
    }

    // ------------------ Helpers ------------------
    function isTypingInInput(e) { const t = e.target; return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable); }
    function throttle(fn, ms) { let last = 0, pending; return (...args) => { const now = Date.now(); if (now - last >= ms) { last = now; fn(...args); } else { clearTimeout(pending); pending = setTimeout(() => { last = Date.now(); fn(...args); }, ms - (now - last)); } }; }
    function flashGesture(text) { if (!dom.gesture) return; dom.gesture.textContent = text; dom.gesture.style.opacity = "1"; dom.gesture.style.transition = "none"; requestAnimationFrame(() => { dom.gesture.style.transition = "opacity .6s ease"; dom.gesture.style.opacity = "0"; }); }
    function fmtTime(sec) { const s = Math.max(0, Math.floor(Number(sec) || 0)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60; return (h ? String(h).padStart(2, "0") + ":" : "") + String(m).padStart(2, "0") + ":" + String(r).padStart(2, "0"); }
    function compactMeta(v) { const views = v.views ?? v.view_count; const age = v.age || v.published_at || v.date; const parts = []; if (views != null) parts.push(`${formatCompact(views)} views`); if (age) parts.push(formatAge(age)); return parts.join(" • "); }
    function formatCompact(n) { const x = Number(n) || 0; if (x >= 1_000_000) return (x / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M"; if (x >= 1_000) return (x / 1_000).toFixed(1).replace(/\.0$/, "") + "K"; return String(x); }
    function formatAge(dateish) { try { const d = new Date(dateish); const diff = Math.max(0, (Date.now() - d.getTime()) / 1000); const day = 86400, week = day * 7, month = day * 30, year = day * 365; if (diff < day) return "today"; if (diff < week) return `${Math.floor(diff / day)} d ago`; if (diff < month) return `${Math.floor(diff / week)} w ago`; if (diff < year) return `${Math.floor(diff / month)} mo ago`; return `${Math.floor(diff / year)} y ago`; } catch { return ""; } }
    function placeholderThumb(seed) { const s = encodeURIComponent(String(seed || Math.random())); return `https://picsum.photos/seed/vid${s}/480/270`; }
    function escapeHtml(s) { return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
    function escapeAttr(s) { return String(s).replaceAll('"', "&quot;"); }
    function seekRelative(delta) { try { const t = player.currentTime() || 0; player.currentTime(Math.max(0, t + delta)); } catch { } }

    // ------------------ Go ------------------
    initPage();
})();
