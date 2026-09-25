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

  const recRows = recs.length ? recs.map((r) => `
    <tr>
      <td><span class="flag ${r.priority === 'critical' ? 'critical' : (r.priority === 'high' ? 'warning' : 'info')}">
            ${esc(r.priority)}</span></td>
      <td><strong>${esc(r.title)}</strong>
          <div style="color:var(--text-secondary);font-size:0.85rem">${esc(r.detail || '')}</div></td>
      <td class="hide-sm" style="color:var(--text-muted);font-size:0.85rem">${esc(r.dimension_name || '')}</td>
      <td class="num">${r.points_recoverable == null ? '—' : '+' + num(r.points_recoverable, 1)}</td>
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
      <div class="section-head"><h2>Open recommendations</h2><p>highest priority first</p></div>
      <div class="card">
        ${recs.length ? `<table>
          <thead><tr><th>Priority</th><th>Action</th><th class="hide-sm">Dimension</th><th class="num">Points</th></tr></thead>
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
        <button class="btn danger" data-reject-post="${esc(p.id)}" ${cfg.configured ? '' : 'disabled'}>Reject</button>
        <span class="meta" style="color:var(--text-muted);font-size:0.8rem" data-status="${esc(p.id)}"></span>
      </div>
    </div>`).join('');

  return `
    ${connBanner}
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

document.addEventListener('click', (e) => {
  const t = e.target;

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

initConnection();
initTheme();
load();
