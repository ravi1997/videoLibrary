/* ==========================================================================
   RPC Surgical Video Library — Login page logic
   Works with templates/login.html
   ========================================================================== */

async function login() {
    const username = document.getElementById("username")?.value.trim();
    const password = document.getElementById("password")?.value.trim();
    const mobile = document.getElementById("mobile")?.value.trim();
    const otp = document.getElementById("otp")?.value.trim();
    const mode = document.querySelector('input[name="loginMode"]:checked')?.value || 'password';
    const errorBox = document.getElementById("errorMsg");

    // Build payload according to chosen mode
    let payload = {};
    if (mode === 'password') {
        if (!username || !password) {
            showError("Enter username/email and password.");
            return;
        }
        payload = { identifier: username, password };
    } else { // otp mode
        if (!mobile || !otp) {
            showError("Enter mobile and OTP.");
            return;
        }
        payload = { mobile, otp };
    }

    try {
        // 1. Request login
        const res = await fetch("/api/v1/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });

        const data = await res.json();

        if (!res.ok || !data.access_token) {
            showError(data.error || "Invalid login credentials.");
            return;
        }

        // 2. Save access token & decide eventual redirect
        localStorage.setItem("token", data.access_token);
        let redirectTo = "/";
        try {
            const payloadPart = data.access_token.split('.')[1];
            const decoded = JSON.parse(atob(payloadPart.replace(/-/g,'+').replace(/_/g,'/')));
            if (decoded && decoded.pwd_change) {
                redirectTo = '/change-password';
            }
        } catch (e) { /* ignore decode errors */ }

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

    // 5. Final redirect (normal or forced password change)
    window.location.href = redirectTo;
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

// DOM bootstrap moved from inline script (CSP compliance)
document.addEventListener("DOMContentLoaded", () => {
    const form = document.querySelector('form[data-js="login-form"]');
    if (form) {
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            login();
        });
    }

    // Toggle OTP vs password UI if elements exist
    const modeRadios = document.querySelectorAll('input[name="loginMode"]');
    const passwordSection = document.getElementById('passwordSection');
    const otpSection = document.getElementById('otpSection');
    if (modeRadios.length && passwordSection && otpSection) {
        const syncMode = () => {
            const current = document.querySelector('input[name="loginMode"]:checked')?.value;
            if (current === 'otp') {
                passwordSection.classList.add('hidden');
                otpSection.classList.remove('hidden');
            } else {
                otpSection.classList.add('hidden');
                passwordSection.classList.remove('hidden');
            }
        };
        modeRadios.forEach(r => r.addEventListener('change', syncMode));
        syncMode();
    }

    const pwd = document.getElementById("password");
    const btn = document.getElementById("togglePwd");
    if (btn && pwd) {
        btn.addEventListener("click", () => {
            const show = pwd.type === "password";
            pwd.type = show ? "text" : "password";
            btn.textContent = show ? "Hide" : "Show";
            btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
            btn.setAttribute("aria-pressed", String(show));
            pwd.focus({ preventScroll: true });
        });
    }

    document.querySelectorAll(".input").forEach((el) => {
        el.addEventListener("focus", () => el.classList.add("ring-1", "ring-[color:var(--brand-600)]"));
        el.addEventListener("blur", () => el.classList.remove("ring-1", "ring-[color:var(--brand-600)]"));
    });

    window.__getRememberMe = () => !!document.getElementById("rememberMe")?.checked;
});
