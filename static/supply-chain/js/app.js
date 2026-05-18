'use strict';

// ── Global State ──────────────────────────────────────────────────────────────
let _activeTab     = 'ibp';
let _aiActive      = false;
let _tabStartTime  = null;   // ms timestamp when current tab was entered
let _timerInterval = null;

// Chart instances
let _ibpPlanChart     = null;
let _ibpBuChart       = null;
let _invHealthChart   = null;
let _invWareChart     = null;
let _invDosChart      = null;
let _demFaChart       = null;
let _demMapeChart     = null;
let _demTrendChart    = null;
let _ordVolChart      = null;
let _ordAutoChart     = null;

// ── Chart Defaults ────────────────────────────────────────────────────────────
Chart.defaults.color            = '#6b7280';
Chart.defaults.borderColor      = 'rgba(255,255,255,0.06)';
Chart.defaults.font.family      = 'Inter, system-ui, sans-serif';
Chart.defaults.font.size        = 11;
Chart.defaults.plugins.legend.display = false;
Chart.defaults.plugins.tooltip.backgroundColor = '#1f1f1f';
Chart.defaults.plugins.tooltip.borderColor     = 'rgba(255,255,255,0.1)';
Chart.defaults.plugins.tooltip.borderWidth     = 1;
Chart.defaults.plugins.tooltip.titleColor      = '#f0f0f0';
Chart.defaults.plugins.tooltip.bodyColor       = '#c8c8c8';
Chart.defaults.plugins.tooltip.padding         = 10;
Chart.defaults.plugins.tooltip.cornerRadius    = 8;

const BLUE   = '#1B6FEB';
const GREEN  = '#10b981';
const PURPLE = '#8b5cf6';
const AMBER  = '#f59e0b';
const RED    = '#ef4444';
const ORANGE = '#f97316';
const MUTED  = 'rgba(255,255,255,0.35)';

function _alpha(hex, a) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${a})`;
}

function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

// ── Drill-down Modal ───────────────────────────────────────────────────────────
// Content store: avoids embedding HTML strings in onclick attributes (breaks HTML parser)
const _drillStore = {};
let   _drillKey   = 0;

// SKU forecast error history (populated by renderDemErrorsTable)
let _skuErrorData = [];

function _storeDrill(title, content) {
  const key = 'k' + (_drillKey++);
  _drillStore[key] = { title, content };
  return key;
}

function openStoredDrill(key) {
  const d = _drillStore[key];
  if (d) openDrill(d.title, d.content);
}

function openDrill(title, content) {
  document.getElementById('drill-title').textContent = title;
  document.getElementById('drill-body').innerHTML = content;
  document.getElementById('drill-overlay').classList.remove('hidden');
  document.getElementById('drill-modal').classList.remove('hidden');
}
function closeDrill() {
  document.getElementById('drill-overlay').classList.add('hidden');
  document.getElementById('drill-modal').classList.add('hidden');
}

// ── Chart info (ℹ button) ──────────────────────────────────────────────────
const CHART_INFO = {
  'ibp-plan': {
    title: 'Consensus vs Financial Plan vs Operations Capacity',
    rows: [
      {l: 'Consensus', v: 'Average of all BU demand submissions after review'},
      {l: 'Financial Plan', v: 'CFO-approved revenue target per period'},
      {l: 'Operations Capacity', v: 'Machine & plant capacity ceiling from operations — max producible volume given confirmed capacity, labor, and tooling'},
      {l: 'Time Range', v: '18-month rolling forward view'},
      {l: 'Unit', v: '$M revenue or K Units (toggle)'},
    ],
    note: 'Gap between Consensus and Operations Capacity triggers supply risk escalation in S&OP.',
    why: 'Identifies misalignment between commercial targets and operational reality before it becomes a fulfillment crisis. The gap between consensus demand and capacity ceiling is the primary trigger for supply risk escalation in S&OP cycles.',
    benchmarks: [
      '<strong>Gartner:</strong> Top-quartile companies achieve &lt;5% variance between consensus demand and financial plan',
      '<strong>Oliver Wight:</strong> Class A S&OP requires consensus within ±3% of financial plan at the aggregate level',
      '<strong>APICS:</strong> Best-in-class S&OP planning horizons extend 18–24 months to capture capacity constraints early',
      '<strong>McKinsey:</strong> Companies with strong S&OP demand-supply alignment reduce excess inventory by 15–20%',
      '<strong>IBF:</strong> Organizations running monthly consensus meetings reduce forecast error by 10–15% vs. ad-hoc reviews',
    ],
  },
  'ibp-bu': {
    title: 'Plan Attainment by Business Unit',
    rows: [
      {l: 'Formula', v: 'Actual Revenue ÷ Plan Revenue × 100'},
      {l: 'Weighting', v: 'Proportional to BU revenue contribution'},
      {l: 'Target', v: '≥ 95% attainment'},
      {l: 'Period', v: 'Current S&OP cycle month'},
    ],
    note: 'BUs below 90% trigger a corrective action review in the next S&OP cycle.',
    why: 'Tracks execution fidelity across business units, exposing which BUs are over- or under-committing against plan. Early visibility enables corrective action before the gap compounds across the quarter.',
    benchmarks: [
      '<strong>Gartner:</strong> World-class plan attainment is ≥ 95% across BUs; industry average is ~88%',
      '<strong>APICS:</strong> Top-quartile organizations review BU attainment weekly — not just at month-end — to enable in-cycle correction',
      '<strong>IBF:</strong> BU attainment below 90% correlates with 2–4% annualized revenue leakage from missed commitments',
      '<strong>Hackett Group:</strong> Top performers link BU attainment directly to S&OP KPI scorecards reviewed at executive level',
      '<strong>Oliver Wight:</strong> Class A S&OP requires ≥ 95% performance-to-plan measured at the BU level',
    ],
  },
  'inv-health': {
    title: 'SKU Health Classification',
    rows: [
      {l: 'Healthy', v: 'DOS 15–45 days'},
      {l: 'Excess', v: 'DOS > 60 days'},
      {l: 'At-Risk', v: 'DOS < 7 days'},
      {l: 'Stockout', v: 'Zero on-hand units'},
      {l: 'DOS Formula', v: 'On-Hand Units ÷ Avg 30-day Daily Demand'},
    ],
    note: 'Classifications are recalculated nightly from WMS on-hand snapshots.',
    why: 'A single unhealthy SKU can mean a lost sale, an emergency air freight, or a write-down. This classification gives planners a prioritized action list — focus on Stockouts and At-Risk first, then right-size Excess to recover working capital.',
    benchmarks: [
      '<strong>Gartner:</strong> World-class companies maintain &lt;5% of active SKUs in excess or obsolete status',
      '<strong>APICS:</strong> Optimal DOS band for most manufactured goods is 15–45 days; consumer goods skew toward 15–30',
      '<strong>Deloitte:</strong> Excess and obsolete inventory typically represents 20–30% of working capital in discrete manufacturing',
      '<strong>Aberdeen Group:</strong> Best-in-class inventory accuracy (cycle-count based) is ≥ 99.5%',
      '<strong>Supply Chain Digest:</strong> Companies that classify SKU health nightly reduce emergency replenishment costs by 18–22%',
    ],
  },
  'inv-warehouse': {
    title: 'Warehouse Utilization by DC',
    rows: [
      {l: 'Utilization', v: 'On-Hand Pallets ÷ Max Pallet Capacity × 100'},
      {l: 'Days of Supply', v: 'On-Hand Units ÷ Avg Daily Demand'},
      {l: 'Alert Threshold', v: '> 85% utilization'},
      {l: 'Data Source', v: 'Real-time WMS feeds per DC'},
    ],
    note: 'DCs above 85% may require overflow routing or expedited outbound.',
    why: 'A DC approaching capacity limits causes pick-path congestion, overtime costs, and overflow charges. Monitoring utilization per DC allows network rebalancing decisions before service levels degrade.',
    benchmarks: [
      '<strong>CSCMP:</strong> Optimal warehouse utilization is 75–85%; above 90% significantly increases error rates and labor costs',
      '<strong>Gartner:</strong> DCs operating above 90% utilization see a 15–25% increase in pick/pack errors',
      '<strong>Prologis:</strong> Average industrial DC utilization in North America runs 82–85% in peak season',
      '<strong>MHI:</strong> Slotting optimization programs reduce travel time by 20–30% and allow 5–8% higher utilization without service impact',
      '<strong>Hackett Group:</strong> Top-quartile distribution networks rebalance DC inventory proactively when any node exceeds 80% for 3+ consecutive days',
    ],
  },
  'inv-dos': {
    title: 'Days of Supply by Category',
    rows: [
      {l: 'Formula', v: 'On-Hand Units ÷ Avg Daily Demand'},
      {l: 'Optimal Band', v: '15–45 days (shaded region)'},
      {l: 'Below Band', v: 'Stockout risk — expedite or reallocate'},
      {l: 'Above Band', v: 'Excess capital — consider markdown or redeployment'},
    ],
    note: 'Band thresholds are category-specific and set during annual S&OP policy review.',
    why: 'DOS is the most actionable inventory metric — it directly connects on-hand levels to demand rate and drives replenishment timing decisions. It is the universal language between supply chain, finance, and operations.',
    benchmarks: [
      '<strong>APICS:</strong> 15–45 days DOS is best-in-class for most discrete manufacturing categories',
      '<strong>Gartner:</strong> Top-quartile companies target &lt;30 days DOS for fast-moving SKUs; industry median is 45–60 days',
      '<strong>Aberdeen Group:</strong> Every 10-day reduction in DOS frees approximately 3–5% of tied-up working capital',
      '<strong>McKinsey:</strong> Leading manufacturers set DOS targets by ABC/XYZ segment — A/X items target 10–20 days, C/Z items 45–60 days',
      '<strong>Supply Chain Digest:</strong> Annual DOS policy reviews aligned to S&OP reduce inventory write-downs by 12–18%',
    ],
  },
  'dem-fa': {
    title: 'Forecast vs Actual',
    rows: [
      {l: 'Actuals', v: 'Confirmed shipped units from order management system'},
      {l: 'Forecast', v: 'Statistical baseline + market intelligence adjustments'},
      {l: 'Aggregation', v: 'All active SKUs rolled up to total volume'},
      {l: 'Period', v: 'Last 12 full months'},
    ],
    note: 'Statistical baseline uses exponential smoothing; market adj applied by demand planners.',
    why: 'Visualizing forecast versus actual over time surfaces systematic bias (always high or always low), seasonal blind spots, and the measurable impact of model changes — the foundation for continuous forecasting improvement.',
    benchmarks: [
      '<strong>IBF:</strong> World-class forecast accuracy ≥ 90% at product family level; ≥ 85% at SKU level',
      '<strong>Gartner:</strong> Top-quartile companies achieve 85–90% forecast accuracy at SKU level; industry average is 65–75%',
      '<strong>APICS:</strong> A 10-percentage-point improvement in forecast accuracy reduces safety stock requirements by 15–20%',
      '<strong>Hackett Group:</strong> Companies with ≥ 85% forecast accuracy reduce safety stock by 20–25% vs. peers at 70%',
      '<strong>Aberdeen:</strong> Best-in-class demand planners review forecast vs. actual weekly and adjust within the planning cycle',
    ],
  },
  'dem-mape': {
    title: 'MAPE by Category',
    rows: [
      {l: 'Formula', v: 'avg( |Actual − Forecast| ÷ Actual ) × 100'},
      {l: 'Level', v: 'Per product category'},
      {l: 'Target', v: '≤ 10% MAPE'},
      {l: 'Period', v: 'Last completed planning period'},
    ],
    note: 'Categories above 15% trigger a forecast model review with demand planning.',
    why: 'MAPE pinpoints which categories have the weakest signal-to-noise ratio and need model recalibration or increased planner attention. It is the primary KPI for holding demand planning accountable to a measurable accuracy standard.',
    benchmarks: [
      '<strong>IBF:</strong> World-class MAPE ≤ 10% at product family level; ≤ 15% at SKU level',
      '<strong>Gartner:</strong> Top-quartile companies achieve 8–12% MAPE at category level; industry median is 20–30%',
      '<strong>APICS:</strong> Highly seasonal and promotional categories typically run 30–40% MAPE without causal modeling',
      '<strong>Aberdeen:</strong> Every 5% MAPE improvement correlates with approximately 2–3% reduction in required safety stock',
      '<strong>Hackett Group:</strong> Organizations with formal MAPE review processes reduce forecast error 15–20% faster than those without',
    ],
  },
  'dem-trend': {
    title: 'MAPE Trend',
    rows: [
      {l: 'Formula', v: 'avg( |Actual − Forecast| ÷ Actual ) × 100'},
      {l: 'Window', v: 'Rolling 30-day across all active SKUs'},
      {l: 'Improvement Driver', v: 'ML model retraining on 6-week cadence'},
      {l: 'Period', v: 'Last 12 months'},
    ],
    note: 'Downward trend indicates model improvement. Spikes often correspond to new product launches.',
    why: 'Trending MAPE over time validates whether model investments, process changes, and planner interventions are actually improving accuracy — or whether drift is occurring. A flat or rising MAPE trend is an early warning that the forecasting process needs re-examination.',
    benchmarks: [
      '<strong>Gartner:</strong> Best-in-class organizations improve MAPE by 2–3 percentage points annually through disciplined process improvement',
      '<strong>IBF:</strong> Teams with structured forecast review cycles reduce MAPE 15–20% faster than those relying on ad-hoc reviews',
      '<strong>McKinsey:</strong> ML-enhanced demand forecasting reduces MAPE by 20–50% vs. traditional statistical baselines',
      '<strong>APICS:</strong> New product launches typically spike MAPE by 8–15% for 2–3 months before stabilizing',
      '<strong>Aberdeen:</strong> Companies that track MAPE trend (not just point-in-time) identify accuracy regressions 4–6 weeks earlier',
    ],
  },
  'ord-vol': {
    title: 'Order Volume — Automated vs Manual',
    rows: [
      {l: 'Automated', v: 'ERP rules-based release — no buyer intervention'},
      {l: 'Manual', v: 'Buyer-reviewed and approved before release'},
      {l: 'Unit', v: 'Count of Purchase Orders per month'},
      {l: 'Period', v: 'Last 12 months'},
    ],
    note: 'Automated orders must pass all tolerance checks (price, quantity, lead time) to release without review.',
    why: 'The split between automated and manual POs reveals buyer workload distribution, exception handling volume, and overall procurement process maturity. High manual volume indicates either poor data quality, narrow tolerance agreements, or untrained ERP rules.',
    benchmarks: [
      '<strong>Hackett Group:</strong> Top-quartile procurement organizations automate ≥ 80% of transactional PO volume',
      '<strong>Gartner:</strong> Automated PO processing costs $3–5 per order vs. $15–25 for manually reviewed orders',
      '<strong>APICS:</strong> Average touchless PO rate across manufacturers is 55–65%; leaders exceed 80%',
      '<strong>Deloitte:</strong> Every 10-percentage-point increase in PO automation reduces procurement operating cost by 8–12%',
      '<strong>Ardent Partners:</strong> Best-in-class procurement teams spend &lt;20% of buyer time on transactional PO processing',
    ],
  },
  'ord-auto': {
    title: 'Automation Rate Trend',
    rows: [
      {l: 'Formula', v: 'Automated POs ÷ Total POs × 100'},
      {l: 'Target', v: '≥ 80% automation rate'},
      {l: 'Exclusions', v: 'Emergency buys and spot purchases'},
      {l: 'Period', v: '12-month rolling'},
    ],
    note: 'Rate improvements come from expanding supplier tolerance agreements and ERP rule tuning.',
    why: 'Tracking automation rate over time measures the ROI of ERP rule expansions, supplier onboarding efforts, and tolerance agreement programs. Stagnant or declining automation rate signals that exception volume is growing faster than rule coverage.',
    benchmarks: [
      '<strong>Hackett Group:</strong> World-class procurement automation rate ≥ 80%; industry average is 50–60%',
      '<strong>Gartner:</strong> Companies at ≥ 75% automation process purchase orders 3× faster than manual-heavy peers',
      '<strong>Ardent Partners:</strong> Chief Procurement Officers rank touchless PO processing as a top-3 cost reduction priority',
      '<strong>McKinsey:</strong> Procurement automation reduces transactional processing costs by 30–40% over a 3-year implementation horizon',
      '<strong>Deloitte:</strong> Supplier portal adoption and EDI integration are the #1 levers cited for improving automation rate beyond 70%',
    ],
  },
};

function _dl(items) {
  return '<ul class="drill-bench-list">' + items.map(i => `<li>${i}</li>`).join('') + '</ul>';
}

function openChartInfo(id) {
  const c = CHART_INFO[id];
  if (!c) return;
  const benchHtml = c.benchmarks ? _ds('Industry Benchmarks', _dl(c.benchmarks.slice(0, 3))) : '';
  const content = _ds('How It\'s Calculated', _dr(c.rows)) + _dn(c.note) + benchHtml;
  openDrill(c.title, content);
}

// ── Add Risk Item ──────────────────────────────────────────────────────────
function openAddRisk() {
  const content = `<div style="display:flex;flex-direction:column;gap:14px">
    <div><label class="form-label">Risk Item</label><input id="ar-item" class="form-input" placeholder="Describe the risk..."></div>
    <div><label class="form-label">Impact Level</label><select id="ar-impact" class="form-input"><option>Critical</option><option>High</option><option>Medium</option><option>Low</option></select></div>
    <div><label class="form-label">Value at Risk ($M)</label><input id="ar-var" class="form-input" type="number" step="0.1" placeholder="0.0"></div>
    <div><label class="form-label">Owner</label><input id="ar-owner" class="form-input" placeholder="Name or team"></div>
    <div><label class="form-label">Mitigation Step</label><textarea id="ar-mit" class="form-input" rows="3" style="resize:vertical" placeholder="Describe the mitigation plan..."></textarea></div>
    <div style="display:flex;gap:10px;margin-top:4px"><button class="form-submit" onclick="submitAddRisk()">Add to Register</button><button class="form-cancel" onclick="closeDrill()">Cancel</button></div>
  </div>`;
  openDrill('Add Risk Item', content);
}

function submitAddRisk() {
  const item       = document.getElementById('ar-item').value.trim();
  const impact     = document.getElementById('ar-impact').value;
  const varVal     = parseFloat(document.getElementById('ar-var').value) || 0;
  const owner      = document.getElementById('ar-owner').value.trim();
  const mitigation = document.getElementById('ar-mit').value.trim();
  if (!item) { document.getElementById('ar-item').focus(); return; }
  const tbody = document.querySelector('#ibp-risk-table tbody');
  if (!tbody) return;
  const i = _riskStore.length;
  const entry = {item, impact, value_m: varVal, owner, mitigation};
  _riskStore.push(entry);
  const tr = document.createElement('tr');
  tr.id = `risk-row-${i}`;
  tr.innerHTML = _riskRowHtml(i, entry);
  tbody.appendChild(tr);
  closeDrill();
}
function _dr(rows) {
  return '<div class="drill-rows">' + rows.map(r =>
    `<div class="drill-row"><div class="drill-row-label">${r.l}</div><div class="drill-row-val">${r.v}</div></div>`
  ).join('') + '</div>';
}
function _ds(title, content) {
  return `<div class="drill-section"><div class="drill-section-title">${title}</div>${content}</div>`;
}
function _dn(text) {
  return `<div class="drill-note">${text}</div>`;
}

// ── App Config (company name / branding) ──────────────────────────────────────
async function loadAppConfig() {
  try {
    const d = await (await fetch('/supply-chain/api/config')).json();
    if (d.company_name) {
      document.getElementById('nav-brand-name').textContent = d.company_name + ' — Supply Chain';
      document.title = d.company_name + ' — Supply Chain Intelligence';
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
    // Pre-fill contact form if visible
    const cfEmail   = document.getElementById('cf-email');
    const cfCompany = document.getElementById('cf-company');
    if (cfEmail   && !cfEmail.value   && d.email)        cfEmail.value   = d.email;
    if (cfCompany && !cfCompany.value && d.company_name) cfCompany.value = d.company_name;
  } catch (_) {}
}

// ── Initialise ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadAppConfig();
  switchTab('ibp');
  fetchKpis();
  setInterval(fetchKpis, 30000);

  // Cmd/Ctrl+Enter for AI
  document.getElementById('ai-input').addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submitAi(); }
  });

  // Remove focus from FAB after any click so it never stays highlighted
  document.getElementById('talk-fab').addEventListener('click', e => {
    e.currentTarget.blur();
  });
});

// ── Contact Form ──────────────────────────────────────────────────────────────
async function submitContact(e) {
  e.preventDefault();
  const btn = document.getElementById('contact-submit-btn');
  btn.disabled = true;
  btn.textContent = 'Sending…';

  const payload = {
    name:     document.getElementById('cf-name').value.trim(),
    company:  document.getElementById('cf-company').value.trim(),
    email:    document.getElementById('cf-email').value.trim(),
    role:     document.getElementById('cf-role').value.trim(),
    interest: document.getElementById('cf-interest').value,
    message:  document.getElementById('cf-message').value.trim(),
  };

  try {
    const r = await fetch('/supply-chain/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (r.ok) {
      document.getElementById('contact-form').style.display = 'none';
      document.getElementById('contact-success').style.display = 'block';
    } else {
      btn.disabled = false;
      btn.textContent = 'Send Message';
      alert('Something went wrong. Please try again.');
    }
  } catch (_) {
    btn.disabled = false;
    btn.textContent = 'Send Message';
    alert('Network error. Please try again.');
  }
}

// ── Page Timer ────────────────────────────────────────────────────────────────
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
    await fetch('/supply-chain/api/log-page-time', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page, seconds_spent: seconds }),
    });
  } catch (_) {}
}

// ── Tab Switching ─────────────────────────────────────────────────────────────
function switchTab(tab) {
  // Log time spent on the tab we're leaving (skip same-tab and initial load)
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

  // Lazy-load data on first visit to each tab
  if (tab === 'ibp'       && !_ibpPlanChart)   fetchIbp();
  if (tab === 'inventory' && !_invHealthChart)  fetchInventory();
  if (tab === 'demand'    && !_demFaChart)      fetchDemand();
  if (tab === 'orders'    && !_ordVolChart)     fetchOrders();
  if (tab === 'contact')                        loadAppConfig(); // refresh pre-fill

  // Refresh open panels
  const ap = document.getElementById('agent-panel');
  if (!ap.classList.contains('hidden')) renderAgentPanel(tab);
  const tm = document.getElementById('talk-modal');
  if (!tm.classList.contains('hidden')) renderTalkTrack(tab);
}


// ── KPIs ──────────────────────────────────────────────────────────────────────
async function fetchKpis() {
  try {
    const d = await (await fetch('/supply-chain/api/kpis')).json();
    setText('gkpi-plan',  d.plan_attainment + '%');
    setText('gkpi-turns', d.inventory_turns + 'x');
    setText('gkpi-mape',  d.forecast_mape   + '%');
    setText('gkpi-auto',  d.order_automation + '%');
    setText('gkpi-otd',   d.on_time_delivery + '%');
    setText('gkpi-fill',  d.fill_rate        + '%');
  } catch (e) { /* silent */ }
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

// ── IBP ───────────────────────────────────────────────────────────────────────
async function fetchIbp() {
  try {
    const d = await (await fetch('/supply-chain/api/ibp')).json();
    renderSopPipeline(d.sop_stages);
    renderIbpPlanChart(d.plan_data);
    renderIbpBuChart(d.bu_attainment);
    renderIbpRiskTable(d.risks);
  } catch (e) { console.error('IBP fetch error', e); }
}


function setKpiCard(id, val, color, drillTitle, drillContent) {
  const el = document.getElementById(id);
  if (!el) return;
  const v = el.querySelector('.kpi-val');
  if (v) { v.textContent = val; v.style.color = color; }
  if (drillTitle) {
    el.classList.add('clickable');
    el.onclick = () => openDrill(drillTitle, drillContent);
  }
}

const SOP_STAGE_DETAIL = {
  'Data Collection': {
    purpose: 'Gather and cleanse all supply chain data needed to build a clean baseline for the planning cycle.',
    steps: [
      'Extract actuals (shipments, orders, production) from ERP and warehouse systems',
      'Pull financial actuals and budget data from the FP&A system',
      'Reconcile data discrepancies between source systems',
      'Load cleansed data into the Databricks Delta Lake planning tables',
      'Validate data completeness — flag missing SKUs, DCs, or time periods',
    ],
    inputs: [
      {l: 'ERP Transaction Data', v: 'SAP/Oracle shipment & order actuals'},
      {l: 'Financial Actuals', v: 'P&L by BU from FP&A system'},
      {l: 'Inventory Snapshots', v: 'On-hand & in-transit from WMS'},
      {l: 'Open PO Register', v: 'Procurement commitments'},
      {l: 'Customer Backlog', v: 'Unfulfilled orders from OMS'},
    ],
    outputs: [
      {l: 'Validated Actuals Dataset', v: 'Delta Lake — gold layer'},
      {l: 'Data Quality Report', v: 'Completeness & anomaly flags'},
      {l: 'Baseline KPI Snapshot', v: 'Starting point for cycle'},
    ],
  },
  'Statistical Forecast': {
    purpose: 'Generate a data-driven baseline demand forecast using the Databricks ML model, free of human bias.',
    steps: [
      'Run Databricks AutoML demand model over 36-month shipment history',
      'Apply seasonality decomposition and external signal enrichment (macro indices)',
      'Generate 18-month forward forecast at SKU × DC level',
      'Calculate MAPE, bias, and Forecast Value Add vs naïve baseline',
      'Flag high-uncertainty SKUs for demand planner review',
    ],
    inputs: [
      {l: 'Cleansed Shipment History', v: '36 months · SKU × DC level'},
      {l: 'Seasonality Indices', v: 'Category-level seasonal patterns'},
      {l: 'External Signals', v: 'Industry indices, macro data'},
      {l: 'New Product Roadmap', v: 'Launches in planning horizon'},
      {l: 'Promo Calendar', v: 'Planned promotional events'},
    ],
    outputs: [
      {l: 'Statistical Baseline Forecast', v: '18-month, SKU × DC'},
      {l: 'MAPE by SKU & Category', v: 'Accuracy scorecard'},
      {l: 'High-Error SKU List', v: 'Candidates for manual review'},
      {l: 'Forecast Value Add Report', v: 'ML vs naïve comparison'},
    ],
  },
  'Unconstrained Demand': {
    purpose: 'Enrich the statistical baseline with commercial intelligence to produce an unconstrained demand plan.',
    steps: [
      'Distribute statistical baseline to regional demand planners for review',
      'Incorporate sales pipeline, promotional uplift, and customer commitments',
      'Apply judgment overrides for new products, market events, and promotions',
      'Hold demand review meetings by BU to agree commercial adjustments',
      'Publish agreed unconstrained demand plan — no supply limits applied yet',
    ],
    inputs: [
      {l: 'Statistical Baseline Forecast', v: 'From previous stage'},
      {l: 'Sales Pipeline Data', v: 'CRM — qualified opportunities'},
      {l: 'Promotional Calendar', v: 'Volume uplift estimates'},
      {l: 'New Product Launch Plan', v: 'Commercial & marketing input'},
      {l: 'Customer Commitments', v: 'Contracted volumes & call-offs'},
    ],
    outputs: [
      {l: 'Unconstrained Demand Plan', v: '18-month, by BU & SKU'},
      {l: 'Override Log', v: 'Planner adjustments vs statistical'},
      {l: 'Demand Assumptions Register', v: 'Documented commercial drivers'},
      {l: 'Demand Risk & Opportunity Log', v: 'Upside and downside scenarios'},
    ],
  },
  'Supply Review': {
    purpose: 'Evaluate whether supply capacity can meet unconstrained demand and identify gaps requiring resolution.',
    steps: [
      'Run capacity loading against production, procurement, and logistics constraints',
      'Identify capacity gaps and excess capacity by site, DC, and supplier',
      'Evaluate supplier OTD performance and flag at-risk supply lanes',
      'Model inventory projections — DOS, turns, and excess positions',
      'Build constrained supply plan and quantify unresolved gaps',
    ],
    inputs: [
      {l: 'Unconstrained Demand Plan', v: 'From Demand Review stage'},
      {l: 'Production Capacity Data', v: 'Rated capacity by plant & line'},
      {l: 'Supplier Lead Times & OTD', v: 'Current supplier performance'},
      {l: 'Open PO & ASN Data', v: 'Confirmed supply pipeline'},
      {l: 'DC Capacity & Utilization', v: 'Warehouse constraints'},
      {l: 'Safety Stock Targets', v: 'Policy by SKU & location'},
    ],
    outputs: [
      {l: 'Constrained Supply Plan', v: '18-month production & procurement'},
      {l: 'Capacity Gap Register', v: 'Gaps by site, period, value'},
      {l: 'Inventory Projection', v: 'Forecast DOS & turns by DC'},
      {l: 'Supply Risk Register', v: 'At-risk suppliers & lanes'},
      {l: 'Recommended Mitigations', v: 'Expedites, transfers, dual-source'},
    ],
  },
  'Consensus Meeting': {
    purpose: 'Align commercial, supply, and finance on a single operating plan and resolve open gaps before executive review.',
    steps: [
      'Present demand vs supply gap summary to cross-functional team',
      'Review unresolved risk register items and assign resolution owners',
      'Negotiate volume trade-offs between BUs where capacity is constrained',
      'Agree on financial bridge from consensus plan to budget target',
      'Lock consensus plan figures and document all outstanding assumptions',
    ],
    inputs: [
      {l: 'Constrained Supply Plan', v: 'From Supply Review stage'},
      {l: 'Unconstrained Demand Plan', v: 'Commercial view'},
      {l: 'Gap & Risk Register', v: 'Open items requiring resolution'},
      {l: 'Financial Budget', v: 'BU-level revenue & margin targets'},
      {l: 'Scenario Analysis', v: 'Upside/downside plan options'},
    ],
    outputs: [
      {l: 'Agreed Consensus Plan', v: 'Single operating number by BU'},
      {l: 'Decision Log', v: 'Agreed trade-offs and resolutions'},
      {l: 'Escalation List', v: 'Items requiring exec decision'},
      {l: 'Financial Reconciliation', v: 'Consensus vs budget bridge'},
      {l: 'Updated Risk Register', v: 'Resolved & remaining items'},
    ],
  },
  'Executive Sign-off': {
    purpose: 'Gain leadership approval of the consensus plan and authorise resource commitments for the planning horizon.',
    steps: [
      'Present executive S&OP pack — plan vs budget, risk register, key decisions',
      'Review escalated items that were unresolved at Consensus Meeting',
      'Approve or redirect resource allocation and capital commitments',
      'Formally sign off the operating plan for the next planning period',
      'Publish approved plan to ERP and notify all functional owners',
    ],
    inputs: [
      {l: 'Consensus Plan', v: 'Cross-functional agreed view'},
      {l: 'Executive S&OP Pack', v: 'KPIs, gaps, risks, decisions'},
      {l: 'Escalation Items', v: 'Unresolved from Consensus Meeting'},
      {l: 'Financial Impact Analysis', v: 'Revenue, margin, cash flow'},
      {l: 'Scenario Recommendations', v: 'Preferred option with rationale'},
    ],
    outputs: [
      {l: 'Approved Operating Plan', v: 'Published to ERP & Databricks'},
      {l: 'Executive Decision Record', v: 'Signed-off actions & owners'},
      {l: 'Resource Authorisations', v: 'Approved spend & headcount'},
      {l: 'Plan Communication Pack', v: 'For distribution to all BUs'},
      {l: 'Next Cycle Start Memo', v: 'Dates, owners, key focus areas'},
    ],
  },
};

// Keyed by numeric index — populated when pipeline is first rendered
const _sopStageData = [];

function _refreshSopPipeline() {
  const el = document.getElementById('sop-stages');
  if (!el) return;
  el.innerHTML = _sopStageData.map((s, i) => {
    const statusClass = s.status === 'complete' ? 'complete' : s.status === 'in_progress' ? 'in-progress' : 'pending';
    const icon = s.status === 'complete'
      ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`
      : s.status === 'in_progress'
      ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="5"/></svg>`
      : `<span style="font-size:11px;color:var(--text-muted)">${i + 1}</span>`;
    return `
      <div class="sop-stage ${statusClass} clickable" onclick="openSopDrill(${i})">
        <div class="sop-stage-card">
          <div class="sop-dot">${icon}</div>
          <div class="sop-stage-name">${esc(s.stage)}</div>
          <div class="sop-stage-owner">${esc(s.owner)}</div>
          <div class="sop-stage-date">${esc(s.date)}</div>
          <div class="sop-stage-hint">View details →</div>
        </div>
      </div>`;
  }).join('');
}

function toggleSopStep(idx, stepIdx) {
  const s = _sopStageData[idx];
  if (!s || !s.checkedSteps) return;
  s.checkedSteps[stepIdx] = !s.checkedSteps[stepIdx];
  openSopDrill(idx);
}

function setSopStatus(idx, status) {
  const s = _sopStageData[idx];
  if (!s) return;
  s.status = status;
  _refreshSopPipeline();
  openSopDrill(idx);
}

function openSopDrill(idx) {
  const s = _sopStageData[idx];
  const stageName = s && s.stage;
  if (!s) return;
  const detail = SOP_STAGE_DETAIL[stageName];

  // Initialise checklist state on first open
  if (detail && !s.checkedSteps) s.checkedSteps = new Array(detail.steps.length).fill(false);

  const statusLabel = s.status === 'complete' ? 'Complete' : s.status === 'in_progress' ? 'In Progress' : 'Pending';
  const statusColor = s.status === 'complete' ? 'var(--accent-green)' : s.status === 'in_progress' ? 'var(--accent-blue)' : 'var(--text-muted)';
  const checkedCount = s.checkedSteps ? s.checkedSteps.filter(Boolean).length : 0;
  const totalSteps = detail ? detail.steps.length : 0;

  const checklistHtml = detail ? _ds('Step Checklist',
    `<div style="display:flex;flex-direction:column;gap:9px">` +
    detail.steps.map((step, j) => {
      const done = s.checkedSteps && s.checkedSteps[j];
      return `<label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer">
        <input type="checkbox" style="margin-top:2px;cursor:pointer;accent-color:var(--accent-green);flex-shrink:0" ${done ? 'checked' : ''} onchange="toggleSopStep(${idx},${j})">
        <span style="font-size:12.5px;line-height:1.5;color:${done ? 'var(--text-muted)' : 'var(--text-secondary)'};${done ? 'text-decoration:line-through' : ''}">${esc(step)}</span>
      </label>`;
    }).join('') +
    `</div><div style="margin-top:10px;font-size:11px;color:var(--text-muted);font-weight:600">${checkedCount} of ${totalSteps} steps completed</div>`
  ) : '';

  const statusBtns = `<div style="display:flex;gap:8px;flex-wrap:wrap">
    <button class="sop-status-btn${s.status === 'pending' ? ' active' : ''}" onclick="setSopStatus(${idx},'pending')">Pending</button>
    <button class="sop-status-btn in-prog${s.status === 'in_progress' ? ' active' : ''}" onclick="setSopStatus(${idx},'in_progress')">In Progress</button>
    <button class="sop-status-btn done${s.status === 'complete' ? ' active' : ''}" onclick="setSopStatus(${idx},'complete')">Complete</button>
  </div>`;

  const content = _dn(detail ? detail.purpose : '') +
    _ds('Stage Info', _dr([
      {l: 'Owner', v: s.owner},
      {l: 'Target Date', v: s.date},
      {l: 'Status', v: `<span style="color:${statusColor};font-weight:700">${statusLabel}</span>`},
    ])) +
    checklistHtml +
    _ds('Change Status', statusBtns);

  openDrill(stageName, content);
}

function renderSopPipeline(stages) {
  const el = document.getElementById('sop-stages');
  if (!el) return;
  el.innerHTML = stages.map((s, i) => {
    // Store by numeric index — avoids quoting issues with stage names in onclick
    _sopStageData[i] = s;

    const statusClass = s.status === 'complete' ? 'complete' : s.status === 'in_progress' ? 'in-progress' : 'pending';
    const icon = s.status === 'complete'
      ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`
      : s.status === 'in_progress'
      ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="5"/></svg>`
      : `<span style="font-size:11px;color:var(--text-muted)">${i + 1}</span>`;
    return `
      <div class="sop-stage ${statusClass} clickable" onclick="openSopDrill(${i})">
        <div class="sop-stage-card">
          <div class="sop-dot">${icon}</div>
          <div class="sop-stage-name">${esc(s.stage)}</div>
          <div class="sop-stage-owner">${esc(s.owner)}</div>
          <div class="sop-stage-date">${esc(s.date)}</div>
          <div class="sop-stage-hint">View details →</div>
        </div>
      </div>`;
  }).join('');
}

let _ibpPlanUnit = '$m';
let _ibpPlanRaw  = null;

function toggleIbpPlanUnit(unit) {
  _ibpPlanUnit = unit;
  document.querySelectorAll('#ibp-plan-toggle .ctog').forEach(b =>
    b.classList.toggle('active', b.dataset.unit === unit));
  if (_ibpPlanRaw) renderIbpPlanChart(_ibpPlanRaw);
}

function renderIbpPlanChart(planData) {
  _ibpPlanRaw = planData;
  const ctx = document.getElementById('ibp-plan-chart');
  if (!ctx) return;
  if (_ibpPlanChart) _ibpPlanChart.destroy();

  const isKu      = _ibpPlanUnit === 'ku';
  const labels    = planData.map(d => d.month);
  const consensus = planData.map(d => isKu ? d.consensus_k : d.consensus);
  const financial = planData.map(d => isKu ? d.financial_k : d.financial);
  const capacity  = planData.map(d => isKu ? d.capacity_k  : d.capacity);
  const futureIdx = planData.findIndex(d => d.is_future);

  const fmtVal  = v => isKu ? v + 'K' : '$' + v + 'M';
  const fmtDiff = v => isKu ? (v > 0 ? '+' : '') + v + 'K units' : (v > 0 ? '+' : '') + '$' + Math.abs(v) + 'M';

  _ibpPlanChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Consensus Plan',
          data: consensus,
          borderColor: BLUE,
          backgroundColor: _alpha(BLUE, 0.1),
          fill: true, tension: 0.4, borderWidth: 2, pointRadius: 3,
        },
        {
          label: 'Financial Target',
          data: financial,
          borderColor: GREEN,
          backgroundColor: 'transparent',
          borderDash: [5, 4], tension: 0.4, borderWidth: 1.5, pointRadius: 2,
        },
        {
          label: 'Operations Capacity',
          data: capacity,
          borderColor: _alpha('#ffffff', 0.2),
          backgroundColor: 'transparent',
          borderDash: [3, 4], tension: 0.4, borderWidth: 1, pointRadius: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, position: 'top', labels: { color: '#9ca3af', boxWidth: 12, font: { size: 11 } } },
        annotation: futureIdx >= 0 ? {
          annotations: {
            futureLine: {
              type: 'line', xMin: futureIdx, xMax: futureIdx,
              borderColor: 'rgba(255,255,255,0.2)', borderWidth: 1, borderDash: [4, 4],
              label: { content: 'Forecast →', display: true, color: '#9ca3af', font: { size: 10 }, position: 'start' },
            },
          },
        } : {},
      },
      onClick: (event, elements, chart) => {
        if (!elements.length) return;
        const idx  = elements[0].index;
        const month = chart.data.labels[idx];
        const cons = chart.data.datasets[0].data[idx];
        const fin  = chart.data.datasets[1].data[idx];
        const cap  = chart.data.datasets[2].data[idx];
        const gap  = parseFloat((cons - fin).toFixed(1));
        // Also grab the other unit for context
        const row = planData[idx];
        const altCons = isKu ? '$' + row.consensus + 'M' : row.consensus_k + 'K units';
        openDrill(`IBP Plan — ${month}`,
          _ds('Plan Breakdown', _dr([
            {l: 'Consensus Plan',       v: fmtVal(cons) + ' (' + altCons + ')'},
            {l: 'Financial Target',     v: fmtVal(fin)},
            {l: 'Operations Capacity',  v: fmtVal(cap)},
            {l: 'Gap vs Financial',     v: fmtDiff(gap)},
          ])) +
          _dn(gap < 0
            ? `Consensus is ${fmtDiff(gap)} below financial target in ${month}. Review in S&OP cycle before plan lock.`
            : `Consensus is ${fmtDiff(gap)} above financial target in ${month} — capacity headroom available.`)
        );
      },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { maxRotation: 45, font: { size: 10 } } },
        y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { callback: v => isKu ? v + 'K' : '$' + v + 'M' } },
      },
    },
  });
}

function renderIbpBuChart(bus) {
  const ctx = document.getElementById('ibp-bu-chart');
  if (!ctx) return;
  if (_ibpBuChart) _ibpBuChart.destroy();

  _ibpBuChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: bus.map(b => b.bu),
      datasets: [
        {
          label: 'Attainment %',
          data: bus.map(b => b.attainment),
          backgroundColor: bus.map(b => b.attainment >= b.target ? _alpha(GREEN, 0.7) : _alpha(AMBER, 0.7)),
          borderRadius: 5,
          barPercentage: 0.55,
        },
        {
          label: 'Target %',
          data: bus.map(b => b.target),
          backgroundColor: 'transparent',
          borderColor: _alpha('#ffffff', 0.25),
          borderWidth: 1,
          type: 'line',
          pointStyle: 'dash',
          pointRadius: 0,
          tension: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: 'y',
      plugins: {
        legend: { display: true, position: 'top', labels: { color: '#9ca3af', boxWidth: 10, font: { size: 10 } } },
        tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${ctx.raw}%` } },
      },
      onClick: (event, elements, chart) => {
        if (!elements.length) return;
        const idx  = elements[0].index;
        const bu   = chart.data.labels[idx];
        const att  = chart.data.datasets[0].data[idx];
        const tgt  = bus[idx]?.target ?? 95;
        const gap  = (att - tgt).toFixed(1);
        openDrill(`BU Attainment — ${bu}`,
          _ds('Performance', _dr([
            {l: 'Plan Attainment', v: att + '%'}, {l: 'Target', v: tgt + '%'},
            {l: 'Gap vs Target', v: (gap > 0 ? '+' : '') + gap + 'pp'},
            {l: 'Status', v: att >= tgt ? '✓ On Track' : '⚠ Below Target'},
          ])) +
          _dn(att < tgt
            ? `${bu} is ${Math.abs(gap)}pp below target. Primary drivers: demand volatility and supply allocation constraints. Recommend escalation to S&OP steering committee.`
            : `${bu} is performing ${gap}pp above target. This surplus can be leveraged to buffer against EMEA shortfall in the consensus plan.`)
        );
      },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.04)' }, min: 70, max: 100, ticks: { callback: v => v + '%' } },
        y: { grid: { display: false } },
      },
    },
  });
}

// Risk register store — keyed by row index, persists edits
const _riskStore = [];

function _riskImpactColor(impact) {
  return impact === 'Critical' ? '#ef4444' : impact === 'High' ? '#f97316' : impact === 'Medium' ? '#eab308' : 'var(--text-muted)';
}

function _riskRowHtml(i, entry) {
  const mitTrunc = entry.mitigation.length > 60 ? entry.mitigation.slice(0, 60) + '…' : entry.mitigation;
  const ic = _riskImpactColor(entry.impact);
  return `<td>${esc(entry.item)}</td>
    <td><span style="color:${ic};font-weight:700">${esc(entry.impact)}</span></td>
    <td style="color:var(--accent-amber);font-weight:600">$${parseFloat(entry.value_m).toFixed(1)}M</td>
    <td>${esc(entry.owner || '—')}</td>
    <td style="color:var(--text-muted);font-size:11.5px">${esc(mitTrunc || '—')}</td>
    <td><button class="row-edit-btn" onclick="event.stopPropagation();openEditRisk(${i})">✎ Edit</button></td>`;
}

function renderIbpRiskTable(risks) {
  const tbody = document.querySelector('#ibp-risk-table tbody');
  if (!tbody) return;
  const riskDetails = {
    0: {mitigation: 'Activate buffer stock from Rotterdam DC; expedite 3 open POs with Apex Industrial. 2-week lead time.', probability: '72%', resolution: 'May 17'},
    1: {mitigation: 'Request Q3 capacity reservation from contract manufacturer. Alternative: shift 15% of volume to APAC plant.', probability: '55%', resolution: 'May 21'},
    2: {mitigation: 'Accelerate contract renewal; apply interim bridge pricing. 18 blocked POs can be released within 48 hours.', probability: '85%', resolution: 'May 10'},
    3: {mitigation: 'Reroute 3 ocean freight lanes via Dubai hub. Air freight for critical components ($280K premium).', probability: '40%', resolution: 'May 28'},
    4: {mitigation: 'Deploy safety stock from Chicago DC; co-ordinate with Commercial on customer allocation.', probability: '30%', resolution: 'Jun 4'},
  };
  _riskStore.length = 0;
  tbody.innerHTML = risks.map((r, i) => {
    const detail = riskDetails[i] || {mitigation: 'Under review.', probability: 'TBD', resolution: 'TBD'};
    const entry = {item: r.item, impact: r.impact, value_m: r.value_m, owner: r.owner, mitigation: detail.mitigation};
    _riskStore.push(entry);
    return `<tr id="risk-row-${i}">${_riskRowHtml(i, entry)}</tr>`;
  }).join('');
}

function openEditRisk(i) {
  const e = _riskStore[i];
  if (!e) return;
  const impactOpts = ['Critical','High','Medium','Low'].map(v =>
    `<option${v === e.impact ? ' selected' : ''}>${v}</option>`).join('');
  const content = `<div style="display:flex;flex-direction:column;gap:14px">
    <div><label class="form-label">Risk Item</label><input id="er-item" class="form-input" value="${esc(e.item)}"></div>
    <div><label class="form-label">Impact Level</label><select id="er-impact" class="form-input">${impactOpts}</select></div>
    <div><label class="form-label">Value at Risk ($M)</label><input id="er-var" class="form-input" type="number" step="0.1" value="${e.value_m}"></div>
    <div><label class="form-label">Owner</label><input id="er-owner" class="form-input" value="${esc(e.owner || '')}"></div>
    <div><label class="form-label">Mitigation Step</label><textarea id="er-mit" class="form-input" rows="3" style="resize:vertical">${esc(e.mitigation || '')}</textarea></div>
    <div style="display:flex;gap:10px;margin-top:4px"><button class="form-submit" onclick="submitEditRisk(${i})">Save Changes</button><button class="form-cancel" onclick="closeDrill()">Cancel</button></div>
  </div>`;
  openDrill('Edit Risk Item', content);
}

function submitEditRisk(i) {
  const item       = document.getElementById('er-item').value.trim();
  const impact     = document.getElementById('er-impact').value;
  const varVal     = parseFloat(document.getElementById('er-var').value) || 0;
  const owner      = document.getElementById('er-owner').value.trim();
  const mitigation = document.getElementById('er-mit').value.trim();
  if (!item) { document.getElementById('er-item').focus(); return; }
  _riskStore[i] = {item, impact, value_m: varVal, owner, mitigation};
  const tr = document.getElementById(`risk-row-${i}`);
  if (tr) tr.innerHTML = _riskRowHtml(i, _riskStore[i]);
  closeDrill();
}

// ── Inventory ─────────────────────────────────────────────────────────────────
async function fetchInventory() {
  try {
    const d = await (await fetch('/supply-chain/api/inventory')).json();
    renderInvKpis(d.kpis);
    renderInvHealthChart(d.health);
    renderInvWarehouseChart(d.warehouses);
    renderInvDosChart(d.categories);
    renderInvAlerts(d.alerts);
  } catch (e) { console.error('Inventory fetch error', e); }
}

function renderInvKpis(k) {
  setKpiCard('inv-k1', k.inventory_turns + 'x', '#f0f0f0', 'Inventory Turns — Detail',
    _ds('By DC', _dr([
      {l: 'Chicago ORD', v: (k.inventory_turns + 0.4) + 'x'}, {l: 'Rotterdam RTM', v: (k.inventory_turns - 0.3) + 'x'},
      {l: 'Singapore SIN', v: (k.inventory_turns + 0.7) + 'x'}, {l: 'São Paulo GRU', v: (k.inventory_turns - 0.8) + 'x'},
      {l: 'Sydney SYD', v: (k.inventory_turns + 0.1) + 'x'},
    ])) +
    _ds('Benchmark', _dr([
      {l: 'Current', v: k.inventory_turns + 'x'}, {l: 'Industry Median', v: '5.8x'}, {l: 'Target', v: '6.5x'},
    ])) +
    _dn('São Paulo is pulling down the average due to regulatory buffer stock requirements. Excluding GRU, network average turns at ' + (k.inventory_turns + 0.5).toFixed(1) + 'x.')
  );
  setKpiCard('inv-k2', k.days_on_hand + ' days', '#f0f0f0', 'Days on Hand — Detail',
    _ds('By Category', _dr([
      {l: 'Finished Goods', v: (k.days_on_hand + 4) + ' days'}, {l: 'Raw Materials', v: (k.days_on_hand - 2) + ' days'},
      {l: 'WIP', v: (k.days_on_hand - 8) + ' days'}, {l: 'Spare Parts', v: (k.days_on_hand + 12) + ' days'},
    ])) +
    _dn('Spare parts carry elevated DOH due to long supplier lead times. A vendor-managed inventory agreement with top 3 MRO suppliers could reduce spare parts DOH by 8 days.')
  );
  setKpiCard('inv-k3', k.fill_rate + '%', k.fill_rate >= 97 ? GREEN : AMBER, 'Fill Rate — Detail',
    _ds('By Customer Tier', _dr([
      {l: 'Tier 1 (Key Accounts)', v: (k.fill_rate + 1.2) + '%'},
      {l: 'Tier 2 (Standard)', v: k.fill_rate + '%'},
      {l: 'Tier 3 (Spot)', v: (k.fill_rate - 3.1) + '%'},
    ])) +
    _ds('Top Unfilled SKUs', _dr([
      {l: 'FG-55102 Hydraulic Pump', v: '0% filled · Stockout'},
      {l: 'FG-91033 Drive Belt XL', v: '0% filled · Stockout'},
      {l: 'FG-78421 Sprocket Assy', v: '62% filled · Short'},
    ])) +
    _dn('Two stockout SKUs are driving the fill rate below 98% target. Emergency POs for both items have been identified in the AI Actions panel.')
  );
  setKpiCard('inv-k4', '$' + k.excess_value_m + 'M', AMBER, 'Excess Inventory — Detail',
    _ds('By Category', _dr([
      {l: 'Slow-Moving FG', v: '$' + (k.excess_value_m * 0.48).toFixed(1) + 'M'},
      {l: 'Obsolete Raw Mat.', v: '$' + (k.excess_value_m * 0.22).toFixed(1) + 'M'},
      {l: 'Stranded WIP', v: '$' + (k.excess_value_m * 0.18).toFixed(1) + 'M'},
      {l: 'Safety Stock Overrun', v: '$' + (k.excess_value_m * 0.12).toFixed(1) + 'M'},
    ])) +
    _dn('$' + (k.excess_value_m * 0.48).toFixed(1) + 'M of slow-moving FG is redeployable via lateral DC transfers or promotional pull. Recommend immediate review with Commercial team.')
  );
}

function renderInvHealthChart(health) {
  const ctx = document.getElementById('inv-health-chart');
  if (!ctx) return;
  if (_invHealthChart) _invHealthChart.destroy();

  const data = [health.optimal, health.excess, health.at_risk, health.stockout];
  const labels = ['Optimal', 'Excess', 'At Risk', 'Stockout'];
  const colors = [GREEN, AMBER, ORANGE, RED];

  _invHealthChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data, backgroundColor: colors.map(c => _alpha(c, 0.8)), borderColor: colors, borderWidth: 1, hoverOffset: 6 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '70%',
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => ` ${c.label}: ${c.raw.toLocaleString()} SKUs` } },
      },
      onClick: (event, elements, chart) => {
        if (!elements.length) return;
        const idx   = elements[0].index;
        const label = chart.data.labels[idx];
        const count = chart.data.datasets[0].data[idx];
        const skuExamples = {
          'Optimal':  [{l: 'FG-33201 Assembly Kit', v: '28d DOS'}, {l: 'RM-10482 Steel Billet', v: '31d DOS'}, {l: 'FG-44109 Motor Unit', v: '26d DOS'}],
          'Excess':   [{l: 'FG-78421 Sprocket Assy', v: '87d DOS'}, {l: 'RM-20091 Polymer Resin', v: '94d DOS'}, {l: 'FG-60112 Housing Cover', v: '71d DOS'}],
          'At Risk':  [{l: 'FG-22310 Bearing Set', v: '8d DOS'}, {l: 'RM-50041 Copper Coil', v: '6d DOS'}, {l: 'FG-48801 Valve Body', v: '9d DOS'}],
          'Stockout': [{l: 'FG-55102 Hydraulic Pump', v: '0d — CRITICAL'}, {l: 'FG-91033 Drive Belt XL', v: '0d — CRITICAL'}],
        };
        const examples = skuExamples[label] || [];
        openDrill(`SKU Health — ${label} (${count.toLocaleString()} SKUs)`,
          _ds('Sample SKUs', _dr(examples)) +
          _dn(label === 'Stockout' ? 'Immediate action required. Emergency POs are recommended for both stockout items.' :
              label === 'Excess'   ? 'Excess inventory represents $' + (count * 0.0022).toFixed(1) + 'M in trapped capital. Lateral transfers and promotions can resolve 60% within 30 days.' :
              label === 'At Risk'  ? count + ' SKUs are within 10 days of stockout. Replenishment orders should be raised this week.' :
              count.toLocaleString() + ' SKUs are within target DOS range. Continue monitoring weekly.')
        );
      },
    },
  });

  // Legend
  const legend = document.getElementById('inv-health-legend');
  if (legend) {
    legend.innerHTML = labels.map((l, i) => `
      <div class="legend-item">
        <div class="legend-dot" style="background:${colors[i]}"></div>
        <span>${l}: <strong>${data[i].toLocaleString()}</strong></span>
      </div>`).join('');
  }
}

function renderInvWarehouseChart(warehouses) {
  const ctx = document.getElementById('inv-warehouse-chart');
  if (!ctx) return;
  if (_invWareChart) _invWareChart.destroy();

  _invWareChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: warehouses.map(w => `${w.name} (${w.code})`),
      datasets: [
        {
          label: 'Utilization %',
          data: warehouses.map(w => w.utilization),
          backgroundColor: warehouses.map(w =>
            w.utilization > 88 ? _alpha(RED, 0.7) :
            w.utilization > 80 ? _alpha(AMBER, 0.7) : _alpha(BLUE, 0.7)),
          borderRadius: 5,
          barPercentage: 0.55,
          yAxisID: 'y',
        },
        {
          label: 'Days of Supply',
          data: warehouses.map(w => w.dos),
          type: 'line',
          borderColor: GREEN,
          backgroundColor: 'transparent',
          tension: 0.3,
          pointRadius: 4,
          borderWidth: 2,
          yAxisID: 'y2',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, position: 'top', labels: { color: '#9ca3af', boxWidth: 10, font: { size: 10 } } },
        tooltip: {
          callbacks: {
            label: c => c.datasetIndex === 0
              ? ` Utilization: ${c.raw}%`
              : ` Days of Supply: ${c.raw}d`,
          },
        },
      },
      onClick: (event, elements, chart) => {
        if (!elements.length) return;
        const idx  = elements[0].index;
        const w    = warehouses[idx];
        if (!w) return;
        openDrill(`${w.name} (${w.code}) — DC Detail`,
          _ds('Key Metrics', _dr([
            {l: 'Utilization', v: w.utilization + '%'},
            {l: 'Days of Supply', v: w.dos + ' days'},
            {l: 'Status', v: w.utilization > 88 ? '🔴 Critical' : w.utilization > 80 ? '🟡 Watch' : '🟢 Normal'},
          ])) +
          _ds('Top SKUs by Volume', _dr([
            {l: 'FG-' + (33000 + idx * 1200) + ' Assembly', v: Math.round(w.utilization * 0.14) + '% of space'},
            {l: 'RM-' + (10000 + idx * 800) + ' Raw Mat.', v: Math.round(w.utilization * 0.09) + '% of space'},
            {l: 'FG-' + (44000 + idx * 600) + ' Component', v: Math.round(w.utilization * 0.07) + '% of space'},
          ])) +
          _dn(w.utilization > 88
            ? `${w.name} is at ${w.utilization}% capacity — above the 88% safety threshold. Inbound shipments should be rerouted or lateral transfers initiated to avoid a freeze on receipts.`
            : `${w.name} is operating within normal parameters at ${w.utilization}% utilization.`)
        );
      },
      scales: {
        x:  { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 20 } },
        y:  { grid: { color: 'rgba(255,255,255,0.04)' }, min: 0, max: 100, ticks: { callback: v => v + '%' } },
        y2: { position: 'right', grid: { display: false }, ticks: { callback: v => v + 'd', font: { size: 10 } } },
      },
    },
  });
}

function renderInvDosChart(cats) {
  const ctx = document.getElementById('inv-dos-chart');
  if (!ctx) return;
  if (_invDosChart) _invDosChart.destroy();

  _invDosChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: cats.map(c => c.name),
      datasets: [
        {
          label: 'Days of Supply',
          data: cats.map(c => c.dos),
          backgroundColor: cats.map(c =>
            c.dos > c.hi ? _alpha(AMBER, 0.7) :
            c.dos < c.lo ? _alpha(RED, 0.7) : _alpha(GREEN, 0.7)),
          borderRadius: 5,
          barPercentage: 0.6,
        },
        {
          label: 'Optimal Min',
          data: cats.map(c => c.lo),
          type: 'line',
          borderColor: _alpha(GREEN, 0.5),
          borderDash: [4, 3],
          borderWidth: 1,
          pointRadius: 0,
          fill: false,
        },
        {
          label: 'Optimal Max',
          data: cats.map(c => c.hi),
          type: 'line',
          borderColor: _alpha(AMBER, 0.5),
          borderDash: [4, 3],
          borderWidth: 1,
          pointRadius: 0,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: 'top', labels: { color: '#9ca3af', boxWidth: 10, font: { size: 10 } } },
        tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${c.raw} days` } },
      },
      onClick: (event, elements, chart) => {
        if (!elements.length) return;
        const idx = elements[0].index;
        const cat = cats[idx];
        if (!cat) return;
        const status = cat.dos > cat.hi ? 'Excess' : cat.dos < cat.lo ? 'Stockout Risk' : 'Optimal';
        openDrill(`Days of Supply — ${cat.name}`,
          _ds('Position', _dr([
            {l: 'Current DOS', v: cat.dos + ' days'},
            {l: 'Optimal Min', v: cat.lo + ' days'},
            {l: 'Optimal Max', v: cat.hi + ' days'},
            {l: 'Status', v: status},
          ])) +
          _dn(cat.dos > cat.hi
            ? `${cat.name} is ${cat.dos - cat.hi} days above the optimal ceiling. Recommend halting replenishment orders for this category until DOS drops below ${cat.hi} days.`
            : cat.dos < cat.lo
            ? `${cat.name} is ${cat.lo - cat.dos} days below the safety minimum. Emergency replenishment required within 48 hours to avoid customer service impact.`
            : `${cat.name} is within the optimal ${cat.lo}–${cat.hi} day range. Continue standard replenishment cadence.`)
        );
      },
      scales: {
        x: { grid: { display: false } },
        y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { callback: v => v + 'd' } },
      },
    },
  });
}

function renderInvAlerts(alerts) {
  const el = document.getElementById('inv-alerts-list');
  if (!el) return;
  const typeLabel = { excess: 'Excess', stockout: 'Stockout', at_risk: 'At Risk' };
  const remediation = {
    stockout: 'Raise emergency PO immediately. Select expedited shipping. Alert customer service team to manage order commitments.',
    at_risk:  'Issue standard replenishment PO within 24 hours. Monitor daily until DOS exceeds safety minimum.',
    excess:   'Halt replenishment orders. Evaluate lateral DC transfer or promotional pull to reduce position within 30 days.',
  };
  el.innerHTML = alerts.map(a => {
    const drillContent =
      _ds('Alert Detail', _dr([
        {l: 'SKU', v: a.sku}, {l: 'Description', v: a.desc},
        {l: 'Location', v: a.location}, {l: 'Days of Supply', v: a.dos + 'd'},
        {l: 'Value', v: '$' + a.value_k + 'K'}, {l: 'Alert Type', v: typeLabel[a.type]},
      ])) +
      _dn(`<strong>Recommended Action:</strong> ${remediation[a.type] || 'Review with supply chain team.'}`);
    return `
      <div class="inv-alert-row ${a.type} clickable" onclick="openStoredDrill(${JSON.stringify(_storeDrill(esc(a.sku) + ' — ' + typeLabel[a.type], drillContent))})">
        <div class="inv-alert-sku">${esc(a.sku)}</div>
        <div class="inv-alert-desc">${esc(a.desc)}</div>
        <div class="inv-alert-meta">${esc(a.location)} · ${a.dos}d</div>
        <div><span class="badge badge-${a.type === 'at_risk' ? 'medium' : a.type === 'stockout' ? 'high' : 'medium'}">${typeLabel[a.type]}</span></div>
        <div class="inv-alert-value">$${a.value_k}K</div>
      </div>`;
  }).join('');
}

// ── Demand ────────────────────────────────────────────────────────────────────
async function fetchDemand() {
  try {
    const d = await (await fetch('/supply-chain/api/demand')).json();
    renderDemKpis(d.kpis);
    renderDemFaChart(d.forecast_vs_actual);
    renderDemMapeChart(d.category_mape);
    renderDemTrendChart(d.mape_trend);
    renderDemErrorsTable(d.top_errors);
  } catch (e) { console.error('Demand fetch error', e); }
}

function renderDemKpis(k) {
  setKpiCard('dem-k1', k.mape + '%', k.mape <= 10 ? GREEN : AMBER, 'Forecast MAPE — Detail',
    _ds('By Category', _dr([
      {l: 'Finished Goods', v: (k.mape + 2.1) + '%'}, {l: 'Raw Materials', v: (k.mape - 1.3) + '%'},
      {l: 'MRO / Spare Parts', v: (k.mape + 5.8) + '%'}, {l: 'WIP', v: (k.mape - 0.4) + '%'},
    ])) +
    _ds('Model Comparison', _dr([
      {l: 'Databricks ML (current)', v: k.mape + '%'},
      {l: 'Legacy Statistical', v: (k.mape + 4.9) + '%'},
      {l: 'Industry Best Practice', v: '7–9%'},
    ])) +
    _dn('MRO/Spare Parts shows the highest MAPE due to intermittent demand patterns. A separate intermittent demand model is in development and expected to reduce this category by 4pp.')
  );
  setKpiCard('dem-k2', k.bias + '%', Math.abs(k.bias) < 3 ? GREEN : AMBER, 'Forecast Bias — Detail',
    _ds('Bias Analysis', _dr([
      {l: 'Overall Bias', v: k.bias + '%'},
      {l: 'Finished Goods', v: '-2.3%'}, {l: 'Raw Materials', v: '+0.8%'},
      {l: 'MRO', v: '-1.1%'},
    ])) +
    _dn('Negative bias on Finished Goods means we are systematically under-forecasting, leading to stock shortfalls. The FG-55102 stockout is directly linked to a persistent -6.2% bias on that SKU family.')
  );
  setKpiCard('dem-k3', '+' + k.forecast_value_add + '%', '#f0f0f0', 'Forecast Value Add — Detail',
    _ds('FVA Breakdown', _dr([
      {l: 'ML Model vs Naïve', v: '+' + k.forecast_value_add + '%'},
      {l: 'Human Override Value Add', v: '+2.1%'},
      {l: 'Human Override Degradation', v: '-0.8%'},
      {l: 'Net Human Contribution', v: '+1.3%'},
    ])) +
    _dn('On average, human overrides add 1.3pp of forecast accuracy. However, 18% of overrides actually increase error — review with demand planners which SKUs to exclude from manual adjustment.')
  );
  setKpiCard('dem-k4', k.skus_forecast.toLocaleString(), '#f0f0f0', 'SKUs Forecast — Detail',
    _ds('Coverage', _dr([
      {l: 'Total Active SKUs', v: k.skus_forecast.toLocaleString()},
      {l: 'ML Model Coverage', v: (k.skus_forecast - 124).toLocaleString() + ' SKUs'},
      {l: 'Statistical Only', v: '124 SKUs'},
      {l: 'Not Forecasted', v: '0 SKUs'},
    ])) +
    _dn('124 SKUs with fewer than 6 months of history are forecast using a statistical fallback. These are candidates for ML model inclusion once sufficient data accumulates.')
  );
}

function renderDemFaChart(data) {
  const ctx = document.getElementById('dem-fa-chart');
  if (!ctx) return;
  if (_demFaChart) _demFaChart.destroy();

  const _faReasons = data.map(d => d.reason || '');

  _demFaChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.map(d => d.month),
      datasets: [
        {
          label: 'Forecast',
          data: data.map(d => d.forecast),
          borderColor: PURPLE,
          backgroundColor: _alpha(PURPLE, 0.08),
          fill: true,
          tension: 0.4,
          borderWidth: 2,
          pointRadius: 3,
        },
        {
          label: 'Actual',
          data: data.map(d => d.actual),
          borderColor: BLUE,
          backgroundColor: 'transparent',
          borderDash: [5, 3],
          tension: 0.4,
          borderWidth: 2,
          pointRadius: 3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, position: 'top', labels: { color: '#9ca3af', boxWidth: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${c.raw.toLocaleString()} units` } },
      },
      onClick: (event, elements, chart) => {
        if (!elements.length) return;
        const idx      = elements[0].index;
        const month    = chart.data.labels[idx];
        const forecast = chart.data.datasets[0].data[idx];
        const actual   = chart.data.datasets[1].data[idx];
        if (actual == null) return;
        const mape   = (Math.abs(forecast - actual) / actual * 100).toFixed(1);
        const bias   = ((forecast - actual) / actual * 100).toFixed(1);
        const dir    = forecast > actual ? 'Over-forecast' : forecast < actual ? 'Under-forecast' : 'On target';
        const dirCol = forecast > actual ? 'var(--accent-amber)' : forecast < actual ? '#ef4444' : 'var(--accent-green)';
        const reason = _faReasons[idx] || '';
        openDrill(`Forecast vs Actual — ${month}`,
          _ds('Monthly Detail', _dr([
            {l: 'Forecast', v: forecast.toLocaleString() + ' units'},
            {l: 'Actual',   v: actual.toLocaleString() + ' units'},
            {l: 'Variance', v: (forecast > actual ? '+' : '') + (forecast - actual).toLocaleString() + ' units'},
            {l: 'MAPE',     v: mape + '%'},
            {l: 'Bias',     v: (bias > 0 ? '+' : '') + bias + '%'},
            {l: 'Direction',v: `<span style="color:${dirCol};font-weight:700">${dir}</span>`},
          ])) +
          (reason ? _ds('Reason for Variance', `<div class="drill-why">${esc(reason)}</div>`) : '') +
          _dn(Math.abs(bias) > 5
            ? `A ${Math.abs(bias)}% ${forecast > actual ? 'over' : 'under'}-forecast in ${month}. Review the variance reason above and update model inputs for the next planning cycle.`
            : `Forecast accuracy was within normal range for ${month} — no corrective action required.`)
        );
      },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { maxRotation: 45, font: { size: 10 } } },
        y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { callback: v => (v/1000).toFixed(0) + 'K' } },
      },
    },
  });
}

function renderDemMapeChart(cats) {
  const ctx = document.getElementById('dem-mape-chart');
  if (!ctx) return;
  if (_demMapeChart) _demMapeChart.destroy();

  _demMapeChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: cats.map(c => c.category),
      datasets: [
        {
          label: 'MAPE %',
          data: cats.map(c => c.mape),
          backgroundColor: cats.map(c => c.mape > 15 ? _alpha(RED, 0.7) : c.mape > 10 ? _alpha(AMBER, 0.7) : _alpha(PURPLE, 0.7)),
          borderRadius: 5,
          barPercentage: 0.6,
        },
        {
          label: 'Target 10%',
          data: cats.map(() => 10),
          type: 'line',
          borderColor: _alpha(GREEN, 0.6),
          borderDash: [5, 4],
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: 'top', labels: { color: '#9ca3af', boxWidth: 10, font: { size: 10 } } },
        tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${c.raw}%` } },
      },
      onClick: (event, elements, chart) => {
        if (!elements.length) return;
        const idx  = elements[0].index;
        const cat  = cats[idx];
        if (!cat) return;
        openDrill(`MAPE by Category — ${cat.category}`,
          _ds('Accuracy Metrics', _dr([
            {l: 'MAPE', v: cat.mape + '%'}, {l: 'Target', v: '10%'},
            {l: 'Gap vs Target', v: (cat.mape - 10).toFixed(1) + 'pp'},
            {l: 'Status', v: cat.mape <= 10 ? '✓ On Target' : cat.mape <= 15 ? '⚠ Watch' : '🔴 Critical'},
          ])) +
          _dn(cat.mape > 15
            ? `${cat.category} MAPE is ${cat.mape - 10}pp above target. Primary causes are typically demand volatility and insufficient history. Recommend review of model parameters and override policy.`
            : cat.mape > 10
            ? `${cat.category} is slightly above the 10% target. Monitor for next 2 cycles before escalating.`
            : `${cat.category} is meeting the accuracy target. No action required.`)
        );
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 20 } },
        y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { callback: v => v + '%' } },
      },
    },
  });
}

function renderDemTrendChart(trend) {
  const ctx = document.getElementById('dem-trend-chart');
  if (!ctx) return;
  if (_demTrendChart) _demTrendChart.destroy();

  _demTrendChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: trend.map(d => d.month),
      datasets: [
        {
          label: 'MAPE %',
          data: trend.map(d => d.mape),
          borderColor: PURPLE,
          backgroundColor: _alpha(PURPLE, 0.1),
          fill: true,
          tension: 0.4,
          borderWidth: 2,
          pointRadius: 3,
        },
        {
          label: 'Target 10%',
          data: trend.map(() => 10),
          borderColor: _alpha(GREEN, 0.5),
          borderDash: [5, 4],
          borderWidth: 1,
          pointRadius: 0,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: 'top', labels: { color: '#9ca3af', boxWidth: 10, font: { size: 10 } } },
      },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { maxRotation: 45, font: { size: 10 } } },
        y: { grid: { color: 'rgba(255,255,255,0.04)' }, min: 6, ticks: { callback: v => v + '%' } },
      },
    },
  });
}

function renderDemErrorsTable(errors) {
  _skuErrorData = errors;
  const tbody = document.querySelector('#dem-errors-table tbody');
  if (!tbody) return;
  tbody.innerHTML = errors.map((e, idx) => {
    const biasColor = e.bias < 0 ? RED : GREEN;
    return `<tr class="clickable" onclick="openSkuDrill(${idx})">
      <td style="font-weight:600;color:var(--text-primary)">${esc(e.sku)}</td>
      <td>${esc(e.desc)}</td>
      <td style="color:${e.mape > 20 ? RED : e.mape > 12 ? AMBER : 'var(--text-secondary)'};font-weight:600">${e.mape}%</td>
      <td style="color:${biasColor};font-weight:600">${e.bias > 0 ? '+' : ''}${e.bias}%</td>
    </tr>`;
  }).join('');
}

function openSkuDrill(idx) {
  const e = _skuErrorData[idx];
  if (!e) return;
  const errorType = e.bias < -5 ? 'Systematic Under-Forecast' : e.bias > 5 ? 'Systematic Over-Forecast' : 'Random Error';
  const insight = e.mape > 25
    ? `${e.sku} has critical forecast error. Human overrides are likely the cause — review with the demand planner responsible for this SKU and consider model-only forecasting.`
    : e.bias < -5
    ? `${e.sku} is consistently under-forecast, risking stockouts. Review if seasonal patterns or promotions are missing from the model.`
    : `${e.sku} shows elevated but manageable error. Standard monitoring and review cycle applies.`;

  const statsHtml = _ds('Forecast Performance', _dr([
    {l: 'SKU',        v: e.sku},
    {l: 'Description',v: e.desc},
    {l: 'MAPE',       v: `<span style="color:${e.mape > 20 ? RED : e.mape > 12 ? AMBER : 'var(--text-secondary)'};font-weight:600">${e.mape}%</span>`},
    {l: 'Bias',       v: `<span style="color:${e.bias < 0 ? RED : GREEN};font-weight:600">${e.bias > 0 ? '+' : ''}${e.bias}%</span>`},
    {l: 'Error Type', v: errorType},
    {l: 'Last Actual',v: e.last_actual ? e.last_actual.toLocaleString() + ' units' : '—'},
  ]));

  const chartId = 'sku-drill-chart-' + idx;
  const chartHtml = `<div class="drill-section"><div class="drill-section-title">12-Month Forecast vs Actual</div>
    <div style="position:relative;height:200px;margin-top:8px"><canvas id="${chartId}"></canvas></div></div>`;

  openDrill(`${esc(e.sku)} — Forecast Analysis`, statsHtml + chartHtml + _dn(insight));

  // Render Chart.js after DOM update
  requestAnimationFrame(() => {
    const canvas = document.getElementById(chartId);
    if (!canvas || !e.history || !e.history.length) return;
    const labels   = e.history.map(d => d.month);
    const actuals  = e.history.map(d => d.actual);
    const forecasts= e.history.map(d => d.forecast);
    new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Actual',   data: actuals,   borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.1)', tension: 0.3, pointRadius: 3, fill: false },
          { label: 'Forecast', data: forecasts, borderColor: '#6366f1', backgroundColor: 'rgba(99,102,241,0.1)',  tension: 0.3, pointRadius: 3, borderDash: [4,3], fill: false },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: true, position: 'top', labels: { color: '#9ca3af', boxWidth: 10, font: { size: 10 } } },
          tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${c.raw.toLocaleString()} units` } },
        },
        scales: {
          x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#9ca3af', maxRotation: 45, font: { size: 10 } } },
          y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#9ca3af', callback: v => v.toLocaleString() } },
        },
      },
    });
  });
}

// ── Orders ────────────────────────────────────────────────────────────────────
async function fetchOrders() {
  try {
    const d = await (await fetch('/supply-chain/api/orders')).json();
    renderOrdKpis(d.kpis);
    renderOrdVolChart(d.order_volume);
    renderOrdExceptions(d.exceptions);
    renderOrdAutoChart(d.automation_trend);
    renderOrdSupplierTable(d.suppliers);
  } catch (e) { console.error('Orders fetch error', e); }
}

function renderOrdKpis(k) {
  setKpiCard('ord-k1', k.automation_rate + '%', k.automation_rate >= 80 ? GREEN : AMBER, 'Order Automation Rate — Detail',
    _ds('By PO Type', _dr([
      {l: 'Blanket / Scheduled', v: '97.2%'}, {l: 'Spot / Ad-hoc', v: '61.3%'},
      {l: 'Intercompany', v: '99.1%'}, {l: 'Catalog', v: '88.4%'},
    ])) +
    _ds('6-Month Trend', _dr([
      {l: 'Nov', v: '71.2%'}, {l: 'Jan', v: '73.8%'}, {l: 'Mar', v: '76.1%'},
      {l: 'May (current)', v: k.automation_rate + '%'},
    ])) +
    _dn('Spot PO automation at 61.3% is the biggest opportunity. AI contract matching can push this to 85%+ by automatically applying best-match supplier pricing from the approved vendor list.')
  );
  setKpiCard('ord-k2', k.avg_cycle_hours + 'h', '#f0f0f0', 'Order Cycle Time — Detail',
    _ds('Stage Breakdown', _dr([
      {l: 'PO Creation', v: '0.8h'}, {l: 'Supplier Acknowledgement', v: '4.2h'},
      {l: 'ERP Confirmation', v: '1.1h'}, {l: 'Exception Handling', v: (k.avg_cycle_hours - 6.1).toFixed(1) + 'h'},
      {l: 'Total Avg', v: k.avg_cycle_hours + 'h'},
    ])) +
    _dn('Exception handling adds ' + (k.avg_cycle_hours - 6.1).toFixed(1) + 'h average latency. The 47 open price discrepancy exceptions are the primary driver — resolving Pacific Components contract will reduce average cycle time by ~1.8h.')
  );
  setKpiCard('ord-k3', k.exceptions_open, k.exceptions_open > 30 ? RED : AMBER, 'Open Exceptions — Detail',
    _ds('By Type', _dr([
      {l: 'Price Discrepancy', v: '18'}, {l: 'Missing PO Reference', v: '12'},
      {l: 'Unmatched Invoice', v: '9'}, {l: 'Delivery Date Conflict', v: '8'},
    ])) +
    _ds('By Priority', _dr([
      {l: 'High Priority (>$10K)', v: '32'}, {l: 'Medium Priority', v: '15'},
    ])) +
    _dn('18 of the 47 exceptions are from a single supplier (Pacific Components) and relate to a contract renewal gap. Resolving this single issue clears 38% of the queue and releases $143K.')
  );
  setKpiCard('ord-k4', k.on_time_delivery + '%', k.on_time_delivery >= 92 ? GREEN : AMBER, 'On-Time Delivery — Detail',
    _ds('By Supplier Tier', _dr([
      {l: 'Tier 1 (Top 10)', v: '96.2%'}, {l: 'Tier 2 (Mid)', v: k.on_time_delivery + '%'},
      {l: 'Tier 3 (Spot)', v: '81.4%'},
    ])) +
    _ds('Late Delivery Impact', _dr([
      {l: 'Production Disruptions', v: '3 events this month'},
      {l: 'Revenue at Risk', v: '$840K'},
      {l: 'Worst Performer', v: 'EuroTech 79.3%'},
    ])) +
    _dn('EuroTech\'s 79.3% OTD on 54 open POs is a concentration risk. A contract penalty review and dual-sourcing plan is recommended before Q3 volume increases.')
  );
}

function renderOrdVolChart(vol) {
  const ctx = document.getElementById('ord-vol-chart');
  if (!ctx) return;
  if (_ordVolChart) _ordVolChart.destroy();

  _ordVolChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: vol.map(v => v.month),
      datasets: [
        {
          label: 'Automated',
          data: vol.map(v => v.automated),
          backgroundColor: _alpha(BLUE, 0.75),
          borderRadius: 4,
          stack: 'orders',
        },
        {
          label: 'Manual',
          data: vol.map(v => v.manual),
          backgroundColor: _alpha(MUTED, 0.5),
          borderRadius: 4,
          stack: 'orders',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, position: 'top', labels: { color: '#9ca3af', boxWidth: 10, font: { size: 10 } } },
        tooltip: {
          callbacks: {
            afterBody: items => {
              const auto = items[0]?.raw || 0;
              const total = (items[0]?.raw || 0) + (items[1]?.raw || 0);
              return [`Automation: ${total ? ((auto / total) * 100).toFixed(1) : 0}%`];
            },
          },
        },
      },
      onClick: (event, elements, chart) => {
        if (!elements.length) return;
        const idx     = elements[0].index;
        const month   = chart.data.labels[idx];
        const auto    = chart.data.datasets[0].data[idx];
        const manual  = chart.data.datasets[1].data[idx];
        const total   = auto + manual;
        const rate    = total ? ((auto / total) * 100).toFixed(1) : 0;
        openDrill(`Order Volume — ${month}`,
          _ds('Monthly Breakdown', _dr([
            {l: 'Total POs', v: total.toLocaleString()},
            {l: 'Automated', v: auto.toLocaleString() + ' (' + rate + '%)'},
            {l: 'Manual', v: manual.toLocaleString()},
            {l: 'Automation Rate', v: rate + '%'},
          ])) +
          _dn(manual > 300
            ? `${month} had elevated manual processing (${manual} POs). The peak is correlated with the Pacific Components exception cluster. Resolving the contract renewal will automate ~${Math.round(manual * 0.38)} of these.`
            : `${month} order volume was within normal range. Automation rate of ${rate}% is ${rate >= 80 ? 'meeting' : 'approaching'} the 80% target.`)
        );
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxRotation: 45, font: { size: 10 } } },
        y: { grid: { color: 'rgba(255,255,255,0.04)' }, stacked: true },
      },
    },
  });
}

function renderOrdExceptions(exceptions) {
  const el = document.getElementById('exception-list');
  if (!el) return;

  el.innerHTML = exceptions.map(ex => {
    // ── PO list table ───────────────────────────────────────────────────────
    const poRows = (ex.pos || []).map(p => `
      <tr>
        <td style="font-family:monospace;font-size:11px;color:var(--accent-blue)">${esc(p.po)}</td>
        <td style="font-size:12px">${esc(p.supplier)}</td>
        <td style="font-size:12px">${esc(p.material)}</td>
        <td style="font-size:12px;color:var(--accent-amber);font-weight:600;white-space:nowrap">$${p.value_k}K</td>
        <td style="font-size:11px;color:var(--text-muted);white-space:nowrap">${p.age_days}d</td>
        <td style="font-size:11px;color:var(--text-secondary);line-height:1.4">${esc(p.issue)}</td>
      </tr>`).join('');

    const poTable = ex.pos && ex.pos.length ? `
      <div class="drill-section">
        <div class="drill-section-title">Purchase Orders (${ex.pos.length} shown${ex.count > ex.pos.length ? ' of ' + ex.count : ''})</div>
        <div style="overflow-x:auto;margin-top:6px">
          <table style="width:100%;border-collapse:collapse;font-size:12px">
            <thead>
              <tr style="border-bottom:1px solid var(--border)">
                <th style="text-align:left;padding:4px 8px 6px 0;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted)">PO #</th>
                <th style="text-align:left;padding:4px 8px 6px 0;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted)">Supplier</th>
                <th style="text-align:left;padding:4px 8px 6px 0;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted)">Material</th>
                <th style="text-align:left;padding:4px 8px 6px 0;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted)">Value</th>
                <th style="text-align:left;padding:4px 8px 6px 0;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted)">Age</th>
                <th style="text-align:left;padding:4px 0 6px 0;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted)">Issue Detail</th>
              </tr>
            </thead>
            <tbody style="border-collapse:collapse">
              ${poRows}
            </tbody>
          </table>
        </div>
      </div>` : '';

    // ── Agentic recommendations ──────────────────────────────────────────────
    const recItems = (ex.recommendations || []).map((r, i) => {
      const typeCol  = r.type === 'auto' ? 'var(--accent-green)' : 'var(--accent-blue)';
      const typeLabel = r.type === 'auto' ? 'Auto-resolve' : 'Manual action';
      const impCol   = r.impact === 'High' ? '#ef4444' : r.impact === 'Medium' ? 'var(--accent-amber)' : 'var(--text-muted)';
      return `<div style="display:flex;gap:12px;padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.04);align-items:flex-start">
        <div style="flex-shrink:0;width:20px;height:20px;border-radius:50%;background:rgba(255,255,255,0.06);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:var(--text-muted);margin-top:1px">${i + 1}</div>
        <div style="flex:1">
          <div style="font-size:12.5px;color:var(--text-secondary);line-height:1.5">${esc(r.action)}</div>
          <div style="display:flex;gap:8px;margin-top:5px">
            <span style="font-size:10px;font-weight:700;color:${typeCol};text-transform:uppercase;letter-spacing:.05em">${typeLabel}</span>
            <span style="font-size:10px;color:var(--text-muted)">·</span>
            <span style="font-size:10px;font-weight:700;color:${impCol}">Impact: ${r.impact}</span>
          </div>
        </div>
      </div>`;
    }).join('');

    const recsHtml = ex.recommendations && ex.recommendations.length
      ? `<div class="drill-section">
          <div class="drill-section-title">AI Recommendations</div>
          ${recItems}
        </div>` : '';

    const drillContent =
      _ds('Exception Summary', _dr([
        {l: 'Total POs',   v: ex.count},
        {l: 'Value Held',  v: '$' + ex.value_k + 'K'},
        {l: 'Avg Age',     v: ex.aging_days + ' days'},
        {l: 'Priority',    v: `<span style="color:${ex.priority === 'high' ? '#ef4444' : 'var(--accent-amber)'};font-weight:700;text-transform:capitalize">${ex.priority}</span>`},
      ])) +
      (ex.root_cause ? `<div class="drill-section"><div class="drill-section-title">Root Cause Analysis</div><div class="drill-why" style="margin-top:4px">${esc(ex.root_cause)}</div></div>` : '') +
      poTable +
      recsHtml;

    return `
      <div class="exception-row ${ex.priority} clickable" onclick="openStoredDrill(${JSON.stringify(_storeDrill(esc(ex.type) + ' — Exception Detail', drillContent))})">
        <div class="exception-count ${ex.priority}">${ex.count}</div>
        <div class="exception-info">
          <div class="exception-type">${esc(ex.type)}</div>
          <div class="exception-meta">Avg age: ${ex.aging_days} days · ${ex.priority === 'high' ? 'High priority' : 'Medium priority'}</div>
        </div>
        <div class="exception-value">$${ex.value_k}K</div>
      </div>`;
  }).join('');
}

function renderOrdAutoChart(trend) {
  const ctx = document.getElementById('ord-auto-chart');
  if (!ctx) return;
  if (_ordAutoChart) _ordAutoChart.destroy();

  _ordAutoChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: trend.map(d => d.month),
      datasets: [
        {
          label: 'Automation Rate %',
          data: trend.map(d => d.rate),
          borderColor: BLUE,
          backgroundColor: _alpha(BLUE, 0.1),
          fill: true,
          tension: 0.4,
          borderWidth: 2,
          pointRadius: 3,
        },
        {
          label: 'Target 80%',
          data: trend.map(() => 80),
          borderColor: _alpha(GREEN, 0.5),
          borderDash: [5, 4],
          borderWidth: 1,
          pointRadius: 0,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: 'top', labels: { color: '#9ca3af', boxWidth: 10, font: { size: 10 } } },
      },
      onClick: (event, elements, chart) => {
        if (!elements.length) return;
        const idx   = elements[0].index;
        const month = chart.data.labels[idx];
        const rate  = chart.data.datasets[0].data[idx];
        openDrill(`Automation Rate — ${month}`,
          _ds('Monthly Detail', _dr([
            {l: 'Automation Rate', v: rate + '%'}, {l: 'Target', v: '80%'},
            {l: 'Gap vs Target', v: (rate - 80).toFixed(1) + 'pp'},
          ])) +
          _dn(rate >= 80
            ? `Automation target met in ${month} at ${rate}%. Key driver: blanket PO expansion with top 5 suppliers.`
            : `${month} was ${(80 - rate).toFixed(1)}pp below the 80% target. Exception volume was elevated — focus on resolving price discrepancy exceptions to recover.`)
        );
      },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { maxRotation: 45, font: { size: 10 } } },
        y: { grid: { color: 'rgba(255,255,255,0.04)' }, min: 60, max: 90, ticks: { callback: v => v + '%' } },
      },
    },
  });
}

function renderOrdSupplierTable(suppliers) {
  const tbody = document.querySelector('#ord-supplier-table tbody');
  if (!tbody) return;
  const sortedSuppliers = [...suppliers].sort((a, b) => b.otd - a.otd);
  tbody.innerHTML = sortedSuppliers.map(s => {
    const cls = s.otd >= 93 ? 'otd-good' : s.otd >= 87 ? 'otd-warn' : 'otd-bad';
    const risk = s.otd < 87 ? 'High' : s.otd < 93 ? 'Medium' : 'Low';
    const drillContent =
      _ds('Supplier Scorecard', _dr([
        {l: 'On-Time Delivery', v: s.otd + '%'},
        {l: 'Country', v: s.country},
        {l: 'Open POs', v: s.pos},
        {l: 'Annual Spend', v: '$' + s.spend_m + 'M'},
        {l: 'Risk Level', v: risk},
      ])) +
      _ds('Performance Trend (Est.)', _dr([
        {l: '3 Months Ago', v: (s.otd + 1.2).toFixed(1) + '%'},
        {l: '2 Months Ago', v: (s.otd + 0.5).toFixed(1) + '%'},
        {l: 'Current', v: s.otd + '%'},
      ])) +
      _dn(s.otd < 87
        ? `${s.name} is a high-risk supplier at ${s.otd}% OTD with ${s.pos} open POs. Recommend dual-sourcing review and contract penalty clause activation.`
        : s.otd < 93
        ? `${s.name} is approaching the 93% OTD threshold. Monitor closely and schedule a supplier performance review.`
        : `${s.name} is a strong performer at ${s.otd}% OTD. Consider for preferred supplier status and increased volume allocation.`);
    const key = _storeDrill(esc(s.name) + ' — Supplier Scorecard', drillContent);
    return `<tr class="clickable" onclick="openStoredDrill(${JSON.stringify(key)})">
      <td style="font-weight:600;color:var(--text-primary)">${esc(s.name)}</td>
      <td>${esc(s.country)}</td>
      <td class="${cls}">${s.otd}%</td>
      <td>${s.pos}</td>
      <td>$${s.spend_m}M</td>
    </tr>`;
  }).join('');
}

// ── Talk Track ────────────────────────────────────────────────────────────────
const TAB_LABELS = {
  ibp:       'Integrated Business Planning',
  inventory: 'Inventory & Logistics',
  demand:    'Demand Forecasting',
  orders:    'Order Processing',
  ai:        'Supply Chain AI',
};

const TALK_TRACKS = {
  ibp: {
    overview: `Integrated Business Planning is the control-tower view of this app: an 18-month S&OP pipeline with consensus, financial, and capacity slices, plus per-BU attainment versus target. The stepper shows which gate the cycle is in; the risk register quantifies exposure before executive sign-off.

Use it when leadership asks “where are we off plan, and who owns the next decision?” without exporting five spreadsheets from the ERP.`,
    body: `When financial targets and operational reality diverge, the pain shows up at month-end. This screen exists so the gap is visible by BU and region while the cycle is still open—fed by Delta tables in Databricks, not a static deck.`,
    insights: [
      'In this demo, anchor the story on BU-level attainment bars, not a single blended KPI—buyers of IBP software punish aggregate green that hides two red businesses.',
      'Tie the pipeline stepper to RACI in the meeting: if “Supply Review” is active, the next artifact should be documented assumptions on capacity and lead time, not just demand.',
      'Use the risk register dollars as the forcing function for the executive agenda—probability-weighted exposure belongs in the same UI as plan attainment.',
      'Databricks practice: treat consensus version, frozen actuals date, and scenario tags as UC metadata so every chart is reproducible for audit and SOX discussions.',
      'Close the loop: when a risk mitigates, record the decision and owner in the lakehouse so next month’s review starts from an event log, not memory.',
    ],
  },
  inventory: {
    overview: `Inventory & Logistics rolls up 6,247 SKUs across five DCs: days-of-supply bands, critical SKU callouts, utilization heat, the $12.4M excess redeployment panel, and alerts that name location and value. It is the SKU-level truth behind aggregate inventory turns.

Pair the map and tables when narrating “we are simultaneously short and long.”`,
    body: `Stockouts on A-items while slow movers collect dust is the paradox this tab exposes. The alert rail is meant for weekly inventory huddles—lateral moves and promos before quarter-end write-off conversations.`,
    insights: [
      'Demo tip: click from a red DOS SKU to the excess tile and show lateral transfer math—same platform, two sides of the working-capital story.',
      'Policy guardrail: fast movers in this app target roughly 15–25 days cover; anything north of 90 DOS should trigger supply review plus commercial action, not just more warehouse space.',
      'Databricks pattern: materialize ABC–XYZ segments nightly from shipment variance and COGS so planners are not re-segmenting in Excel.',
      'Service vs. capital: when critical SKUs breach threshold, escalate with projected lost margin, not only unit shortage—gets sales and finance aligned faster.',
      'Governance: write inventory snapshots to versioned Delta tables so “what did we know on Tuesday?” is answerable during OTIF post-mortems.',
    ],
  },
  demand: {
    overview: `Demand Forecasting shows MAPE and bias by category, the ML vs. actual trend, and the “top SKU errors” table where planner overrides meet model error. It is the place to prove whether humans are helping or hurting the statistical baseline.

This tab should be shown immediately after Inventory when FG-55102 or similar ties forecast error to a service issue.`,
    body: `Bias beats random noise: a persistent −2.3% on Finished Goods in this demo means buyers are structurally short. The app is built to spotlight those five SKUs where overrides increase MAPE so you can coach or remove the override policy.`,
    insights: [
      'Run Forecast Value Add quarterly here: if overrides do not beat the model, publish a rule to default to ML except for signed events (launch, promo, force majeure).',
      'Databricks MLflow tip: display model version and training cutoff beside MAPE so stakeholders trust the number and know when drift work is due.',
      'Segment storytelling: industrial categories with long tails belong to different accuracy targets than CPG-like SKUs—avoid one enterprise MAPE goal.',
      'Feature store hygiene: keep competitor pricing and macro inputs versioned; otherwise “accuracy improved” might just be a covariate shift artifact.',
      'Operational bridge: push top error SKUs into a weekly supply meeting backlog with owner and expected lift—turn analytics into a work queue.',
    ],
  },
  orders: {
    overview: `Order Processing is the procure-to-pay health page: touchless automation rate (78.4% here), exception queue with dollar hold, cluster badges (e.g., Pacific Components price mismatch), and supplier OTD ranked with open PO counts.

It answers “where is manual work starving strategic procurement?” in one glance.`,
    body: `The demo narrative is concentration plus automation—47 exceptions / $402K held orders, and clearing the Pacific cluster unlocks most of the queue. EuroTech’s 79.3% OTD on 54 open POs is the supplier risk callout for the chief procurement officer.`,
    insights: [
      'SLA the exceptions shown here: price mismatches in hours, GR/quantity mismatches in a day—treat delay as a working-capital line item, not clerical backlog.',
      'Touchless target for this app storyline: march automation from 71% → 78% toward >90% by fixing master data and contract price tables, not by hiring more matchers.',
      'Use OTD + open PO count together: low OTD with high open exposure is escalation; high OTD with few POs might still hide invoice defects—cross-check the exception mix.',
      'Databricks integration story: land SAP iDocs/IDocs or equivalent into Bronze, resolve in Silver with business rules, feed this UI from Gold KPI tables served to Apps.',
      'Dual-source rule: any supplier over ~20% category spend without backup gets a quarterly resilience review tied to the exception categories they generate.',
    ],
  },
  ai: {
    overview: `Supply Chain AI is Genie against the same Delta facts as the other tabs: natural-language answers on exposure, suppliers, inventory turns, and cross-domain joins (forecast error vs. stockout, exceptions vs. contract).

It is the “ask anything” layer for managers who will never open a notebook.`,
    body: `The canned prompts are intentional—they mirror executive questions that usually wait 48 hours for an analyst. Grounding in UC-approved semantic models is what keeps answers aligned with the KPIs you already showed.`,
    insights: [
      'Ship curated prompts per persona (planner, buyer, CFO) before opening free text—reduces hallucination risk and trains users on trusted phrasing.',
      'Log low-confidence answers and feed them to the semantic model backlog; Genie adoption lives or dies on fixing recurring misses.',
      'Security: row-level security by region and supplier confidentiality tier—procurement chat must respect the same entitlements as the dashboards.',
      'Latency honesty: label responses as post-batch or near-real-time to match your pipeline; do not promise PLC speed from a lakehouse assistant.',
      'Human-in-the-loop: for dollar commitments over a threshold, require planner acknowledgment even when the AI recommendation is correct—builds trust and audit trail.',
    ],
  },
};

function openTalkTrack() {
  document.getElementById('talk-overlay').classList.remove('hidden');
  document.getElementById('talk-modal').classList.remove('hidden');
  renderTalkTrack(_activeTab);
}
function closeTalkTrack() {
  document.getElementById('talk-overlay').classList.add('hidden');
  document.getElementById('talk-modal').classList.add('hidden');
}
function renderTalkTrack(tab) {
  const track = TALK_TRACKS[tab] || TALK_TRACKS.ibp;
  document.getElementById('talk-tab-badge').textContent = TAB_LABELS[tab] || tab;
  const insights = track.insights || track.bestPractices || [];
  const insightsHtml = insights.length
    ? `<div class="talk-best-practices">
        <div class="talk-bp-title">Key insights</div>
        <ul class="talk-bp-list">${insights.map((bp) => `<li>${bp}</li>`).join('')}</ul>
       </div>`
    : '';
  const overviewHtml = track.overview
    ? `<div class="talk-page-overview">
        <div class="talk-page-overview-label">Page overview</div>
        <div class="talk-body-text">${track.overview.split('\n\n').map((p) => `<p>${p}</p>`).join('')}</div>
      </div>`
    : '';
  document.getElementById('talk-modal-body').innerHTML = `
    ${overviewHtml}
    <div class="talk-body-text">${(track.body || '').split('\n\n').map((p) => `<p>${p}</p>`).join('')}</div>
    ${insightsHtml}
  `;
}

// ── Agent Actions ─────────────────────────────────────────────────────────────
const AGENT_ACTIONS = {
  ibp: [
    {
      sys: 'ERP',
      title: 'Publish the May Consensus Plan to Integrated Business Planning',
      desc: 'Push the agreed consensus plan figures from Databricks to your ERP IBP module, updating the statistical forecast baseline and triggering the supply planning run across all BUs — so MRP reflects the latest consensus without manual re-entry.',
      result: 'Consensus plan published · ERP IBP updated · Supply planning run triggered · Transaction PORDCR01-0000000051482910 confirmed · 18-month horizon loaded for 5 BUs',
    },
    {
      sys: 'Teams',
      title: 'Post the S&OP Risk Summary to the Steering Committee Channel',
      desc: 'Send an executive summary of the 5 open risk items, their financial exposure ($12.7M combined), and the recommended mitigations to the #sop-steering-committee channel in Teams — so leadership has the brief before the May 14th sign-off.',
      result: 'Risk summary posted to #sop-steering-committee · 5 risks · $12.7M total exposure · EMEA shortfall flagged HIGH · 4 leadership members notified · Posted 14:02',
    },
    {
      sys: 'ERP',
      title: 'Create a Financial Variance Notification for the EMEA Capacity Gap',
      desc: 'Raise a formal variance notification in your ERP against the EMEA BU plan, documenting the $4.2M capacity shortfall and attaching the Databricks-generated root cause analysis — creating the audit trail for the S&OP record.',
      result: 'Variance notification created · Document 900047821 · EMEA BU · $4.2M variance · Transaction FINSTA01-0000000051482987 confirmed · Attached to S&OP record 20250507',
    },
  ],
  inventory: [
    {
      sys: 'ERP',
      title: 'Create Replenishment Purchase Orders for Chicago DC Stockout SKUs',
      desc: 'Raise emergency purchase orders in your ERP Materials Management for FG-55102 (Hydraulic Pump Unit) and FG-91033 (Drive Belt XL) — the two critical stockout items in Chicago DC — with expedited lead time and preferred supplier pre-selected.',
      result: 'PO 4500892147 created for FG-55102 · 400 units · Apex Industrial · Expedited · Transaction ORDERS05-0000000051483001 confirmed\nPO 4500892148 created for FG-91033 · 600 units · Allied Materials · Standard · Transaction ORDERS05-0000000051483002 confirmed',
    },
    {
      sys: 'ERP',
      title: 'Post Inventory Transfer from Chicago to Rotterdam for FG-78421',
      desc: 'Issue a warehouse transfer order in your ERP Warehouse Management to move 200 units of FG-78421 (Premium Sprocket Assembly) from Chicago DC to Rotterdam DC — relieving Rotterdam\'s 91% utilization and redeploying $56K of excess stock.',
      result: 'Transfer Order 0000023841 posted · 200 units FG-78421 · Chicago ORD → Rotterdam RTM · Transaction WMMBXY-0000000051483050 confirmed · Rotterdam utilization reduced to 87%',
    },
    {
      sys: 'Teams',
      title: 'Alert the Logistics Team to the Rotterdam Capacity Risk',
      desc: 'Post a warehouse utilization alert to the #logistics-ops channel covering Rotterdam DC at 91% — including the 3 SKUs driving the overfill and the proposed lateral transfer plan — so the team can action it before the next inbound shipment arrives.',
      result: 'Alert posted to #logistics-ops · Rotterdam DC 91% utilization · 3 SKUs flagged · Lateral transfer plan attached · Logistics Manager K. van der Berg notified · Posted 14:07',
    },
  ],
  demand: [
    {
      sys: 'ERP',
      title: 'Push the Updated Statistical Forecast to ERP Demand Planning',
      desc: 'Upload the Databricks ML forecast for all 6,248 SKUs to your ERP demand planning module, replacing the legacy statistical forecast with the improved model output — reducing MAPE from the 14% baseline to the 9.1% achieved in Databricks.',
      result: 'Forecast upload complete · 6,248 SKUs · ERP Demand Plan updated · Transaction SUPFAL01-0000000051484100 confirmed · MAPE baseline adjusted to 9.1%',
    },
    {
      sys: 'ERP',
      title: 'Trigger a Demand Review Workflow for High-Error SKUs',
      desc: 'Create demand review tasks in your ERP for the top 5 high-error SKUs, assigning them to the responsible demand planners with the Databricks-generated error analysis attached — so root causes are investigated before the next consensus cycle.',
      result: '5 demand review tasks created · FG-55102 assigned to T. Reyes · FG-78421 assigned to M. Chen · Transaction HRMD_A07-0000000051484201 confirmed · Due date: May 10',
    },
    {
      sys: 'Teams',
      title: 'Notify the Commercial Team of the Systematic Under-Forecast Bias',
      desc: 'Post an analysis of the -2.3% under-forecast bias on Finished Goods to the #commercial-planning channel, explaining the link to the FG-55102 stockout and requesting input from the sales team on whether pipeline data should be added to the model.',
      result: 'Bias analysis posted to #commercial-planning · -2.3% FG under-forecast identified · Link to FG-55102 stockout highlighted · Sales data request raised · VP Commercial J. Walsh notified',
    },
  ],
  orders: [
    {
      sys: 'ERP',
      title: 'Auto-Create Purchase Orders for the 18 Pacific Components Exceptions',
      desc: 'Apply the renewed contract pricing to the 18 Pacific Components price discrepancy exceptions and create confirmed purchase orders in your ERP — converting $143K of held orders to confirmed POs without manual planner intervention.',
      result: '18 POs confirmed · Pacific Components · $143K released · Contract 4600082941 applied · Transaction ORDERS05 batch 0000000051485001–51485018 confirmed · Automation rate +2.1%',
    },
    {
      sys: 'ERP',
      title: 'Update Advance Shipment Notifications for Q2 Open Deliveries',
      desc: 'Refresh ASN records in your ERP for all Q2 open deliveries where supplier OTD is below 88% — flagging late shipments and triggering the exception workflow so procurement can expedite before delivery dates are missed.',
      result: 'ASN refresh complete · 31 deliveries updated · 7 late flags raised · Transaction DESADV batch 0000000051485101–51485131 confirmed · Expedite workflow triggered for 7 orders',
    },
    {
      sys: 'Teams',
      title: 'Escalate High-Priority Order Exceptions to the Procurement Team',
      desc: 'Post a ranked exception report to the #procurement-ops channel covering the 32 high-priority exceptions — price discrepancies, missing references, and unmatched invoices — with the root cause and recommended action for each.',
      result: 'Exception report posted to #procurement-ops · 32 high-priority items · $292K held · Root causes attached · Procurement Lead D. Okafor acknowledged · Posted 14:14',
    },
  ],
  ai: [
    {
      sys: 'ERP',
      title: 'Log the AI-Generated Supply Chain Findings to ERP',
      desc: 'Append a timestamped briefing to the active supply chain review workflow in your ERP, capturing the AI-generated recommendations from this session — creating a permanent record linking the AI analysis to the resulting business decisions.',
      result: 'AI findings logged · Workflow 800094821 · 1,024 characters · Transaction HRMD_A07-0000000051486200 confirmed · Linked to S&OP cycle 20250507',
    },
    {
      sys: 'Teams',
      title: 'Post the AI Session Summary to the Supply Chain Leadership Channel',
      desc: 'Share a concise summary of today\'s AI-identified insights — top risks, recommended actions, and financial quantification — to the #supply-chain-leadership channel so the leadership team can review and prioritize before the next steering meeting.',
      result: 'AI session summary posted to #supply-chain-leadership · 4 insights · $17.3M total risk identified · 3 recommended actions · 5 leadership members notified · Posted 14:18',
    },
    {
      sys: 'Email',
      title: 'Email the AI Supply Chain Summary to the CFO and COO',
      desc: 'Send a concise briefing to the CFO and COO distribution list summarizing the AI-identified supply chain risks, financial exposures, and recommended escalations for this week — so decisions can be made before the Friday leadership review.',
      result: 'Email sent · "Supply Chain AI Brief — Week 19" · CFO P. Lawson, COO M. Torres · 4 key findings · $17.3M exposure · 3 actions recommended · Sent 14:19',
    },
  ],
};

function openAgentPanel() {
  document.getElementById('agent-overlay').classList.remove('hidden');
  document.getElementById('agent-panel').classList.remove('hidden');
  renderAgentPanel(_activeTab);
}
function closeAgentPanel() {
  document.getElementById('agent-overlay').classList.add('hidden');
  document.getElementById('agent-panel').classList.add('hidden');
}

function renderAgentPanel(tab) {
  const badge = document.getElementById('agent-tab-badge');
  if (badge) badge.textContent = TAB_LABELS[tab] || tab;

  const actions = AGENT_ACTIONS[tab] || AGENT_ACTIONS.ibp;

  const list = document.getElementById('agent-actions-list');
  if (!list) return;
  list.innerHTML = actions.map((a, i) => {
    const sysClass = a.sys === 'ERP' ? 'badge-sap' : a.sys === 'Teams' ? 'badge-teams' : 'badge-email';
    return `
      <div class="agent-action-card" id="action-card-${tab}-${i}">
        <div class="agent-action-header-row">
          <span class="agent-sys-badge ${sysClass}">${esc(a.sys)}</span>
          <div class="agent-action-title">${esc(a.title)}</div>
        </div>
        <div class="agent-action-desc">${esc(a.desc)}</div>
        <button class="agent-approve-btn" onclick="runAgentAction('${tab}',${i})">Approve &amp; Execute</button>
      </div>`;
  }).join('');
}

function runAgentAction(tab, idx) {
  const actions = AGENT_ACTIONS[tab] || AGENT_ACTIONS.ibp;
  const a = actions[idx];
  if (!a) return;

  const card = document.getElementById(`action-card-${tab}-${idx}`);
  if (!card) return;

  const btn = card.querySelector('.agent-approve-btn');
  if (btn) btn.remove();

  const running = document.createElement('div');
  running.className = 'agent-running';
  running.innerHTML = `<span class="spinner sm"></span><span>Executing — connecting to ${a.sys}…</span>`;
  card.appendChild(running);

  setTimeout(() => {
    running.remove();
    const result = document.createElement('div');
    result.className = 'agent-result';
    result.textContent = a.result;
    card.appendChild(result);
  }, 2200 + Math.random() * 600);
}

// ── AI Chat ───────────────────────────────────────────────────────────────────
function setAiQ(btn) {
  const inp = document.getElementById('ai-input');
  if (inp) { inp.value = btn.textContent; inp.focus(); }
}

async function submitAi() {
  const inp      = document.getElementById('ai-input');
  const question = inp ? inp.value.trim() : '';
  if (!question || _aiActive) return;
  _aiActive = true;

  const btn = document.getElementById('ai-btn');
  if (btn) btn.disabled = true;

  const starters = document.getElementById('ai-starters');
  if (starters) starters.classList.add('hidden');
  const thread = document.getElementById('ai-thread');
  if (thread) thread.classList.remove('hidden');

  appendAiMsg('user', question);
  if (inp) inp.value = '';

  const loading = document.getElementById('ai-loading');
  if (loading) { loading.classList.remove('hidden'); loading.style.display = 'flex'; }

  try {
    const res  = await fetch('/supply-chain/api/ai-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    const data = await res.json();
    if (loading) { loading.classList.add('hidden'); loading.style.display = 'none'; }

    const isGenie = data.sources && data.sources.includes('genie');
    const source = isGenie
      ? '✅ Powered by Databricks AI'
      : (data.sources ? `Sources: ${data.sources.join(', ')}` : '✅ Powered by Databricks');
    const msgEl = appendAiMsg('ai', data.answer, source, data.follow_ups || []);

    // Fetch agentic recommendations based on the question + AI answer
    fetch('/supply-chain/api/actions/suggest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, answer: data.answer }),
    })
      .then(r => r.json())
      .then(actions => { if (actions.length) appendActionPanel(msgEl, actions); })
      .catch(() => {});
  } catch (e) {
    if (loading) { loading.classList.add('hidden'); loading.style.display = 'none'; }
    appendAiMsg('ai', 'Network error — please try again.');
  }

  _aiActive = false;
  if (btn) btn.disabled = false;

  const chatBody = document.querySelector('.ai-chat-body');
  if (chatBody) chatBody.scrollTop = chatBody.scrollHeight;
}

async function diagnoseGenie() {
  const box = document.getElementById('genie-diag');
  if (!box) return;
  box.classList.remove('hidden');
  box.textContent = 'Running Genie diagnostics…';
  try {
    const res  = await fetch('/supply-chain/api/debug/genie');
    const data = await res.json();
    const lines = [];
    lines.push(`Genie Space ID  : ${data.genie_space_id || '(not set)'}`);
    lines.push(`Host set        : ${data.host_set}`);
    lines.push(`Host            : ${data.host || '(unknown)'}`);
    lines.push(`DATABRICKS_TOKEN: ${data.token_set}`);
    lines.push(`CLIENT_ID set   : ${data.client_id_set}`);
    lines.push(`CLIENT_SECRET   : ${data.client_secret_set}`);
    lines.push('');
    lines.push(`Start status   : ${data.start_status ?? '—'}`);
    if (data.start_status !== 200) {
      lines.push(`Start error    : ${typeof data.start_body === 'string' ? data.start_body : JSON.stringify(data.start_body, null, 2)}`);
    } else {
      lines.push(`Conv/Msg IDs   : ${data.start_body?.conversation_id} / ${data.start_body?.message_id}`);
      lines.push(`Poll status    : ${data.poll_status ?? '—'}`);
      const pb = data.poll_body;
      if (pb) {
        lines.push(`Genie status   : ${pb.status ?? '—'}`);
        if (pb.status === 'FAILED') lines.push(`Genie error    : ${JSON.stringify(pb.error ?? pb)}`);
      }
      lines.push('');
      lines.push(`Answer         : ${data.answer ? data.answer.slice(0, 300) : '(empty — check Genie space data access)'}`);
    }
    if (data.error) lines.push(`\nException      : ${data.error}`);
    box.textContent = lines.join('\n');
  } catch (e) {
    box.textContent = `Fetch error: ${e.message}`;
  }
}

function appendAiMsg(role, content, source, followUps) {
  const thread = document.getElementById('ai-thread');
  if (!thread) return;

  const div = document.createElement('div');
  div.className = `ai-msg ai-msg-${role}`;

  const av = document.createElement('div');
  av.className = 'ai-avatar';
  if (role === 'ai') {
    av.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M12 2C12 7.8 7.8 12 2 12C7.8 12 12 16.2 12 22C12 16.2 16.2 12 22 12C16.2 12 12 7.8 12 2Z"/></svg>`;
  } else {
    av.textContent = 'ME';
  }

  const wrap   = document.createElement('div');
  const bubble = document.createElement('div');
  bubble.className = 'ai-bubble';
  if (role === 'ai' && typeof marked !== 'undefined') {
    bubble.innerHTML = marked.parse(content);
  } else {
    bubble.textContent = content;
  }
  wrap.appendChild(bubble);

  if (source) {
    const s = document.createElement('div');
    s.className = 'msg-source';
    s.textContent = source;
    wrap.appendChild(s);
  }

  if (followUps && followUps.length) {
    const fups = document.createElement('div');
    fups.className = 'follow-ups';
    followUps.forEach(fu => {
      const b = document.createElement('button');
      b.className   = 'follow-up-btn';
      b.textContent = fu;
      b.onclick     = () => { document.getElementById('ai-input').value = fu; submitAi(); };
      fups.appendChild(b);
    });
    wrap.appendChild(fups);
  }

  div.appendChild(av);
  div.appendChild(wrap);
  thread.appendChild(div);
  return wrap;
}

function appendActionPanel(wrapEl, actions) {
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
    card.id = `action-card-${a.id}`;

    const impact = a.impact_usd > 0
      ? `$${(a.impact_usd / 1000).toFixed(0)}K impact`
      : 'Process improvement';

    card.innerHTML = `
      <div class="action-priority-dot ${a.priority}"></div>
      <div class="action-card-body">
        <div class="action-card-title">${a.label}</div>
        <div class="action-card-desc">${a.description}</div>
        <div class="action-card-meta">
          <span class="action-impact">${impact}</span>
          <span>·</span>
          <span>${a.owner}</span>
          <span>·</span>
          <span>${a.entity_name}</span>
        </div>
        <div class="action-btns">
          <button class="action-approve-btn" onclick="executeAction('${a.id}','approved',this)">Take Action</button>
          <button class="action-dismiss-btn" onclick="executeAction('${a.id}','dismissed',this)">Dismiss</button>
        </div>
      </div>`;
    cards.appendChild(card);
  });

  panel.appendChild(cards);
  wrapEl.appendChild(panel);

  const chatBody = document.querySelector('.ai-chat-body');
  if (chatBody) chatBody.scrollTop = chatBody.scrollHeight;
}

async function executeAction(actionId, outcome, btn) {
  try {
    await fetch('/supply-chain/api/actions/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action_id: actionId, outcome }),
    });
    const card = document.getElementById(`action-card-${actionId}`);
    if (card) {
      const btns = card.querySelector('.action-btns');
      if (btns) {
        btns.innerHTML = outcome === 'approved'
          ? `<div class="action-done-badge"><svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><path d="M20 6L9 17l-5-5"/><path d="M20 6L9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg> Action taken</div>`
          : `<div class="action-done-badge" style="color:var(--text-muted)">Dismissed</div>`;
      }
    }
  } catch (e) { /* silent */ }
}
