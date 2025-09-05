// Change Password page logic extracted for CSP compliance
(() => {
  const API_CHANGE = "/api/v1/user/change-password"; // adjust if backend differs
  const $ = (s, r = document) => r.querySelector(s);
  const form = $("#pwdForm");
  const currentPwd = $("#currentPwd");
  const newPwd = $("#newPwd");
  const confirmPwd = $("#confirmPwd");
  const errCurrent = $("#errCurrent");
  const errNew = $("#errNew");
  const errConfirm = $("#errConfirm");
  const formMsg = $("#formMsg");
  const btnSubmit = $("#btnSubmit");
  const btnReset = $("#btnReset");
  const strengthBar = $("#strengthBar");
  const strengthLabel = $("#strengthLabel");

  const dialog = $("#alertDialog");
  const alertTitle = $("#alertTitle");
  const alertMessage = $("#alertMessage");
  const alertClose = $("#alertClose");

  function getToken() { return localStorage.getItem("token") || ""; }
  function withAuth(opts = {}) {
    return {
      ...opts,
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        ...(opts.headers || {}),
        ...(getToken() ? { Authorization: "Bearer " + getToken() } : {}),
      },
    };
  }
  function openDialog(title, msg) {
    alertTitle.textContent = title;
    alertMessage.textContent = msg;
    dialog.classList.remove("hidden");
    dialog.classList.add("flex");
  }
  function closeDialog() {
    dialog.classList.add("hidden");
    dialog.classList.remove("flex");
  }
  if (alertClose) alertClose.addEventListener("click", closeDialog);

  function setError(el, msg) {
    el.textContent = msg || "";
    el.classList.toggle("hidden", !msg);
  }
  function clearErrors() {
    setError(errCurrent, "");
    setError(errNew, "");
    setError(errConfirm, "");
  }

  function scorePassword(pw) {
    if (!pw) return 0;
    let score = 0;
    if (pw.length >= 8) score++;
    if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
    if (/\d/.test(pw)) score++;
    if (/[^A-Za-z0-9]/.test(pw)) score++;
    if (pw.length >= 12) score++; // bonus for length
    return Math.min(score, 4);
  }
  function renderStrength(pw) {
    const s = scorePassword(pw);
    const pct = [0, 25, 50, 75, 100][s];
    strengthBar.style.width = pct + "%";
    let label = "Too weak";
    if (s === 1) label = "Weak";
    if (s === 2) label = "Fair";
    if (s === 3) label = "Strong";
    if (s === 4) label = "Very strong";
    strengthLabel.textContent = pw ? label : "—";
  }

  document.querySelectorAll("[data-toggle]").forEach((btn) => {
    const targetSel = btn.getAttribute("data-toggle");
    const input = document.querySelector(targetSel);
    btn.addEventListener("click", () => {
      if (!input) return;
      input.type = input.type === "password" ? "text" : "password";
      btn.textContent = input.type === "password" ? "Show" : "Hide";
      input.focus();
    });
  });

  newPwd.addEventListener("input", () => renderStrength(newPwd.value));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearErrors();
    const c = currentPwd.value.trim();
    const n = newPwd.value.trim();
    const k = confirmPwd.value.trim();
    let hasErr = false;
    if (!c) { setError(errCurrent, "Please enter your current password."); hasErr = true; }
    if (!n) { setError(errNew, "Please enter a new password."); hasErr = true; }
    else if (n.length < 8) { setError(errNew, "New password must be at least 8 characters."); hasErr = true; }
    if (k !== n) { setError(errConfirm, "Passwords do not match."); hasErr = true; }
    if (hasErr) { openDialog("Error", "Please fix the errors above."); return; }

    btnSubmit.disabled = true;
    try {
      const payload = { current_password: c, new_password: n };
      const res = await fetch(API_CHANGE, withAuth({ method: "PUT", body: JSON.stringify(payload) }));
      if (res.status === 401) {
        openDialog("Error", "Your session expired. Please log in again.");
        setTimeout(() => (location.href = "/login"), 900);
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        const msg = data.detail || data.message || data.error || "Could not change password.";
        if (data.field === "current_password") setError(errCurrent, msg);
        else if (data.field === "new_password") setError(errNew, msg);
        openDialog("Error", msg);
        return;
      }
      openDialog("Success", "Password updated successfully ✓");
      form.reset();
      renderStrength("");
    } catch (err) {
      console.error(err);
      openDialog("Error", "Network error. Please try again.");
    } finally {
      btnSubmit.disabled = false;
    }
  });

  btnReset.addEventListener("click", () => {
    form.reset();
    clearErrors();
    renderStrength("");
    openDialog("Info", "Enter your current password and a strong new one.");
  });

  renderStrength("");
})();
