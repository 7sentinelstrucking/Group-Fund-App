/* ============================================================
   Group Fund — frontend app (vanilla JS, no build step)
   Implements the backend JSON API contract exactly as specified.
   ============================================================ */
(function () {
  'use strict';

  /* ---------- tiny helpers ---------- */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function centsToDollars(cents) {
    var n = Number(cents || 0) / 100;
    return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  }

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  function fmtMonth(key) {
    // '2026-10' -> "Oct '26"
    var parts = String(key).split('-');
    if (parts.length !== 2) return esc(key);
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, 1);
    if (isNaN(d.getTime())) return esc(key);
    return d.toLocaleString('en-US', { month: 'short' }) + " '" + String(d.getFullYear()).slice(2);
  }

  async function api(path, opts) {
    opts = opts || {};
    var fetchOpts = {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' }
    };
    if (opts.body !== undefined) fetchOpts.body = JSON.stringify(opts.body);
    var res;
    try {
      res = await fetch(path, fetchOpts);
    } catch (e) {
      throw new Error('Network error — check your connection and try again.');
    }
    var data = null;
    try { data = await res.json(); } catch (e) { /* non-JSON body */ }
    if (!res.ok) {
      var msg = (data && data.error) ? data.error : ('Request failed (HTTP ' + res.status + ')');
      var err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return data || {};
  }

  async function apiForm(path, formData) {
    var res;
    try {
      res = await fetch(path, { method: 'POST', body: formData });
    } catch (e) {
      throw new Error('Network error — check your connection and try again.');
    }
    var data = null;
    try { data = await res.json(); } catch (e) { /* non-JSON body */ }
    if (!res.ok) {
      var msg = (data && data.error) ? data.error : ('Upload failed (HTTP ' + res.status + ')');
      var err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return data || {};
  }

  /* ---------- toast ---------- */
  var toastTimer = null;
  function toast(msg) {
    var el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 3200);
  }

  /* ---------- button busy state ---------- */
  function setBusy(btn, busy, busyLabel) {
    if (!btn) return;
    if (busy) {
      btn.dataset.label = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = esc(busyLabel || 'Working…');
    } else {
      btn.disabled = false;
      if (btn.dataset.label !== undefined) btn.innerHTML = btn.dataset.label;
    }
  }

  function formError(form, msg) {
    var box = form.querySelector('.form-error');
    if (!box) return;
    box.textContent = msg;
    box.classList.add('show');
  }

  function clearFormError(form) {
    var box = form.querySelector('.form-error');
    if (box) box.classList.remove('show');
  }

  /* ---------- app state ---------- */
  var status = { adminExists: false, fundConfigured: false, session: null };
  var navEl = document.getElementById('nav');
  var viewEl = document.getElementById('view');

  async function refreshStatus() {
    try {
      status = await api('/api/status');
    } catch (e) {
      toast('Could not reach the server. Retrying…');
      throw e;
    }
    renderNav();
  }

  function isUser() { return status.session && status.session.type === 'user'; }
  function isAdmin() { return status.session && status.session.type === 'admin'; }

  /* ---------- shared HTML fragments ---------- */

  function avatarHtml(url, name, size) {
    var sm = size === 'sm';
    var initial = (name || '?').trim().charAt(0).toUpperCase() || '?';
    var inner = url
      ? '<img class="avatar' + (sm ? ' avatar-sm' : '') + '" src="' + esc(url) + '" alt="' + esc(name || 'avatar') + '">'
      : '<span class="avatar avatar-fallback' + (sm ? ' avatar-sm' : '') + '" aria-hidden="true">' + esc(initial) + '</span>';
    return '<span class="avatar-wrap' + (sm ? ' sm' : '') + '">' + inner + '</span>';
  }

  function avatarWithDot(url, name, paidInFull, size) {
    var sm = size === 'sm';
    var initial = (name || '?').trim().charAt(0).toUpperCase() || '?';
    var inner = url
      ? '<img class="avatar' + (sm ? ' avatar-sm' : '') + '" src="' + esc(url) + '" alt="' + esc(name || 'avatar') + '">'
      : '<span class="avatar avatar-fallback' + (sm ? ' avatar-sm' : '') + '" aria-hidden="true">' + esc(initial) + '</span>';
    var dot = paidInFull ? '<span class="green-dot" title="Share paid in full"></span>' : '';
    return '<span class="avatar-wrap' + (sm ? ' sm' : '') + '">' + inner + dot + '</span>';
  }

  function progressBar(pct, label) {
    pct = Math.max(0, Math.min(100, Number(pct) || 0));
    return '<div class="progress" role="progressbar" aria-valuenow="' + pct.toFixed(1) +
      '" aria-valuemin="0" aria-valuemax="100" aria-label="' + esc(label || 'progress') + '">' +
      '<div class="progress-fill" data-pct="' + pct.toFixed(1) + '" style="width:0"></div></div>';
  }

  function animateBars(root) {
    var fills = (root || document).querySelectorAll('.progress-fill[data-pct]');
    // force first paint at 0, then transition to target
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        fills.forEach(function (f) { f.style.width = f.getAttribute('data-pct') + '%'; });
      });
    });
  }

  /* ---------- header nav ---------- */

  function renderNav() {
    var s = status.session;
    if (!s) {
      navEl.innerHTML =
        '<a class="btn btn-ghost btn-sm" href="#/login">Login</a>' +
        '<a class="btn btn-green btn-sm" href="#/register">Register</a>';
      return;
    }
    var name = esc(s.name || (s.type === 'admin' ? 'Admin' : 'Member'));
    var dashLink = s.type === 'admin'
      ? '<a class="btn btn-ghost btn-sm" href="#/admin">Admin panel</a>'
      : '<a class="btn btn-ghost btn-sm" href="#/dashboard">Dashboard</a>';
    navEl.innerHTML =
      '<span class="whoami">' + avatarHtml(s.avatarUrl, s.name, 'sm') +
      '<span>' + name + '</span></span>' +
      dashLink +
      '<button class="btn btn-ghost btn-sm" id="nav-logout" type="button">Logout</button>';
    var btn = document.getElementById('nav-logout');
    if (btn) btn.addEventListener('click', doLogout);
  }

  async function doLogout() {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) { /* still log out locally */ }
    await refreshStatus();
    location.hash = '#/';
    toast('Logged out. See you soon! 👋');
  }

  /* ---------- router ---------- */

  var routes = ['/', '/register', '/login', '/admin-claim', '/admin-setup', '/dashboard', '/admin'];

  function currentRoute() {
    var h = location.hash.replace(/^#/, '') || '/';
    return routes.indexOf(h) !== -1 ? h : '/';
  }

  async function route() {
    var r = currentRoute();
    window.scrollTo(0, 0);
    if (r === '/') return renderHome();
    if (r === '/register') {
      if (isUser()) { location.hash = '#/dashboard'; return; }
      if (isAdmin()) { location.hash = '#/admin'; return; }
      return renderRegister();
    }
    if (r === '/login') {
      if (isUser()) { location.hash = '#/dashboard'; return; }
      if (isAdmin()) { location.hash = '#/admin'; return; }
      return renderLogin();
    }
    if (r === '/admin-claim') return renderAdminClaim();
    if (r === '/admin-setup') {
      if (!isAdmin()) { toast('Admins only — please log in as admin.'); location.hash = '#/login'; return; }
      return renderAdminSetup();
    }
    if (r === '/dashboard') {
      if (isAdmin()) { location.hash = '#/admin'; return; }
      if (!isUser()) { toast('Please log in to see your dashboard.'); location.hash = '#/login'; return; }
      return renderDashboard();
    }
    if (r === '/admin') {
      if (!isAdmin()) { toast('Admins only — please log in as admin.'); location.hash = '#/login'; return; }
      if (isUser()) { location.hash = '#/dashboard'; return; }
      return renderAdminPanel();
    }
  }

  /* ============================================================
     VIEW 1 — Home (public fund page)
     ============================================================ */
  async function renderHome() {
    viewEl.innerHTML =
      '<div class="card"><div class="skeleton" style="height:120px"></div></div>' +
      '<div class="card"><div class="skeleton" style="height:180px"></div></div>';

    var fundData = null, ledgerData = null, boardData = null;
    try {
      var results = await Promise.all([
        api('/api/fund'),
        api('/api/ledger?limit=50'),
        api('/api/scoreboard')
      ]);
      fundData = results[0]; ledgerData = results[1]; boardData = results[2];
    } catch (e) {
      viewEl.innerHTML = '<div class="card"><div class="empty-state"><span class="big">📡</span>' +
        'Could not load the fund page.<br>' + esc(e.message) +
        '<div class="mt"><button class="btn btn-blue" id="retry-home" type="button">Try again</button></div></div></div>';
      var rb = document.getElementById('retry-home');
      if (rb) rb.addEventListener('click', renderHome);
      return;
    }

    var html = '';

    /* claim-admin banner for a fresh install */
    if (!status.adminExists) {
      html += '<div class="card center" style="--card-stripe: linear-gradient(90deg,#f59e0b,#ec4899)">' +
        '<h2>🎉 This fund is brand new!</h2>' +
        '<p>Be the first to claim the admin seat and set up the fund.</p>' +
        '<a class="btn btn-amber btn-block" href="#/admin-claim">Claim admin seat</a></div>';
    }

    var fund = fundData.fund;
    if (!fund) {
      html += '<div class="card center"><div class="empty-state"><span class="big">🏗️</span>' +
        'The fund has not been set up yet.</div>';
      if (isAdmin()) {
        html += '<p class="muted">As the admin, complete the setup to get started.</p>' +
          '<a class="btn btn-green" href="#/admin-setup">Complete fund setup</a>';
      } else {
        html += '<p class="muted">Check back soon!</p>';
      }
      html += '</div>';
    } else {
      var pct = fund.goalCents > 0 ? (fundData.totalCents / fund.goalCents) * 100 : 0;
      html += '<section class="card hero" aria-label="Fund summary">' +
        '<h2 class="fund-name">' + esc(fund.name) + '</h2>' +
        '<p class="fund-goal">Goal: ' + centsToDollars(fund.goalCents) + '</p>' +
        '<div class="fund-total">' + centsToDollars(fundData.totalCents) + '</div>' +
        '<div class="muted" style="font-weight:700">raised of ' + centsToDollars(fund.goalCents) + ' goal</div>' +
        '<div class="mt">' + progressBar(pct, 'Fund progress') + '</div>' +
        '<div class="progress-labels"><span>' + pct.toFixed(1) + '% funded</span>' +
        '<span>' + (fundData.paymentCount || 0) + ' payments</span></div>' +
        '<div class="fund-meta">' +
          '<span class="pill-stat">👥 ' + (fundData.contributors ? fundData.contributors.length : 0) +
            ' / ' + fund.numContributors + ' contributors</span>' +
          '<span class="pill-stat">💵 ' + centsToDollars(fund.monthlyCents) + ' / month</span>' +
          '<span class="pill-stat">📅 Due day ' + fund.dueDay + '</span>' +
        '</div></section>';

      /* contributors grid */
      var contribs = fundData.contributors || [];
      html += '<section class="card"><h2>Contributors</h2>';
      if (!contribs.length) {
        html += '<div class="empty-state"><span class="big">👋</span>No contributors yet — be the first to join!</div>' +
          '<div class="center"><a class="btn btn-green" href="#/register">Register to contribute</a></div>';
      } else {
        html += '<div class="contrib-grid">';
        contribs.forEach(function (c, i) {
          var hue = (i * 47) % 360;
          var share = c.shareCents || 0;
          var cpct = share > 0 ? (c.totalCents / share) * 100 : 0;
          html += '<div class="contrib-card" style="--accent:hsl(' + hue + ',70%,55%)">' +
            avatarWithDot(c.avatarUrl, c.name, !!c.paidInFull) +
            '<div class="cname">' + esc(c.name) + '</div>' +
            '<div class="cbar">' + progressBar(Math.min(100, cpct), c.name + ' progress') + '</div>' +
            '<div class="camounts">' + centsToDollars(c.totalCents) + ' paid of ' +
              centsToDollars(share) + ' share</div>' +
            (c.paidInFull ? '<span class="cfull">✓ Paid in full</span>' : '') +
          '</div>';
        });
        html += '</div>';
      }
      html += '</section>';

      /* scoreboard */
      html += scoreboardHtml(boardData);

      /* ledger */
      html += '<section class="card"><h2>Recent payments</h2>';
      var payments = (ledgerData && ledgerData.payments) || [];
      if (!payments.length) {
        html += '<div class="empty-state"><span class="big">🧾</span>No payments recorded yet.</div>';
      } else {
        html += '<ul class="ledger-list">';
        payments.forEach(function (p) {
          html += '<li class="ledger-item">' +
            avatarHtml(p.avatarUrl, p.userName, 'sm') +
            '<div><div class="lname">' + esc(p.userName) + '</div>' +
            '<div class="ldate">' + esc(fmtDate(p.createdAt)) + '</div></div>' +
            '<div class="lamt">' + centsToDollars(p.amountCents) + '</div></li>';
        });
        html += '</ul>';
      }
      html += '</section>';
    }

    viewEl.innerHTML = html;
    animateBars(viewEl);
  }

  function scoreboardHtml(boardData) {
    var html = '<section class="card"><h2>Monthly scoreboard</h2>';
    var months = (boardData && boardData.months) || [];
    var rows = (boardData && boardData.rows) || [];
    if (!months.length || !rows.length) {
      html += '<div class="empty-state"><span class="big">📊</span>The scoreboard will appear once payments start rolling in.</div></section>';
      return html;
    }
    var sorted = months.slice().sort();
    html += '<div class="table-scroll"><table class="scoreboard"><thead><tr><th>Contributor</th>';
    sorted.forEach(function (m) { html += '<th>' + fmtMonth(m) + '</th>'; });
    html += '</tr></thead><tbody>';
    rows.forEach(function (row) {
      html += '<tr><td><span class="row" style="gap:8px">' +
        avatarHtml(row.avatarUrl, row.userName, 'sm') + esc(row.userName) + '</span></td>';
      sorted.forEach(function (m) {
        var v = row.cells ? row.cells[m] : undefined;
        var pill;
        if (v === 'paid') pill = '<span class="cell-pill cell-paid">Paid</span>';
        else if (v === 'late') pill = '<span class="cell-pill cell-late">Late</span>';
        else pill = '<span class="cell-pill cell-missed">—</span>';
        html += '<td>' + pill + '</td>';
      });
      html += '</tr>';
    });
    html += '</tbody></table></div>';
    html += '<div class="legend">' +
      '<span><span class="cell-pill cell-paid">Paid</span> on time</span>' +
      '<span><span class="cell-pill cell-late">Late</span> paid late</span>' +
      '<span><span class="cell-pill cell-missed">—</span> missed</span></div>';
    html += '</section>';
    return html;
  }

  /* ============================================================
     VIEW 2 — Register
     ============================================================ */
  function renderRegister() {
    viewEl.innerHTML =
      '<div class="card"><h2>Join the fund 🙌</h2>' +
      '<p class="muted">Create your contributor account. You can upload an avatar and start chipping in right away.</p>' +
      '<form id="register-form" novalidate>' +
      '<div class="form-error" role="alert"></div>' +
      '<div class="field"><label for="r-name">Your name</label>' +
      '<input id="r-name" name="name" type="text" autocomplete="name" required maxlength="80" placeholder="e.g. Alex Carter"></div>' +
      '<div class="field"><label for="r-email">Email</label>' +
      '<input id="r-email" name="email" type="email" autocomplete="email" required maxlength="120" placeholder="you@example.com"></div>' +
      '<div class="field"><label for="r-phone">Phone</label>' +
      '<input id="r-phone" name="phone" type="tel" autocomplete="tel" maxlength="30" placeholder="(555) 123-4567"></div>' +
      '<div class="field"><label for="r-pass">Password</label>' +
      '<input id="r-pass" name="password" type="password" autocomplete="new-password" required minlength="4" placeholder="Choose a password"></div>' +
      '<button class="btn btn-green btn-block" type="submit" id="r-submit">Create account</button>' +
      '</form>' +
      '<p class="center muted">Already registered? <a href="#/login">Log in</a></p></div>';

    var form = document.getElementById('register-form');
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      clearFormError(form);
      var name = form.name.value.trim();
      var email = form.email.value.trim();
      var phone = form.phone.value.trim();
      var password = form.password.value;
      if (!name || !email || !password) { formError(form, 'Please fill in your name, email, and password.'); return; }
      var btn = document.getElementById('r-submit');
      setBusy(btn, true, 'Creating…');
      try {
        await api('/api/users/register', { method: 'POST', body: { name: name, email: email, phone: phone, password: password } });
        await refreshStatus();
        toast('Welcome aboard, ' + name + '! 🎉');
        location.hash = '#/dashboard';
      } catch (err) {
        formError(form, err.message);
        setBusy(btn, false);
      }
    });
  }

  /* ============================================================
     VIEW 3 — Login (contributor + admin tabs)
     ============================================================ */
  function renderLogin() {
    viewEl.innerHTML =
      '<div class="card"><h2>Log in 🔑</h2>' +
      '<div class="row" role="tablist" aria-label="Login type">' +
      '<button class="btn btn-blue btn-sm" id="tab-user" type="button" role="tab" aria-selected="true">Contributor</button>' +
      '<button class="btn btn-ghost btn-sm" id="tab-admin" type="button" role="tab" aria-selected="false">Admin</button>' +
      '</div>' +
      '<form id="login-form" novalidate class="mt">' +
      '<div class="form-error" role="alert"></div>' +
      '<div class="field"><label for="l-email">Email</label>' +
      '<input id="l-email" type="email" autocomplete="email" required placeholder="you@example.com"></div>' +
      '<div class="field"><label for="l-pass">Password</label>' +
      '<input id="l-pass" type="password" autocomplete="current-password" required placeholder="Your password"></div>' +
      '<button class="btn btn-blue btn-block" type="submit" id="l-submit">Log in as contributor</button>' +
      '</form>' +
      '<p class="center muted">New here? <a href="#/register">Create an account</a></p></div>';

    var mode = 'user';
    var tabUser = document.getElementById('tab-user');
    var tabAdmin = document.getElementById('tab-admin');
    var submit = document.getElementById('l-submit');
    var form = document.getElementById('login-form');

    function setMode(m) {
      mode = m;
      var userActive = m === 'user';
      tabUser.className = 'btn btn-sm ' + (userActive ? 'btn-blue' : 'btn-ghost');
      tabAdmin.className = 'btn btn-sm ' + (userActive ? 'btn-ghost' : 'btn-blue');
      tabUser.setAttribute('aria-selected', String(userActive));
      tabAdmin.setAttribute('aria-selected', String(!userActive));
      submit.textContent = userActive ? 'Log in as contributor' : 'Log in as admin';
    }
    tabUser.addEventListener('click', function () { setMode('user'); });
    tabAdmin.addEventListener('click', function () { setMode('admin'); });

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      clearFormError(form);
      var email = document.getElementById('l-email').value.trim();
      var password = document.getElementById('l-pass').value;
      if (!email || !password) { formError(form, 'Enter your email and password.'); return; }
      setBusy(submit, true, 'Logging in…');
      try {
        var path = mode === 'admin' ? '/api/admin/login' : '/api/users/login';
        await api(path, { method: 'POST', body: { email: email, password: password } });
        await refreshStatus();
        toast(mode === 'admin' ? 'Welcome back, admin! 🛠️' : 'Welcome back! 👋');
        location.hash = mode === 'admin' ? '#/admin' : '#/dashboard';
      } catch (err) {
        formError(form, err.message);
        setBusy(submit, false);
      }
    });
  }

  /* ============================================================
     VIEW 4 — Admin claim
     ============================================================ */
  function renderAdminClaim() {
    if (status.adminExists) {
      viewEl.innerHTML = '<div class="card center"><div class="empty-state"><span class="big">🔒</span>' +
        '<strong>The admin seat is already claimed.</strong><br>' +
        '<span class="muted">Only one admin per fund — this seat is taken for good.</span></div>' +
        '<a class="btn btn-blue" href="#/">Back to fund page</a></div>';
      return;
    }
    viewEl.innerHTML =
      '<div class="card" style="--card-stripe: linear-gradient(90deg,#f59e0b,#ec4899)">' +
      '<h2>Claim the admin seat 👑</h2>' +
      '<p class="muted">The first person to claim becomes the fund\'s <strong>permanent</strong> admin. ' +
      'After this, the seat locks forever and this link becomes contributor-only.</p>' +
      '<form id="claim-form" novalidate>' +
      '<div class="form-error" role="alert"></div>' +
      '<div class="field"><label for="c-name">Your name</label>' +
      '<input id="c-name" type="text" autocomplete="name" required maxlength="80" placeholder="e.g. Alex Carter"></div>' +
      '<div class="field"><label for="c-email">Email</label>' +
      '<input id="c-email" type="email" autocomplete="email" required maxlength="120" placeholder="you@example.com"></div>' +
      '<div class="field"><label for="c-phone">Phone</label>' +
      '<input id="c-phone" type="tel" autocomplete="tel" maxlength="30" placeholder="(555) 123-4567"></div>' +
      '<div class="field"><label for="c-pass">Password</label>' +
      '<input id="c-pass" type="password" autocomplete="new-password" required minlength="4" placeholder="Choose a strong password"></div>' +
      '<button class="btn btn-amber btn-block" type="submit" id="c-submit">Claim admin seat</button>' +
      '</form></div>';

    var form = document.getElementById('claim-form');
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      clearFormError(form);
      var name = document.getElementById('c-name').value.trim();
      var email = document.getElementById('c-email').value.trim();
      var phone = document.getElementById('c-phone').value.trim();
      var password = document.getElementById('c-pass').value;
      if (!name || !email || !password) { formError(form, 'Please fill in your name, email, and password.'); return; }
      var btn = document.getElementById('c-submit');
      setBusy(btn, true, 'Claiming…');
      try {
        await api('/api/admin/claim', { method: 'POST', body: { name: name, email: email, phone: phone, password: password } });
        await refreshStatus();
        toast('Admin seat claimed! Now set up your fund. 👑');
        location.hash = '#/admin-setup';
      } catch (err) {
        formError(form, err.message);
        setBusy(btn, false);
      }
    });
  }

  /* ============================================================
     VIEW 5 — Admin setup
     ============================================================ */
  async function renderAdminSetup() {
    viewEl.innerHTML = '<div class="card"><div class="skeleton" style="height:320px"></div></div>';
    var existing = null;
    try {
      var fd = await api('/api/fund');
      existing = fd.fund;
    } catch (e) { /* fall through; empty form */ }

    function val(v, dflt) { return v !== null && v !== undefined && v !== '' ? esc(v) : (dflt || ''); }

    viewEl.innerHTML =
      '<div class="card"><h2>' + (existing ? 'Edit fund settings ⚙️' : 'Set up your fund 🛠️') + '</h2>' +
      '<p class="muted">Define the goal, the monthly rhythm, and where the money goes.</p>' +
      '<form id="setup-form" novalidate>' +
      '<div class="form-error" role="alert"></div>' +
      '<div class="field"><label for="s-name">Fund name</label>' +
      '<input id="s-name" type="text" required maxlength="120" placeholder="e.g. New Orleans Trip Fund" value="' + val(existing && existing.name) + '"></div>' +
      '<div class="field"><label for="s-goal">Goal (dollars)</label>' +
      '<input id="s-goal" type="number" min="1" step="0.01" required placeholder="6000" value="' + val(existing && (existing.goalCents / 100)) + '">' +
      '<div class="hint">Total amount the group is raising.</div></div>' +
      '<div class="field"><label for="s-num">Number of contributors</label>' +
      '<input id="s-num" type="number" min="1" step="1" required placeholder="8" value="' + val(existing && existing.numContributors) + '"></div>' +
      '<div class="field"><label for="s-monthly">Monthly amount per contributor (dollars)</label>' +
      '<input id="s-monthly" type="number" min="0.01" step="0.01" required placeholder="62.50" value="' + val(existing && (existing.monthlyCents / 100)) + '"></div>' +
      '<div class="field"><label for="s-dueday">Monthly due day (1–28)</label>' +
      '<input id="s-dueday" type="number" min="1" max="28" step="1" required placeholder="1" value="' + val(existing && existing.dueDay, '1') + '"></div>' +
      '<h3>PayPal (money goes straight to your account)</h3>' +
      '<div class="field"><label for="s-mode">PayPal mode</label>' +
      '<select id="s-mode"><option value="sandbox" selected>Sandbox (test money)</option><option value="live">Live (real money)</option></select>' +
      '<div class="hint">Start with Sandbox to test. Switch to Live when ready for real payments.</div></div>' +
      '<div class="field"><label for="s-cid">PayPal Client ID</label>' +
      '<input id="s-cid" type="text" autocomplete="off" spellcheck="false" placeholder="From your PayPal Business app" value="' + val(existing && existing.paypalClientId) + '">' +
      '<div class="hint">From your PayPal Business dashboard (Developer → Apps).</div></div>' +
      '<div class="field"><label for="s-secret">PayPal Secret</label>' +
      '<input id="s-secret" type="password" autocomplete="new-password" placeholder="Stored server-side, never shown">' +
      '<div class="hint">Real credentials entered here are stored server-side only — they are never sent to browsers.</div></div>' +
      '<button class="btn btn-green btn-block" type="submit" id="s-submit">Save fund settings</button>' +
      '</form></div>';

    var form = document.getElementById('setup-form');
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      clearFormError(form);
      var fundName = document.getElementById('s-name').value.trim();
      var goalDollars = parseFloat(document.getElementById('s-goal').value);
      var numContributors = parseInt(document.getElementById('s-num').value, 10);
      var monthlyDollars = parseFloat(document.getElementById('s-monthly').value);
      var dueDay = parseInt(document.getElementById('s-dueday').value, 10);
      var paypalClientId = document.getElementById('s-cid').value.trim();
      var paypalSecret = document.getElementById('s-secret').value;
      var paypalMode = document.getElementById('s-mode').value;
      if (!fundName) { formError(form, 'Give your fund a name.'); return; }
      if (!(goalDollars > 0)) { formError(form, 'Enter a goal amount greater than zero.'); return; }
      if (!(numContributors >= 1)) { formError(form, 'Number of contributors must be at least 1.'); return; }
      if (!(monthlyDollars > 0)) { formError(form, 'Enter a monthly amount greater than zero.'); return; }
      if (!(dueDay >= 1 && dueDay <= 28)) { formError(form, 'Due day must be between 1 and 28.'); return; }
      var btn = document.getElementById('s-submit');
      setBusy(btn, true, 'Saving…');
      try {
        await api('/api/admin/setup', {
          method: 'POST',
          body: {
            fundName: fundName,
            goalDollars: goalDollars,
            numContributors: numContributors,
            monthlyDollars: monthlyDollars,
            dueDay: dueDay,
            paypalClientId: paypalClientId,
            paypalSecret: paypalSecret,
            paypalMode: paypalMode
          }
        });
        await refreshStatus();
        toast('Fund settings saved! 🎉');
        location.hash = '#/admin';
      } catch (err) {
        formError(form, err.message);
        setBusy(btn, false);
      }
    });
  }

  /* ============================================================
     VIEW 6 — Dashboard (contributor)
     ============================================================ */

  var paypalSdkPromise = null;
  function loadPaypalSdk(clientId) {
    if (window.paypal) return Promise.resolve();
    if (paypalSdkPromise) return paypalSdkPromise;
    paypalSdkPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://www.paypal.com/sdk/js?client-id=' + encodeURIComponent(clientId) + '&currency=USD';
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('PayPal SDK failed to load. Check your connection and try again.')); };
      document.head.appendChild(s);
    });
    return paypalSdkPromise;
  }

  async function renderDashboard() {
    viewEl.innerHTML = '<div class="card"><div class="skeleton" style="height:200px"></div></div>' +
      '<div class="card"><div class="skeleton" style="height:160px"></div></div>';

    var fundData, payCfg;
    try {
      var results = await Promise.all([api('/api/fund'), api('/api/pay/config')]);
      fundData = results[0]; payCfg = results[1];
    } catch (e) {
      viewEl.innerHTML = '<div class="card"><div class="empty-state"><span class="big">📡</span>' +
        'Could not load your dashboard.<br>' + esc(e.message) +
        '<div class="mt"><button class="btn btn-blue" id="retry-dash" type="button">Try again</button></div></div></div>';
      var rb = document.getElementById('retry-dash');
      if (rb) rb.addEventListener('click', renderDashboard);
      return;
    }

    var me = null;
    (fundData.contributors || []).forEach(function (c) {
      if (status.session && c.id === status.session.id) me = c;
    });
    var myTotal = me ? me.totalCents : 0;
    var myShare = me ? me.shareCents : 0;
    var myPct = myShare > 0 ? (myTotal / myShare) * 100 : 0;
    var full = !!(me && me.paidInFull);
    var fund = fundData.fund;
    var myName = status.session ? status.session.name : 'Member';

    var html = '';

    /* my progress card */
    html += '<section class="card" aria-label="My progress">' +
      '<h2>My progress 💪</h2>' +
      '<div class="row"><div style="flex:1;min-width:0">' +
      '<div style="font-size:1.6rem;font-weight:900">' + centsToDollars(myTotal) + '</div>' +
      '<div class="muted" style="font-weight:700">paid of ' + centsToDollars(myShare) + ' share</div>' +
      '</div>' +
      (full ? '<span class="cell-pill cell-paid" style="font-size:.9rem">✓ Paid in full</span>' : '') +
      '</div>' +
      '<div class="mt">' + progressBar(Math.min(100, myPct), 'My contribution progress') + '</div>' +
      '<div class="progress-labels"><span>' + myPct.toFixed(1) + '% of my share</span>' +
      (fund ? '<span>Fund: ' + esc(fund.name) + '</span>' : '') + '</div>' +
      '</section>';

    /* avatar card */
    var curAvatar = status.session ? status.session.avatarUrl : null;
    html += '<section class="card" aria-label="My avatar">' +
      '<h2>My avatar 😎</h2>' +
      '<div class="big-avatar-row">' +
      '<span id="avatar-preview">' + avatarWithDot(curAvatar, myName, full) + '</span>' +
      '<div><div class="muted">Pick a photo — it shows next to your name everywhere. ' +
      (full ? 'That glowing green dot means your share is fully paid. ✨' : 'Pay your full share to earn the glowing green dot. ✨') +
      '</div></div></div>' +
      '<div class="field"><label for="avatar-file">Upload a new avatar</label>' +
      '<input class="file-input" id="avatar-file" type="file" accept="image/*">' +
      '<div class="hint" id="avatar-hint">JPG, PNG, GIF or WebP.</div></div>' +
      '</section>';

    /* pay section */
    var suggested = fund ? (fund.monthlyCents / 100) : '';
    html += '<section class="card" aria-label="Make a payment"><h2>Chip in 💸</h2>';
    if (payCfg.demoMode) {
      html += '<div class="demo-banner">🧪 DEMO MODE — no real money moves</div>';
    }
    html += '<div class="pay-amount-row"><div class="field"><label for="pay-amount">Amount (USD)</label>' +
      '<input id="pay-amount" type="number" min="0.01" step="0.01" inputmode="decimal" placeholder="25.00"' +
      (suggested !== '' ? ' value="' + esc(String(suggested)) + '"' : '') + '></div></div>' +
      '<div class="muted" id="pay-status" style="min-height:1.4em;margin:8px 0"></div>';
    if (payCfg.demoMode) {
      html += '<button class="btn btn-amber btn-block" id="demo-pay" type="button">🧪 Demo Pay (no real money)</button>';
    } else {
      html += '<div id="paypal-buttons"></div>' +
        '<p class="muted" style="font-size:.82rem">Secure checkout by PayPal — pay as a guest with any card, no PayPal account needed. ' +
        'Money goes straight to the admin\'s PayPal.</p>';
    }
    html += '</section>';

    viewEl.innerHTML = html;
    animateBars(viewEl);

    /* avatar upload wiring */
    var fileInput = document.getElementById('avatar-file');
    var hintEl = document.getElementById('avatar-hint');
    fileInput.addEventListener('change', async function () {
      var file = fileInput.files && fileInput.files[0];
      if (!file) return;
      hintEl.textContent = 'Uploading… ⏳';
      var fd = new FormData();
      fd.append('avatar', file);
      try {
        var r = await apiForm('/api/users/avatar', fd);
        if (status.session) status.session.avatarUrl = r.avatarUrl;
        renderNav();
        var preview = document.getElementById('avatar-preview');
        if (preview) preview.innerHTML = avatarWithDot(r.avatarUrl, myName, full);
        hintEl.textContent = 'Avatar updated! 🎉';
        toast('Avatar updated! 🎉');
      } catch (err) {
        hintEl.textContent = 'JPG, PNG, GIF or WebP.';
        toast(err.message);
      }
      fileInput.value = '';
    });

    /* payment wiring */
    function readAmount() {
      var raw = document.getElementById('pay-amount').value;
      var amt = parseFloat(raw);
      return (isFinite(amt) && amt > 0) ? amt : null;
    }
    function setPayStatus(msg) {
      var el = document.getElementById('pay-status');
      if (el) el.textContent = msg;
    }
    async function afterPayment(amountCents) {
      toast('Payment received: ' + centsToDollars(amountCents) + ' 🎉');
      await refreshStatus();
      renderDashboard();
    }

    if (payCfg.demoMode) {
      var demoBtn = document.getElementById('demo-pay');
      demoBtn.addEventListener('click', async function () {
        var amt = readAmount();
        if (amt == null) { setPayStatus('Enter an amount greater than $0 first.'); return; }
        setBusy(demoBtn, true, 'Processing demo payment…');
        setPayStatus('Creating demo order…');
        try {
          var o = await api('/api/pay/create-order', { method: 'POST', body: { amountDollars: amt } });
          setPayStatus('Capturing demo order…');
          var c = await api('/api/pay/capture-order', { method: 'POST', body: { orderId: o.orderId } });
          setPayStatus('');
          await afterPayment(c.amountCents);
        } catch (err) {
          setPayStatus('');
          setBusy(demoBtn, false);
          toast(err.message);
        }
      });
    } else {
      var clientId = payCfg.paypalClientId;
      if (!clientId) {
        setPayStatus('PayPal is not connected yet — the admin needs to add PayPal credentials in fund setup.');
        return;
      }
      setPayStatus('Loading secure PayPal checkout…');
      loadPaypalSdk(clientId).then(function () {
        setPayStatus('');
        if (!window.paypal || !window.paypal.Buttons) {
          setPayStatus('PayPal checkout could not start. Please try again later.');
          return;
        }
        window.paypal.Buttons({
          style: { layout: 'vertical', shape: 'pill', label: 'paypal' },
          createOrder: async function () {
            var amt = readAmount();
            if (amt == null) throw new Error('Enter an amount greater than $0 first.');
            var r = await api('/api/pay/create-order', { method: 'POST', body: { amountDollars: amt } });
            return r.orderId;
          },
          onApprove: async function (data) {
            setPayStatus('Confirming your payment… ⏳');
            try {
              var r = await api('/api/pay/capture-order', { method: 'POST', body: { orderId: data.orderID } });
              setPayStatus('');
              await afterPayment(r.amountCents);
            } catch (err) {
              setPayStatus('');
              toast(err.status === 402 ? err.message : 'Payment confirmation failed: ' + err.message);
            }
          },
          onCancel: function () { setPayStatus('Payment cancelled — no charge was made.'); },
          onError: function (err) {
            var msg = (err && err.message) ? err.message : 'PayPal ran into a problem. Please try again.';
            setPayStatus('');
            toast(msg);
          }
        }).render('#paypal-buttons');
      }).catch(function (err) {
        setPayStatus(err.message);
      });
    }
  }

  /* ============================================================
     VIEW 7 — Admin panel
     ============================================================ */
  async function renderAdminPanel() {
    viewEl.innerHTML = '<div class="card"><div class="skeleton" style="height:200px"></div></div>' +
      '<div class="card"><div class="skeleton" style="height:140px"></div></div>';

    var fundData = null, notifData = null, failed = null;
    try {
      var results = await Promise.all([
        api('/api/fund'),
        api('/api/admin/notifications')
      ]);
      fundData = results[0]; notifData = results[1];
    } catch (e) {
      failed = e;
    }
    if (failed) {
      viewEl.innerHTML = '<div class="card"><div class="empty-state"><span class="big">📡</span>' +
        'Could not load the admin panel.<br>' + esc(failed.message) +
        '<div class="mt"><button class="btn btn-blue" id="retry-admin" type="button">Try again</button></div></div></div>';
      var rb = document.getElementById('retry-admin');
      if (rb) rb.addEventListener('click', renderAdminPanel);
      return;
    }

    var html = '';
    var fund = fundData.fund;

    /* fund summary */
    html += '<section class="card" aria-label="Fund summary"><h2>Fund summary 📈</h2>';
    if (!fund) {
      html += '<div class="empty-state"><span class="big">🏗️</span>Your fund is not set up yet.</div>' +
        '<div class="center"><a class="btn btn-green" href="#/admin-setup">Set up the fund</a></div>';
    } else {
      var pct = fund.goalCents > 0 ? (fundData.totalCents / fund.goalCents) * 100 : 0;
      html += '<h3 style="margin-top:0">' + esc(fund.name) + '</h3>' +
        '<div class="fund-meta" style="justify-content:flex-start">' +
        '<span class="pill-stat">🎯 ' + centsToDollars(fund.goalCents) + ' goal</span>' +
        '<span class="pill-stat">💰 ' + centsToDollars(fundData.totalCents) + ' raised</span>' +
        '<span class="pill-stat">🧾 ' + (fundData.paymentCount || 0) + ' payments</span>' +
        '</div>' +
        '<div class="mt">' + progressBar(pct, 'Fund progress') + '</div>' +
        '<div class="progress-labels"><span>' + pct.toFixed(1) + '% funded</span>' +
        '<span>' + (fundData.contributors ? fundData.contributors.length : 0) + ' / ' + fund.numContributors + ' contributors</span></div>' +
        '<p class="muted">Monthly: ' + centsToDollars(fund.monthlyCents) + ' per contributor · due day ' + fund.dueDay +
        (fundData.demoMode ? ' · <strong>DEMO MODE</strong> (no real money)' : ' · live payments') + '</p>' +
        '<div class="mt"><a class="btn btn-blue btn-sm" href="#/admin-setup">Edit fund settings</a></div>';
    }
    html += '</section>';

    /* notifications */
    html += '<section class="card" aria-label="Notifications"><h2>Notifications 🔔</h2>';
    var notifs = (notifData && notifData.notifications) || [];
    if (!notifs.length) {
      html += '<div class="empty-state"><span class="big">🔕</span>No notifications yet.<br>' +
        '<span class="muted">You\'ll get one here every time a payment clears.</span></div>';
    } else {
      html += '<ul class="notif-list">';
      notifs.forEach(function (n) {
        html += '<li class="notif-item">' + esc(n.text) +
          '<span class="ntime">' + esc(fmtDate(n.createdAt)) + '</span></li>';
      });
      html += '</ul>';
    }
    html += '</section>';

    /* quick link */
    html += '<div class="center"><a class="btn btn-ghost" href="#/">View public fund page</a></div>';

    viewEl.innerHTML = html;
    animateBars(viewEl);
  }

  /* ============================================================
     boot
     ============================================================ */
  window.addEventListener('hashchange', route);

  (async function boot() {
    if (!location.hash) location.hash = '#/';
    try {
      await refreshStatus();
    } catch (e) {
      viewEl.innerHTML = '<div class="card"><div class="empty-state"><span class="big">📡</span>' +
        'Could not reach the server.<br>Check your connection and reload the page.</div></div>';
      return;
    }
    route();
  })();

})();
