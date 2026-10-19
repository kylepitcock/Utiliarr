const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401 && path !== '/login') { showLogin(); throw new Error('Not logged in'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const dur = (s) => s == null ? '—' : s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : s < 86400 ? Math.floor(s / 3600) + 'h ' + Math.floor(s % 3600 / 60) + 'm' : Math.floor(s / 86400) + 'd ' + Math.floor(s % 86400 / 3600) + 'h';
const bytes = (b) => { const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (b >= 1024 && i < 4) { b /= 1024; i++; } return b.toFixed(i > 2 ? 1 : 0) + ' ' + u[i]; };
const ago = (t) => dur(Math.floor((Date.now() - t) / 1000)) + ' ago';

let tab = 'dashboard', timer;
function showLogin() { $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); clearInterval(timer); }
async function showApp() { $('#login').classList.add('hidden'); $('#app').classList.remove('hidden'); go(tab); clearInterval(timer); timer = setInterval(() => { if (tab === 'dashboard' || tab === 'reports') load[tab](); }, 10000); }

$('#loginForm').onsubmit = async (e) => {
  e.preventDefault();
  try { await api('/login', 'POST', { password: $('#pw').value }); $('#pw').value = ''; showApp(); } catch (er) { $('#loginErr').textContent = er.message; }
};
$('#logout').onclick = async () => { await api('/logout', 'POST'); showLogin(); };
document.querySelectorAll('nav [data-tab]').forEach((b) => b.onclick = () => go(b.dataset.tab));
function go(t) {
  tab = t;
  document.querySelectorAll('nav [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  document.querySelectorAll('main > section').forEach((s) => s.classList.toggle('hidden', s.id !== t));
  load[t]();
}

const reportRows = (rs, actions) => rs.length ? `<table><tr><th>When</th><th>Type</th><th>Title</th><th>By</th><th>Status</th><th>Tries</th>${actions ? '<th></th>' : ''}</tr>` + rs.map((r) =>
  `<tr><td class="mut">${ago(r.created_at)}</td><td>${r.kind === 'video' ? 'Video' : 'Subtitle'}</td><td>${esc(r.title)}<br><small>${esc(r.reason || '')} ${esc(r.note || '')}</small></td><td>${esc(r.discord_name || '—')}</td><td><span class="pill ${r.status}">${r.status}</span></td><td>${r.attempts}</td>` +
  (actions ? `<td>${['searching', 'downloading'].includes(r.status) ? `<button class="sec" data-act="cancel" data-id="${r.id}">Cancel</button>` : ['gave_up', 'cancelled'].includes(r.status) ? `<button class="sec" data-act="retry" data-id="${r.id}">Retry</button>` : ''}</td>` : '') + '</tr>').join('') + '</table>' : '<p class="mut">Nothing yet.</p>';

const load = {
  async dashboard() {
    api('/queue').then((q) => {
      $('#qsum').textContent = q.items.length ? `${q.items.length} items · ${bytes(q.totalLeft)} left · all done in ~${dur(q.allDoneInSeconds)}` : '';
      $('#queue').innerHTML = q.items.length ? '<table><tr><th>Title</th><th>Progress</th><th>Time left</th><th>Status</th></tr>' + q.items.map((i) =>
        `<tr><td>${i.source === 'movie' ? '🎬' : '📺'} ${esc(i.title)}</td><td><div class="bar"><i style="width:${i.percent}%"></i></div>${i.percent}%</td><td>${dur(i.secondsLeft)}</td><td>${esc(i.status)}${i.warning ? ` <span class="warn" title="${esc(i.warning)}">⚠</span>` : ''}</td></tr>`).join('') + '</table>' : '<p class="mut">Queue is empty.</p>';
    }).catch((e) => $('#queue').innerHTML = `<p class="err">${esc(e.message)}</p>`);
    api('/nowplaying').then((p) => $('#playing').innerHTML = p.length ? p.map((x) => `<div>${esc(x.user)} — ${esc(x.title)} <small>${esc(x.device || '')}</small></div>`).join('') : '<p class="mut">Nobody is watching.</p>')
      .catch((e) => $('#playing').innerHTML = `<p class="err">${esc(e.message)}</p>`);
    const rs = await api('/reports');
    $('#active').innerHTML = reportRows(rs.filter((r) => ['searching', 'downloading'].includes(r.status)), true);
  },
  async reports() { $('#reportTable').innerHTML = reportRows(await api('/reports'), true); },
  async settings() {
    const fs = await api('/settings');
    let html = '', group = '';
    for (const f of fs) {
      if (f.group !== group) {
        if (group) html += '</div>';
        group = f.group;
        const svc = ['Jellyfin', 'Radarr', 'Sonarr', 'Bazarr', 'Discord'].includes(group);
        html += `<div class="card"><h2>${group} ${svc ? `<button type="button" class="sec" data-test="${group.toLowerCase()}">Test</button> <small id="t-${group.toLowerCase()}"></small>` : ''}</h2>`;
      }
      const id = 'f-' + f.key;
      const input = f.type === 'bool' ? `<label><input type="checkbox" id="${id}" ${f.value === 'true' ? 'checked' : ''}> ${esc(f.label)}</label>`
        : `<input id="${id}" type="${f.secret ? 'password' : f.type === 'number' ? 'number' : 'text'}" value="${esc(f.value)}" placeholder="${f.secret && f.isSet ? '•••••• (saved, leave blank to keep)' : ''}" autocomplete="off">`;
      html += `<div class="field">${f.type === 'bool' ? '<span></span>' : `<label for="${id}">${esc(f.label)}</label>`}${input}${f.help ? `<small>${esc(f.help)}</small>` : ''}</div>`;
    }
    $('#settingsForm').innerHTML = html + '</div><button>Save settings</button> <span id="saveMsg"></span>';
    $('#settingsForm').dataset.fields = JSON.stringify(fs.map((f) => ({ key: f.key, type: f.type })));
  },
};

$('#settingsForm').onsubmit = async (e) => {
  e.preventDefault();
  const body = {};
  for (const f of JSON.parse($('#settingsForm').dataset.fields)) { const el = document.getElementById('f-' + f.key); body[f.key] = f.type === 'bool' ? String(el.checked) : el.value; }
  try { await api('/settings', 'PUT', body); $('#saveMsg').innerHTML = '<span class="ok">Saved</span>'; load.settings(); } catch (er) { $('#saveMsg').innerHTML = `<span class="err">${esc(er.message)}</span>`; }
};
$('#settingsForm').onclick = async (e) => {
  const svc = e.target.dataset?.test; if (!svc) return;
  const out = document.getElementById('t-' + svc); out.textContent = 'testing…';
  const r = await api('/test/' + svc, 'POST').catch((er) => ({ ok: false, info: er.message }));
  out.innerHTML = `<span class="${r.ok ? 'ok' : 'err'}">${r.ok ? '✓' : '✗'} ${esc(r.info)}</span>`;
};
document.body.addEventListener('click', async (e) => {
  const { act, id } = e.target.dataset || {}; if (!act) return;
  await api(`/reports/${id}/${act}`, 'POST');
  load[tab]();
});

api('/session').then((s) => s.authed ? showApp() : showLogin());
