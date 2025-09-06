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
        if (!mobile) { showError("Enter mobile number."); return; }
        if (!otp) { showError("Enter the OTP sent to your mobile."); return; }
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
    const identifierSection = document.getElementById('identifierSection');
    const passwordSection = document.getElementById('passwordSection');
    const otpSection = document.getElementById('otpSection');
    const otpInputRow = document.getElementById('otpInputRow');
    const otpField = document.getElementById('otp');
    const usernameField = document.getElementById('username');
    const passwordField = document.getElementById('password');
    const sendBtn = document.getElementById('sendOtpBtn');
    const resendRow = document.getElementById('resendRow');
    const resendBtn = document.getElementById('resendOtpBtn');
    const otpTimer = document.getElementById('otpTimer');
    const otpSentMsg = document.getElementById('otpSentMsg');
    const sendRow = document.getElementById('sendRow');
    const mobileRow = document.getElementById('mobileRow');
    const changeMobileLink = document.getElementById('changeMobileLink');
    const optionsRow = document.getElementById('optionsRow');
    const loginBtn = document.getElementById('loginBtn');
    let otpTimerId = null;
    let lastOtpMobile = '';
    if (modeRadios.length && passwordSection && otpSection) {
        const syncMode = () => {
            const current = document.querySelector('input[name="loginMode"]:checked')?.value;
            if (current === 'otp') {
                // Hide username/password; show mobile area
                if (identifierSection) identifierSection.classList.add('hidden');
                passwordSection.classList.add('hidden');
                otpSection.classList.remove('hidden');
                // Toggle required attributes appropriately
                usernameField?.removeAttribute('required');
                passwordField?.removeAttribute('required');
                otpField?.removeAttribute('required'); // will enable after Send OTP
                // reset otp ui
                otpField && (otpField.value = '');
                if (otpInputRow) otpInputRow.classList.add('hidden');
                if (resendRow) resendRow.classList.add('hidden');
                if (otpSentMsg) otpSentMsg.classList.add('hidden');
                if (changeMobileLink) changeMobileLink.classList.add('hidden');
                if (sendBtn) sendBtn.classList.remove('hidden');
                if (mobileRow) mobileRow.classList.remove('hidden');
                // Hide remember/forgot and hide Sign in until OTP sent
                optionsRow && optionsRow.classList.add('hidden');
                loginBtn && loginBtn.classList.add('hidden');
                stopOtpTimer();
            } else {
                // Password mode
                otpSection.classList.add('hidden');
                passwordSection.classList.remove('hidden');
                if (identifierSection) identifierSection.classList.remove('hidden');
                usernameField?.setAttribute('required', 'true');
                passwordField?.setAttribute('required', 'true');
                otpField?.removeAttribute('required');
                if (otpInputRow) otpInputRow.classList.add('hidden');
                if (resendRow) resendRow.classList.add('hidden');
                if (otpSentMsg) otpSentMsg.classList.add('hidden');
                if (changeMobileLink) changeMobileLink.classList.add('hidden');
                if (sendBtn) sendBtn.classList.remove('hidden');
                if (mobileRow) mobileRow.classList.remove('hidden');
                // Show remember/forgot and Sign in in password mode
                optionsRow && optionsRow.classList.remove('hidden');
                loginBtn && loginBtn.classList.remove('hidden');
                stopOtpTimer();
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

    // OTP sending logic
    function maskMobile(m) {
        if (!m) return '';
        const digits = m.replace(/\D/g, '');
        if (digits.length <= 4) return '****' + digits;
        const last4 = digits.slice(-4);
        const prefix = m.startsWith('+') ? '+' : '';
        return prefix + '******' + last4;
    }

    function formatTime(s) {
        const mm = String(Math.floor(s / 60)).padStart(2, '0');
        const ss = String(s % 60).padStart(2, '0');
        return `${mm}:${ss}`;
    }

    function stopOtpTimer() {
        if (otpTimerId) {
            clearInterval(otpTimerId);
            otpTimerId = null;
        }
        if (otpTimer) otpTimer.textContent = '00:00';
        if (resendBtn) resendBtn.disabled = true;
        if (sendBtn) sendBtn.disabled = false;
    }

    function startOtpTimer(seconds = 30) {
        if (!otpTimer) return;
        let remaining = seconds;
        otpTimer.textContent = formatTime(remaining);
        resendBtn && (resendBtn.disabled = true);
        sendBtn && (sendBtn.disabled = true);
        otpTimerId = setInterval(() => {
            remaining -= 1;
            if (remaining <= 0) {
                clearInterval(otpTimerId);
                otpTimerId = null;
                otpTimer.textContent = '00:00';
                resendBtn && (resendBtn.disabled = false);
                sendBtn && (sendBtn.disabled = false);
            } else {
                otpTimer.textContent = formatTime(remaining);
            }
        }, 1000);
    }

    async function requestOtp(forResend = false) {
        const mobile = document.getElementById('mobile')?.value.trim();
        if (!mobile) {
            alert('Enter mobile number');
            return;
        }
        (forResend ? resendBtn : sendBtn) && ((forResend ? resendBtn : sendBtn).disabled = true);
        try {
            const res = await fetch('/api/v1/auth/generate-otp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mobile })
            });
            const body = await res.json().catch(() => ({}));
            if (res.ok && body.success) {
                lastOtpMobile = mobile;
                // Show message with masked mobile
                if (otpSentMsg) {
                    otpSentMsg.textContent = `OTP sent to ${maskMobile(mobile)}. Please enter it below.`;
                    otpSentMsg.classList.remove('hidden');
                }
                // Hide mobile and send row's button, show change link
                if (mobileRow) mobileRow.classList.add('hidden');
                if (sendBtn) sendBtn.classList.add('hidden');
                if (changeMobileLink) changeMobileLink.classList.remove('hidden');
                // Reveal OTP field and make it required
                if (otpInputRow) otpInputRow.classList.remove('hidden');
                otpField?.setAttribute('required', 'true');
                // Show resend row and start timer
                if (resendRow) resendRow.classList.remove('hidden');
                // Now allow submit
                loginBtn && loginBtn.classList.remove('hidden');
                startOtpTimer(30);
            } else {
                alert(body.msg || 'Failed to send OTP');
                (forResend ? resendBtn : sendBtn) && ((forResend ? resendBtn : sendBtn).disabled = false);
            }
        } catch (e) {
            alert('Network error sending OTP');
            (forResend ? resendBtn : sendBtn) && ((forResend ? resendBtn : sendBtn).disabled = false);
        }
    }

    if (sendBtn) {
        sendBtn.addEventListener('click', async () => {
            requestOtp(false);
        });
    }

    if (resendBtn) {
        resendBtn.addEventListener('click', async () => {
            requestOtp(true);
        });
    }

    if (changeMobileLink) {
        changeMobileLink.addEventListener('click', (e) => {
            e.preventDefault();
            // Restore input state
            if (mobileRow) mobileRow.classList.remove('hidden');
            if (sendBtn) sendBtn.classList.remove('hidden');
            if (resendRow) resendRow.classList.add('hidden');
            if (otpSentMsg) otpSentMsg.classList.add('hidden');
            if (changeMobileLink) changeMobileLink.classList.add('hidden');
            if (otpInputRow) otpInputRow.classList.add('hidden');
            otpField?.removeAttribute('required');
            // Hide submit again until a new OTP is sent
            loginBtn && loginBtn.classList.add('hidden');
            stopOtpTimer();
            document.getElementById('mobile')?.focus();
        });
    }
});
