/* Finance Intelligence — Frontend */

// ── Global State ───────────────────────────────────────────────────────────
let _activeTab    = 'pl';
let _tabStartTime = null;
let _timerInterval = null;

// lazy-load flags
let _plLoaded   = false;
let _wcLoaded   = false;
let _cfLoaded   = false;
let _costLoaded = false;

// ── Page-time logging ──────────────────────────────────────────────────────
function _startTimer() {
  clearInterval(_timerInterval);
  _tabStartTime = Date.now();
  _timerDisplay(0);
  _timerInterval = setInterval(() => {
    _timerDisplay(Math.floor((Date.now() - _tabStartTime) / 1000));
  }, 1000);
}

function _timerDisplay(seconds) {
  const el = document.getElementById('page-timer');
  if (!el) return;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  el.textContent = `${m}:${s.toString().padStart(2, '0')}`;
}

async function _logPageTime(page, seconds) {
  if (seconds < 1) return;
  try {
    await fetch('/finance/api/log-page-time', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page, seconds_spent: seconds }),
    });
  } catch (_) {}
}

window.addEventListener('beforeunload', () => {
  if (_tabStartTime !== null) {
    const seconds = Math.round((Date.now() - _tabStartTime) / 1000);
    navigator.sendBeacon('/finance/api/log-page-time',
      new Blob([JSON.stringify({ page: _activeTab, seconds_spent: seconds })],
               { type: 'application/json' }));
  }
});

// ── Tab Switching ──────────────────────────────────────────────────────────
function switchTab(tab) {
  if (_tabStartTime !== null && tab !== _activeTab) {
    _logPageTime(_activeTab, Math.floor((Date.now() - _tabStartTime) / 1000));
  }

  document.querySelectorAll('.nav-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-panel').forEach(p => {
    p.classList.toggle('hidden', p.id !== `tab-${tab}`);
  });
  _activeTab = tab;
  _startTimer();

  // Lazy-load data on first visit
  if (tab === 'pl'              && !_plLoaded)   { _plLoaded   = true; loadPl(); }
  if (tab === 'working-capital' && !_wcLoaded)   { _wcLoaded   = true; loadWorkingCapital(); }
  if (tab === 'cashflow'        && !_cfLoaded)   { _cfLoaded   = true; loadCashFlow(); }
  if (tab === 'cost'            && !_costLoaded) { _costLoaded = true; loadCostCenters(); }
  if (tab === 'genie') initGenie();
}

// ── App Config (branding) ──────────────────────────────────────────────────
async function loadAppConfig() {
  try {
    const d = await (await fetch('/finance/api/config')).json();
    if (d.company_name) {
      const nameEl = document.querySelector('.nav-brand-name');
      if (nameEl) nameEl.textContent = d.company_name + ' — Finance';
      document.title = d.company_name + ' — Finance Intelligence';
    }
    if (d.company_name) {
      fetch(`https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(d.company_name)}`)
        .then(r => r.json())
        .then(results => {
          if (!results || !results[0] || !results[0].domain) return;
          const img = document.createElement('img');
          img.src = `https://logo.clearbit.com/${results[0].domain}`;
          img.alt = d.company_name;
          img.style.cssText = 'width:22px;height:22px;border-radius:4px;object-fit:contain;background:#fff;padding:2px;margin-left:8px;flex-shrink:0;';
          img.onerror = () => img.remove();
          const brand = document.querySelector('.nav-brand');
          if (brand) brand.appendChild(img);
        })
        .catch(() => {});
    }
  } catch (_) {}
}

// ── Boot ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadKpis();          // global strip always loads
  loadAppConfig();
  switchTab('pl');     // triggers P&L lazy load + timer
});

// ── Global KPI Strip ───────────────────────────────────────────────────────
async function loadKpis() {
  try {
    const d = await fetch('/finance/api/kpis').then(r => r.json());
    setText('gkpi-revenue',   d.revenue    || '—');
    setText('gkpi-ebitda',    d.ebitda     || '—');
    setText('gkpi-margin',    d.ebitda_margin || '—');
    const vbEl = document.getElementById('gkpi-vs-budget');
    if (vbEl) {
      const val = d.vs_budget || '—';
      vbEl.textContent = val;
      vbEl.className = 'gkpi-val ' + (parseFloat(String(val).replace(/[^0-9.-]/g,'')) >= 0 ? 'positive' : 'negative');
    }
    // P&L tab KPIs
    setText('kpi-revenue',   d.revenue    || '—');
    setText('kpi-ebitda',    d.ebitda     || '—');
    setText('kpi-margin',    d.ebitda_margin || '—');
    const vbEl2 = document.getElementById('kpi-vs-budget');
    if (vbEl2) {
      const val = d.vs_budget || '—';
      vbEl2.textContent = val;
      vbEl2.className = 'kpi-val ' + (parseFloat(String(val).replace(/[^0-9.-]/g,'')) >= 0 ? 'positive' : 'negative');
    }
  } catch (_) {}
}

// ── P&L Tab ────────────────────────────────────────────────────────────────
function loadPl() {
  loadBriefing();
  loadTrend();
}

async function loadBriefing(force = false) {
  const el  = document.getElementById('briefing-text');
  const btn = document.getElementById('btn-refresh-briefing');
  if (!el) return;
  if (btn) { btn.classList.add('spinning'); btn.disabled = true; }
  el.innerHTML = `<div class="skeleton-lines">
    <div class="skel"></div><div class="skel w90"></div>
    <div class="skel w80"></div><div class="skel w70"></div>
  </div>`;
  try {
    const d = await fetch('/finance/api/gemini/briefing', { method: 'POST' }).then(r => r.json());
    const text = d.briefing || '';
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    const paras = [];
    for (let i = 0; i < sentences.length; i += 2) {
      paras.push(sentences.slice(i, i + 2).join(' ').trim());
    }
    el.innerHTML = paras.map(p => `<p>${highlight(p)}</p>`).join('');
  } catch (_) {
    el.innerHTML = `<p>Executive briefing is unavailable. Ensure GOOGLE_API_KEY and data sources are configured.</p>`;
  }
  if (btn) { btn.classList.remove('spinning'); btn.disabled = false; }
}

document.getElementById('btn-refresh-briefing')?.addEventListener('click', () => loadBriefing(true));

function highlight(text) {
  return text
    .replace(/(\$[\d,.]+[MBK%]?)/g,  '<strong>$1</strong>')
    .replace(/(\+[\d.]+%)/g,          '<strong class="positive-text">$1</strong>')
    .replace(/(-[\d.]+%)/g,           '<strong class="negative-text">$1</strong>');
}

async function loadTrend() {
  try {
    const rows = await fetch('/finance/api/pl-trend').then(r => r.json());
    if (rows && rows.length) renderTrendChart(rows, 'trend-chart', '#D4A017', '#4CAF7D');
  } catch (_) {}
}

function renderTrendChart(rows, svgId, col1, col2) {
  const svg = document.getElementById(svgId);
  if (!svg) return;
  const W = 460, H = 130, padL = 36, padR = 12, padT = 14, padB = 22;
  const cw = W - padL - padR, ch = H - padT - padB, n = rows.length;
  const xs = i => padL + (i / (n - 1)) * cw;
  const v1 = rows.map(r => parseFloat(r.revenue_m || r.operating_cf) || 0);
  const v2 = rows.map(r => parseFloat(r.ebitda_m  || r.fcf) || 0);
  const all = [...v1, ...v2];
  const minV = Math.min(...all) * 0.9, maxV = Math.max(...all) * 1.08;
  const ys = v => padT + ch - ((v - minV) / (maxV - minV)) * ch;
  const pts = vals => vals.map((v, i) => `${xs(i)},${ys(v)}`).join(' ');
  const polyPath = vals => {
    const p = vals.map((v, i) => `${i === 0 ? 'M' : 'L'}${xs(i)} ${ys(v)}`).join(' ');
    return p + ` L${xs(n-1)} ${padT+ch} L${padL} ${padT+ch} Z`;
  };
  let html = '';
  for (let t = 0; t <= 3; t++) {
    const v = minV + (maxV - minV) * (t / 3);
    const y = ys(v);
    html += `<line x1="${padL}" y1="${y}" x2="${W-padR}" y2="${y}" stroke="#2E2E2E" stroke-width="1" stroke-dasharray="3,3"/>
             <text x="${padL-4}" y="${y+4}" text-anchor="end" font-size="9" fill="#787868">$${Math.round(v)}M</text>`;
  }
  rows.forEach((r, i) => {
    if (i % 2 === 0) {
      html += `<text x="${xs(i)}" y="${H-4}" text-anchor="middle" font-size="9" fill="#787868">${(r.period_key||r.period).replace('FY','')}</text>`;
    }
  });
  const col2hex = col2.replace('#','');
  const col1hex = col1.replace('#','');
  const r2 = parseInt(col2hex.slice(0,2),16), g2 = parseInt(col2hex.slice(2,4),16), b2 = parseInt(col2hex.slice(4,6),16);
  const r1 = parseInt(col1hex.slice(0,2),16), g1 = parseInt(col1hex.slice(2,4),16), b1 = parseInt(col1hex.slice(4,6),16);
  html += `<path d="${polyPath(v2)}" fill="rgba(${r2},${g2},${b2},0.07)" stroke="none"/>`;
  html += `<path d="${polyPath(v1)}" fill="rgba(${r1},${g1},${b1},0.07)" stroke="none"/>`;
  html += `<polyline points="${pts(v1)}" fill="none" stroke="${col1}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  html += `<polyline points="${pts(v2)}" fill="none" stroke="${col2}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  const li = n - 1;
  html += `<circle cx="${xs(li)}" cy="${ys(v1[li])}" r="4" fill="${col1}"/>`;
  html += `<circle cx="${xs(li)}" cy="${ys(v2[li])}" r="4" fill="${col2}"/>`;
  svg.innerHTML = html;
}

// ── Working Capital Tab ────────────────────────────────────────────────────
async function loadWorkingCapital() {
  const tbody = document.getElementById('wc-tbody');
  if (!tbody) return;
  try {
    const rows = await fetch('/finance/api/working-capital').then(r => r.json());
    // Compute averages for KPI cards
    const avgDso = (rows.reduce((s,r) => s + parseFloat(r.dso), 0) / rows.length).toFixed(1);
    const avgDpo = (rows.reduce((s,r) => s + parseFloat(r.dpo), 0) / rows.length).toFixed(1);
    const avgCcc = (rows.reduce((s,r) => s + parseFloat(r.ccc), 0) / rows.length).toFixed(1);
    const avgAr  = (rows.reduce((s,r) => s + parseFloat(r.ar_90_plus_pct), 0) / rows.length).toFixed(1);
    setText('wc-k1', avgDso + 'd');
    setText('wc-k2', avgDpo + 'd');
    const cccEl = document.getElementById('wc-k3');
    if (cccEl) { cccEl.textContent = (parseFloat(avgCcc) <= 0 ? '' : '+') + avgCcc + 'd'; cccEl.className = 'kpi-val ' + (parseFloat(avgCcc) <= 0 ? 'positive' : 'negative'); }
    setText('wc-k4', avgAr + '%');

    tbody.innerHTML = rows.map(r => {
      const ccc = parseFloat(r.ccc);
      const cccCls  = ccc <= 0 ? 'ccc-positive' : 'ccc-negative';
      const cccSign = ccc <= 0 ? '' : '+';
      const ar90 = parseFloat(r.ar_90_plus_pct);
      const arCls = ar90 > 7 ? 'ar-warn' : '';
      return `<tr>
        <td>${r.region}</td>
        <td>${r.dso}d</td>
        <td>${r.dpo}d</td>
        <td class="${cccCls}">${cccSign}${ccc}d</td>
        <td class="${arCls}">${ar90}%</td>
      </tr>`;
    }).join('');
  } catch (_) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="5" class="loading-cell">Unable to load</td></tr>`;
  }
}

// ── Cash Flow Tab ──────────────────────────────────────────────────────────
async function loadCashFlow() {
  try {
    const rows = await fetch('/finance/api/cash-flow').then(r => r.json());
    const latest = rows[rows.length - 1];
    const prev   = rows[rows.length - 5] || rows[0]; // Q1 prior year
    setText('cf-k1', `$${latest.operating_cf}M`);
    setText('cf-k2', `$${Math.abs(latest.capex)}M`);
    setText('cf-k3', `$${latest.fcf}M`);
    const yoy = ((latest.fcf - prev.fcf) / Math.abs(prev.fcf) * 100).toFixed(1);
    const yoyEl = document.getElementById('cf-k4');
    if (yoyEl) { yoyEl.textContent = (parseFloat(yoy) >= 0 ? '+' : '') + yoy + '%'; yoyEl.className = 'kpi-val ' + (parseFloat(yoy) >= 0 ? 'positive' : 'negative'); }
    // Global KPI strip FCF
    setText('gkpi-fcf', `$${latest.fcf}M`);

    // Chart — map rows to use operating_cf and fcf keys
    renderTrendChart(rows, 'cf-trend-chart', '#1B6FEB', '#4CAF7D');

    // Table
    const tbody = document.getElementById('cf-tbody');
    if (tbody) {
      tbody.innerHTML = [...rows].reverse().slice(0, 8).map(r => `<tr>
        <td>${(r.period_key||r.period).replace('FY','')}</td>
        <td>$${r.operating_cf}M</td>
        <td style="color:var(--negative)">($${Math.abs(r.capex)}M)</td>
        <td class="${parseFloat(r.fcf) >= 0 ? 'ccc-positive' : 'ccc-negative'}">$${r.fcf}M</td>
      </tr>`).join('');
    }
  } catch (_) {}
}

// ── Cost Management Tab ────────────────────────────────────────────────────
async function loadCostCenters() {
  try {
    const rows = await fetch('/finance/api/cost-centers').then(r => r.json());
    const totalActual  = rows.reduce((s, r) => s + parseFloat(r.actual_m), 0).toFixed(1);
    const overBudget   = rows.filter(r => parseFloat(r.variance_m) < 0).length;
    const totalVariance = rows.reduce((s, r) => s + parseFloat(r.variance_m), 0).toFixed(1);
    // G&A = Finance + HR + G&A cost centers
    const gaRows = rows.filter(r => r.department === 'Corporate');
    const gaActual = gaRows.reduce((s, r) => s + parseFloat(r.actual_m), 0).toFixed(1);

    setText('cost-k1', `$${totalActual}M`);
    setText('cost-k2', `${((gaActual / 509) * 100).toFixed(1)}%`);
    const obEl = document.getElementById('cost-k3');
    if (obEl) { obEl.textContent = overBudget; obEl.className = 'kpi-val ' + (overBudget > 2 ? 'negative' : 'positive'); }
    const tvEl = document.getElementById('cost-k4');
    if (tvEl) { tvEl.textContent = (parseFloat(totalVariance) >= 0 ? '+' : '') + `$${totalVariance}M`; tvEl.className = 'kpi-val ' + (parseFloat(totalVariance) >= 0 ? 'positive' : 'negative'); }

    const tbody = document.getElementById('cost-tbody');
    if (tbody) {
      tbody.innerHTML = rows.map(r => {
        const v = parseFloat(r.variance_m);
        const over = v < 0;
        return `<tr>
          <td style="font-weight:600;color:var(--text-primary)">${r.cost_center}</td>
          <td>${r.department}</td>
          <td>$${r.budget_m}M</td>
          <td>$${r.actual_m}M</td>
          <td class="${over ? 'ccc-negative' : 'ccc-positive'}">${over ? '' : '+'}$${r.variance_m}M</td>
          <td><span class="status-badge ${over ? 'over' : 'under'}">${over ? 'Over Budget' : 'On Track'}</span></td>
        </tr>`;
      }).join('');
    }
  } catch (_) {}
}

// ── Finance Genie Chat ─────────────────────────────────────────────────────
let _genieReady = false;
function initGenie() {
  if (_genieReady) return;
  _genieReady = true;
  const input   = document.getElementById('chat-input');
  const btnSend = document.getElementById('btn-send');
  btnSend?.addEventListener('click', () => sendMessage());
  input?.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => { if (chip.dataset.q) sendMessage(chip.dataset.q); });
  });
}

let _sending = false;

async function sendMessage(overrideText) {
  if (_sending) return;
  const input   = document.getElementById('chat-input');
  const btnSend = document.getElementById('btn-send');
  const question = (overrideText || input?.value || '').trim();
  if (!question) return;
  _sending = true;
  if (input)   input.value = '';
  if (btnSend) btnSend.disabled = true;
  appendMsg('user', question);
  const typingId = appendTyping();
  try {
    const resp = await fetch('/finance/api/genie/ask', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    const d = await resp.json();
    removeMsg(typingId);
    const msgEl = appendGenieAnswer(d);
    // Agentic recommendations
    fetch('/finance/api/actions/suggest', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, answer: d.answer || '' }),
    })
      .then(r => r.json())
      .then(actions => { if (actions.length && msgEl) appendFinActionPanel(msgEl, actions); })
      .catch(() => {});
  } catch (_) {
    removeMsg(typingId);
    appendMsg('system', 'Sorry, I couldn\'t reach the Genie space. Please try again.');
  }
  _sending = false;
  if (btnSend) btnSend.disabled = false;
  if (input) input.focus();
}

const _avatarSVG = `<svg width="16" height="16" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="48" height="48" rx="8" fill="#1A1A2E"/>
  <path d="M24 10L10 18v8l14 8 14-8v-8L24 10z" fill="#D4A017"/>
</svg>`;

function appendMsg(type, text) {
  const messages = document.getElementById('messages');
  if (!messages) return null;
  const id = 'msg-' + Date.now();
  const isUser = type === 'user';
  const div = document.createElement('div');
  div.className = `msg ${isUser ? 'msg-user' : ''}`;
  div.id = id;
  const avatar = document.createElement('div');
  avatar.className = `msg-avatar ${isUser ? 'user-avatar' : 'system-avatar'}`;
  avatar.innerHTML = isUser ? 'CFO' : _avatarSVG;
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.innerHTML = `<p>${escHtml(text)}</p>`;
  div.appendChild(avatar);
  div.appendChild(bubble);
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
  return id;
}

function appendGenieAnswer(d) {
  const messages = document.getElementById('messages');
  if (!messages) return;
  const id = 'msg-' + Date.now();
  const div = document.createElement('div');
  div.className = 'msg';
  div.id = id;
  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar system-avatar';
  avatar.innerHTML = _avatarSVG;
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.innerHTML = `<p>${highlight(escHtml(d.answer || 'No answer returned.'))}</p>`;
  if (d.gemini_context) {
    const ctx = document.createElement('div');
    ctx.className = 'gemini-context';
    ctx.innerHTML = `<div class="gemini-context-label">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M12 2L9.5 9.5 2 12l7.5 2.5L12 22l2.5-7.5L22 12l-7.5-2.5Z" fill="#8B6914"/></svg>
      Gemini context
    </div>${escHtml(d.gemini_context)}`;
    bubble.appendChild(ctx);
  }
  if (d.query?.sql) {
    const det = document.createElement('details');
    det.className = 'sql-disclosure';
    det.innerHTML = `<summary>▶ View SQL</summary><pre>${escHtml(d.query.sql)}</pre>`;
    bubble.appendChild(det);
  }
  div.appendChild(avatar);
  div.appendChild(bubble);
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
  return bubble;
}

function appendFinActionPanel(wrapEl, actions) {
  const panel = document.createElement('div');
  panel.className = 'action-panel';
  const hdr = document.createElement('div');
  hdr.className = 'action-panel-header';
  hdr.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg> Recommended Actions`;
  panel.appendChild(hdr);
  const cards = document.createElement('div');
  cards.className = 'action-cards';
  actions.forEach(a => {
    const card = document.createElement('div');
    card.className = 'action-card';
    card.id = `fin-action-card-${a.id}`;
    const impact = a.impact_usd > 0 ? `$${(a.impact_usd/1000000).toFixed(1)}M impact` : 'Process improvement';
    card.innerHTML = `
      <div class="action-priority-dot ${a.priority}"></div>
      <div class="action-card-body">
        <div class="action-card-title">${a.label}</div>
        <div class="action-card-desc">${a.description}</div>
        <div class="action-card-meta"><span class="action-impact">${impact}</span> · <span>${a.owner}</span> · <span>${a.entity_name}</span></div>
        <div class="action-btns">
          <button class="action-approve-btn" onclick="executeFinAction('${a.id}','approved',this)">Take Action</button>
          <button class="action-dismiss-btn" onclick="executeFinAction('${a.id}','dismissed',this)">Dismiss</button>
        </div>
      </div>`;
    cards.appendChild(card);
  });
  panel.appendChild(cards);
  wrapEl.appendChild(panel);
  messages.scrollTop = messages.scrollHeight;
}

async function executeFinAction(actionId, outcome, btn) {
  try {
    btn.disabled = true;
    const card = document.getElementById(`fin-action-card-${actionId}`);
    await fetch('/finance/api/actions/execute', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action_id: actionId, outcome }),
    });
    if (card) card.style.opacity = '0.45';
    btn.closest('.action-btns').innerHTML = outcome === 'approved'
      ? '<span style="color:#10b981;font-size:11px;font-weight:600">✓ Action taken</span>'
      : '<span style="color:#6b7280;font-size:11px">Dismissed</span>';
  } catch (_) { btn.disabled = false; }
}

function appendTyping() {
  const messages = document.getElementById('messages');
  if (!messages) return null;
  const id = 'typing-' + Date.now();
  const div = document.createElement('div');
  div.className = 'msg';
  div.id = id;
  div.innerHTML = `<div class="msg-avatar system-avatar">${_avatarSVG}</div>
    <div class="msg-bubble"><div class="typing-dots"><span></span><span></span><span></span></div></div>`;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
  return id;
}

function removeMsg(id) { if (id) document.getElementById(id)?.remove(); }
function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
