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
        // Upload endpoint should accept multipart/form-data; returns { file_id, video_id, ... }
        API_UPLOAD: "/api/v1/video/upload",
        // Metadata endpoint should accept JSON body
        API_METADATA: "/api/v1/video/",
        // For datalists (optional; will be mocked if fails)
        API_CATEGORIES: "/api/v1/video/categories",
        API_TAGS: "/api/v1/video/tags",
        API_SURGEONS: "/api/v1/video/surgeons",
        TIMEOUT_MS: 60_000,
        MAX_FILE_MB: 5_000, // 5 GB safeguard; adjust if needed
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
        if (!state.file) {
            dom.input?.click();
            return;
        }
        resetProgress();
        toggleProgress(true);
        showStatus("Uploading…", "info");

        try {
            const form = new FormData();
            form.append("file", state.file);

            const json = await xhrPostWithProgress(CFG.API_UPLOAD, form, (pct) => setProgress(pct));
            // Expecting { uuid, video_id, ... }
            if (!json || (!json.uuid && !json.video_id)) {
                throw new Error("Unexpected upload response");
            }

            state.fileId = json.file_id || json.id || null;
            state.videoId = json.uuid || json.file_id || json.id || null;

            setProgress(100);
            showStatus("✅ Upload complete.", "success");

            // Reveal metadata form and prefill title from filename
            if (dom.metaForm) dom.metaForm.classList.remove("hidden");
            if (dom.title && !dom.title.value) dom.title.value = basename(state.file.name);
        } catch (err) {
            console.error(err);
            showStatus("❌ Upload failed. Please try again.", "error");
        } finally {
            toggleProgress(false); // keep bar hidden after finishing (status remains)
        }
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
                headers: { "Content-Type": "application/json", "Accept": "application/json" },
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

    function setProgress(pct) {
        if (!dom.progressBar) return;
        dom.progressBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    }

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

            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable && typeof onProgress === "function") {
                    const pct = (e.loaded / e.total) * 100;
                    onProgress(pct);
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
    function escapeAttr(s) {
        return String(s).replaceAll('"', "&quot;");
    }

    // ------------------ Expose & start ------------------
    window.uploadFile = uploadFile;
    window.submitMetadata = submitMetadata;
    init();
})();
