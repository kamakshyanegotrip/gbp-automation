/* ==========================================================================
   GBP Automation Console
   Static app. Holds no data of its own — everything comes from the n8n API
   at runtime, authenticated with a token the operator enters once.
   Runs in demo mode until an endpoint is configured.
   ========================================================================== */

'use strict';

/* ---------- dimensions: fixed order, fixed colour, fixed weights ---------- */

const DIMENSIONS = [
  { key: 'business_info', label: 'Business Info', weight: 25, slot: 1 },
  { key: 'photos',        label: 'Photos',        weight: 20, slot: 2 },
  { key: 'reviews',       label: 'Reviews',       weight: 20, slot: 3 },
  { key: 'profile',       label: 'Profile',       weight: 15, slot: 4 },
  { key: 'content',       label: 'Content',       weight: 10, slot: 5 },
  { key: 'services',      label: 'Services',      weight: 10, slot: 6 }
];

const seriesColor = (slot) => `var(--series-${slot})`;

/* ---------- storage: per-viewer convenience only, never required ---------- */

const store = {
  get(k, fallback) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? fallback : v;
    } catch (_) { return fallback; }
  },
  set(k, v) {
    try { localStorage.setItem(k, v); } catch (_) { /* private mode, ignore */ }
  },
  del(k) {
    try { localStorage.removeItem(k); } catch (_) { /* ignore */ }
  }
};

const cfg = {
  get endpoint() { return store.get('gbp.endpoint', ''); },
  get token()    { return store.get('gbp.token', ''); },
  get configured() { return Boolean(this.endpoint && this.token); }
};

/* ---------- app state ---------- */

const state = {
  data: null,
  mode: 'demo',        // demo | live | error
  error: null,
  view: 'overview',
  locationId: null,
  clientId: null,
  busy: new Set()
};

/* ---------- API ---------- */

async function apiGet() {
  if (!cfg.configured) {
    state.mode = 'demo';
    return demoData();
  }
  const url = cfg.endpoint.replace(/\/+$/, '') + '?action=overview';
  const res = await fetch(url, {
    headers: { 'Authorization': 'Bearer ' + cfg.token, 'Accept': 'application/json' }
  });
  if (!res.ok) throw new Error(`API returned ${res.status} ${res.statusText}`);
  state.mode = 'live';
  return res.json();
}

async function apiPost(action, payload) {
  if (!cfg.configured) {
    // Demo mode never pretends a write succeeded against Google.
    throw new Error('Not connected — approvals need a live API endpoint.');
  }
  const url = cfg.endpoint.replace(/\/+$/, '');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + cfg.token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(Object.assign({ action }, payload))
  });
  if (!res.ok) throw new Error(`API returned ${res.status} ${res.statusText}`);
  return res.json();
}

/* ---------- helpers ---------- */

const $ = (sel, root) => (root || document).querySelector(sel);
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const num = (v, dp) => {
  const n = Number(v);
  if (!isFinite(n)) return '—';
  return n.toFixed(dp == null ? 0 : dp);
};

function gradeClass(g) {
  const c = String(g || '').trim().toUpperCase().charAt(0).toLowerCase();
  return 'abcdf'.includes(c) ? c : 'f';
}

function relTime(iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (!isFinite(t)) return '—';
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function deltaHtml(d) {
  const n = Number(d);
  if (!isFinite(n) || n === 0) return '<span class="delta flat">no change</span>';
  const cls = n > 0 ? 'up' : 'down';
  const arrow = n > 0 ? '▲' : '▼';
  return `<span class="delta ${cls}">${arrow} ${Math.abs(n).toFixed(2)}</span>`;
}

/* ---------- tooltip ---------- */

const tip = { el: null };
function showTip(html, x, y) {
  if (!tip.el) {
    tip.el = document.createElement('div');
    tip.el.className = 'tooltip';
    document.body.appendChild(tip.el);
  }
  tip.el.innerHTML = html;
  tip.el.classList.add('on');
  const r = tip.el.getBoundingClientRect();
  let left = x + 14;
  if (left + r.width > window.innerWidth - 8) left = x - r.width - 14;
  let top = y - r.height - 10;
  if (top < 8) top = y + 16;
  tip.el.style.left = left + 'px';
  tip.el.style.top = top + 'px';
}
function hideTip() { if (tip.el) tip.el.classList.remove('on'); }

/* ==========================================================================
   Charts — hand-built SVG, no library, no external request
   ========================================================================== */

/**
 * Score by dimension — one bar per dimension, in fixed slot order.
 * Built as HTML rather than SVG so the tracks flex with the container.
 * Every bar carries a visible value label: three of these hues sit under
 * 3:1 on the light surface, so the relief rule requires readable text.
 */
function dimensionBarsHtml(scores) {
  const rows = DIMENSIONS.map((d) => {
    const raw = Number(scores[d.key + '_score']);
    const v = isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 0;
    return `
      <div class="dim-row" data-label="${esc(d.label)}" data-value="${v.toFixed(2)}" data-weight="${d.weight}">
        <div class="dim-label">${esc(d.label)}</div>
        <div class="dim-track">
          <div class="dim-fill" style="width:${v}%;background:${seriesColor(d.slot)}"></div>
        </div>
        <div class="dim-val">${num(v, 1)}</div>
      </div>`;
  }).join('');

  const legend = DIMENSIONS.map((d) =>
    `<span><i class="swatch" style="background:${seriesColor(d.slot)}"></i>${esc(d.label)} · ${d.weight}%</span>`
  ).join('');

  return `<div class="dims">${rows}</div><div class="legend">${legend}</div>`;
}

/**
 * Score trend. Single series, so no legend box — the section title names it.
 * Crosshair + tooltip on hover, per the interaction rules.
 */
function trendChart(points) {
  if (!points || points.length < 2) {
    return '<p class="empty">Not enough history yet — the trend appears after the second audit.</p>';
  }
  const W = 720, H = 200, padL = 34, padR = 12, padT = 12, padB = 26;
  const xs = points.map((p, i) => i);
  const ys = points.map((p) => Number(p.avg_overall) || 0);
  const yMin = Math.max(0, Math.floor(Math.min.apply(null, ys) / 10) * 10 - 5);
  const yMax = Math.min(100, Math.ceil(Math.max.apply(null, ys) / 10) * 10 + 5);
  const span = (yMax - yMin) || 1;

  const X = (i) => padL + (i / (points.length - 1)) * (W - padL - padR);
  const Y = (v) => padT + (1 - (v - yMin) / span) * (H - padT - padB);

  const ticks = [];
  for (let t = yMin; t <= yMax; t += Math.max(5, Math.round(span / 4 / 5) * 5)) {
    ticks.push(`<line class="gridline" x1="${padL}" y1="${Y(t)}" x2="${W - padR}" y2="${Y(t)}"></line>
                <text x="${padL - 8}" y="${Y(t) + 4}" text-anchor="end">${t}</text>`);
  }

  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${X(i).toFixed(1)},${Y(ys[i]).toFixed(1)}`).join(' ');

  const hits = points.map((p, i) => {
    const w = (W - padL - padR) / points.length;
    return `<rect class="hit" x="${(X(i) - w / 2).toFixed(1)}" y="${padT}" width="${w.toFixed(1)}"
                  height="${H - padT - padB}"
                  data-x="${X(i).toFixed(1)}" data-y="${Y(ys[i]).toFixed(1)}"
                  data-date="${esc(p.score_date)}" data-val="${ys[i].toFixed(2)}"></rect>`;
  }).join('');

  const first = fmtDate(points[0].score_date);
  const last = fmtDate(points[points.length - 1].score_date);

  return `
    <svg class="chart trend" viewBox="0 0 ${W} ${H}" role="img"
         aria-label="Overall health score over time">
      ${ticks.join('')}
      <line class="axisline" x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}"></line>
      <text x="${padL}" y="${H - 6}">${esc(first)}</text>
      <text x="${W - padR}" y="${H - 6}" text-anchor="end">${esc(last)}</text>
      <path class="line" d="${d}" stroke="var(--series-1)"></path>
      <circle class="marker crosshair-dot" r="5" fill="var(--series-1)" style="display:none"></circle>
      <line class="gridline crosshair-line" y1="${padT}" y2="${H - padB}" style="display:none"></line>
      ${hits}
    </svg>`;
}

/* ==========================================================================
   Views
   ========================================================================== */

function statTile(label, value, sub) {
  return `<div class="card tile">
            <div class="label">${esc(label)}</div>
            <div class="value">${value}</div>
            ${sub ? `<div class="sub">${sub}</div>` : ''}
          </div>`;
}

const CASE_KIND_LABEL = {
  content_restriction: 'Content restriction',
  suspension: 'Suspension',
  reinstatement: 'Reinstatement',
  api_allowlist: 'API allowlist',
  review_removal: 'Review removal',
  edit_rejected: 'Edit rejected',
  other: 'Support case',
};

// Open cases with Google. Two things are called out loudly here, because both
// have already cost this project months: a case with no reference recorded,
// and a case past the date Google gave. Neither is a technical failure, which
// is exactly why neither shows up anywhere else.
function appealsHtml(d) {
  const appeals = d.appeals || [];
  if (!appeals.length) return '';

  const overdueCount = appeals.filter((a) => a.overdue === true).length;

  const items = appeals.map((a) => {
    const days = Number(a.days_open);
    const hasRef = !!a.case_reference;
    return `
      <li class="case ${a.overdue === true ? 'is-overdue' : ''}">
        <div class="case-top">
          <strong>${esc(a.subject)}</strong>
          ${hasRef
            ? `<code class="case-ref">${esc(a.case_reference)}</code>`
            : '<span class="chip warn">no reference recorded</span>'}
        </div>
        <p class="case-meta">
          ${esc(a.business_name || 'Account-wide')}
          · ${esc(CASE_KIND_LABEL[a.case_kind] || a.case_kind)}
          ${isFinite(days) ? ` · open ${days} day${days === 1 ? '' : 's'}` : ''}
          ${a.filed_at ? ` · filed ${fmtDate(a.filed_at)}` : ' · not yet filed'}
          ${a.overdue === true ? ' <span class="chip warn">past Google\'s own date</span>' : ''}
        </p>
        ${a.blocks ? `<p class="case-blocks"><span>Blocks</span> ${esc(a.blocks)}</p>` : ''}
        ${a.outcome_clause
          ? `<p class="case-blocks"><span>Clause cited</span> ${esc(a.outcome_clause)}</p>` : ''}
      </li>`;
  }).join('');

  return `
    <div class="section">
      <div class="section-head">
        <h2>Open with Google</h2>
        <p>${overdueCount
              ? `${overdueCount} past the date Google gave — chase on the reference, don't refile`
              : 'Cases filed and awaiting a decision'}</p>
      </div>
      <div class="card"><ul class="cases">${items}</ul></div>
    </div>`;
}

function viewOverview(d) {
  const health = d.health || [];
  const locs = d.locations || [];
  const recs = d.recommendations || [];
  const reviews = d.reviewQueue || [];
  const posts = d.postQueue || [];
  const alerts = (d.alerts || []).filter((a) => !a.acknowledged_at);

  const scored = health.filter((h) => isFinite(Number(h.overall_score)));
  const avg = scored.length
    ? scored.reduce((s, h) => s + Number(h.overall_score), 0) / scored.length
    : null;

  const critical = recs.filter((r) => r.priority === 'critical').length;

  const alertBanner = alerts.length
    ? `<div class="banner ${alerts.some((a) => a.severity === 'critical') ? 'critical' : ''}">
         <strong>${alerts.length} unacknowledged profile ${alerts.length === 1 ? 'alert' : 'alerts'}</strong>
         ${esc(alerts[0].subject || alerts[0].alert_type)}${alerts.length > 1 ? ` — and ${alerts.length - 1} more` : ''}
       </div>` : '';

  const rows = locs.map((l) => {
    const h = health.find((x) => String(x.location_id) === String(l.id)) || {};
    const openRecs = recs.filter((r) => String(r.location_id) === String(l.id)).length;
    const hasScore = isFinite(Number(h.overall_score));
    return `
      <tr class="clickable" data-goto-location="${esc(l.id)}">
        <td>
          <strong>${esc(l.business_name)}</strong>
          <div class="meta" style="color:var(--text-muted);font-size:0.8rem">
            ${esc(l.client_name || 'unassigned')}${l.city ? ' · ' + esc(l.city) : ''}
          </div>
        </td>
        <td>${hasScore
              ? `<span class="grade ${gradeClass(h.grade)}">${esc(h.grade)}</span>`
              : '<span style="color:var(--text-muted);font-size:0.85rem">not audited</span>'}</td>
        <td class="num">${hasScore ? num(h.overall_score, 2) : '—'}</td>
        <td class="num hide-sm">${hasScore ? deltaHtml(h.score_delta) : '—'}</td>
        <td class="num hide-sm">${openRecs}</td>
        <td class="num hide-sm" style="color:var(--text-muted);font-size:0.82rem">
          ${l.api_reachable === false ? 'unreachable' : (hasScore ? relTime(h.scored_at) : '—')}
        </td>
      </tr>`;
  }).join('');

  return `
    ${alertBanner}
    <div class="section">
      <div class="grid tiles">
        ${statTile('Profiles managed', locs.length,
          `${(d.clients || []).length} client${(d.clients || []).length === 1 ? '' : 's'}`)}
        ${statTile('Average health', avg == null ? '—' : num(avg, 1),
          scored.length ? `across ${scored.length} audited` : 'no audits yet')}
        ${statTile('Awaiting approval', reviews.length + posts.length,
          `${reviews.length} replies · ${posts.length} posts`)}
        ${statTile('Critical actions', critical,
          `${recs.length} open recommendation${recs.length === 1 ? '' : 's'}`)}
      </div>
    </div>

    ${appealsHtml(d)}

    <div class="section">
      <div class="section-head"><h2>Profiles</h2><p>Select a profile for its full breakdown</p></div>
      <div class="card">
        ${locs.length ? `
        <table>
          <thead><tr>
            <th>Business</th><th>Grade</th><th class="num">Score</th>
            <th class="num hide-sm">Change</th><th class="num hide-sm">Open</th>
            <th class="num hide-sm">Audited</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>` : '<p class="empty">No profiles yet.</p>'}
      </div>
    </div>`;
}

function viewLocation(d, locId) {
  const loc = (d.locations || []).find((l) => String(l.id) === String(locId));
  if (!loc) return '<p class="empty">Profile not found.</p>';

  const h = (d.health || []).find((x) => String(x.location_id) === String(locId));
  const recs = (d.recommendations || []).filter((r) => String(r.location_id) === String(locId));
  const trend = (d.trend || []).filter((t) => String(t.location_id) === String(locId));
  const perf = (d.performance || [])
    .filter((p) => String(p.location_id) === String(locId))
    .sort((a, b) => String(b.period_month).localeCompare(String(a.period_month)))
    .slice(0, 6);

  const scoreBlock = h ? `
    <div class="grid tiles">
      ${statTile('Overall', `${num(h.overall_score, 2)} <span class="grade ${gradeClass(h.grade)}"
                   style="vertical-align:middle;margin-left:6px">${esc(h.grade)}</span>`,
                 deltaHtml(h.score_delta) + ' · ' + relTime(h.scored_at))}
      ${statTile('Open actions', recs.length,
                 `${recs.filter((r) => r.priority === 'critical').length} critical`)}
      ${statTile('Recoverable', num(recs.reduce((s, r) => s + (Number(r.points_recoverable) || 0), 0), 1),
                 'points if all actions cleared')}
    </div>` : '<div class="banner"><strong>Not yet audited</strong>This profile has no health score. Run the audit workflow to generate one.</div>';

  // Each recommendation is joined to whatever the optimizer has already done
  // about it. The classification of what can be generated lives in the
  // workflow, not here: every check offers a Fix, and one that cannot be
  // generated answers with the reason instead of content.
  const fixable = d.fixable || [];
  const fixByRec = {};
  fixable.forEach((f) => { fixByRec[String(f.recommendation_id)] = f; });

  function fixCell(r) {
    const f = fixByRec[String(r.id)];
    const key = f && f.check_key;
    if (!key) { return '<span style="color:var(--text-muted)">—</span>'; }
    const sk = 'fix-' + key;
    if (f.fix_status === 'generated' || f.fix_status === 'queued') {
      return `<span class="flag info">in review</span>
        <div style="color:var(--text-secondary);font-size:0.8rem">${num(f.fix_item_count)} drafted</div>`;
    }
    if (f.fix_status === 'failed') {
      return `<button class="btn" data-fix="${esc(key)}" data-fix-loc="${esc(r.location_id)}">Retry</button>
        <div class="flag critical" style="margin-top:4px">${esc(f.fix_error || 'failed')}</div>`;
    }
    return `<button class="btn primary" data-fix="${esc(key)}" data-fix-loc="${esc(r.location_id)}">Fix</button>
      <div data-status="${esc(sk)}" style="color:var(--text-secondary);font-size:0.8rem"></div>`;
  }

  const recRows = recs.length ? recs.map((r) => `
    <tr>
      <td><span class="flag ${r.priority === 'critical' ? 'critical' : (r.priority === 'high' ? 'warning' : 'info')}">
            ${esc(r.priority)}</span></td>
      <td><strong>${esc(r.title)}</strong>
          <div style="color:var(--text-secondary);font-size:0.85rem">${esc(r.detail || '')}</div></td>
      <td class="hide-sm" style="color:var(--text-muted);font-size:0.85rem">${esc(r.dimension_name || '')}</td>
      <td class="num">${r.points_recoverable == null ? '—' : '+' + num(r.points_recoverable, 1)}</td>
      <td>${fixCell(r)}</td>
    </tr>`).join('') : '';

  const perfRows = perf.map((p) => `
    <tr>
      <td>${esc(fmtDate(p.period_month))}</td>
      <td class="num">${num(p.total_interactions)}</td>
      <td class="num">${num(p.profile_views)}</td>
      <td class="num hide-sm">${num(p.calls)}</td>
      <td class="num hide-sm">${num(p.website_visits)}</td>
      <td class="num hide-sm">${num(p.direction_requests)}</td>
    </tr>`).join('');

  return `
    <div class="section">
      <div class="section-head">
        <h1>${esc(loc.business_name)}</h1>
        <p>${esc(loc.client_name || 'unassigned')}${loc.city ? ' · ' + esc(loc.city) : ''}</p>
      </div>
      ${scoreBlock}
    </div>

    ${h ? `
    <div class="section grid two">
      <div class="card">
        <div class="section-head"><h2>Score by dimension</h2><p>weighted to 100</p></div>
        ${dimensionBarsHtml(h)}
      </div>
      <div class="card">
        <div class="section-head"><h2>Overall score, last 90 days</h2></div>
        ${trendChart(trend)}
      </div>
    </div>` : ''}

    ${h && h.ai_summary ? `
    <div class="section">
      <div class="card">
        <div class="section-head"><h2>Summary</h2></div>
        <p style="margin:0;color:var(--text-secondary)">${esc(h.ai_summary)}</p>
      </div>
    </div>` : ''}

    <div class="section">
      <div class="section-head">
        <h2>Open recommendations</h2>
        <p>highest priority first</p>
        ${recs.length ? `<button class="btn primary" data-fix-all="${esc(locId)}">Fix everything</button>
          <span data-status="fix-all" style="color:var(--text-secondary);font-size:0.85rem"></span>` : ''}
      </div>
      <div class="card">
        ${recs.length ? `<table>
          <thead><tr><th>Priority</th><th>Action</th><th class="hide-sm">Dimension</th><th class="num">Points</th><th>Fix</th></tr></thead>
          <tbody>${recRows}</tbody></table>`
        : '<p class="empty">Nothing open. Either the profile is in good shape, or it has not been audited.</p>'}
      </div>
    </div>

    ${perf.length ? `
    <div class="section">
      <div class="section-head"><h2>Monthly performance</h2><p>from Google's summary emails</p></div>
      <div class="card">
        <table>
          <thead><tr>
            <th>Month</th><th class="num">Interactions</th><th class="num">Views</th>
            <th class="num hide-sm">Calls</th><th class="num hide-sm">Website</th><th class="num hide-sm">Directions</th>
          </tr></thead>
          <tbody>${perfRows}</tbody>
        </table>
      </div>
    </div>` : ''}`;
}

function viewApprovals(d) {
  const reviews = d.reviewQueue || [];
  const posts = d.postQueue || [];

  const connBanner = cfg.configured ? '' : `
    <div class="banner">
      <strong>Demo mode — approvals are disabled</strong>
      Connect a live endpoint to approve or reject anything. Nothing here can reach Google.
    </div>`;

  const reviewCards = reviews.map((r) => {
    const stars = '★'.repeat(Math.max(0, Math.min(5, Number(r.star_rating) || 0)))
                + '☆'.repeat(5 - Math.max(0, Math.min(5, Number(r.star_rating) || 0)));
    const flags = [];
    if (r.requires_escalation) flags.push('<span class="flag critical">needs a human</span>');
    if (r.comment_truncated) flags.push('<span class="flag warning">text truncated — read it on Google first</span>');
    if (Number(r.failed_attempts) > 0) flags.push(`<span class="flag warning">${r.failed_attempts} failed send${r.failed_attempts > 1 ? 's' : ''}</span>`);
    const link = r.review_url
      ? `<a href="${esc(r.review_url)}" target="_blank" rel="noopener noreferrer">open on Google</a>` : '';

    return `
      <div class="qcard" data-review="${esc(r.id)}">
        <div class="qhead">
          <div>
            <div class="who">${esc(r.reviewer_display_name || 'Anonymous')}</div>
            <div class="meta">${esc(r.business_name)} · ${relTime(r.review_created_at)} ${link ? '· ' + link : ''}</div>
          </div>
          <div class="stars" style="margin-left:auto" aria-label="${Number(r.star_rating) || 0} out of 5">${stars}</div>
        </div>
        ${flags.length ? `<div class="qactions" style="margin:0 0 8px">${flags.join('')}</div>` : ''}
        ${r.comment ? `<div class="quote">${esc(r.comment)}</div>`
                    : '<div class="quote" style="font-style:italic">Rating only — no text left.</div>'}
        <label class="sronly" for="reply-${esc(r.id)}">Reply to ${esc(r.reviewer_display_name || 'this review')}</label>
        <textarea class="draft" id="reply-${esc(r.id)}">${esc(r.ai_suggested_reply || '')}</textarea>
        <div class="qactions">
          <button class="btn primary" data-approve-reply="${esc(r.id)}" ${cfg.configured ? '' : 'disabled'}>Approve &amp; send</button>
          <button class="btn danger" data-reject-reply="${esc(r.id)}" ${cfg.configured ? '' : 'disabled'}>Reject</button>
          <button class="btn" data-ask="reply-${esc(r.id)}" ${cfg.configured ? '' : 'disabled'}>Ask Claude</button>
          <span class="meta" style="color:var(--text-muted);font-size:0.8rem" data-status="${esc(r.id)}"></span>
        </div>
      </div>`;
  }).join('');

  const postCards = posts.map((p) => `
    <div class="qcard" data-post="${esc(p.id)}">
      <div class="qhead">
        <div>
          <div class="who">${esc(p.topic_type || 'STANDARD')} post</div>
          <div class="meta">${esc(p.business_name || '')} · ${p.scheduled_for ? 'scheduled ' + fmtDate(p.scheduled_for) : 'unscheduled'}</div>
        </div>
      </div>
      <label class="sronly" for="post-${esc(p.id)}">Post text</label>
      <textarea class="draft" id="post-${esc(p.id)}">${esc(p.summary || '')}</textarea>
      ${p.cta_url ? `<p class="hint">CTA ${esc(p.cta_type || '')} → ${esc(p.cta_url)}</p>` : ''}
      <div class="qactions">
        <button class="btn primary" data-approve-post="${esc(p.id)}" ${cfg.configured ? '' : 'disabled'}>Approve</button>
        <button class="btn" data-save-post="${esc(p.id)}" ${cfg.configured ? '' : 'disabled'}>Save draft</button>
        <button class="btn danger" data-reject-post="${esc(p.id)}" ${cfg.configured ? '' : 'disabled'}>Reject</button>
        <button class="btn" data-ask="post-${esc(p.id)}" ${cfg.configured ? '' : 'disabled'}>Ask Claude</button>
        <span class="meta" style="color:var(--text-muted);font-size:0.8rem" data-status="${esc(p.id)}"></span>
      </div>
    </div>`).join('');

  const locOptions = (d.locations || [])
    .map((l) => `<option value="${esc(l.id)}">${esc(l.business_name)}</option>`).join('');

  const ctaOptions = ['', 'BOOK', 'ORDER', 'SHOP', 'LEARN_MORE', 'SIGN_UP', 'CALL', 'GET_OFFER']
    .map((c) => `<option value="${c}">${c || 'No call to action'}</option>`).join('');

  // Writing a post by hand. It lands in the same queue as an automated draft
  // and still has to be approved — the console never publishes.
  const compose = `
    <div class="section">
      <div class="section-head">
        <h2>Write a post</h2>
        <p>Goes into the queue below as a draft. Approving is still a separate act.</p>
      </div>
      <div class="card">
        <div class="grid two">
          <label class="field">Profile
            <select id="new-post-loc">${locOptions || '<option value="">No profiles</option>'}</select>
          </label>
          <label class="field">Call to action
            <select id="new-post-cta">${ctaOptions}</select>
          </label>
        </div>
        <label class="field">Post text
          <textarea class="draft" id="new-post-text" rows="5"
            placeholder="What are you telling people?"></textarea>
        </label>
        <label class="field">Link
          <input type="url" id="new-post-url" placeholder="https://negotrip.in/..." spellcheck="false">
        </label>
        <div class="qactions">
          <button class="btn primary" id="new-post-save" ${cfg.configured ? '' : 'disabled'}>Add to queue</button>
          <button class="btn" data-ask="new-post-text" ${cfg.configured ? '' : 'disabled'}>Ask Claude</button>
          <span class="meta" style="color:var(--text-muted);font-size:0.8rem" data-status="new-post"></span>
        </div>
        <p class="hint">
          Posting is switched off on the Negotrip profile until the content
          appeal is decided, so a post approved now waits in the queue rather
          than publishing.
        </p>
      </div>
    </div>`;

  return `
    ${connBanner}
    ${compose}
    <div class="section">
      <div class="section-head"><h2>Review replies</h2><p>${reviews.length} awaiting approval</p></div>
      <div class="queue">${reviews.length ? reviewCards : '<div class="card"><p class="empty">Queue is clear.</p></div>'}</div>
    </div>
    <div class="section">
      <div class="section-head"><h2>Posts</h2><p>${posts.length} held</p></div>
      <div class="queue">${posts.length ? postCards : '<div class="card"><p class="empty">Nothing held.</p></div>'}</div>
    </div>`;
}

function viewPortal(d, clientId) {
  const clients = d.clients || [];
  const client = clients.find((c) => String(c.id) === String(clientId)) || clients[0];
  if (!client) return '<p class="empty">No clients configured.</p>';

  const locs = (d.locations || []).filter((l) => String(l.client_id) === String(client.id));
  const health = (d.health || []).filter((h) => locs.some((l) => String(l.id) === String(h.location_id)));
  const recs = (d.recommendations || []).filter((r) => locs.some((l) => String(l.id) === String(r.location_id)));
  const avg = health.length ? health.reduce((s, h) => s + (Number(h.overall_score) || 0), 0) / health.length : null;

  const picker = clients.length > 1 ? `
    <div class="qactions" style="margin-bottom:18px">
      ${clients.map((c) => `<button class="btn ${String(c.id) === String(client.id) ? 'primary' : ''}"
         data-goto-client="${esc(c.id)}">${esc(c.client_name)}</button>`).join('')}
    </div>` : '';

  const cards = locs.map((l) => {
    const h = health.find((x) => String(x.location_id) === String(l.id));
    const myRecs = recs.filter((r) => String(r.location_id) === String(l.id)).slice(0, 4);
    return `
      <div class="card">
        <div class="section-head">
          <h2>${esc(l.business_name)}</h2>
          ${h ? `<span class="grade ${gradeClass(h.grade)}">${esc(h.grade)}</span>
                 <p>${num(h.overall_score, 1)} / 100 · ${deltaHtml(h.score_delta)}</p>` : '<p>awaiting first audit</p>'}
        </div>
        ${h ? dimensionBarsHtml(h) : ''}
        ${myRecs.length ? `
          <h3 style="margin:18px 0 8px">What we are working on</h3>
          <ul style="margin:0;padding-left:18px;color:var(--text-secondary);font-size:0.9rem">
            ${myRecs.map((r) => `<li style="margin-bottom:5px">${esc(r.title)}</li>`).join('')}
          </ul>` : ''}
      </div>`;
  }).join('');

  return `
    <div class="section">
      <div class="section-head">
        <h1>${esc(client.client_name)}</h1>
        <p>Profile health report · ${fmtDate(new Date().toISOString())}</p>
      </div>
      ${picker}
      <div class="grid tiles">
        ${statTile('Profiles', locs.length, '')}
        ${statTile('Average health', avg == null ? '—' : num(avg, 1), avg == null ? 'not yet audited' : 'out of 100')}
        ${statTile('Actions identified', recs.length, 'being worked through')}
      </div>
    </div>
    <div class="section grid two">${cards || '<p class="empty">No profiles for this client.</p>'}</div>
    <p class="hint">Prepared by Assign Over. Figures come from Google Business Profile and are refreshed on each audit.</p>`;
}

/* ==========================================================================
   Render & events
   ========================================================================== */

// Settings deliberately stops short of the two switches that would turn this
// from suggest-only into autonomous publishing. Those stay a deliberate
// database change; a button is too easy to press by accident.
function viewSettings(d) {
  const locs = d.locations || [];
  const clients = d.clients || [];
  const appeals = d.appeals || [];

  const banner = cfg.configured ? '' : `
    <div class="banner">
      <strong>Demo mode — nothing here saves</strong>
      Connect a live endpoint to change settings.
    </div>`;

  const locRows = locs.map((l) => `
    <div class="qcard" data-setting-loc="${esc(l.id)}">
      <div class="qhead"><div>
        <div class="who">${esc(l.business_name)}</div>
        <div class="meta">${esc(l.client_name || 'unassigned')}${l.city ? ' · ' + esc(l.city) : ''}</div>
      </div></div>
      <div class="grid two">
        <label class="field">Audited
          <select id="loc-audit-${esc(l.id)}">
            <option value="true"  ${l.audit_enabled === true ? 'selected' : ''}>Yes</option>
            <option value="false" ${l.audit_enabled === true ? '' : 'selected'}>No</option>
          </select>
        </label>
        <label class="field">Report emails
          <input type="text" id="loc-mail-${esc(l.id)}" value="${esc(l.notify_emails || '')}"
                 placeholder="comma separated" spellcheck="false">
        </label>
      </div>
      <div class="qactions">
        <button class="btn primary" data-save-loc="${esc(l.id)}" ${cfg.configured ? '' : 'disabled'}>Save</button>
        <span class="meta" style="color:var(--text-muted);font-size:0.8rem" data-status="loc-${esc(l.id)}"></span>
      </div>
      <p class="hint">
        Auto-reply ${l.auto_reply_enabled ? 'on' : 'off'} · auto-post
        ${l.auto_post_enabled ? 'on' : 'off'} — both changed in the database only.
      </p>
    </div>`).join('');

  const clientRows = clients.map((c) => `
    <div class="qcard">
      <div class="qhead"><div>
        <div class="who">${esc(c.client_name)}</div>
        <div class="meta">${esc(c.client_code)}</div>
      </div></div>
      <div class="grid two">
        <label class="field">Name
          <input type="text" id="cli-name-${esc(c.id)}" value="${esc(c.client_name || '')}">
        </label>
        <label class="field">Status
          <select id="cli-status-${esc(c.id)}">
            ${['active', 'paused', 'offboarding', 'closed'].map((s) =>
              `<option value="${s}" ${c.status === s ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="qactions">
        <button class="btn primary" data-save-client="${esc(c.id)}" ${cfg.configured ? '' : 'disabled'}>Save</button>
        <span class="meta" style="color:var(--text-muted);font-size:0.8rem" data-status="cli-${esc(c.id)}"></span>
      </div>
    </div>`).join('');

  const appealRows = appeals.map((a) => `
    <div class="qcard">
      <div class="qhead"><div>
        <div class="who">${esc(a.subject)}</div>
        <div class="meta">${a.case_reference ? esc(a.case_reference) : 'no reference'} ·
          ${esc(a.business_name || 'account-wide')}${a.overdue ? ' · overdue' : ''}</div>
      </div></div>
      <div class="grid two">
        <label class="field">What Google said
          <select id="app-outcome-${esc(a.id)}">
            <option value="">No decision yet</option>
            ${['granted', 'partial', 'refused', 'unanswered', 'withdrawn'].map((o) =>
              `<option value="${o}" ${a.outcome === o ? 'selected' : ''}>${o}</option>`).join('')}
          </select>
        </label>
        <label class="field">Case reference
          <input type="text" id="app-ref-${esc(a.id)}" value="${esc(a.case_reference || '')}" spellcheck="false">
        </label>
      </div>
      <label class="field">Clause they cited, if any
        <input type="text" id="app-clause-${esc(a.id)}" value="${esc(a.outcome_clause || '')}">
      </label>
      <div class="qactions">
        <button class="btn primary" data-save-appeal="${esc(a.id)}" ${cfg.configured ? '' : 'disabled'}>Record</button>
        <button class="btn" data-close-appeal="${esc(a.id)}" ${cfg.configured ? '' : 'disabled'}>Record &amp; close</button>
        <span class="meta" style="color:var(--text-muted);font-size:0.8rem" data-status="app-${esc(a.id)}"></span>
      </div>
      <p class="hint">Closing needs an outcome. "unanswered" is a real one — use it rather than leaving a dead case open.</p>
    </div>`).join('');

  // Services go in and out as "Name :: description" lines. A table of inputs
  // would be more precise and far worse to use for a list this short; the
  // separator is :: because service names contain commas and dashes.
  const servicesToText = (rows) => rows
    .map((s) => s.description ? `${s.display_name} :: ${s.description}` : s.display_name)
    .join('\n');

  const edits = d.profileEdits || [];
  const allServices = d.services || [];

  const profileRows = locs.map((l) => {
    const edit = edits.find((e) => String(e.location_id) === String(l.id));
    const live = allServices.filter((s) => String(s.location_id) === String(l.id));

    // An unapplied edit wins over the live list, otherwise re-opening the page
    // would quietly discard what was typed yesterday.
    const serviceText = edit && Array.isArray(edit.services)
      ? servicesToText(edit.services)
      : servicesToText(live);

    const state = !edit ? ''
      : edit.status === 'failed'
        ? `<div class="banner critical"><strong>The last attempt failed</strong>${esc(edit.apply_error || '')}</div>`
        : edit.status === 'pending'
          ? `<div class="banner"><strong>Queued</strong>Submitted ${relTime(edit.submitted_at)} — waiting for the applier to run.</div>`
          : `<div class="banner"><strong>Draft saved</strong>Not submitted. Nothing has been sent to Google.</div>`;

    return `
      <div class="qcard" data-profile="${esc(l.id)}">
        <div class="qhead"><div>
          <div class="who">${esc(l.business_name)}</div>
          <div class="meta">${live.length} service${live.length === 1 ? '' : 's'} on the profile now</div>
        </div></div>
        ${state}
        <label class="field">Business description
          <textarea class="draft" id="pe-desc-${esc(l.id)}" rows="5"
            placeholder="Leave empty to leave the current description untouched.">${esc(edit && edit.description != null ? edit.description : '')}</textarea>
        </label>
        <label class="field">Services — one per line, <code>Name :: description</code>
          <textarea class="draft" id="pe-svc-${esc(l.id)}" rows="6">${esc(serviceText)}</textarea>
        </label>
        <label class="field">Why (kept with the change)
          <input type="text" id="pe-note-${esc(l.id)}" value="${esc(edit && edit.note || '')}">
        </label>
        <div class="qactions">
          <button class="btn" data-save-profile="${esc(l.id)}" ${cfg.configured ? '' : 'disabled'}>Save draft</button>
          <button class="btn primary" data-submit-profile="${esc(l.id)}" ${cfg.configured ? '' : 'disabled'}>Submit to Google</button>
          <button class="btn" data-ask="pe-desc-${esc(l.id)}" ${cfg.configured ? '' : 'disabled'}>Ask Claude</button>
          <span class="meta" style="color:var(--text-muted);font-size:0.8rem" data-status="pe-${esc(l.id)}"></span>
        </div>
        <p class="hint">
          <strong>The service list is sent whole.</strong> Google has no partial
          update for services — whatever is in that box becomes the entire list.
          The applier carries the existing services forward and refuses a merged
          list shorter than the live one, so removing a service deliberately
          takes a second step. Only the name is sent; the text after
          <code>::</code> is kept here but not written to Google, because that
          field's shape is unverified.
        </p>
        <p class="hint">
          Submitting queues the change. <strong>Nothing is sent until the Apply
          Profile Content workflow runs</strong>, and that workflow needs the
          Business Profile API, which is still waiting on the allowlist. Until
          then a submitted edit sits queued.
        </p>
      </div>`;
  }).join('');

  return `
    ${banner}
    <div class="section">
      <div class="section-head">
        <h2>Profile content</h2>
        <p>Description and services. Saving is not submitting.</p>
      </div>
      <div class="queue">${locs.length ? profileRows : '<div class="card"><p class="empty">No profiles.</p></div>'}</div>
      <p class="hint">
        Opening hours are not editable here yet — the schema carries them but the
        editor does not, so they stay a workflow change for now.
      </p>
    </div>
    <div class="section">
      <div class="section-head"><h2>Profiles</h2><p>What gets audited, and where reports go</p></div>
      <div class="queue">${locs.length ? locRows : '<div class="card"><p class="empty">No profiles.</p></div>'}</div>
    </div>
    <div class="section">
      <div class="section-head"><h2>Clients</h2><p>${clients.length} on the books</p></div>
      <div class="queue">${clients.length ? clientRows : '<div class="card"><p class="empty">No clients.</p></div>'}</div>
    </div>
    <div class="section">
      <div class="section-head"><h2>Open with Google</h2><p>Record a decision when one arrives</p></div>
      <div class="queue">${appeals.length ? appealRows : '<div class="card"><p class="empty">No open cases.</p></div>'}</div>
    </div>`;
}

function render() {
  const main = $('#main');
  const d = state.data;

  if (state.error) {
    main.innerHTML = `<div class="banner critical">
        <strong>Could not load data</strong>${esc(state.error)}
      </div>
      <div class="card"><p class="empty">
        Check the endpoint and token under <em>Connection</em>, or carry on in demo mode.
      </p></div>`;
    return;
  }
  if (!d) { main.innerHTML = '<p class="empty">Loading…</p>'; return; }

  let html = '';
  if (state.view === 'overview')       html = viewOverview(d);
  else if (state.view === 'location')  html = viewLocation(d, state.locationId);
  else if (state.view === 'approvals') html = viewApprovals(d);
  else if (state.view === 'portal')    html = viewPortal(d, state.clientId);
  else if (state.view === 'settings')  html = viewSettings(d);
  main.innerHTML = html;

  document.querySelectorAll('nav.views button').forEach((b) => {
    b.setAttribute('aria-current', String(b.dataset.view === state.view));
  });

  wireCharts();
}

function wireCharts() {
  document.querySelectorAll('.dim-row').forEach((row) => {
    row.addEventListener('mousemove', (e) => {
      showTip(
        `<div class="tt-k">${esc(row.dataset.label)}</div>
         <div class="tt-v">${esc(row.dataset.value)} / 100</div>
         <div class="tt-k">weight ${esc(row.dataset.weight)}%</div>`,
        e.clientX, e.clientY
      );
    });
    row.addEventListener('mouseleave', hideTip);
  });

  document.querySelectorAll('svg.trend').forEach((svg) => {
    const dot = svg.querySelector('.crosshair-dot');
    const line = svg.querySelector('.crosshair-line');
    svg.querySelectorAll('.hit').forEach((hit) => {
      hit.addEventListener('mousemove', (e) => {
        const x = hit.dataset.x, y = hit.dataset.y;
        if (dot) { dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.style.display = ''; }
        if (line) { line.setAttribute('x1', x); line.setAttribute('x2', x); line.style.display = ''; }
        showTip(
          `<div class="tt-k">${esc(fmtDate(hit.dataset.date))}</div>
           <div class="tt-v">${esc(hit.dataset.val)} / 100</div>`,
          e.clientX, e.clientY
        );
      });
    });
    svg.addEventListener('mouseleave', () => {
      hideTip();
      if (dot) dot.style.display = 'none';
      if (line) line.style.display = 'none';
    });
  });
}

function setConnBadge() {
  const badge = $('#conn');
  const dot = $('#conn .dot');
  const label = $('#conn .conn-label');
  dot.className = 'dot ' + (state.mode === 'live' ? 'live' : state.mode === 'error' ? 'err' : 'demo');
  label.textContent = state.mode === 'live' ? 'Live' : state.mode === 'error' ? 'Error' : 'Demo data';
  badge.title = cfg.configured ? 'Connected to ' + cfg.endpoint : 'Not connected — showing sample data';
}

async function load() {
  try {
    state.error = null;
    state.data = await apiGet();
  } catch (err) {
    state.mode = 'error';
    state.error = err.message || String(err);
    state.data = null;
  }
  setConnBadge();
  render();
}

/* ---------- approvals ---------- */

async function act(btn, action, id, textEl, verb) {
  const statusEl = document.querySelector(`[data-status="${CSS.escape(id)}"]`);
  const card = btn.closest('.qcard');
  btn.disabled = true;
  if (statusEl) statusEl.textContent = 'Sending…';
  try {
    const text = textEl ? textEl.value.trim() : undefined;
    await apiPost(action, { id, text });
    if (card) {
      card.style.transition = 'opacity .25s';
      card.style.opacity = '0.4';
      card.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    }
    if (statusEl) statusEl.textContent = verb;
  } catch (err) {
    btn.disabled = false;
    if (statusEl) statusEl.textContent = 'Failed: ' + (err.message || err);
  }
}

// A write that is not approve-or-reject: no card to fade, just a status line.
async function send(btn, body, statusKey, done) {
  const statusEl = document.querySelector(`[data-status="${CSS.escape(statusKey)}"]`);
  btn.disabled = true;
  if (statusEl) statusEl.textContent = 'Saving…';
  try {
    const res = await apiPost(body.action, body);
    if (res && res.ok === false) throw new Error('nothing matched — the row may have changed');
    if (statusEl) statusEl.textContent = done;
    return res;
  } catch (err) {
    if (statusEl) statusEl.textContent = 'Failed: ' + (err.message || err);
    throw err;
  } finally {
    btn.disabled = false;
  }
}

/* ---------- the Claude panel ---------- */

// Which editor the answer goes back into. Set when the dialog opens so that
// "put this in the editor" cannot land in the wrong box.
const ai = { targetId: null };

function openAi(targetId) {
  ai.targetId = targetId;
  const dlg = $('#ai-dialog');
  const target = document.getElementById(targetId);
  const existing = target && target.value.trim();
  $('#ai-context-note').textContent = existing
    ? 'The current text in that editor will be sent along with your request.'
    : 'That editor is empty, so only your request is sent.';
  $('#ai-out').hidden = true;
  $('#ai-result').value = '';
  $('#ai-prompt').value = '';
  dlg.showModal();
  $('#ai-prompt').focus();
}

async function runAi() {
  const btn = $('#ai-run');
  const ask = $('#ai-prompt').value.trim();
  if (!ask) { $('#ai-prompt').focus(); return; }
  const target = ai.targetId ? document.getElementById(ai.targetId) : null;
  const existing = target ? target.value.trim() : '';

  // The model sees only what is assembled here. Nothing about the business is
  // attached implicitly, which is why the dialog says so.
  const prompt = existing
    ? `Current text:\n\n${existing}\n\n---\n\n${ask}`
    : ask;

  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Thinking…';
  try {
    const res = await apiPost('ask_claude', { prompt });
    if (!res || !res.ok) throw new Error((res && res.error) || 'no text came back');
    $('#ai-result').value = res.text || '';
    $('#ai-out').hidden = false;
    $('#ai-result').focus();
  } catch (err) {
    $('#ai-result').value = '';
    $('#ai-out').hidden = false;
    $('#ai-context-note').textContent = 'Failed: ' + (err.message || err);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// Running the optimizer is a generate-and-file action, never a publish. A
// check that cannot be generated answers with the reason, which is shown
// as-is rather than being translated into a guess about why.
async function runOptimizer(btn, checkKey, locationId, statusKey) {
  const statusEl = document.querySelector(`[data-status="${CSS.escape(statusKey)}"]`);
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Writing…';
  if (statusEl) statusEl.textContent = '';
  try {
    const body = { location_id: locationId };
    if (checkKey) { body.check_key = checkKey; }
    const res = await apiPost('run_optimizer', body);
    const n = (res && res.generated) || 0;
    if (n > 0) {
      if (statusEl) statusEl.textContent = n + ' drafted — waiting for approval';
      await load();
    } else if (statusEl) {
      statusEl.textContent = res && res.reason ? res.reason : 'nothing to generate';
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = 'Failed: ' + (err.message || err);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

document.addEventListener('click', (e) => {
  const t = e.target;

  const fixBtn = t.closest('[data-fix]');
  if (fixBtn) {
    return runOptimizer(fixBtn, fixBtn.dataset.fix, fixBtn.dataset.fixLoc, 'fix-' + fixBtn.dataset.fix);
  }
  const fixAll = t.closest('[data-fix-all]');
  if (fixAll) {
    return runOptimizer(fixAll, null, fixAll.dataset.fixAll, 'fix-all');
  }

  const loc = t.closest('[data-goto-location]');
  if (loc) { state.view = 'location'; state.locationId = loc.dataset.gotoLocation; render(); window.scrollTo(0, 0); return; }

  const cli = t.closest('[data-goto-client]');
  if (cli) { state.clientId = cli.dataset.gotoClient; render(); return; }

  if (t.dataset && t.dataset.view) { state.view = t.dataset.view; render(); window.scrollTo(0, 0); return; }

  if (t.dataset && t.dataset.approveReply)
    return act(t, 'approve_reply', t.dataset.approveReply, $('#reply-' + CSS.escape(t.dataset.approveReply)), 'Approved');
  if (t.dataset && t.dataset.rejectReply)
    return act(t, 'reject_reply', t.dataset.rejectReply, null, 'Rejected');
  if (t.dataset && t.dataset.approvePost)
    return act(t, 'approve_post', t.dataset.approvePost, $('#post-' + CSS.escape(t.dataset.approvePost)), 'Approved');
  if (t.dataset && t.dataset.rejectPost)
    return act(t, 'reject_post', t.dataset.rejectPost, null, 'Rejected');

  if (t.dataset && t.dataset.ask) return openAi(t.dataset.ask);

  if (t.dataset && t.dataset.savePost) {
    const id = t.dataset.savePost;
    const el = $('#post-' + CSS.escape(id));
    return send(t, { action: 'save_post', id, text: el ? el.value.trim() : '' }, id, 'Saved');
  }

  if (t.id === 'new-post-save') {
    const loc = $('#new-post-loc');
    const text = $('#new-post-text').value.trim();
    if (!text) {
      document.querySelector('[data-status="new-post"]').textContent = 'Write something first.';
      return;
    }
    return send(t, {
      action: 'create_post',
      location_id: loc ? loc.value : '',
      text,
      cta_type: $('#new-post-cta').value,
      cta_url: $('#new-post-url').value.trim()
    }, 'new-post', 'Added to the queue').then(() => {
      $('#new-post-text').value = '';
      $('#new-post-url').value = '';
      load();
    }).catch(() => {});
  }

  if (t.dataset && t.dataset.saveLoc) {
    const id = t.dataset.saveLoc;
    return send(t, {
      action: 'update_location',
      location_id: id,
      audit_enabled: $('#loc-audit-' + CSS.escape(id)).value,
      notify_emails: $('#loc-mail-' + CSS.escape(id)).value.trim()
    }, 'loc-' + id, 'Saved').catch(() => {});
  }

  if (t.dataset && (t.dataset.saveProfile || t.dataset.submitProfile)) {
    const id = t.dataset.saveProfile || t.dataset.submitProfile;
    const submitting = !!t.dataset.submitProfile;
    const desc = $('#pe-desc-' + CSS.escape(id)).value;
    const svcText = $('#pe-svc-' + CSS.escape(id)).value;

    // "Name :: description", one per line. Blank lines are dropped rather than
    // becoming an empty service, which Google would reject anyway.
    const services = svcText.split('\n').map((line) => {
      const raw = line.trim();
      if (!raw) return null;
      const i = raw.indexOf('::');
      return i === -1
        ? { display_name: raw }
        : { display_name: raw.slice(0, i).trim(), description: raw.slice(i + 2).trim() };
    }).filter(Boolean).filter((s) => s.display_name);

    const body = {
      action: 'save_profile_edit',
      location_id: id,
      note: $('#pe-note-' + CSS.escape(id)).value.trim()
    };
    // Only send what was actually filled in: an absent key means "leave that
    // part of the profile alone", which is not the same as sending "".
    if (desc.trim()) body.description = desc.trim();
    if (services.length) body.services = services;

    if (!body.description && !body.services) {
      document.querySelector(`[data-status="pe-${CSS.escape(id)}"]`).textContent =
        'Nothing to save — fill in a description or some services.';
      return;
    }

    return send(t, body, 'pe-' + id, submitting ? 'Saved' : 'Draft saved')
      .then(() => submitting
        ? send(t, { action: 'submit_profile_edit', location_id: id }, 'pe-' + id, 'Queued for the applier')
            .then(() => load())
        : load())
      .catch(() => {});
  }

  if (t.dataset && t.dataset.saveClient) {
    const id = t.dataset.saveClient;
    return send(t, {
      action: 'update_client',
      id,
      client_name: $('#cli-name-' + CSS.escape(id)).value.trim(),
      status: $('#cli-status-' + CSS.escape(id)).value
    }, 'cli-' + id, 'Saved').catch(() => {});
  }

  if (t.dataset && (t.dataset.saveAppeal || t.dataset.closeAppeal)) {
    const id = t.dataset.saveAppeal || t.dataset.closeAppeal;
    const closing = !!t.dataset.closeAppeal;
    const outcome = $('#app-outcome-' + CSS.escape(id)).value;
    if (closing && !outcome) {
      document.querySelector(`[data-status="app-${CSS.escape(id)}"]`).textContent =
        'Pick what Google said before closing it.';
      return;
    }
    return send(t, {
      action: 'record_appeal',
      id,
      outcome,
      case_reference: $('#app-ref-' + CSS.escape(id)).value.trim(),
      outcome_clause: $('#app-clause-' + CSS.escape(id)).value.trim(),
      status: closing ? 'closed' : (outcome ? 'responded' : '')
    }, 'app-' + id, closing ? 'Closed' : 'Recorded').then(() => { if (closing) load(); }).catch(() => {});
  }
});

/* ---------- connection dialog ---------- */

function initConnection() {
  const dlg = $('#conn-dialog');
  $('#conn').addEventListener('click', () => {
    $('#f-endpoint').value = cfg.endpoint;
    $('#f-token').value = cfg.token;
    dlg.showModal();
  });
  $('#conn-save').addEventListener('click', (e) => {
    e.preventDefault();
    const ep = $('#f-endpoint').value.trim();
    const tk = $('#f-token').value.trim();
    if (ep) store.set('gbp.endpoint', ep); else store.del('gbp.endpoint');
    if (tk) store.set('gbp.token', tk); else store.del('gbp.token');
    dlg.close();
    load();
  });
  $('#conn-clear').addEventListener('click', (e) => {
    e.preventDefault();
    store.del('gbp.endpoint'); store.del('gbp.token');
    dlg.close();
    load();
  });
}

/* ---------- theme ---------- */

function initTheme() {
  const saved = store.get('gbp.theme', '');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
  $('#theme').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    const isDark = cur ? cur === 'dark'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    const next = isDark ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    store.set('gbp.theme', next);
  });
}

/* ==========================================================================
   Demo data — clearly synthetic, so nothing real is ever published here
   ========================================================================== */

function demoData() {
  const today = new Date();
  const trend = [];
  for (let i = 11; i >= 0; i--) {
    const dt = new Date(today.getTime() - i * 7 * 86400000);
    trend.push({
      location_id: 1,
      score_date: dt.toISOString().slice(0, 10),
      avg_overall: +(48 + (11 - i) * 0.75 + Math.sin(i) * 1.8).toFixed(2)
    });
  }
  return {
    demo: true,
    generatedAt: today.toISOString(),
    clients: [
      { id: 1, client_code: 'demo-one', client_name: 'Sample Client', status: 'active' }
    ],
    services: [
      { location_id: 1, service_key: 'svc_tour', display_name: 'Odisha tour packages',
        description: 'Guided multi-day itineraries across Odisha.',
        price_amount_micros: null, price_currency: null },
      { location_id: 1, service_key: 'svc_transfer', display_name: 'Airport transfers',
        description: null, price_amount_micros: null, price_currency: null }
    ],
    profileEdits: [],
    // Two shapes on purpose: one case healthy, one overdue with no reference —
    // the state the tracker exists to make impossible to overlook.
    appeals: [
      { id: 1, location_id: 1, business_name: 'Sample Travel Co',
        case_kind: 'content_restriction', case_reference: '0-0000000000000',
        subject: 'Posting disabled after a policy removal', channel: 'email',
        status: 'awaiting_google',
        filed_at: new Date(today.getTime() - 2 * 86400000).toISOString(),
        days_open: 2, overdue: false,
        blocks: 'All posts and photos until it is resolved.' },
      { id: 2, location_id: null, business_name: null,
        case_kind: 'api_allowlist', case_reference: null,
        subject: 'API allowlist request', channel: 'form',
        status: 'awaiting_google',
        filed_at: new Date(today.getTime() - 23 * 86400000).toISOString(),
        days_open: 23, overdue: true,
        blocks: 'Reviews, posts and photos over the API.' }
    ],
    locations: [
      { id: 1, business_name: 'Sample Travel Co', city: 'Bhubaneswar', client_id: 1,
        client_name: 'Sample Client', api_reachable: true, auto_reply_enabled: false },
      { id: 2, business_name: 'Sample Stays', city: 'Bhubaneswar', client_id: 1,
        client_name: 'Sample Client', api_reachable: true, auto_reply_enabled: false }
    ],
    health: [
      { location_id: 1, business_name: 'Sample Travel Co', overall_score: 54.91, grade: 'D',
        business_info_score: 72.0, photos_score: 31.5, reviews_score: 68.0,
        profile_score: 55.0, content_score: 22.0, services_score: 60.0,
        score_delta: 2.35, scored_at: new Date(today.getTime() - 6 * 3600000).toISOString(),
        ai_summary: 'Photos and content are the weak dimensions. Business info is solid. Adding a dozen recent photos would recover the most points for the least effort.' }
    ],
    recommendations: [
      { id: 1, location_id: 1, business_name: 'Sample Travel Co', dimension_name: 'Photos',
        priority: 'critical', title: 'Fewer than 10 photos on the profile',
        detail: 'Profiles with 20+ photos see materially more interactions.', points_recoverable: 12.5 },
      { id: 2, location_id: 1, business_name: 'Sample Travel Co', dimension_name: 'Content',
        priority: 'high', title: 'No post published in 90 days',
        detail: 'Posting weekly keeps the profile active in local results.', points_recoverable: 8.0 },
      { id: 3, location_id: 1, business_name: 'Sample Travel Co', dimension_name: 'Profile',
        priority: 'medium', title: 'Description is under 500 characters',
        detail: 'Use the full 750 characters to describe services.', points_recoverable: 3.5 }
    ],
    reviewQueue: [
      { id: 101, location_id: 1, business_name: 'Sample Travel Co', reviewer_display_name: 'A. Sample',
        star_rating: 5, comment: 'Excellent arrangements from start to finish. Everything ran on time.',
        sentiment: 'positive', requires_escalation: false, failed_attempts: 0,
        ai_suggested_reply: 'Thank you for the kind words. We are glad the schedule ran smoothly and hope to arrange your next trip.',
        reply_status: 'awaiting_approval',
        review_created_at: new Date(today.getTime() - 20 * 3600000).toISOString() },
      { id: 102, location_id: 1, business_name: 'Sample Travel Co', reviewer_display_name: 'B. Example',
        star_rating: 2, comment: 'Pickup was late and nobody answered the phone…',
        comment_truncated: true, sentiment: 'negative', requires_escalation: true, failed_attempts: 0,
        ai_suggested_reply: 'We are sorry about the delay and the missed calls. That is not the standard we aim for. Please contact us so we can put it right.',
        reply_status: 'awaiting_approval',
        review_created_at: new Date(today.getTime() - 52 * 3600000).toISOString() }
    ],
    postQueue: [
      { id: 201, post_id: 'demo-post-1', location_id: 1, business_name: 'Sample Travel Co',
        topic_type: 'STANDARD', status: 'awaiting_approval',
        summary: 'Monsoon season packages are open for booking. Three-night itineraries with guided transfers.',
        cta_type: 'BOOK', cta_url: 'https://example.com/packages', scheduled_for: null }
    ],
    performance: [0, 1, 2, 3, 4, 5].map((i) => {
      const dt = new Date(today.getFullYear(), today.getMonth() - i, 1);
      return {
        location_id: 1, period_month: dt.toISOString().slice(0, 10),
        total_interactions: 50 + i * 7, profile_views: 380 + i * 24,
        calls: 12 + i, website_visits: 4 + (i % 3), direction_requests: 9 + i,
        searches: 210 + i * 11, chat_clicks: 0
      };
    }),
    alerts: [
      { id: 1, location_id: 1, alert_type: 'post_removed', severity: 'critical',
        subject: 'Sample alert — a post was removed for policy reasons',
        occurred_at: new Date(today.getTime() - 96 * 3600000).toISOString(), acknowledged_at: null }
    ],
    trend: trend
  };
}

/* ---------- boot ---------- */

function initAi() {
  const dlg = $('#ai-dialog');
  if (!dlg) return;
  $('#ai-run').addEventListener('click', runAi);
  $('#ai-again').addEventListener('click', () => {
    $('#ai-out').hidden = true;
    $('#ai-prompt').focus();
  });
  $('#ai-close').addEventListener('click', () => dlg.close());
  $('#ai-use').addEventListener('click', () => {
    const target = ai.targetId ? document.getElementById(ai.targetId) : null;
    if (target) {
      target.value = $('#ai-result').value;
      target.dispatchEvent(new Event('input', { bubbles: true }));
    }
    dlg.close();
    if (target) target.focus();
  });
}

initConnection();
initTheme();
initAi();
load();
