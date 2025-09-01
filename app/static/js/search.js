/* ==========================================================================
   RPC Surgical Video Library — Search page logic (with left filters)
   Works with templates/search.html (updated with a left filter panel).
   - Reads ?q= from URL and shows it
   - Sorting (relevance|recent|most_viewed)
   - Grid/List toggle with persistence
   - Pagination with server API
   - Left filters: categories (single-select), duration, uploaded date, tags
   - Persists filters in localStorage
   - Graceful fallback to mock data if API fails
   ========================================================================== */

(() => {
    // ------------------ Config ------------------
    const CFG = {
        API_SEARCH: "/api/v1/video/search",  // expects ?q=&page=&page_size=&sort= plus optional filter params
        API_CATEGORIES: "/api/v1/video/categories",
        API_TAGS: "/api/v1/video/tags",
        PAGE_SIZE: 12,
        TIMEOUT_MS: 8000,
        LS: {
            VIEW: "search.view",
            SORT: "search.sort",
            PAGE: "search.page",
            FILTERS: "search.filters", // stores JSON
        },
    };

    // ------------------ State ------------------
    const urlQ = new URLSearchParams(location.search).get("q") || "";
    const savedFilters = readFilters();

    const state = {
        q: urlQ,
        sort: localStorage.getItem(CFG.LS.SORT) || "relevance", // relevance|recent|most_viewed
        view: localStorage.getItem(CFG.LS.VIEW) || "grid",       // grid|list
        page: +(localStorage.getItem(CFG.LS.PAGE) || 1),
        pageSize: CFG.PAGE_SIZE,
        totalPages: 1,
        totalCount: 0,

        // Filters
        filters: {
            categories: new Set(savedFilters.categories || []),  // single-select (0 or 1 item)
            durationMin: savedFilters.durationMin ?? "",         // minutes (string/number)
            durationMax: savedFilters.durationMax ?? "",         // minutes (string/number)
            // (optional) resolutions if you re-add them later
            dateFrom: savedFilters.dateFrom || "",               // "YYYY-MM-DD"
            dateTo: savedFilters.dateTo || "",
            tags: new Set(savedFilters.tags || []),              // user-entered strings
        },
    };

    // ------------------ DOM refs ------------------
    const $ = (s, r = document) => r.querySelector(s);
    const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

    const dom = {
        queryText: $("#searchQuery"),
        totalResults: $("#totalResults"),
        sortBtns: $$("button.sort-btn"),
        viewToggle: $("#viewToggle"),

        resultsGrid: $("#resultsGrid"),
        pageNumber: $("#pageNumber"),
        prevBtn: $("#prevBtn"),
        nextBtn: $("#nextBtn"),

        // Filters panel
        filterCategoryList: $("#filterCategoryList"),
        durationMin: $("#durationMin"),
        durationMax: $("#durationMax"),
        durationQuick: $("#durationQuick"),
        dateQuick: $("#dateQuick"),
        dateFrom: $("#dateFrom"),
        dateTo: $("#dateTo"),
        tagInput: $("#tagInput"),
        activeTags: $("#activeTags"),
        searchTagList: $("#searchTagList"),
        clearAllFilters: $("#clearAllFilters"),
        resetFilters: $("#resetFilters"),
        applyFilters: $("#applyFilters"),

        // Templates
        tplCard: $("#searchCardTpl"),
        tplRow: $("#searchRowTpl"),
    };

    // Keep last data for view toggle without refetch
    let lastData = { items: [], total: 0, page: 1, pages: 1 };

    // ------------------ Init ------------------
    function init() {
        // Put query text
        if (dom.queryText) dom.queryText.textContent = state.q ? `"${state.q}"` : "(empty)";

        // Bind sorting
        dom.sortBtns.forEach((btn) => {
            btn.addEventListener("click", () => {
                const v = btn.getAttribute("data-sort");
                if (!v) return;
                state.sort = v;
                localStorage.setItem(CFG.LS.SORT, v);
                updateActiveSort();
                state.page = 1;
                localStorage.setItem(CFG.LS.PAGE, "1");
                refresh();
            });
        });
        updateActiveSort();

        // View toggle
        if (dom.viewToggle) {
            dom.viewToggle.addEventListener("click", () => {
                state.view = state.view === "grid" ? "list" : "grid";
                localStorage.setItem(CFG.LS.VIEW, state.view);
                applyViewMode();
                render(lastData); // re-render without refetch
            });
            applyViewMode();
        }

        // Pagination
        if (dom.prevBtn) dom.prevBtn.addEventListener("click", () => changePage(-1));
        if (dom.nextBtn) dom.nextBtn.addEventListener("click", () => changePage(1));

        // Filters wiring
        wireFiltersUI();

        // Prefill UI from state.filters
        hydrateFiltersUI();

        // Populate filter sources (categories/tags)
        populateCategories();
        populateTags();

        // Initial load
        refresh();
    }

    // ------------------ Filters: UI wiring ------------------
    function wireFiltersUI() {
        // Categories (delegated, because list is populated async)
        if (dom.filterCategoryList) {
            dom.filterCategoryList.addEventListener("change", (e) => {
                const rb = e.target.closest('input[type=radio][name="category"]');
                if (!rb) return;
                const id = rb.value || "";
                // enforce single-select in state
                state.filters.categories.clear();
                if (rb.checked && id) state.filters.categories.add(id);

                // Ensure only this radio is checked (in case of rogue DOM)
                dom.filterCategoryList
                    .querySelectorAll('input[type=radio][name="category"]')
                    .forEach((el) => {
                        el.checked = el === rb ? rb.checked : false;
                    });

                persistFilters();
                state.page = 1;
                refresh();
            });
        }

        // Duration inputs
        if (dom.durationMin) {
            dom.durationMin.addEventListener("input", () => {
                state.filters.durationMin = clampNonNegInt(dom.durationMin.value);
                persistFilters();
            });
        }
        if (dom.durationMax) {
            dom.durationMax.addEventListener("input", () => {
                state.filters.durationMax = clampNonNegInt(dom.durationMax.value);
                persistFilters();
            });
        }

        // Duration quick chips
        if (dom.durationQuick) {
            dom.durationQuick.addEventListener("click", (e) => {
                const chip = e.target.closest(".chip");
                if (!chip) return;
                const min = chip.getAttribute("data-min") ?? "";
                const max = chip.getAttribute("data-max") ?? "";
                dom.durationMin.value = min;
                dom.durationMax.value = max;
                state.filters.durationMin = clampNonNegInt(min);
                state.filters.durationMax = clampNonNegInt(max);
                persistFilters();
                state.page = 1;
                refresh();
            });
        }

        // Uploaded date quick chips
        if (dom.dateQuick) {
            dom.dateQuick.addEventListener("click", (e) => {
                const chip = e.target.closest(".chip");
                if (!chip) return;
                const span = chip.getAttribute("data-date"); // 24h|7d|30d|365d
                const { from, to } = computeDateRange(span);
                if (dom.dateFrom) dom.dateFrom.value = from || "";
                if (dom.dateTo) dom.dateTo.value = to || "";
                state.filters.dateFrom = from || "";
                state.filters.dateTo = to || "";
                persistFilters();
                state.page = 1;
                refresh();
            });
        }

        // Uploaded date manual inputs
        if (dom.dateFrom) {
            dom.dateFrom.addEventListener("change", () => {
                state.filters.dateFrom = dom.dateFrom.value || "";
                persistFilters();
            });
        }
        if (dom.dateTo) {
            dom.dateTo.addEventListener("change", () => {
                state.filters.dateTo = dom.dateTo.value || "";
                persistFilters();
            });
        }

        // Tags input (Enter to add)
        if (dom.tagInput) {
            dom.tagInput.addEventListener("keydown", (e) => {
                if (e.key === "Enter") {
                    e.preventDefault();
                    const v = sanitizeTag(dom.tagInput.value);
                    if (v) {
                        state.filters.tags.add(v);
                        renderActiveTags();
                        persistFilters();
                        state.page = 1;
                        refresh();
                    }
                    dom.tagInput.value = "";
                }
            });
        }

        // Active tag chip removal
        if (dom.activeTags) {
            dom.activeTags.addEventListener("click", (e) => {
                const closeBtn = e.target.closest("button[data-tag]");
                if (!closeBtn) return;
                const tag = closeBtn.getAttribute("data-tag");
                state.filters.tags.delete(tag);
                renderActiveTags();
                persistFilters();
                state.page = 1;
                refresh();
            });
        }

        // Clear / Reset / Apply
        if (dom.clearAllFilters) {
            dom.clearAllFilters.addEventListener("click", () => {
                clearAllFilters();
                persistFilters();
                state.page = 1;
                refresh();
            });
        }
        if (dom.resetFilters) {
            dom.resetFilters.addEventListener("click", () => {
                clearAllFilters();
                hydrateFiltersUI(); // reflect cleared UI
                persistFilters();
            });
        }
        if (dom.applyFilters) {
            dom.applyFilters.addEventListener("click", () => {
                // Ensure manual inputs are committed
                state.filters.durationMin = clampNonNegInt(dom.durationMin?.value ?? "");
                state.filters.durationMax = clampNonNegInt(dom.durationMax?.value ?? "");
                state.filters.dateFrom = dom.dateFrom?.value || "";
                state.filters.dateTo = dom.dateTo?.value || "";
                persistFilters();
                state.page = 1;
                refresh();
            });
        }
    }

    function hydrateFiltersUI() {
        // Duration
        if (dom.durationMin) dom.durationMin.value = strOrEmpty(state.filters.durationMin);
        if (dom.durationMax) dom.durationMax.value = strOrEmpty(state.filters.durationMax);

        // Categories (single-select)
        if (dom.filterCategoryList) {
            const selected = getFirstCategory();
            dom.filterCategoryList
                .querySelectorAll('input[type=radio][name="category"]')
                .forEach((rb) => {
                    rb.checked = rb.value === selected;
                });
        }

        // Uploaded dates
        if (dom.dateFrom) dom.dateFrom.value = state.filters.dateFrom || "";
        if (dom.dateTo) dom.dateTo.value = state.filters.dateTo || "";

        // Tags
        renderActiveTags();
    }

    function renderActiveTags() {
        if (!dom.activeTags) return;
        const frag = document.createDocumentFragment();
        if (state.filters.tags.size === 0) {
            const muted = document.createElement("span");
            muted.className = "muted";
            muted.textContent = "No tags";
            frag.appendChild(muted);
        } else {
            [...state.filters.tags].forEach((t) => {
                const chip = document.createElement("span");
                chip.className = "chip";
                chip.innerHTML = `
          <span>${escapeHtml(t)}</span>
          <button class="close" data-tag="${escapeAttr(t)}" aria-label="Remove ${escapeAttr(t)}">&times;</button>
        `;
                frag.appendChild(chip);
            });
        }
        dom.activeTags.replaceChildren(frag);
    }

    function clearAllFilters() {
        state.filters.categories.clear();
        state.filters.durationMin = "";
        state.filters.durationMax = "";
        state.filters.dateFrom = "";
        state.filters.dateTo = "";
        state.filters.tags.clear();

        // Also clear UI elements
        if (dom.filterCategoryList) {
            dom.filterCategoryList
                .querySelectorAll('input[type="radio"][name="category"]')
                .forEach((rb) => (rb.checked = false));
        }
        if (dom.durationMin) dom.durationMin.value = "";
        if (dom.durationMax) dom.durationMax.value = "";
        if (dom.dateFrom) dom.dateFrom.value = "";
        if (dom.dateTo) dom.dateTo.value = "";
        renderActiveTags();
    }

    // ------------------ Fetch & render ------------------
    async function refresh() {
        const params = new URLSearchParams();
        if (state.q) params.set("q", state.q);
        params.set("sort", state.sort);
        params.set("page", String(state.page));
        params.set("page_size", String(state.pageSize));

        // Append filters (server-side should accept these names; adjust if different)
        const cat = getFirstCategory();
        if (cat) params.set("category", cat); // single value now
        if (state.filters.durationMin) params.set("duration_min", String(state.filters.durationMin)); // minutes
        if (state.filters.durationMax) params.set("duration_max", String(state.filters.durationMax)); // minutes
        if (state.filters.dateFrom) params.set("date_from", state.filters.dateFrom);
        if (state.filters.dateTo) params.set("date_to", state.filters.dateTo);
        if (state.filters.tags.size) [...state.filters.tags].forEach(tag => {
            params.append("tags", tag);
        });

        const url = `${CFG.API_SEARCH}?${params.toString()}`;
        const data = await safeGet(url);
        const result =
            normalizePaged(data) ||
            normalizePaged({ items: mockVideos(18, state.q), total: 18, page: 1, pages: 2 });

        state.totalPages = result.pages || 1;
        state.totalCount = result.total || result.items.length;
        lastData = result;

        render(result);
    }

    function render(result) {
        // Page number + nav
        if (dom.pageNumber)
            dom.pageNumber.textContent = `Page ${result.page || state.page} of ${result.pages || state.totalPages || 1}`;
        toggleDisabled(dom.prevBtn, (result.page || state.page) <= 1);
        toggleDisabled(dom.nextBtn, (result.page || state.page) >= (result.pages || state.totalPages || 1));

        // Total count
        if (dom.totalResults) dom.totalResults.textContent = String(result.total ?? result.items.length);

        // Results
        if (state.view === "grid") {
            dom.resultsGrid.classList.remove("list-view");
            dom.resultsGrid.classList.add("grid");
            renderCardsInto(result.items, dom.resultsGrid);
        } else {
            dom.resultsGrid.classList.remove("grid");
            dom.resultsGrid.classList.add("list-view");
            renderRowsInto(result.items, dom.resultsGrid);
        }
    }

    // ------------------ Populate filter sources ------------------
    async function populateCategories() {
        const data = await safeGet(CFG.API_CATEGORIES);
        const cats = Array.isArray(data) ? data : mockCategories();

        if (!dom.filterCategoryList) return;
        const frag = document.createDocumentFragment();
        const selected = getFirstCategory();

        cats.forEach((c) => {
            const id = c.id || c.slug || c.name || "";
            const name = c.name || prettify(id || "");
            if (!name) return;

            const li = document.createElement("li");
            li.innerHTML = `
        <label class="flex items-center gap-2 text-sm">
          <input type="radio" name="category" value="${escapeAttr(name)}" ${selected === name ? "checked" : ""} />
          <span>${escapeHtml(name)}</span>
        </label>
      `;
            frag.appendChild(li);
        });

        dom.filterCategoryList.replaceChildren(frag);
    }

    async function populateTags() {
        const data = await safeGet(CFG.API_TAGS);
        const arr = Array.isArray(data) ? data : mockTags();
        if (!dom.searchTagList) return;

        const frag = document.createDocumentFragment();
        arr.forEach(t => {
            const opt = document.createElement("option");
            const val = typeof t === "string" ? t : (t.name || t.slug || "");
            opt.value = val;
            frag.appendChild(opt);
        });
        dom.searchTagList.replaceChildren(frag);
    }

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
            const a = document.createElement("a");
            a.className = "card p-0 overflow-hidden hover:shadow-xl transition-shadow block";
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

        // lookups
        const link = el.tagName === "A" ? el : el.querySelector("a");
        const hero = el.querySelector(".aspect-video") || el;
        const imgs = el.querySelectorAll("img");
        const [thumb, avatar] = [imgs[0], imgs[1]];
        const title = el.querySelector("h3");
        const desc = el.querySelector("p");
        const duration = el.querySelector('span[class*="bottom-2"][class*="right-2"]');
        const metaEl = Array.from(el.querySelectorAll(".text-xs.muted")).pop();

        // data
        const id = v.uuid ?? v.id ?? v.slug ?? "";
        const safeId = encodeURIComponent(id);
        const titleText = (v.title || "").trim() || "Untitled";
        const categoryTxt = (v.category_name || v.category?.name || v.category || "").trim();
        const descText = (v.description || categoryTxt || "").trim();
        const authorName = (v.author || v.channel || "").trim() || "Unknown";
        const href = v.url || (id ? `/${safeId}` : "#");
        const durText = fmtDuration(v.duration);
        const metaText = compactMeta(v);

        // link
        if (link) {
            link.href = href;
            link.setAttribute("aria-label", titleText);
            link.dataset.videoId = id;
            if (categoryTxt) link.dataset.category = categoryTxt;
        }

        // thumbnail
        if (thumb) {
            thumb.src = v.thumbnail || v.thumb || (id ? `/api/v1/video/thumbnails/${safeId}.jpg` : placeholderThumb(id));
            thumb.alt = titleText;
            thumb.loading = "lazy";
            thumb.decoding = "async";
            thumb.onerror = () => {
                if (thumb.dataset.fbk) return;
                thumb.dataset.fbk = "1";
                thumb.src = placeholderThumb(id);
            };
        }

        // avatar
        if (avatar) {
            avatar.src = v.author_avatar || v.channel_avatar || placeholderAvatar(authorName);
            avatar.alt = authorName;
            avatar.loading = "lazy";
            avatar.decoding = "async";
            avatar.onerror = () => {
                if (avatar.dataset.fbk) return;
                avatar.dataset.fbk = "1";
                avatar.src = placeholderAvatar(authorName);
            };
        }

        // text
        if (title) title.textContent = titleText;
        if (desc) desc.textContent = descText;
        if (duration) duration.textContent = durText;
        if (metaEl) metaEl.textContent = metaText;

        // progress bar (optional)
        const pos = Number(v.position);
        const dur = Number(v.duration);
        if (Number.isFinite(pos) && Number.isFinite(dur) && dur > 0 && pos >= 0) {
            let pct = (pos / dur) * 100;
            let color = "bg-[color:var(--brand-600)]";
            if (pos >= dur - 1) {
                pct = 100;
                color = "bg-green-600";
            }
            const barWrap = document.createElement("div");
            barWrap.className = "absolute left-0 right-0 bottom-0 h-1 bg-black/20";
            barWrap.setAttribute("role", "progressbar");
            barWrap.setAttribute("aria-label", `Watched ${Math.round(pct)}%`);
            barWrap.setAttribute("aria-valuemin", "0");
            barWrap.setAttribute("aria-valuemax", "100");
            barWrap.setAttribute("aria-valuenow", String(Math.round(pct)));

            const bar = document.createElement("div");
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

        el.href = v.url || `/${encodeURIComponent(v.uuid || v.slug || "")}`;

        const thumb = el.querySelector("img");
        const title = el.querySelector("h3");
        const desc = el.querySelector("p");
        const av = el.querySelector("img.w-6.h-6.rounded-full");
        const who = el.querySelector(".text-xs.muted");
        const meta = el.querySelectorAll(".text-xs.muted")[1];
        const badge = el.querySelector(".badge");
        const dur = el.querySelector(".mt-1");

        if (thumb) {
            const id = v.uuid ?? v.id ?? v.slug ?? "";
            thumb.src = v.thumbnail || v.thumb || (id ? `/api/v1/video/thumbnails/${encodeURIComponent(id)}.jpg` : placeholderThumb(v.id));
            thumb.alt = v.title || "Video";
            thumb.loading = "lazy";
            thumb.decoding = "async";
        }
        if (title) title.textContent = v.title || "Untitled";
        if (desc) desc.textContent = v.snippet || v.description || v.category || "";
        if (av) av.src = v.author_avatar || v.channel_avatar || placeholderAvatar(v.author || v.channel);
        if (who) who.textContent = v.author || v.channel || "Unknown";
        if (meta) meta.textContent = compactMeta(v);
        if (badge) badge.textContent = (v.badge || v.resolution || "HD").toUpperCase();
        if (dur) dur.textContent = fmtDuration(v.duration);

        return el;
    }

    // ------------------ Pagination ------------------
    function changePage(delta) {
        const next = Math.min(Math.max(1, state.page + delta), state.totalPages || 1);
        if (next === state.page) return;
        state.page = next;
        localStorage.setItem(CFG.LS.PAGE, String(state.page));
        refresh();
    }

    // ------------------ UI helpers ------------------
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
        dom.viewToggle.textContent = "Toggle Grid/List";
    }

    function toggleDisabled(btn, disabled) {
        if (!btn) return;
        btn.disabled = !!disabled;
        btn.style.opacity = disabled ? 0.6 : 1;
        btn.style.pointerEvents = disabled ? "none" : "auto";
    }

    // ------------------ Networking ------------------
    async function safeGet(url) {
        try {
            const res = await fetchWithTimeout(url, { headers: { Accept: "application/json" } }, CFG.TIMEOUT_MS);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (e) {
            console.warn("Search GET failed, using mock:", url, e);
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
        return `https://picsum.photos/seed/search${n}/640/360`;
    }

    function placeholderAvatar(seed) {
        const s = encodeURIComponent(String(seed || "u"));
        return `https://api.dicebear.com/7.x/identicon/svg?seed=${s}`;
    }

    function strOrEmpty(v) {
        return v === undefined || v === null ? "" : String(v);
    }

    function hashCode(str) {
        let h = 0;
        for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
        return h;
    }

    function prettify(slug) {
        if (!slug) return "";
        return slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
    }

    function clampNonNegInt(v) {
        if (v === "" || v === null || v === undefined) return "";
        const n = Math.max(0, Math.floor(Number(v)));
        return Number.isFinite(n) ? String(n) : "";
    }

    function computeDateRange(span) {
        const now = new Date();
        const to = now.toISOString().slice(0, 10);
        let from = "";
        const map = { "24h": 1, "7d": 7, "30d": 30, "365d": 365 , "366d": 366 };
        if (map[span]!=366) {
            const d = new Date(now.getTime() - map[span] * 86400000);
            from = d.toISOString().slice(0, 10);
        }
        else {
            from = "";
        }
        return { from, to };
    }

    function sanitizeTag(s) {
        return String(s || "").replace(/,/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
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

    function persistFilters() {
        const obj = {
            categories: [...state.filters.categories], // 0 or 1 value
            durationMin: state.filters.durationMin,
            durationMax: state.filters.durationMax,
            dateFrom: state.filters.dateFrom,
            dateTo: state.filters.dateTo,
            tags: [...state.filters.tags],
        };
        try { localStorage.setItem(CFG.LS.FILTERS, JSON.stringify(obj)); } catch { }
    }
    function readFilters() {
        try { return JSON.parse(localStorage.getItem(CFG.LS.FILTERS) || "{}"); } catch { return {}; }
    }

    function getFirstCategory() {
        for (const v of state.filters.categories) return v;
        return "";
    }

    // ------------------ Mock sources ------------------
    function mockCategories() {
        return [
            { id: "retina", name: "Retina" },
            { id: "cataract", name: "Cataract" },
            { id: "glaucoma", name: "Glaucoma" },
            { id: "cornea", name: "Cornea" },
            { id: "oculoplasty", name: "Oculoplasty" },
            { id: "pediatric", name: "Pediatric" },
        ];
    }
    function mockTags() {
        return ["vitrectomy", "IOL", "trabeculectomy", "DMEK", "phaco", "buckling", "tips"];
    }
    function mockVideos(n = 18, q = "") {
        const labels = ["Retina", "Cataract", "Glaucoma", "Cornea", "Oculoplasty", "Pediatric"];
        return Array.from({ length: n }, (_, i) => ({
            id: `s-${i + 1}`,
            uuid: `s-${i + 1}`,
            title: `${q ? q + " - " : ""}Sample Surgery ${i + 1}`,
            description: `${labels[i % labels.length]} case demo`,
            duration: 120 + i * 17,
            resolution: ["HD", "FHD", "4K"][i % 3],
            thumbnail: placeholderThumb(i),
            author: ["Dr. Rao", "Dr. Mehta", "Dr. Singh", "Dr. Chawla"][i % 4],
            author_avatar: placeholderAvatar(i),
            views: 1000 * (i + 1),
            published_at: new Date(Date.now() - (i + 1) * 86400000).toISOString(),
            url: `#mock-${i + 1}`,
            category_name: labels[i % labels.length],
        }));
    }

    // ------------------ GO ------------------
    init();
})();
