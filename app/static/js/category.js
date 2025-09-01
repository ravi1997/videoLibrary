/* ==========================================================================
   RPC Surgical Video Library — Category page logic (no dependencies)
   Works with templates/category.html (with left panel).
   - Reads category from URL: /category/<slug> OR ?category=<slug>
   - Fetches and renders left-panel categories; highlights active
   - Sorting (recent|most_viewed), grid/list toggle, pagination
   - Persists user choices per-category in localStorage
   - Graceful mock fallback if API fails
   ========================================================================== */

(() => {
    // ------------------ Config ------------------
    const CFG = {
        API_CATEGORIES: "/api/v1/video/categories",
        API_VIDEOS: "/api/v1/video/", // supports ?category=&page=&page_size=&sort=
        PAGE_SIZE: 12,
        TIMEOUT_MS: 8000,
    };

    // ------------------ Category from URL ------------------
    const url = new URL(location.href);
    let currentCategory =
        extractCategoryFromPath(location.pathname) ||
        url.searchParams.get("category") ||
        localStorage.getItem("category.current") ||
        "";

    // ------------------ State ------------------
    const state = loadStateFor(currentCategory);

    // ------------------ DOM refs ------------------
    const $ = (s, r = document) => r.querySelector(s);
    const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

    const dom = {
        categoryName: $("#categoryName"),
        categoryList: $("#categoryList"),

        sortBtns: $$("button.sort-btn"),
        viewToggle: $("#viewToggle"),

        grid: $("#categoryGrid"),
        pageNumber: $("#pageNumber"),
        prevBtn: $("#prevBtn"),
        nextBtn: $("#nextBtn"),

        tplCard: $("#categoryCardTpl"),
        tplRow: $("#categoryRowTpl"),
    };

    // Keep last data for instant re-render on view toggle
    let lastData = { items: [], total: 0, page: 1, pages: 1 };

    // ------------------ Init ------------------
    function init() {
        // Heading
        if (dom.categoryName) dom.categoryName.textContent = prettify(currentCategory) || "All";

        // Sorting
        dom.sortBtns.forEach((btn) => {
            btn.addEventListener("click", () => {
                const v = btn.getAttribute("data-sort");
                if (!v) return;
                state.sort = v;
                persistState();
                updateActiveSort();
                state.page = 1;
                refreshVideos();
            });
        });
        updateActiveSort();

        // View toggle
        if (dom.viewToggle) {
            dom.viewToggle.addEventListener("click", () => {
                state.view = state.view === "grid" ? "list" : "grid";
                persistState();
                applyViewMode();
                render(lastData); // re-render without refetch
            });
            applyViewMode();
        }

        // Pagination
        if (dom.prevBtn) dom.prevBtn.addEventListener("click", () => changePage(-1));
        if (dom.nextBtn) dom.nextBtn.addEventListener("click", () => changePage(1));

        // Data loads
        refreshCategories(); // left panel
        refreshVideos();     // main grid
    }

    // ------------------ Category helpers ------------------
    function extractCategoryFromPath(pathname) {
        // Accept /category/<slug> (typical) or /categories/<slug>
        const parts = pathname.split("/").filter(Boolean);
        const i = parts.findIndex((p) => p === "category" || p === "categories");
        if (i >= 0 && parts[i + 1]) return decodeURIComponent(parts[i + 1]);
        return null;
    }

    function prettify(slug) {
        if (!slug) return "";
        return slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
    }

    // ------------------ Persistence (per category) ------------------
    function key(k) {
        // Persist per-category to remember each category’s preferences separately
        return `cat.${currentCategory || "all"}.${k}`;
    }

    function loadStateFor(cat) {
        return {
            category: cat || "",
            sort: localStorage.getItem(`cat.${cat || "all"}.sort`) || "recent", // recent|most_viewed
            view: localStorage.getItem(`cat.${cat || "all"}.view`) || "grid",    // grid|list
            page: +(localStorage.getItem(`cat.${cat || "all"}.page`) || 1),
            pageSize: +(localStorage.getItem(`cat.${cat || "all"}.pageSize`) || CFG.PAGE_SIZE),
            totalPages: 1,
            totalCount: 0,
        };
    }

    function persistState() {
        localStorage.setItem("category.current", currentCategory);
        localStorage.setItem(key("sort"), state.sort);
        localStorage.setItem(key("view"), state.view);
        localStorage.setItem(key("page"), String(state.page));
        localStorage.setItem(key("pageSize"), String(state.pageSize));
    }

    // ------------------ Left panel (categories) ------------------
    async function refreshCategories() {
        const data = await safeGet(CFG.API_CATEGORIES);
        const cats = Array.isArray(data) ? data : mockCategories();

        if (!dom.categoryList) return;

        const frag = document.createDocumentFragment();
        cats.forEach((c) => {
            const li = document.createElement("li");
            const isActive = (c.id || c.slug) === currentCategory || (c.slug === undefined && c.id === undefined && !currentCategory);

            li.innerHTML = `
        <button class="btn-ghost w-full justify-start rounded-lg ${isActive ? "ring-1 ring-[color:var(--brand-600)] font-semibold" : ""}"
                data-cat="${escapeAttr(c.name || c.slug || "")}">
          ${escapeHtml(c.name || prettify(c.id || c.slug || "All"))}
        </button>
      `;
            const btn = li.querySelector("button");
            btn.addEventListener("click", () => {
                const next = btn.getAttribute("data-cat") || "";
                if (next === currentCategory) return;
                // Switch category
                currentCategory = next;
                // Update state for new category
                Object.assign(state, loadStateFor(currentCategory));
                persistState();

                // Update heading
                if (dom.categoryName) dom.categoryName.textContent = prettify(currentCategory) || "All";

                // Re-render left panel active style
                refreshCategories();

                // Reload videos
                refreshVideos();

                // Optionally update URL (keeps navigation semantic)
                try {
                    const base = location.pathname.replace(/\/(category|categories)\/[^/]*$/, "");
                    const nextPath = `${base}/category/${encodeURIComponent(currentCategory)}`;
                    history.replaceState({}, "", nextPath);
                } catch { /* ignore if path shape is unknown */ }
            });

            frag.appendChild(li);
        });

        dom.categoryList.replaceChildren(frag);
    }

    // ------------------ Videos (fetch & render) ------------------
    async function refreshVideos() {
        const params = new URLSearchParams();
        if (currentCategory) params.set("category", currentCategory);
        params.set("sort", state.sort);
        params.set("page", String(state.page));
        params.set("page_size", String(state.pageSize));

        const url = `${CFG.API_VIDEOS}?${params.toString()}`;
        const data = await safeGet(url);

        const result = normalizePaged(data) || normalizePaged({
            items: mockVideos(16, currentCategory),
            total: 16,
            page: 1,
            pages: 2,
        });

        state.totalPages = result.pages || 1;
        state.totalCount = result.total || result.items.length;
        lastData = result;

        render(result);
    }

    function render(result) {
        // Page number + nav
        if (dom.pageNumber) dom.pageNumber.textContent = `Page ${result.page || state.page}`;
        toggleDisabled(dom.prevBtn, (result.page || state.page) <= 1);
        toggleDisabled(dom.nextBtn, (result.page || state.page) >= (result.pages || state.totalPages || 1));

        // Grid/List
        if (state.view === "grid") {
            dom.grid.classList.remove("list-view");
            dom.grid.classList.add("grid");
            renderCardsInto(result.items, dom.grid);
        } else {
            dom.grid.classList.remove("grid");
            dom.grid.classList.add("list-view");
            renderRowsInto(result.items, dom.grid);
        }
    }

    // ------------------ UI controls ------------------
    function changePage(delta) {
        const next = Math.min(Math.max(1, state.page + delta), state.totalPages || 1);
        if (next === state.page) return;
        state.page = next;
        persistState();
        refreshVideos();
    }

    function updateActiveSort() {
        dom.sortBtns.forEach((b) => {
            const active = b.getAttribute("data-sort") === state.sort;
            b.classList.toggle("ring-1", active);
            b.classList.toggle("ring-[color:var(--brand-600)]", active);
            b.classList.toggle("font-semibold", active);
        });
    }

    function applyViewMode() {
        if (!dom.viewToggle) return;
        dom.viewToggle.textContent = state.view === "grid" ? "Toggle Grid/List" : "Toggle Grid/List";
    }

    // Expose minimal API for inline onclick handlers in template
    window.categoryPage = {
        toggleView: () => {
            state.view = state.view === "grid" ? "list" : "grid";
            persistState();
            applyViewMode();
            render(lastData);
        },
        changePage,
    };

    // ------------------ Builders ------------------
    function renderCardsInto(items, mount) {
        if (!mount) return;
        const frag = document.createDocumentFragment();
        items.forEach((v) => frag.appendChild(buildCard(v)));
        mount.replaceChildren(frag);
    }

    function renderRowsInto(items, mount) {
        if (!mount) return;
        const frag = document.createDocumentFragment();
        items.forEach((v) => frag.appendChild(buildRow(v)));
        mount.replaceChildren(frag);
    }

    function buildCard(v) {
        const t = dom.tplCard?.content?.firstElementChild;
        const el = t ? t.cloneNode(true) : (() => {
            const a = document.createElement('a');
            a.className = 'card p-0 overflow-hidden hover:shadow-xl transition-shadow block';
            a.innerHTML = `
      <div class="w-full aspect-video bg-[color:var(--border)] relative overflow-hidden">
        <img class="w-full h-full object-cover block" alt="">
        <span class="absolute bottom-2 right-2 text-xs px-2 py-1 rounded bg-black/70 text-white">00:00</span>
      </div>
      <div class="p-3">
        <h3 class="font-semibold line-clamp-2 text-[color:var(--text)]"></h3>
        <p class="text-sm mt-1 muted line-clamp-2"></p>
        <div class="flex items-center justify-between mt-3">
          <div class="hidden flex items-center gap-2">
            <img class="w-7 h-7 rounded-full" alt="">
            <span class="text-sm muted"></span>
          </div>
          <span class="text-xs muted"></span>
        </div>
      </div>
    `;
            return a;
        })();

        // --------- lookups ---------
        const link = el.tagName === 'A' ? el : el.querySelector('a');
        const hero = el.querySelector('.aspect-video') || el.querySelector('[data-hero]') || el;
        const allImgs = el.querySelectorAll('img');
        const [thumb] = allImgs;
        const avatar = allImgs.length > 1 ? allImgs[1] : null;
        const title = el.querySelector('h3');
        const desc = (title && title.parentElement?.querySelector('p')) || el.querySelector('p');
        const duration = el.querySelector('span[class*="bottom-2"][class*="right-2"]');
        const metaEl = Array.from(el.querySelectorAll('.text-xs, .muted')).pop();

        // --------- data ---------
        const id = v.uuid ?? v.id ?? v.slug ?? '';
        const safeId = encodeURIComponent(id);
        const href = v.url || (id ? `/${safeId}` : '#');
        const titleText = (v.title || '').trim() || 'Untitled';
        const categoryTxt = (v.category_name || v.category?.name || '').trim();
        const descText = (v.description || categoryTxt || '').trim();
        const authorName = (v.author || v.channel || '').trim() || 'Unknown';
        const thumbUrl = v.thumbnail || v.thumb || (id ? `/api/v1/video/thumbnails/${safeId}.jpg` : placeholderThumb(id));
        const avatarUrl = v.author_avatar || v.channel_avatar || placeholderAvatar(authorName);
        const durText = fmtDuration(v.duration);
        const metaText = compactMeta(v);

        // --------- link ---------
        if (link) {
            link.href = href;
            link.setAttribute('aria-label', titleText);
            link.dataset.videoId = id;
            if (categoryTxt) link.dataset.category = categoryTxt;
        }

        // --------- thumbnail ---------
        if (thumb) {
            thumb.src = `/api/v1/video/thumbnails/${id}.jpg`;
            thumb.alt = titleText;
            thumb.loading = "lazy";
            thumb.decoding = "async";
            thumb.onerror = () => {
                if (thumb.dataset.fbk) return;
                thumb.dataset.fbk = "1";
                thumb.src = placeholderThumb(id);
            };
        }

        // --------- avatar ---------
        if (avatar) {
            avatar.src = avatarUrl;
            avatar.alt = authorName;
            avatar.loading = 'lazy';
            avatar.decoding = 'async';
            avatar.onerror = () => {
                if (avatar.dataset.fbk) return;
                avatar.dataset.fbk = '1';
                avatar.src = placeholderAvatar(authorName);
            };
        }

        // --------- text ---------
        if (title) title.textContent = titleText;
        if (desc) desc.textContent = descText;
        if (duration) duration.textContent = durText;
        if (metaEl) metaEl.textContent = metaText;

        // --------- progress bar (optional) ---------
        const pos = Number(v.position);
        const dur = Number(v.duration);
        if (Number.isFinite(pos) && Number.isFinite(dur) && dur > 0 && pos >= 0) {
            let pct = (pos / dur) * 100;
            let color = 'bg-[color:var(--brand-600)]';
            if (pos >= dur - 1) {
                pct = 100;
                color = 'bg-green-600'; // ✅ completed state
            }
            const barWrap = document.createElement('div');
            barWrap.className = 'absolute left-0 right-0 bottom-0 h-1 bg-black/20';
            barWrap.setAttribute('role', 'progressbar');
            barWrap.setAttribute('aria-label', `Watched ${Math.round(pct)}%`);
            barWrap.setAttribute('aria-valuemin', '0');
            barWrap.setAttribute('aria-valuemax', '100');
            barWrap.setAttribute('aria-valuenow', String(Math.round(pct)));

            const bar = document.createElement('div');
            bar.className = `h-full ${color}`;
            bar.style.width = `${pct}%`;

            barWrap.appendChild(bar);
            hero?.appendChild(barWrap);
        }

        return el;
    }

    function buildRow(v) {
        const t = dom.tplRow?.content?.firstElementChild;
        const el = t ? t.cloneNode(true) : document.createElement("a");
        if (!t) {
            el.className = "card p-3 flex gap-3";
            el.href = v.url || "#";
            el.textContent = v.title || "Video";
        }

        el.href = v.url || `/watch/${encodeURIComponent(v.id || v.slug || "")}`;

        const thumb = el.querySelector("img");
        const title = el.querySelector("h3");
        const desc = el.querySelector("p");
        const av = el.querySelector("img.w-6.h-6.rounded-full");
        const who = el.querySelector(".text-xs.muted");
        const meta = el.querySelectorAll(".text-xs.muted")[1];
        const badge = el.querySelector(".badge");
        const dur = el.querySelector(".mt-1");

        if (thumb) {
            thumb.src = v.thumbnail || v.thumb || placeholderThumb(v.id);
            thumb.alt = v.title || "Video";
        }
        if (title) title.textContent = v.title || "Untitled";
        if (desc) desc.textContent = v.description || v.category || "";
        if (av) av.src = v.author_avatar || v.channel_avatar || placeholderAvatar(v.author || v.channel);
        if (who) who.textContent = v.author || v.channel || "Unknown";
        if (meta) meta.textContent = compactMeta(v);
        if (badge) badge.textContent = (v.badge || v.resolution || "HD").toUpperCase();
        if (dur) dur.textContent = fmtDuration(v.duration);

        return el;
    }

    // ------------------ Networking ------------------
    async function safeGet(url) {
        try {
            const res = await fetchWithTimeout(url, { headers: { Accept: "application/json" } }, CFG.TIMEOUT_MS);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (e) {
            console.warn("GET failed, using mock:", url, e);
            return null;
        }
    }

    async function fetchWithTimeout(resource, options = {}, timeout = CFG.TIMEOUT_MS) {
        const ctrl = new AbortController();
        const id = setTimeout(() => ctrl.abort(), timeout);
        try {
            const res = await fetch(resource, { ...options, signal: ctrl.signal });
            return res;
        } finally {
            clearTimeout(id);
        }
    }

    // ------------------ Formatting helpers ------------------
    function normalizePaged(v) {
        if (!v) return null;
        if (Array.isArray(v)) return { items: v, total: v.length, page: 1, pages: 1 };
        if (v.items) {
            return {
                items: v.items || [],
                total: typeof v.total === "number" ? v.total : v.items.length,
                page: v.page || 1,
                pages: v.pages || 1,
            };
        }
        return null;
    }

    function toggleDisabled(btn, disabled) {
        if (!btn) return;
        btn.disabled = !!disabled;
        btn.style.opacity = disabled ? 0.6 : 1;
        btn.style.pointerEvents = disabled ? "none" : "auto";
    }

    function fmtDuration(sec) {
        const s = Number.isFinite(sec) ? Math.max(0, Math.round(sec)) : 0;
        const m = Math.floor(s / 60);
        const r = s % 60;
        return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
    }

    function compactMeta(v) {
        const views = v.views ?? v.view_count;
        const age = v.age || v.published_at || v.date;
        const parts = [];
        if (views != null) parts.push(`${formatCompact(views)} views`);
        if (age) parts.push(formatAge(age));
        return parts.join(" • ");
    }

    function formatCompact(n) {
        const x = Number(n) || 0;
        if (x >= 1_000_000) return (x / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
        if (x >= 1_000) return (x / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
        return String(x);
    }

    function formatAge(dateish) {
        try {
            const d = new Date(dateish);
            const diff = Math.max(0, (Date.now() - d.getTime()) / 1000);
            const day = 86400, week = day * 7, month = day * 30, year = day * 365;
            if (diff < day) return "today";
            if (diff < week) return `${Math.floor(diff / day)}d ago`;
            if (diff < month) return `${Math.floor(diff / week)}w ago`;
            if (diff < year) return `${Math.floor(diff / month)}mo ago`;
            return `${Math.floor(diff / year)}y ago`;
        } catch { return ""; }
    }

    function placeholderThumb(id) {
        const n = (Math.abs(hashCode(String(id || Date.now()))) % 10) + 1;
        return `https://picsum.photos/seed/cat${n}/640/360`;
    }

    function placeholderAvatar(seed) {
        const s = encodeURIComponent(String(seed || "u"));
        return `https://api.dicebear.com/7.x/identicon/svg?seed=${s}`;
    }

    function hashCode(str) {
        let h = 0;
        for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
        return h;
    }

    function escapeHtml(s) {
        return String(s)
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#039;");
    }
    function escapeAttr(s) {
        return String(s).replaceAll('"', "&quot;");
    }

    // ------------------ Mock fallback ------------------
    function mockCategories() {
        return [
            { id: "", name: "All" },
            { id: "retina", name: "Retina" },
            { id: "cataract", name: "Cataract" },
            { id: "glaucoma", name: "Glaucoma" },
            { id: "cornea", name: "Cornea" },
            { id: "oculoplasty", name: "Oculoplasty" },
            { id: "pediatric", name: "Pediatric" },
        ];
    }

    function mockVideos(n = 12, cat = "") {
        const labels = ["Retina", "Cataract", "Glaucoma", "Cornea", "Oculoplasty", "Pediatric"];
        return Array.from({ length: n }, (_, i) => ({
            id: `${cat || "all"}-${i + 1}`,
            title: `${prettify(cat) || "General"} Surgery ${i + 1}`,
            description: `${prettify(cat) || labels[i % labels.length]} case demo`,
            duration: 160 + i * 13,
            resolution: ["HD", "FHD", "4K"][i % 3],
            thumbnail: placeholderThumb(`${cat}-${i}`),
            author: ["Dr. Rao", "Dr. Mehta", "Dr. Singh", "Dr. Chawla"][i % 4],
            author_avatar: placeholderAvatar(`${cat}-${i}`),
            views: 1200 * (i + 1),
            published_at: new Date(Date.now() - (i + 1) * 86400000).toISOString(),
            url: `#mock-${cat}-${i + 1}`,
        }));
    }

    // ------------------ Start ------------------
    init();
})();
