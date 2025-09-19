// file: static/js/forget_password.js

function $(id) { return document.getElementById(id); }

async function postJSON(url, body) {
    try {
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const j = await r.json().catch(() => ({}));
        return { ok: r.ok, status: r.status, body: j };
    } catch {
        return { ok: false, body: { msg: 'network error' } };
    }
}

function showStep(step) {
    $('step1').classList.toggle('hidden', step !== 1);
    $('step2').classList.toggle('hidden', step !== 2);
}

async function submitForgot() {
    const email = $('fp_email')?.value.trim() || '';
    const mobile = $('fp_mobile')?.value.trim() || '';
    const msgEl = $('fp_msg');
    const btn = $('fp_submit');

    // basic client validation
    if (!email && !mobile) {
        msgEl.textContent = 'Enter email or mobile.';
        msgEl.className = 'text-sm mt-2 text-red-600';
        return;
    }

    msgEl.textContent = 'Please wait...';
    msgEl.className = 'text-sm mt-2 opacity-80';
    btn?.setAttribute('disabled', 'true');

    const res = await postJSON('/video/api/v1/auth/forgot-password', { email, mobile });

    btn?.removeAttribute('disabled');
    msgEl.textContent = (res.body && res.body.msg) || (res.ok ? 'Check your inbox/SMS' : 'Error');
    msgEl.className = 'text-sm mt-2 ' + (res.ok ? 'text-green-600' : 'text-red-600');

    // prefill identifier for step 2 and advance
    const em_rp = $('rp_identifier');
    if (em_rp) em_rp.value = email || mobile;
    showStep(2);
}

async function submitReset() {
    const identifier = $('rp_identifier')?.value.trim() || '';
    const token = $('rp_token')?.value.trim() || '';
    const password = $('rp_password')?.value || '';
    const passwordConfirm = $('rp_password_confirm')?.value || '';
    const confirmMsg = $('rp_confirm_msg');
    const msgEl = $('rp_msg');
    const btn = $('rp_submit');

    // Clear previous inline errors
    confirmMsg.classList.add('hidden');

    if (!identifier || !token) {
        msgEl.textContent = 'Identifier and token are required.';
        msgEl.className = 'text-sm mt-2 text-red-600';
        return;
    }

    if (password !== passwordConfirm) {
        confirmMsg.textContent = 'Passwords do not match.';
        confirmMsg.classList.remove('hidden');
        msgEl.textContent = '';
        return;
    }

    msgEl.textContent = 'Updating...';
    msgEl.className = 'text-sm mt-2 opacity-80';
    btn?.setAttribute('disabled', 'true');

    const res = await postJSON('/video/api/v1/auth/reset-password', { email: identifier, token, password });

    btn?.removeAttribute('disabled');
    msgEl.textContent = (res.body && res.body.msg) || (res.ok ? 'Password updated' : 'Error');
    msgEl.className = 'text-sm mt-2 ' + (res.ok ? 'text-green-600' : 'text-red-600');

    if (res.ok) {
        $('rp_password').value = '';
        $('rp_password_confirm').value = '';
        showSuccessModal();
    }
}

function wireShowPassword(btnId, inputId) {
    const btn = $(btnId);
    const input = $(inputId);
    if (!btn || !input) return;
    btn.addEventListener('click', () => {
        const showing = input.type === 'text';
        input.type = showing ? 'password' : 'text';
        btn.textContent = showing ? 'Show' : 'Hide';
        btn.setAttribute('aria-pressed', (!showing).toString());
    });
}

function showSuccessModal() {
    const modal = $('successModal');
    modal.classList.remove('hidden');
    const btn = $('sm_login_btn');
    btn.focus();
    btn.addEventListener('click', () => { window.location.href = '/video/login'; });
    setTimeout(() => { window.location.href = '/video/login'; }, 3000);
}

// --- Wire up everything once DOM is parsed (defer guarantees this, but it's safe)
document.addEventListener('DOMContentLoaded', () => {
    // Form submits (CSP-safe, no inline handlers)
    const forgotForm = $('forgotForm');
    if (forgotForm) {
        forgotForm.addEventListener('submit', (e) => {
            e.preventDefault();
            submitForgot();
        });
    }

    const resetForm = $('resetForm');
    if (resetForm) {
        resetForm.addEventListener('submit', (e) => {
            e.preventDefault();
            submitReset();
        });
    }

    // Show/hide password buttons
    wireShowPassword('toggle_rp_password', 'rp_password');
    wireShowPassword('toggle_rp_password_confirm', 'rp_password_confirm');

    // Live mismatch hint
    const pwd = $('rp_password');
    const pwd2 = $('rp_password_confirm');
    const confirmMsg = $('rp_confirm_msg');
    const check = () => {
        const bad = pwd.value && pwd2.value && pwd.value !== pwd2.value;
        confirmMsg.classList.toggle('hidden', !bad);
    };
    if (pwd && pwd2) {
        pwd.addEventListener('input', check);
        pwd2.addEventListener('input', check);
    }
});
