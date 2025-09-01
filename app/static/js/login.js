/* ==========================================================================
   RPC Surgical Video Library — Login page logic
   Works with templates/login.html
   ========================================================================== */

async function login() {
    const username = document.getElementById("username")?.value.trim();
    const password = document.getElementById("password")?.value.trim();
    const errorBox = document.getElementById("errorMsg");

    if (!username || !password) {
        showError("Please enter both username and password.");
        return;
    }

    try {
        // 1. Request login
        const res = await fetch("/api/v1/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ identifier: username, password }),
        });

        const data = await res.json();

        if (!res.ok || !data.access_token) {
            showError(data.error || "Invalid login credentials.");
            return;
        }

        // 2. Save access token
        localStorage.setItem("token", data.access_token);

        // 3. Fetch profile
        const me = await fetch("/api/v1/auth/me", {
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${data.access_token}`,
            },
        });

        if (!me.ok) {
            showError("Failed to fetch user profile.");
            return;
        }

        const data2 = await me.json();
        const user = data2.logged_in_as;

        if (!user) {
            showError("Malformed profile response.");
            return;
        }

        // 4. Save user profile to localStorage
        localStorage.setItem(
            "user",
            JSON.stringify({
                id: user.id,
                username: user.username,
                email: user.email,
                mobile: user.mobile,
                roles: user.roles,
                is_admin: user.is_admin,
            })
        );

        console.log("✅ Logged in as:", user.username);

        // 5. Redirect to homepage
        window.location.href = "/";
    } catch (err) {
        console.error("Login error:", err);
        showError("An error occurred. Try again.");
    }

    function showError(msg) {
        if (!errorBox) return;
        errorBox.textContent = msg;
        errorBox.classList.remove("hidden");
    }
}
