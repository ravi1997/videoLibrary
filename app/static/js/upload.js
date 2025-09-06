/* ==========================================================================
   RPC Surgical Video Library — Upload page logic (no dependencies)
   Hooks expected from templates/upload.html:
     #dropZone, #fileInput, #progressContainer, #progressBar, #uploadStatus,
     #metaForm, #title, #description, #category, #categoryList,
     #tagContainer, #tagInput, #tagList, #surgeonContainer, #surgeonInput, #surgeonList
   Exposes:
     window.uploadFile()
     window.submitMetadata()
   ========================================================================== */

(() => {
    // ------------------ Config ------------------
    const CFG = {
        API_UPLOAD: "/api/v1/video/upload",            // direct (legacy) upload
        API_UPLOAD_INIT: "/api/v1/video/upload/init",   // chunk init
        API_UPLOAD_CHUNK: "/api/v1/video/upload/chunk", // chunk endpoint
    API_UPLOAD_COMPLETE: "/api/v1/video/upload/complete",
    API_UPLOAD_STATUS: "/api/v1/video/upload/status",
        API_METADATA: "/api/v1/video/",
        API_CATEGORIES: "/api/v1/video/categories",
        API_TAGS: "/api/v1/video/tags",
        API_SURGEONS: "/api/v1/video/surgeons",
        TIMEOUT_MS: 60_000,
        MAX_FILE_MB: 5_000,
    CHUNK_SIZE: 8 * 1024 * 1024, // 8 MB (initial; may adapt)
        RESUME_KEY_PREFIX: "upload.session.",
        MIN_CHUNK_THRESHOLD_MB: 200, // if file >= this, prefer chunked
    PARALLEL_CHUNKS: 3,
    MAX_RETRIES: 4,
    RETRY_BASE_DELAY_MS: 500,
    MIN_DYNAMIC_CHUNK: 2 * 1024 * 1024,
    MAX_DYNAMIC_CHUNK: 32 * 1024 * 1024,
    TARGET_CHUNK_TIME_MS: 2000,
    };

    // ------------------ DOM ------------------
    const $ = (s, r = document) => r.querySelector(s);
    const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

    const dom = {
        dropZone: $("#dropZone"),
        input: $("#fileInput"),
        progressWrap: $("#progressContainer"),
        progressBar: $("#progressBar"),
        status: $("#uploadStatus"),
        metaForm: $("#metaForm"),

        title: $("#title"),
        description: $("#description"),
        category: $("#category"),
        categoryList: $("#categoryList"),

        tagContainer: $("#tagContainer"),
        tagInput: $("#tagInput"),
        tagList: $("#tagList"),

        surgeonContainer: $("#surgeonContainer"),
        surgeonInput: $("#surgeonInput"),
        surgeonList: $("#surgeonList"),
    };

    // ------------------ State ------------------
    const state = {
        file: null,
        fileId: null,
        videoId: null,
        tags: new Set(),
        surgeons: new Set(),
        // chunk/resume
        uploadId: null,
        totalChunks: 0,
        chunkSize: CFG.CHUNK_SIZE,
        nextChunk: 0,
        aborted: false,
        startedAt: 0,
        uploadedBytes: 0,
        lastTickBytes: 0,
        lastTickTime: 0,
    controller: null,
    paused: false,
    retryCounts: {},
    adaptiveHistory: [],
    };

    // ------------------ Init ------------------
    function init() {
        // Drop + click to select
        if (dom.dropZone) {
            dom.dropZone.addEventListener("click", () => dom.input?.click());
            ["dragenter", "dragover"].forEach(ev =>
                dom.dropZone.addEventListener(ev, (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    dom.dropZone.classList.add("ring-2", "ring-[color:var(--brand-600)]", "bg-[color:var(--brand-50)]");
                })
            );
            ["dragleave", "drop"].forEach(ev =>
                dom.dropZone.addEventListener(ev, (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    dom.dropZone.classList.remove("ring-2", "ring-[color:var(--brand-600)]", "bg-[color:var(--brand-50)]");
                })
            );
            dom.dropZone.addEventListener("drop", (e) => {
                const f = (e.dataTransfer?.files || [])[0];
                if (f) handleSelectedFile(f);
            });
        }

        // File input
        if (dom.input) {
            dom.input.addEventListener("change", () => {
                const f = dom.input.files && dom.input.files[0];
                if (f) handleSelectedFile(f);
            });
        }

        // Populate suggestions for edit or upload flows
        populateDatalist(dom.categoryList, CFG.API_CATEGORIES, mockCategories());
        populateDatalist(dom.tagList, CFG.API_TAGS, mockTags());
        populateDatalist(dom.surgeonList, CFG.API_SURGEONS, mockSurgeons());

        // Edit flow: if a page provides an existing video id, prefill metadata
        const vidNode = document.getElementById('video-id');
        const existingId = (vidNode?.textContent || '').trim();
        if (existingId) {
            state.videoId = existingId;
            if (dom.metaForm) dom.metaForm.classList.remove('hidden');
            loadExistingMetadata(existingId);
        }

        // Tag input (comma or Enter to add)
        if (dom.tagInput) {
            dom.tagInput.addEventListener("keydown", (e) => {
                if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    const v = sanitizeTag(dom.tagInput.value);
                    if (v) {
                        state.tags.add(v);
                        renderTags();
                    }
                    dom.tagInput.value = "";
                }
            });
        }

        // Surgeon input (comma or Enter to add)
        if (dom.surgeonInput) {
            dom.surgeonInput.addEventListener("keydown", (e) => {
                if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    const v = sanitizeTag(dom.surgeonInput.value);
                    if (v) {
                        state.surgeons.add(v);
                        renderSurgeons();
                    }
                    dom.surgeonInput.value = "";
                }
            });
        }

        // Prefill datalists
        populateDatalist(dom.categoryList, CFG.API_CATEGORIES, mockCategories());
        populateDatalist(dom.tagList, CFG.API_TAGS, mockTags());
        populateDatalist(dom.surgeonList, CFG.API_SURGEONS, mockSurgeons());
    }

    // ------------------ File selection ------------------
    function handleSelectedFile(file) {
        if (!file) return;
        if (!file.type.startsWith("video/")) {
            showStatus("Please select a valid video file.", "warn");
            return;
        }
        const sizeMB = file.size / (1024 * 1024);
        if (sizeMB > CFG.MAX_FILE_MB) {
            showStatus(`File is too large (${sizeMB.toFixed(1)} MB). Limit is ${CFG.MAX_FILE_MB} MB.`, "warn");
            return;
        }
        state.file = file;
        showStatus(`Selected: ${file.name} (${sizeMB.toFixed(1)} MB)`, "info");
        // Auto-start upload on selection
        uploadFile();
    }

    // ------------------ Upload ------------------
    async function uploadFile() {
        if (!state.file) { dom.input?.click(); return; }
        // Choose strategy
        const sizeMB = state.file.size / (1024 * 1024);
        const useChunked = sizeMB >= CFG.MIN_CHUNK_THRESHOLD_MB;
        if (useChunked) {
            await startOrResumeChunked();
        } else {
            await legacySingleUpload();
        }
    }

    async function legacySingleUpload() {
        resetProgress(); toggleProgress(true); showStatus("Uploading (single)…", "info");
        state.startedAt = performance.now(); state.uploadedBytes = 0; state.aborted = false;
        try {
            const form = new FormData(); form.append("file", state.file);
            const json = await xhrPostWithProgress(CFG.API_UPLOAD, form, (pct, loaded) => {
                state.uploadedBytes = loaded;
                updateProgressMetrics(pct, loaded, state.file.size);
            });
            if (!json || (!json.uuid && !json.video_id)) throw new Error("Unexpected upload response");
            finishUpload(json.uuid || json.file_id || json.id, json.file_id || json.id || null);
        } catch (e) {
            if (state.aborted) showStatus("Upload canceled.", "warn"); else { console.error(e); showStatus("❌ Upload failed.", "error"); }
        } finally { toggleProgress(false); }
    }

    function persistSessionKey(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }
    function readSessionKey(key) { try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; } }
    function sessionKey() { if (!state.file) return null; return CFG.RESUME_KEY_PREFIX + [state.file.name, state.file.size].join(":"); }

    async function startOrResumeChunked() {
        resetProgress(); toggleProgress(true); showStatus("Preparing chunked upload…", "info");
        state.startedAt = performance.now(); state.aborted = false; state.uploadedBytes = 0; state.nextChunk = 0;
        const key = sessionKey();
        const existing = key ? readSessionKey(key) : null;
        if (existing && existing.upload_id) {
            // Ask server for authoritative status
            try {
                const qs = new URLSearchParams({ upload_id: existing.upload_id });
                const res = await fetch(`${CFG.API_UPLOAD_STATUS}?${qs.toString()}`);
                if (res.ok) {
                    const status = await res.json();
                    if (status.total_chunks && status.next_index < status.total_chunks) {
                        state.uploadId = status.upload_id;
                        state.chunkSize = status.chunk_size || existing.chunk_size;
                        state.totalChunks = status.total_chunks;
                        state.nextChunk = status.next_index;
                        showStatus(`Resuming at chunk ${state.nextChunk}/${state.totalChunks}…`, "info");
                    } else if (status.total_chunks && status.next_index === status.total_chunks) {
                        // All chunks present but not finalized on client: attempt finalize
                        state.uploadId = status.upload_id;
                        state.chunkSize = status.chunk_size || existing.chunk_size;
                        state.totalChunks = status.total_chunks;
                        state.nextChunk = status.total_chunks;
                        showStatus("Finalizing previous upload session…", "info");
                        await finalizeChunked();
                        return;
                    } else {
                        await initChunkSession();
                    }
                } else {
                    await initChunkSession();
                }
            } catch {
                await initChunkSession();
            }
        } else {
            await initChunkSession();
        }
        try {
            await uploadChunksLoop();
            if (!state.aborted) await finalizeChunked();
        } catch (e) {
            if (state.aborted) showStatus("Upload canceled.", "warn"); else { console.error(e); showStatus("❌ Chunked upload failed.", "error"); }
        } finally { toggleProgress(false); }
    }

    function getToken(){ try { return localStorage.getItem('token'); } catch { return null; } }

    async function initChunkSession() {
        if (!state.file_sha256) {
            showStatus("Hashing file (SHA-256)…", "info");
            state.file_sha256 = await hashBlobSHA256(state.file);
        }
        const res = await fetch(CFG.API_UPLOAD_INIT, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json", ...(getToken()? { Authorization: 'Bearer ' + getToken() }: {}) },
            body: JSON.stringify({ filename: state.file.name, size: state.file.size, chunk_size: CFG.CHUNK_SIZE, file_sha256: state.file_sha256 })
        });
        if (!res.ok) throw new Error("init failed");
        const data = await res.json();
        state.uploadId = data.upload_id; state.chunkSize = data.chunk_size; state.totalChunks = data.total_chunks; state.nextChunk = 0;
        persistSession();
    }

    function persistSession() {
        const key = sessionKey(); if (!key) return;
        persistSessionKey(key, {
            upload_id: state.uploadId,
            chunk_size: state.chunkSize,
            total_chunks: state.totalChunks,
            next_chunk: state.nextChunk
        });
    }

    async function uploadChunksLoop() {
        const file = state.file; if (!file) return;
        const inFlight = new Set();
        const scheduleNext = async () => {
            if (state.aborted) return;
            if (state.paused) return; // don't schedule new chunks while paused
            if (state.nextChunk >= state.totalChunks) return;
            const chunkIndex = state.nextChunk++;
            const start = chunkIndex * state.chunkSize;
            const end = Math.min(start + state.chunkSize, file.size);
            const blob = file.slice(start, end);
            const p = sendChunkWithRetry(blob, chunkIndex).then(() => {
                inFlight.delete(p);
                state.uploadedBytes = Math.max(state.uploadedBytes, end);
                persistSession();
                const pct = (state.uploadedBytes / file.size) * 100;
                updateProgressMetrics(pct, state.uploadedBytes, file.size);
                return scheduleNext();
            }).catch(err => {
                inFlight.delete(p);
                if (!state.aborted) {
                    console.error("Chunk failed permanently", err);
                    state.aborted = true;
                    showStatus("Chunk upload failed.", "error");
                }
            });
            inFlight.add(p);
            if (inFlight.size < CFG.PARALLEL_CHUNKS) await scheduleNext();
        };
        const starters = [];
        for (let i = 0; i < CFG.PARALLEL_CHUNKS; i++) starters.push(scheduleNext());
        await Promise.all(Array.from(inFlight));
    }

    async function sendChunkWithRetry(blob, index) {
        let attempt = 0;
        while (true) {
            try {
                await sendChunk(blob, index);
                return;
            } catch (e) {
                attempt++;
                if (attempt > CFG.MAX_RETRIES || state.aborted) throw e;
                const delay = CFG.RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1) + Math.random() * 200;
                await new Promise(r => setTimeout(r, delay));
                state.retryCounts[index] = attempt;
                updateRetryInfo();
            }
        }
    }

    async function sendChunk(blob, index) {
        const t0 = performance.now();
        const sha256 = await hashBlobSHA256(blob);
        const form = new FormData();
        form.append("upload_id", state.uploadId);
        form.append("index", String(index));
        form.append("chunk_sha256", sha256);
        form.append("chunk", blob, state.file.name + ".part");
    const res = await fetch(CFG.API_UPLOAD_CHUNK, { method: "POST", body: form, headers: { ...(getToken()? { Authorization: 'Bearer ' + getToken() }: {}) } });
        if (!res.ok) throw new Error(`chunk ${index} failed`);
        const dt = performance.now() - t0;
        adaptiveTune(blob.size, dt);
    }

    function adaptiveTune(bytes, ms) {
        const mb = bytes / (1024 * 1024) || 1;
        const msPerMB = ms / mb;
        state.adaptiveHistory.push(msPerMB);
        if (state.adaptiveHistory.length > 6) state.adaptiveHistory.shift();
        const avg = state.adaptiveHistory.reduce((a,b)=>a+b,0)/state.adaptiveHistory.length;
        const desiredMB = CFG.TARGET_CHUNK_TIME_MS / avg;
        let newSize = desiredMB * 1024 * 1024;
        newSize = Math.min(Math.max(newSize, CFG.MIN_DYNAMIC_CHUNK), CFG.MAX_DYNAMIC_CHUNK);
        if (Math.abs(newSize - state.chunkSize) / state.chunkSize > 0.25) {
            state.chunkSize = Math.round(newSize / (256*1024)) * (256*1024);
        }
    }

    function updateRetryInfo() {
        const el = document.getElementById("retryInfo");
        if (!el) return;
        const totalRetries = Object.values(state.retryCounts).reduce((a,b)=>a+b,0);
        if (totalRetries === 0) { el.classList.add("hidden"); return; }
        el.classList.remove("hidden");
        el.textContent = `Retries: ${totalRetries}`;
    }

    async function hashBlobSHA256(blob) {
        const buf = await blob.arrayBuffer();
        const hashBuffer = await crypto.subtle.digest('SHA-256', buf);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    async function finalizeChunked() {
        if (state.aborted) return;
        showStatus("Finalizing…", "info");
        const res = await fetch(CFG.API_UPLOAD_COMPLETE, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json", ...(getToken()? { Authorization: 'Bearer ' + getToken() }: {}) },
            body: JSON.stringify({ upload_id: state.uploadId, filename: state.file.name, total_chunks: state.totalChunks })
        });
        if (!res.ok) throw new Error("complete failed");
        const data = await res.json();
        finishUpload(data.uuid, data.file_id || null);
        clearSession();
    }

    function finishUpload(uuid, fileId) {
        state.videoId = uuid; state.fileId = fileId;
        setProgress(100); updateProgressMetrics(100, state.file.size, state.file.size);
        showStatus("✅ Upload complete.", "success");
        if (dom.metaForm) dom.metaForm.classList.remove("hidden");
        // Always attempt to load existing metadata (handles duplicate MD5 case)
        loadExistingMetadata(uuid);
        if (dom.title && !dom.title.value) dom.title.value = basename(state.file.name);
    }

    async function loadExistingMetadata(uuid) {
        if (!uuid) return;
        try {
            const headers = { Accept: 'application/json', ...(getToken()? { Authorization: 'Bearer ' + getToken() }: {}) };
            const res = await fetch(`/api/v1/video/${uuid}`, { headers });
            if (!res.ok) return; // silently ignore
            const data = await res.json();
            if (data.title && dom.title) dom.title.value = data.title;
            if (dom.description && typeof data.description === 'string') dom.description.value = data.description;
            if (dom.category && data.category && data.category.name) dom.category.value = data.category.name;
            // Tags
            if (Array.isArray(data.tags)) {
                state.tags = new Set(data.tags.map(t => (t.name || t.title || '').trim()).filter(Boolean));
                renderTags();
            }
            // Surgeons
            if (Array.isArray(data.surgeons)) {
                state.surgeons = new Set(data.surgeons.map(s => {
                    const n = (s.name || '').trim();
                    const type = (s.type || '').trim();
                    return type ? `${n} : ${type}` : n;
                }).filter(Boolean));
                renderSurgeons();
            }
        } catch (e) {
            console.debug('Metadata fetch skipped', e);
        }
    }

    function clearSession() { const key = sessionKey(); if (key) try { localStorage.removeItem(key); } catch {} }

    function cancelUpload() { state.aborted = true; showStatus("Canceling…", "warn"); }
    function pauseUpload() { state.paused = true; showStatus("Paused.", "info"); }
    function resumeUpload() {
        if (!state.file) return;
        if (!state.videoId) {
            if (state.paused) { state.paused = false; showStatus("Resuming…", "info"); startOrResumeChunked(); }
            else { state.aborted = false; uploadFile(); }
        }
    }

    function updateProgressMetrics(pct, loaded, total) {
        setProgress(pct);
        const label = document.getElementById("progressLabel");
        if (label) label.textContent = `${pct.toFixed(1)}%`;
        const now = performance.now();
        if (!state.lastTickTime) { state.lastTickTime = now; state.lastTickBytes = loaded; return; }
        const dt = (now - state.lastTickTime) / 1000; // s
        if (dt >= 0.5) {
            const dBytes = loaded - state.lastTickBytes;
            const speed = dBytes / dt; // B/s
            const etaSec = speed > 0 ? (total - loaded) / speed : 0;
            const speedEl = document.getElementById("progressSpeed");
            const etaEl = document.getElementById("progressEta");
            if (speedEl) speedEl.textContent = formatSpeed(speed);
            if (etaEl) etaEl.textContent = `ETA ${formatEta(etaSec)}`;
            state.lastTickTime = now; state.lastTickBytes = loaded;
        }
        const cancelBtn = document.getElementById("cancelUploadBtn");
        const resumeBtn = document.getElementById("resumeUploadBtn");
        const pauseBtn = document.getElementById("pauseUploadBtn");
        if (cancelBtn && !state.aborted && pct < 100) cancelBtn.classList.remove("hidden");
        if (pauseBtn && !state.aborted && pct < 100) pauseBtn.classList.remove("hidden");
        if (resumeBtn) {
            const shouldShowResume = (state.aborted || state.paused) && pct < 100;
            resumeBtn.classList.toggle("hidden", !shouldShowResume);
        }
    }

    function formatSpeed(bytesPerSec) {
        const mbps = bytesPerSec / (1024 * 1024); return `${mbps.toFixed(2)} MB/s`;
    }
    function formatEta(s) {
        if (!isFinite(s) || s <= 0) return "—"; if (s < 60) return `${Math.round(s)}s`; const m = Math.floor(s / 60); const r = Math.round(s % 60); return `${m}m ${r}s`;
    }

    function parseNameType(str) {
        const s = String(str || "").trim();
        if (!s) return { name: "" };
        const [name, type] = s.split(":").map(x => x.trim());
        if (type) {
            return { name, type };
        }
        return { name };
    }


    // ------------------ Metadata submit ------------------
    async function submitMetadata() {
        if (!state.fileId && !state.videoId) {
            showStatus("Please upload a file first.", "warn");
            return;
        }

        const payload = {
            file_id: state.fileId,
            uuid: state.videoId,
            title: (dom.title?.value || "").trim(),
            description: (dom.description?.value || "").trim(),
            // Category: always send as { name, type? }
            category: parseNameType((dom.category?.value || "").trim()),

            // Tags: array of { name, type? }
            tags: [...state.tags].map(t => parseNameType(t)),

            // Surgeons: array of { name, type? }
            surgeons: [...state.surgeons].map(s => parseNameType(s)),
        };

        if (!payload.title) {
            showStatus("Title is required.", "warn");
            dom.title?.focus();
            return;
        }

        showStatus("Saving metadata…", "info");

        try {
            const res = await fetchWithTimeout(CFG.API_METADATA, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Accept": "application/json", ...(getToken()? { Authorization: 'Bearer ' + getToken() }: {}) },
                body: JSON.stringify(payload),
            }, CFG.TIMEOUT_MS);

            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json().catch(() => ({}));
            showStatus("✅ Metadata saved.", "success");

            // Redirect to watch page if server returns a video id/slug
            const id = data.video_id || state.videoId;
            if (id) navigate(`/`);
        } catch (err) {
            console.error(err);
            showStatus("❌ Failed to save metadata.", "error");
        }
    }

    // ------------------ UI helpers ------------------
    function renderTags() {
        if (!dom.tagContainer) return;
        const frag = document.createDocumentFragment();
        if (state.tags.size === 0) {
            const muted = document.createElement("span");
            muted.className = "muted";
            muted.textContent = "No tags yet";
            frag.appendChild(muted);
        } else {
            [...state.tags].forEach((t) => {
                const chip = document.createElement("span");
                chip.className = "chip";
                chip.innerHTML = `
          <span>${escapeHtml(t)}</span>
          <button class="close" title="Remove tag" aria-label="Remove tag">&times;</button>
        `;
                chip.querySelector(".close").addEventListener("click", () => {
                    state.tags.delete(t);
                    renderTags();
                });
                frag.appendChild(chip);
            });
        }
        dom.tagContainer.replaceChildren(frag);
    }

    function renderSurgeons() {
        if (!dom.surgeonContainer) return;
        const frag = document.createDocumentFragment();
        if (state.surgeons.size === 0) {
            const muted = document.createElement("span");
            muted.className = "muted";
            muted.textContent = "No surgeons yet";
            frag.appendChild(muted);
        } else {
            [...state.surgeons].forEach((s) => {
                const chip = document.createElement("span");
                chip.className = "chip";
                chip.innerHTML = `
          <span>${escapeHtml(s)}</span>
          <button class="close" title="Remove surgeon" aria-label="Remove surgeon">&times;</button>
        `;
                chip.querySelector(".close").addEventListener("click", () => {
                    state.surgeons.delete(s);
                    renderSurgeons();
                });
                frag.appendChild(chip);
            });
        }
        dom.surgeonContainer.replaceChildren(frag);
    }

    function showStatus(msg, kind = "info") {
        if (!dom.status) return;
        dom.status.classList.remove("hidden");
        dom.status.textContent = msg;
        // color via semantic kinds
        const cls = {
            info: "text-[color:var(--text-muted)]",
            success: "text-green-600 dark:text-green-400",
            warn: "text-yellow-600 dark:text-yellow-400",
            error: "text-red-600 dark:text-red-400",
        };
        dom.status.className = `mt-2 text-sm ${cls[kind] || cls.info}`;
    }

    function toggleProgress(show) {
        if (!dom.progressWrap) return;
        dom.progressWrap.classList.toggle("hidden", !show);
    }

    function resetProgress() {
        if (!dom.progressBar) return;
        dom.progressBar.style.width = "0%";
    }

    function setProgress(pct) { if (!dom.progressBar) return; dom.progressBar.style.width = `${Math.max(0, Math.min(100, pct))}%`; }

    function sanitizeTag(s) {
        return String(s || "")
            .replace(/,/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 40);
    }

    function basename(name) {
        const n = String(name || "");
        const i = Math.max(n.lastIndexOf("/"), n.lastIndexOf("\\"));
        return i >= 0 ? n.slice(i + 1) : n;
    }

    function navigate(url) {
        try { window.location.assign(url); } catch { window.location.href = url; }
    }

    // ------------------ Networking ------------------
    async function populateDatalist(datalistEl, url, fallback = []) {
        if (!datalistEl) return;
        try {
            const res = await fetchWithTimeout(url, { headers: { Accept: "application/json" } }, 8000);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const items = Array.isArray(data) ? data : (data.items || fallback);
            fillOptions(datalistEl, items);
        } catch {
            fillOptions(datalistEl, fallback);
        }
    }

    function fillOptions(datalistEl, arr) {
        const frag = document.createDocumentFragment();
        (arr || []).forEach((v) => {
            const opt = document.createElement("option");
            let val = "";

            if (typeof v === "string") {
                val = v;
            } else if (v && typeof v === "object") {
                if (v.type) {
                    val = `${v.name || v.title || v.id || v.slug || ""} : ${v.type}`;
                } else {
                    val = v.name || v.title || v.id || v.slug || "";
                }
            }

            opt.value = val;
            frag.appendChild(opt);
        });
        datalistEl.replaceChildren(frag);
    }


    function xhrPostWithProgress(url, formData, onProgress) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open("POST", url, true);
            xhr.responseType = "json";
            const token = getToken();
            if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);

            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable && typeof onProgress === "function") {
                    const pct = (e.loaded / e.total) * 100;
                    onProgress(pct, e.loaded, e.total);
                }
            };

            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(xhr.response || tryParseJSON(xhr.responseText));
                } else {
                    reject(new Error(`HTTP ${xhr.status}`));
                }
            };

            xhr.onerror = () => reject(new Error("Network error"));
            xhr.ontimeout = () => reject(new Error("Request timeout"));
            xhr.timeout = CFG.TIMEOUT_MS;

            xhr.send(formData);
        });
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

    function tryParseJSON(t) {
        try { return JSON.parse(t); } catch { return null; }
    }

    // ------------------ Mocks ------------------
    function mockCategories() {
        return ["Retina", "Cataract", "Glaucoma", "Cornea", "Oculoplasty", "Pediatric"];
    }
    function mockTags() {
        return ["vitrectomy", "IOL", "trabeculectomy", "DMEK", "phaco", "buckling", "tips"];
    }
    function mockSurgeons() {
        return ["Dr. Rao", "Dr. Mehta", "Dr. Singh", "Dr. Chawla", "Dr. Kapoor"];
    }

    // ------------------ Missing helpers (patched) ------------------
    function escapeHtml(s) {
        return String(s)
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#039;");
    }
    function escapeAttr(s) { return String(s).replaceAll('"', "&quot;"); }

    // ------------------ Bind buttons (CSP-safe) ------------------
    function bindButtons() {
        const up = document.getElementById("uploadBtn");
        if (up) up.addEventListener("click", (e) => { e.preventDefault(); uploadFile(); });
        const save = document.getElementById("saveMetaBtn");
        if (save) save.addEventListener("click", (e) => { e.preventDefault(); submitMetadata(); });
    }

    init();
    bindButtons();
    // cancel/resume wiring
    const cancelBtn = document.getElementById("cancelUploadBtn");
    if (cancelBtn) cancelBtn.addEventListener("click", (e) => { e.preventDefault(); cancelUpload(); });
    const resumeBtn = document.getElementById("resumeUploadBtn");
    if (resumeBtn) resumeBtn.addEventListener("click", (e) => { e.preventDefault(); resumeUpload(); });
    const pauseBtn = document.getElementById("pauseUploadBtn");
    if (pauseBtn) pauseBtn.addEventListener("click", (e) => { e.preventDefault(); pauseUpload(); });
})();
