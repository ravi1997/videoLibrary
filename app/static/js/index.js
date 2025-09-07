/* ==========================================================================
   RPC Surgical Video Library — Homepage logic (no dependencies)
   Works with templates/index.html as provided. Keeps layout.html untouched.
   - Populates: categories, tag chips, Continue Watching, Trending, New, All
   - Sorting, category filter, tag filters
   - Grid/List view toggle, pagination
   - Remembers user choices in localStorage
   - ✅ Sends CATEGORY NAME (not id) to the API
   ========================================================================== */

(() => {
    // ------------------ Config ------------------
    const CFG = {
        API_CATEGORIES: "/api/v1/video/categories",
        API_HISTORY: "/api/v1/video/history/latest?limit=8",
        API_TRENDING: "/api/v1/video/trending?limit=12",
        API_TAGS_TOP: "/api/v1/video/tags/top?limit=5",
        API_RECENT: "/api/v1/video/?limit=12&sort=recent",
        API_VIDEOS: "/api/v1/video/", // supports ?page=&page_size=&sort=&category=&tags=
        PAGE_SIZE: 12,
        TIMEOUT_MS: 8000,
    };

    // ------------------ State ------------------
    const state = {
        page: +(localStorage.getItem("index.page") || 1),
        pageSize: CFG.PAGE_SIZE,
        sort: localStorage.getItem("index.sort") || "trending", // trending|recent|most_viewed
        view: localStorage.getItem("index.view") || "grid",     // grid|list
        // store the CATEGORY NAME here (not id)
        category: localStorage.getItem("index.category") || "",
        tags: new Set(JSON.parse(localStorage.getItem("index.tags") || "[]")),
        totalPages: 1,
        totalCount: 0,
        activeTab: localStorage.getItem("index.activeTab") || "trendingTab", // trendingTab|newTab|allTab
    };

    // Expose minimal API for template buttons to call
    window.indexPage = Object.assign(window.indexPage || {}, {
        onCategoryChange: (v) => {
            // v is expected to be the NAME coming from the <select> value
            state.category = (v || "").trim();
            persist();
            refreshAllTab(true);
        },
        onTagChange: (v) => {
            // v is expected to be the NAME coming from the <select> value
            if (v) {
                state.tags.add(v);
            } else {
                state.tags.delete(v);
            }
            persist();
            refreshAllTab(true);
        },
        toggleView: () => {
            state.view = state.view === "grid" ? "list" : "grid";
            localStorage.setItem("index.view", state.view);
            applyViewMode();
            // re-render current page items without refetch
            renderAllTab(lastAllData);
        },
        changePage: (delta) => {
            const next = Math.min(Math.max(1, state.page + delta), state.totalPages || 1);
            if (next === state.page) return;
            state.page = next;
            localStorage.setItem("index.page", String(state.page));
            refreshAllTab(false);
        },
        switchTab,
    });

    // ------------------ DOM refs ------------------
    const $ = (s, r = document) => r.querySelector(s);
    const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

    const dom = {
        // Common
        sortBtns: $$('button.sort-btn'),
        tagFilters: $('#tagFilters'),
        categoryList: $('#categoryList'),
        categorySelect: $('#categorySelect'),
        quickChips: $('#quickChips'),

        // Sections
        historyList: $('#historyList'),
        trendingGrid: $('#trending'),
        recentGrid: $('#recentGrid'),

        // All tab
        allCount: $('#totalCount'),
        videoList: $('#videoList'),
        prevBtn: $('#prevBtn'),
        nextBtn: $('#nextBtn'),
        pageNumber: $('#pageNumber'),
        viewToggle: $('#viewToggle'),

        // Templates
        tplCard: $('#videoCardTpl'),
        tplRow: $('#videoRowTpl'),
        // Tabs
        tabBtns: $$('.tab-btn'),
        tabPanels: $$('.tab-panel'),
    };

    // Track last dataset to allow view switching without refetching
    let lastAllData = { items: [], total: 0, page: 1, pages: 1 };

    // ------------------ Init ------------------
    function init() {
        // Bind sort buttons
        dom.sortBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const val = btn.getAttribute('data-sort');
                if (!val) return;
                state.sort = val;
                localStorage.setItem("index.sort", state.sort);
                updateActiveSort();

                if (isTabActive('trendingTab')) {
                    refreshTrending();
                } else if (isTabActive('newTab')) {
                    refreshRecent();
                } else {
                    refreshAllTab(true);
                }
            });
        });
        dom.tabBtns.forEach(b => {
            const id = b.getAttribute('data-tab');
            if (!id) return;
            b.addEventListener('click', () => switchTab(id));
        });

        // Restore category and tags
        if (dom.categorySelect && state.category) {
            setSelectByName(dom.categorySelect, state.category);
        }
        renderTagFilters();

        // Quick hero chips (if present) -> clicking adds a tag
        if (dom.quickChips) {
            dom.quickChips.addEventListener('click', (e) => {
                const el = e.target.closest('.chip');
                if (!el) return;
                const tag = (el.textContent || '').trim();
                if (!tag) return;
                state.tags.add(tag);
                persist();
                renderTagFilters();
                if (isTabActive('allTab')) refreshAllTab(true);
            });
        }

        // Apply initial view mode
        applyViewMode();
        updateActiveSort();

        // Data loads
        refreshCategories();
        refreshTags();
        refreshHistory();
        refreshTrending();
        refreshRecent();
        refreshAllTab(false);
        refreshFeaturedPlaylists();

        // Ensure correct tab is visible on first paint
        switchTab(state.activeTab);
        // Load All tab data if All is active
        if (state.activeTab === 'allTab') refreshAllTab(false);
    }

    // ------------------ Persistence helpers ------------------
    function persist() {
        localStorage.setItem("index.tags", JSON.stringify([...state.tags]));
        localStorage.setItem("index.category", state.category);
    }

    function switchTab(id) {
        if (!id) return;
        state.activeTab = id;
        localStorage.setItem("index.activeTab", id);

        // Show/hide panels
        dom.tabPanels.forEach(panel => {
            panel.classList.toggle('hidden', panel.id !== id);
        });

        // Update button active underline/border
        dom.tabBtns.forEach(btn => {
            const isActive = btn.getAttribute('data-tab') === id;
            btn.style.borderBottomColor = isActive ? 'var(--brand-600)' : 'transparent';
            btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });

        // Load data for the selected tab (keeps UI fresh)
        if (id === 'trendingTab') {
            refreshTrending();
        } else if (id === 'newTab') {
            refreshRecent();
        } else if (id === 'allTab') {
            refreshAllTab(false);
        }
    }

    function updateActiveSort() {
        dom.sortBtns.forEach(b => {
            const active = b.getAttribute('data-sort') === state.sort;
            b.classList.toggle('ring-1', active);
            b.classList.toggle('ring-[color:var(--brand-600)]', active);
            b.classList.toggle('font-semibold', active);
        });
    }

    function applyViewMode() {
        if (!dom.viewToggle) return;
        dom.viewToggle.textContent = 'Toggle Grid/List';
    }

    // ------------------ Tabs helpers ------------------
    function isTabActive(id) {
        const el = document.getElementById(id);
        return el && !el.classList.contains('hidden');
    }

    // ------------------ Rendering: Tags ------------------
    function renderTagFilters() {
        if (!dom.tagFilters) return;
        const frag = document.createDocumentFragment();

        if (state.tags.size === 0) {
            const muted = document.createElement('span');
            muted.className = 'muted';
            muted.textContent = 'No tag filters';
            frag.appendChild(muted);
        } else {
            [...state.tags].forEach(tag => {
                const chip = document.createElement('span');
                chip.className = 'chip';
                chip.innerHTML = `
          <span>${escapeHtml(tag)}</span>
          <button class="close" title="Remove tag" aria-label="Remove tag">&times;</button>
        `;
                chip.querySelector('.close').addEventListener('click', () => {
                    state.tags.delete(tag);
                    persist();
                    renderTagFilters();
                    if (isTabActive('allTab')) refreshAllTab(true);
                });
                frag.appendChild(chip);
            });

            const clear = document.createElement('button');
            clear.className = 'btn-ghost';
            clear.textContent = 'Clear tags';
            clear.addEventListener('click', () => {
                state.tags.clear();
                persist();
                renderTagFilters();
                if (isTabActive('allTab')) refreshAllTab(true);
            });
            frag.appendChild(clear);
        }

        dom.tagFilters.replaceChildren(frag);
    }

    // ------------------ Rendering: Categories ------------------
    async function refreshCategories() {
        const data = await safeGet(CFG.API_CATEGORIES);
        // expect array of items { id, name } or { name }
        const cats = Array.isArray(data) ? data : mockCategories();

        // Sidebar grid list
        if (dom.categoryList) {
            const frag = document.createDocumentFragment();
            cats.forEach(c => {
                const name = (c?.name || c?.id || '').toString();
                if (!name) return;

                const li = document.createElement('li');
                li.innerHTML = `
          <button class="btn-ghost w-full justify-start" data-cat-name="${escapeAttr(name)}">
            ${escapeHtml(name)}
          </button>
        `;
                li.querySelector('button').addEventListener('click', () => {
                    const slug = encodeURIComponent(name);
                    window.location.href = `/category/${slug}`;
                });
                frag.appendChild(li);
            });
            dom.categoryList.replaceChildren(frag);
        }

        if (dom.categorySelect) {
            renderCategorySelect(cats, state.category);
            // Keep in sync with state when user changes manually
            dom.categorySelect.addEventListener('change', (e) => {
                const val = e.target.value || "";
                if (val === state.category) return;
                state.category = val;
                persist();
                refreshAllTab(true);
            });
        }
    }
    function renderCategorySelect(cats, selectedId = "") {
        const sel = dom.categorySelect;
        if (!sel) return;

        const prev = sel.value; // remember any current value briefly
        sel.replaceChildren();   // clear all options

        // "All" default
        const optAll = document.createElement('option');
        optAll.value = "";
        optAll.textContent = "All";
        sel.appendChild(optAll);

        // API-provided categories
        cats.forEach(c => {
            const opt = document.createElement('option');
            opt.value = `${escapeAttr(c.name)}`;
            opt.textContent = c.name;
            sel.appendChild(opt);
        });

        // Prefer selectedId, else previously saved state, else ""
        const desired = selectedId || state.category || "";
        sel.value = desired;

        // If desired not in list (edge-case), fallback gracefully
        if (sel.value !== desired) sel.value = "";
    }


    function setSelectByName(selectEl, name) {
        if (!selectEl) return;
        const target = (name || "").trim().toLowerCase();
        let matched = false;
        for (const opt of selectEl.options) {
            const val = (opt.value || opt.textContent || "").trim().toLowerCase();
            if (val === target) {
                opt.selected = true;
                matched = true;
                break;
            }
        }
        if (!matched && selectEl.options.length) {
            // default to first if not found
            selectEl.selectedIndex = 0;
        }
    }

    function ensureAllTab() {
        if (window.indexPage && typeof window.indexPage.switchTab === 'function') {
            window.indexPage.switchTab('allTab');
        }
    }


    async function refreshTags() {
        // Fetch top tags
        const data = await safeGet(CFG.API_TAGS_TOP);
        // Expect: [{id, name}, ...] or [{name}, ...]
        const tags = Array.isArray(data) ? data : mockTags();

        if (!dom.quickChips) return;

        const frag = document.createDocumentFragment();

        tags.forEach(t => {
            const name = (t?.name || t?.id || "").toString().trim();
            if (!name) return;

            const btn = document.createElement("button");
            btn.className = "chip";
            btn.type = "button";
            btn.textContent = name;

            // Click behavior:
            // 1) Prefer your page-level handler for tags
            // 2) Else fall back to a search route using ?tag=
            btn.addEventListener("click", () => window.indexPage?.onTagChange?.(name));

            frag.appendChild(btn);
        });

        // Replace static category chips with dynamic tag chips
        dom.quickChips.replaceChildren(frag);
    }
    function mockTags() {
        return [{ name: "Retina" }, { name: "Cataract" }, { name: "Cornea" }, { name: "Pediatric" }, { name: "Glaucoma" }];
    }

    // ------------------ Rendering: History ------------------
    async function refreshHistory() {
        const data = await safeGet(CFG.API_HISTORY);
        const items = ensureArray(data) || [];
        renderCardsInto(items.slice(0, 8), dom.historyList);
    }

    // ------------------ Rendering: Trending & Recent ------------------
    async function refreshTrending() {
        const data = await safeGet(appendSort(CFG.API_TRENDING, state.sort));
        const items = ensureArray(data?.items) || mockVideos(8);
        renderCardsInto(items, dom.trendingGrid);
    }

    async function refreshRecent() {
        const data = await safeGet(appendSort(CFG.API_RECENT, state.sort));
        const items = ensureArray(data?.items) || mockVideos(8);
        renderCardsInto(items, dom.recentGrid);
    }

    // ------------------ Rendering: All (pagination, view mode) ------------------
    async function refreshAllTab(resetPageIfFiltersChanged) {
        if (resetPageIfFiltersChanged) state.page = 1;

        // Build query — ✅ send category NAME
        const params = new URLSearchParams();
        params.set("page", String(state.page));
        params.set("page_size", String(state.pageSize));
        params.set("sort", state.sort);
        if (state.category) params.set("category", state.category); // <-- name, not id
        if (state.tags.size) 
            [...state.tags].forEach(tag => {
                params.append("tags", tag);
            });

        const url = `${CFG.API_VIDEOS}?${params.toString()}`;
        const data = await safeGet(url);
        const result =
            normalizePaged(data) ||
            normalizePaged({ items: mockVideos(20), total: 20, page: 1, pages: 2 });

        state.totalPages = result.pages || 1;
        state.totalCount = result.total || result.items.length;

        lastAllData = result; // keep for view toggle re-render

        renderAllTab(result);
    }

    function renderAllTab(result) {
        if (dom.allCount) dom.allCount.textContent = String(result.total || result.items.length);
        if (dom.pageNumber) dom.pageNumber.textContent = `Page ${result.page || state.page}`;
        toggleDisabled(dom.prevBtn, (result.page || state.page) <= 1);
        toggleDisabled(dom.nextBtn, (result.page || state.page) >= (result.pages || state.totalPages || 1));

        if (state.view === "grid") {
            dom.videoList.classList.remove("list-view");
            dom.videoList.classList.add("grid");
            dom.videoList.style.display = "";
            renderCardsInto(result.items, dom.videoList);
        } else {
            dom.videoList.classList.remove("grid");
            dom.videoList.classList.add("list-view");
            dom.videoList.style.display = "";
            renderRowsInto(result.items, dom.videoList);
        }
    }

    // ------------------ Card / Row builders ------------------
    async function renderCardsInto(items, mount) {
        if (!mount) return;
        const frag = document.createDocumentFragment();
        items.forEach(v => frag.appendChild(buildCard(v)));
        mount.replaceChildren(frag);
        try { await annotateSaved(mount, items); } catch {}
    }

    async function renderRowsInto(items, mount) {
        if (!mount) return;
        const frag = document.createDocumentFragment();
        items.forEach(v => frag.appendChild(buildRow(v)));
        mount.replaceChildren(frag);
        try { await annotateSaved(mount, items); } catch {}
    }

    async function annotateSaved(container, items){
        const ids = (items||[]).map(v=> v.uuid || v.id || v.slug).filter(Boolean);
        if(!ids.length) return;
        const params = new URLSearchParams(); params.set('ids', ids.join(','));
        const r = await fetch(`/api/v1/video/playlists/contains?${params.toString()}`, { headers:{ 'Accept':'application/json' }});
        if(!r.ok) return; const data = await r.json().catch(()=>({present:[]}));
        const present = new Set(data.present||[]);
        container.querySelectorAll('[data-video-id]').forEach(a=>{
            const id = a.getAttribute('data-video-id'); if(!present.has(id)) return;
            const hero = a.querySelector('.aspect-video') || a;
            const badge = document.createElement('span');
            badge.className = 'absolute top-2 left-2 badge';
            badge.textContent = 'Saved'; hero.classList.add('relative'); hero.appendChild(badge);
        });
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

        // --------- add-to-playlist floating button ---------
        try {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'absolute left-2 bottom-2 z-10 text-xs px-2 py-1 rounded bg-black/60 text-white hover:bg-black/80';
            btn.textContent = '＋ Playlist';
            btn.addEventListener('click', (e)=>{ e.preventDefault(); e.stopPropagation(); if(window.playlistMulti){ window.playlistMulti.show(id); } });
            hero?.appendChild(btn);
            hero?.classList.add('relative');
        } catch {}

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
        const el = t ? t.cloneNode(true) : document.createElement('a');
        if (!t) {
            el.className = 'card p-3 flex gap-3';
            el.href = v.url || '#';
            el.textContent = v.title || "Video";
        }

        el.href = v.url || `/watch/${encodeURIComponent(v.id || v.slug || '')}`;

        const thumb = el.querySelector('img');
        const title = el.querySelector('h3');
        const desc = el.querySelector('p');
        const av = el.querySelector('img.w-6.h-6.rounded-full');
        const who = el.querySelector('.text-xs.muted');
        const meta = el.querySelectorAll('.text-xs.muted')[1];
        const badge = el.querySelector('.badge');
        const dur = el.querySelector('.mt-1');

        if (thumb) {
            thumb.src = v.thumbnail || v.thumb || placeholderThumb(v.id);
            thumb.alt = v.title || "Video";
        }
        if (title) title.textContent = v.title || "Untitled";
        if (desc) desc.textContent = v.description || v.category_name || v.category || "";
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
            const res = await fetchWithTimeout(url, { headers: { 'Accept': 'application/json' } }, CFG.TIMEOUT_MS);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            return data;
        } catch (e) {
            console.warn("GET failed, using mock:", url, e);
            return null;
        }
    }

    // ------------------ Featured Playlists ------------------
    async function refreshFeaturedPlaylists(){
        const mount = document.getElementById('featuredPlaylists'); if(!mount) return;
        try{
            const res = await fetch('/api/v1/video/playlists?scope=public&page=1&page_size=8', { headers: { 'Accept':'application/json' }});
            if(!res.ok) throw new Error('HTTP '+res.status);
            const data = await res.json();
            const items = data.items||[];
            const frag = document.createDocumentFragment();
            items.forEach(p=>{
                const a = document.createElement('a'); a.href = `/playlist/${p.id}/play`; a.className='card p-3 no-underline hover:shadow-xl transition-shadow';
                a.innerHTML = `<div class="rounded-lg h-24 bg-[color:var(--border)] mb-2 flex items-center justify-center text-2xl">🎵</div>
                <div class="font-semibold line-clamp-2">${escapeHtml(p.title||'Untitled')}</div>
                <div class="text-xs muted">${p.items||0} items</div>`;
                frag.appendChild(a);
            });
            mount.replaceChildren(frag);
        }catch(e){ mount.innerHTML = `<div class='text-sm muted'>Failed to load playlists</div>`; }
    }

    function appendSort(url, sort) {
        try {
            const u = new URL(url, window.location.origin);
            u.searchParams.set("sort", sort);
            return u.toString();
        } catch {
            const sep = url.includes("?") ? "&" : "?";
            return `${url}${sep}sort=${encodeURIComponent(sort)}`;
        }
    }

    async function fetchWithTimeout(resource, options = {}, timeout = 8000) {
        const ctrl = new AbortController();
        const id = setTimeout(() => ctrl.abort(), timeout);
        try {
            const res = await fetch(resource, { ...options, signal: ctrl.signal });
            return res;
        } finally {
            clearTimeout(id);
        }
    }

    // ------------------ Utilities ------------------
    function ensureArray(v) {
        return Array.isArray(v) ? v : (v && Array.isArray(v.items) ? v.items : null);
    }

    function normalizePaged(v) {
        if (!v) return null;
        if (Array.isArray(v)) {
            return { items: v, total: v.length, page: 1, pages: 1 };
        }
        if (v.items) {
            return {
                items: v.items || [],
                total: typeof v.total === 'number' ? v.total : (v.items.length),
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
        return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
    }

    function compactMeta(v) {
        const views = v.views ?? v.view_count;
        const age = v.age || v.published_at || v.date;
        const parts = [];
        if (views != null) parts.push(`${formatCompact(views)} views`);
        if (age) parts.push(formatAge(age));
        return parts.join(' • ');
    }

    function formatCompact(n) {
        const x = Number(n) || 0;
        if (x >= 1_000_000) return (x / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
        if (x >= 1_000) return (x / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
        return String(x);
    }

    function formatAge(dateish) {
        try {
            const d = new Date(dateish);
            const diff = Math.max(0, (Date.now() - d.getTime()) / 1000);
            const day = 86400, week = day * 7, month = day * 30, year = day * 365;
            if (diff < day) return 'today';
            if (diff < week) return `${Math.floor(diff / day)}d ago`;
            if (diff < month) return `${Math.floor(diff / week)}w ago`;
            if (diff < year) return `${Math.floor(diff / month)}mo ago`;
            return `${Math.floor(diff / year)}y ago`;
        } catch {
            return '';
        }
    }

    function placeholderThumb(id) {
        const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 9'><rect width='16' height='9' fill='%23ddd'/><path d='M0 9 L5.5 4.5 L9 7 L12 5 L16 9 Z' fill='%23bbb'/></svg>`;
        return `data:image/svg+xml;base64,${btoa(svg)}`;
    }

    function placeholderAvatar(seed) {
        const s = String(seed || 'u');
        const color = '#'+((Math.abs(hashCode(s))>>8)&0xFFFFFF).toString(16).padStart(6,'0');
        const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' fill='%23f2f2f2'/><circle cx='32' cy='24' r='14' fill='${color}'/><rect x='14' y='40' width='36' height='18' rx='9' fill='${color}'/></svg>`;
        return `data:image/svg+xml;base64,${btoa(svg)}`;
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

    // ------------------ Mock (only used when API fails) ------------------
    function mockCategories() {
        return [
            { name: "Retina" },
            { name: "Cataract" },
            { name: "Glaucoma" },
            { name: "Cornea" },
            { name: "Oculoplasty" },
            { name: "Pediatric" },
        ];
    }

    function mockVideos(n = 8) {
        return Array.from({ length: n }, (_, i) => ({
            id: `vid-${i + 1}`,
            title: `Sample Surgery ${i + 1}`,
            description: ["Retina", "Cataract", "Glaucoma", "Cornea"][i % 4] + " case demo",
            category_name: ["Retina", "Cataract", "Glaucoma", "Cornea"][i % 4],
            duration: 120 + i * 17,
            resolution: ["HD", "FHD", "4K"][i % 3],
            thumbnail: placeholderThumb(i),
            author: ["Dr. Rao", "Dr. Mehta", "Dr. Singh", "Dr. Chawla"][i % 4],
            author_avatar: placeholderAvatar(i),
            views: 1000 * (i + 1),
            published_at: new Date(Date.now() - (i + 1) * 86400000).toISOString(),
            url: `#mock-${i + 1}`,
        }));
    }

    // ------------------ Start ------------------
    init();
})();
