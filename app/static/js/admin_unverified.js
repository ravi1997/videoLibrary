/* Admin Unverified Users Page Logic (CSP compliant)
   All previous inline JS moved here to satisfy strict Content-Security-Policy.
*/
(function(){
  function authHeaders() {
    const t = localStorage.getItem('token');
    return t ? { 'Authorization': `Bearer ${t}` } : {};
  }

  async function fetchUnverified() {
    const wrap = document.getElementById('unverifiedContainer');
    if(!wrap) return;
    try {
      const res = await fetch('/api/v1/auth/unverified', {
        credentials: 'include',
        headers: { 'Accept': 'application/json', ...authHeaders() }
      });
      if (!res.ok) {
        wrap.innerHTML = '<div class="text-red-600">Failed to load users</div>';
        return;
      }
      const data = await res.json();
      wrap.innerHTML = '';
      if (!data.users.length) {
        wrap.innerHTML = '<div class="p-6 border rounded bg-green-50 dark:bg-green-900/30">All caught up — no pending users.</div>';
        return;
      }
      const tpl = document.getElementById('userRowTemplate');
      data.users.forEach(u => {
        const node = tpl.content.cloneNode(true);
        node.querySelector('.username').textContent = u.username || '(no username)';
        node.querySelector('.email').textContent = u.email || '—';
        node.querySelector('.mobile').textContent = u.mobile || '—';
        node.querySelector('.employee_id').textContent = u.employee_id || '—';
        node.querySelector('.user_type').textContent = u.user_type || '—';
        node.querySelector('.document_submitted').textContent = u.document_submitted ? 'Yes' : 'No';
        node.querySelector('.created_at').textContent = u.created_at ? new Date(u.created_at).toLocaleString() : '—';
        const verifyBtn = node.querySelector('.verifyBtn');
        verifyBtn.addEventListener('click', () => verifyUser(u.id, verifyBtn));
        const grantBtn = node.querySelector('.grantUploaderBtn');
        grantBtn.addEventListener('click', () => grantUploader(u.id, grantBtn));
        const docBtn = node.querySelector('.viewDocBtn');
        docBtn.addEventListener('click', () => viewDocument(u.id, docBtn));
        if(!u.document_submitted){
          docBtn.disabled = true;
          docBtn.title = 'No document uploaded';
        }
        const discardBtn = node.querySelector('.discardBtn');
        discardBtn.addEventListener('click', () => discardUser(u.id, discardBtn));
        wrap.appendChild(node);
      });
    } catch (e) {
      console.error(e);
      wrap.innerHTML = '<div class="text-red-600">Network error loading users</div>';
    }
  }

  async function verifyUser(id, btn) {
    btn.disabled = true;
    btn.textContent = 'Verifying...';
    try {
      const res = await fetch('/api/v1/auth/verify-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        credentials: 'include',
        body: JSON.stringify({ user_id: id })
      });
      const data = await res.json();
      if (!res.ok || data.msg !== 'verified') {
        alert(data.msg || 'Verification failed');
        btn.disabled = false;
        btn.textContent = 'Verify';
        return;
      }
      btn.textContent = 'Verified';
      btn.classList.remove('btn-primary');
      btn.classList.add('btn-success');
      setTimeout(fetchUnverified, 600);
    } catch (e) {
      console.error(e);
      alert('Network error');
      btn.disabled = false;
      btn.textContent = 'Verify';
    }
  }

  async function grantUploader(id, btn) {
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = 'Granting...';
    try {
      const res = await fetch('/api/v1/auth/grant-uploader', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        credentials: 'include',
        body: JSON.stringify({ user_id: id })
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.msg || 'Failed to grant role');
        btn.disabled = false; btn.textContent = orig;
        return;
      }
      btn.textContent = 'Granted';
      btn.classList.add('btn-success');
      btn.classList.remove('btn-ghost');
      setTimeout(() => { btn.disabled = false; }, 600);
    } catch (e) {
      console.error(e);
      alert('Network error');
      btn.disabled = false; btn.textContent = orig;
    }
  }

  async function viewDocument(id, btn){
    btn.disabled = true;
    try {
      const win = window.open(`/api/v1/auth/user-document/${id}`, '_blank');
      if(!win){ alert('Popup blocked. Allow popups to view document.'); }
    } finally {
      btn.disabled = false;
    }
  }

  async function discardUser(id, btn){
    if(!confirm('Discard this user? This cannot be undone.')) return;
    btn.disabled = true;
    btn.textContent = 'Discarding...';
    try {
      const res = await fetch('/api/v1/auth/discard-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        credentials: 'include',
        body: JSON.stringify({ user_id: id })
      });
      const data = await res.json();
      if(!res.ok){
        alert(data.msg || 'Discard failed');
        btn.disabled = false; btn.textContent='Discard';
        return;
      }
      setTimeout(fetchUnverified, 300);
    } catch(e){
      console.error(e);
      alert('Network error');
      btn.disabled = false; btn.textContent='Discard';
    }
  }

  // Expose minimal if needed for debugging (optional)
  window.__adminUnverified = { refresh: fetchUnverified };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fetchUnverified);
  } else {
    fetchUnverified();
  }
})();
