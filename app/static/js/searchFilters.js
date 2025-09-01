let currentPage = 1;
const perPage = 12;
const selectedFilters = {
    category: null,
    min_duration: null,
    max_duration: null,
    uploaded: null,
    sort: "recent"
};

// Theme toggle
document.getElementById("themeSelect").addEventListener("change", (e) => {
    const newTheme = e.target.value;
    document.body.classList.remove("dark", "light", "neon");
    document.body.classList.add(newTheme);
    localStorage.setItem("theme", newTheme);
});

// Sort bar chips
document.querySelectorAll('#sortBar .sort-chip').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('#sortBar .sort-chip').forEach(b => b.classList.remove('active-chip'));
        btn.classList.add('active-chip');
        selectedFilters.sort = btn.dataset.sort;
        applyFilters(1);
    });
});


// Sort chips
document.querySelectorAll('.sort-chip').forEach(button => {
    button.addEventListener('click', () => {
        selectedFilters.sort = button.getAttribute('data-value');

        document.querySelectorAll('.sort-chip').forEach(btn => {
            btn.classList.remove('bg-pink-600', 'scale-105', 'ring-2', 'ring-pink-500');
            btn.classList.add('bg-gray-700');
        });

        button.classList.remove('bg-gray-700');
        button.classList.add('bg-pink-600', 'scale-105', 'ring-2', 'ring-pink-500');
        applyFilters(1);
    });
});


// Duration filter chips
document.querySelectorAll('.chip-duration').forEach(button => {
    button.addEventListener('click', () => {
        selectedFilters.min_duration = button.getAttribute('data-min');
        selectedFilters.max_duration = button.getAttribute('data-max');

        document.querySelectorAll('.chip-duration').forEach(btn => {
            btn.classList.remove('bg-pink-600', 'scale-105', 'ring-2', 'ring-pink-500');
            btn.classList.add('bg-gray-700');
        });

        button.classList.remove('bg-gray-700');
        button.classList.add('bg-pink-600', 'scale-105', 'ring-2', 'ring-pink-500');
        applyFilters(1);
    });
});

// Uploaded filter chips
document.querySelectorAll('.chip-upload').forEach(button => {
    button.addEventListener('click', () => {
        selectedFilters.uploaded = button.getAttribute('data-value');

        document.querySelectorAll('.chip-upload').forEach(btn => {
            btn.classList.remove('bg-pink-600', 'scale-105', 'ring-2', 'ring-pink-500');
            btn.classList.add('bg-gray-700');
        });

        button.classList.remove('bg-gray-700');
        button.classList.add('bg-pink-600', 'scale-105', 'ring-2', 'ring-pink-500');
        applyFilters(1);
    });
});

// Category dropdown change
document.getElementById("filter-category").addEventListener("change", (e) => {
    selectedFilters.category = e.target.value;
    applyFilters(1);
});

// Pagination
document.getElementById("prevPage").addEventListener("click", () => {
    if (currentPage > 1) applyFilters(currentPage - 1);
});
document.getElementById("nextPage").addEventListener("click", () => {
    applyFilters(currentPage + 1);
});

function applyFilters(page = 1) {
    currentPage = page;
    const params = new URLSearchParams();

    const query = document.getElementById("searchInput-primary")?.value || "";
    if (query.trim()) params.append("q", query.trim());

    if (selectedFilters.category && selectedFilters.category !== "All")
        params.append("category", selectedFilters.category);

    if (selectedFilters.min_duration)
        params.append("min_duration", selectedFilters.min_duration);
    if (selectedFilters.max_duration)
        params.append("max_duration", selectedFilters.max_duration);

    if (selectedFilters.uploaded)
        params.append("uploaded", selectedFilters.uploaded);

    if (selectedFilters.sort)
        params.append("sort", selectedFilters.sort);

    params.append("page", page);
    params.append("per_page", perPage);

    fetch(`/api/v1/video/search?${params.toString()}`)
        .then(res => res.json())
        .then(data => {
            renderResults(data);
        })
        .catch(err => {
            console.error("Error applying filters:", err);
            document.getElementById("resultsContainer").innerHTML = `<p class="col-span-full text-center text-red-500">Failed to fetch videos.</p>`;
        });
}

function renderResults(data) {
    const container = document.getElementById("resultsContainer");
    container.innerHTML = "";
    const resultsInfo = document.getElementById("resultsInfo");

    if (!data.items.length) {
        resultsInfo.textContent = ``;
        container.innerHTML = `<p class="col-span-full text-center text-gray-400">No videos found.</p>`;
        return;
    }

    data.items.forEach(video => {
        const watchedPercent = video.position && video.duration
            ? Math.min(100, Math.round((video.position / video.duration) * 100))
            : 0;

        const progressBar = watchedPercent > 0
            ? `<div class="absolute bottom-0 left-0 h-1 bg-pink-500" style="width:${watchedPercent}%"></div>`
            : '';

        const card = document.createElement("div");
        card.className = "relative flex bg-gray-900 border border-gray-700 rounded-lg overflow-hidden shadow hover:ring-1 hover:ring-pink-400 transition";
        card.innerHTML = `
                <a href="/${video.uuid}" class="flex w-full no-underline text-white">
                    <div class="relative">
                        <img src="/api/v1/video/thumbnails/${video.uuid}.jpg" alt="${video.title}" class="w-72 h-42 object-cover" />
                        ${progressBar}
                    </div>
                    <div class="p-4 flex flex-col justify-between space-y-2 w-full">
                        <h2 class="text-lg font-bold truncate">${video.title}</h2>
                        <p class="text-sm text-gray-400">${video.views || 0} views • ${video.duration || "?"}</p>
                        <p class="text-sm"><span class="text-gray-400">Surgeon:</span> ${video.surgeons?.map(s => `${s.name} (${s.type})`).join(', ') || "N/A"}</p>
                        <p class="text-sm"><span class="text-gray-400">Category:</span> ${video.category?.name || "N/A"}</p>
                        ${watchedPercent > 0 ? `<p class="text-xs text-gray-400">${watchedPercent}% watched</p>` : ""}
                    </div>
                </a>`;
        container.appendChild(card);
    });

    document.getElementById("pageIndicator").textContent = `Page ${data.page}`;
    document.getElementById("prevPage").disabled = data.page <= 1;
    document.getElementById("nextPage").disabled = data.page * data.per_page >= data.total;

    const startIndex = (data.page - 1) * data.per_page + 1;
    const endIndex = Math.min(startIndex + data.items.length - 1, data.total);
    resultsInfo.textContent = `Showing ${startIndex}–${endIndex} of ${data.total} results`;
}

// Init
document.addEventListener("DOMContentLoaded", () => {
    const savedTheme = localStorage.getItem("theme");
    if (savedTheme) {
        document.body.classList.remove("dark", "light", "neon");
        document.body.classList.add(savedTheme);
        document.getElementById("themeSelect").value = savedTheme;
    }

    fetch("/api/v1/video/categories")
        .then(res => res.json())
        .then(categories => {
            const catSelect = document.getElementById("filter-category");
            categories.forEach(cat => {
                const opt = document.createElement("option");
                opt.value = cat.name;
                opt.textContent = cat.name;
                catSelect.appendChild(opt);
            });
        });

    applyFilters();
});