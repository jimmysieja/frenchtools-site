'use strict';

// The page code is public; the content is not. Everything shown here is read from the private
// repository through the GitHub API, with a token kept in this browser, and answers are saved back
// the same way (data/replies/<date>.json). Served by tools/site_dev.py, the API is a local stand-in.
const REPO = 'jimmysieja/frenchtools';
const BRANCH = 'master';
const DEV = ['localhost', '127.0.0.1'].includes(location.hostname);
const API = (DEV ? '/api' : 'https://api.github.com') + '/repos/' + REPO;
const KINDS = ['writing', 'speaking'];

const view = document.getElementById('view');
const nav = document.getElementById('nav');
const foot = document.getElementById('foot');

const store = {
  get(key) { try { return localStorage.getItem('ft.' + key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem('ft.' + key, value); } catch { /* private mode */ } },
  del(key) { try { localStorage.removeItem('ft.' + key); } catch { /* private mode */ } },
};

// ---------------------------------------------------------------- GitHub

class ApiError extends Error {
  constructor(status) { super('HTTP ' + status); this.status = status; }
}

async function api(path, { raw = false, method = 'GET', body } = {}) {
  const headers = { Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json' };
  const token = store.get('token');
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(API + path, { method, headers, body: body && JSON.stringify(body), cache: 'no-store' });
  } catch {
    throw new ApiError(0);
  }
  if (!res.ok) throw new ApiError(res.status);
  return raw ? res.text() : res.json();
}

const b64encode = text => btoa(Array.from(new TextEncoder().encode(text), b => String.fromCharCode(b)).join(''));
const b64decode = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), c => c.charCodeAt(0)));
const at = path => `/contents/${path}?ref=${BRANCH}`;
const missing = fallback => err => { if (err.status === 404) return fallback; throw err; };

const readJson = async path => JSON.parse(await api(at(path), { raw: true }));
const listDir = path => api(at(path)).catch(missing([]));
const readWithSha = path => api(at(path))
  .then(f => ({ data: JSON.parse(b64decode(f.content)), sha: f.sha }))
  .catch(missing(null));

async function writeJson(path, data, sha, message) {
  const body = { message, branch: BRANCH, content: b64encode(JSON.stringify(data, null, 1) + '\n') };
  if (sha) body.sha = sha;
  return (await api('/contents/' + path, { method: 'PUT', body })).content.sha;
}

// ---------------------------------------------------------------- data

const state = {
  index: null,          // data/site/index.json
  byDate: new Map(),    // date -> its entry in index.issues
  shas: {},             // date -> current hash of data/replies/<date>.json
  replies: new Map(),   // date -> {data, sha}, for the reply files downloaded this session
  issues: new Map(),    // date -> promise of data/daily/<date>.json
  wordbank: null,
  loadedAt: 0,
  ticket: 0,
};

async function loadBase() {
  const [index, listing] = await Promise.all([readJson('data/site/index.json'), listDir('data/replies')]);
  state.index = index;
  state.byDate = new Map(index.issues.map(i => [i.date, i]));
  state.shas = Object.fromEntries(listing.map(f => [f.name.replace('.json', ''), f.sha]));
  state.replies.clear();
  state.issues.clear();
  // The index is rebuilt once a day. Anything saved since then shows up as a changed hash.
  const changed = Object.keys(state.shas).filter(d => (index.replies[d] || {}).sha !== state.shas[d]);
  await Promise.all(changed.map(fetchReply));
  state.loadedAt = Date.now();
}

async function fetchReply(date) {
  const file = await readWithSha(`data/replies/${date}.json`) || { data: { date }, sha: null };
  state.replies.set(date, file);
  return file;
}

async function getReply(date) {
  return state.replies.get(date) || (state.shas[date] ? fetchReply(date) : { data: { date }, sha: null });
}

function getIssue(date) {
  if (!state.issues.has(date)) {
    const loading = readJson(`data/daily/${date}.json`);
    loading.catch(() => state.issues.delete(date));
    state.issues.set(date, loading);
  }
  return state.issues.get(date);
}

// One write at a time per day: "opened" and a quick first save would otherwise collide.
const queues = new Map();

function updateReply(date, change, message) {
  const run = async () => {
    let current = await getReply(date);
    for (let attempt = 0; ; attempt++) {
      const data = { date, ...current.data };
      if (change(data) === false) return data;
      try {
        const sha = await writeJson(`data/replies/${date}.json`, data, current.sha, message);
        state.replies.set(date, { data, sha });
        return data;
      } catch (err) {
        // Saved from another device in the meantime: take its version and apply the change again.
        if (attempt > 0 || ![409, 422].includes(err.status)) throw err;
        current = await fetchReply(date);
      }
    }
  };
  const queued = (queues.get(date) || Promise.resolve()).then(run, run);
  queues.set(date, queued.catch(() => {}));
  return queued;
}

const hasText = answer => Boolean(answer && answer.text);

function dayInfo(date) {
  const live = state.replies.get(date);
  const built = state.index.replies[date] || {};
  const r = live
    ? { opened: Boolean(live.data.opened_at), writing: hasText(live.data.writing), speaking: hasText(live.data.speaking) }
    : built;
  const answers = (r.writing ? 1 : 0) + (r.speaking ? 1 : 0);
  // An answer sent by email counts as one, since it doesn't say which prompt it was for.
  const emailed = !answers && state.byDate.get(date)?.reply_received;
  // What makes a day "green" isn't settled yet: 1 = opened, 2 = one answer, 3 = both. Change it here.
  const level = answers === 2 ? 3 : answers === 1 || emailed ? 2 : r.opened ? 1 : 0;
  return { ...r, answers: answers || (emailed ? 1 : 0), corrected: built.corrected || [], level };
}

// ---------------------------------------------------------------- helpers

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const rich = s => esc(s).replace(/&#60;(\/?[bi])&#62;/g, '<$1>');  // blog paragraphs may use <b> and <i>
const safeUrl = url => (/^https?:\/\//.test(url) ? url : '#');
const toDate = iso => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
const toIso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const longDate = iso => toDate(iso).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const clock = stamp => new Date(stamp).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const fold = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function explain(err) {
  if (err.status === 0) return 'Can’t reach GitHub. Check your connection.';
  if (err.status === 403 || err.status === 429) return 'GitHub is refusing requests for the moment. Try again in a few minutes.';
  if (err.status === 404) return 'Not found. The token may not have access to the frenchtools repository.';
  return `Something went wrong (${err.message}).`;
}

// ---------------------------------------------------------------- today / one issue

const HINTS = {
  writing: 'Write 4–6 sentences. Corrections come with the next issue.',
  speaking: 'Tap the box, then the 🎤 on your French keyboard, and talk for about a minute. Corrections come with the next issue.',
};

const fixList = fixes => (fixes || []).map(f =>
  `<li><s>${esc(f.wrong)}</s> → <b>${esc(f.right)}</b><span class="sub">${esc(f.why)}</span></li>`).join('');

function correctionHtml(x, context = '') {
  const intent = x.intent ? `<p class="intent"><b>What you meant:</b> ${esc(x.intent)}</p>` : '';
  const native = x.native ? `<p class="note"><b>A native might say:</b> <i>${esc(x.native)}</i></p>` : '';
  if ((x.segments || []).length) {
    // Their text a couple of sentences at a time, each with its improvements underneath (hidden at first).
    const segments = x.segments.map(s => `<div class="seg">
      <p class="orig">${esc(s.original)}</p>
      <div class="fix">${s.corrected && s.corrected !== s.original ? `<p class="corrected">${esc(s.corrected)}</p>` : '<p class="ok">✓ Nothing to fix here.</p>'}
        ${(s.fixes || []).length ? `<ul>${fixList(s.fixes)}</ul>` : ''}
        ${s.check ? `<p class="check">${esc(s.check)}</p>` : ''}</div>
    </div>`).join('');
    return `<div class="correction segmented">
      <div class="corrbar">${context || '<span></span>'}<button type="button" class="ghost fix-toggle">Show improvements</button></div>
      ${intent}${segments}<div class="fix">${native}</div>
    </div>`;
  }
  const fixes = fixList(x.fixes);
  return `<div class="correction">${context}${intent}
    <p class="corrected">${esc(x.corrected)}</p>
    <ul>${fixes}</ul>
    ${native}
    ${x.original ? `<details><summary>What you wrote</summary><p>${esc(x.original)}</p></details>` : ''}
  </div>`;
}

function promptHtml(kind, c, reply, info, corrections) {
  const p = kind === 'writing' ? c.writing_prompt : c.speaking_prompt;
  const targets = kind === 'writing'
    ? (p.use || []).length && `Try to use: ${p.use.map(u => `<b>${esc(u)}</b>`).join(', ')}`
    : (p.phrases || []).length && `Useful: ${p.phrases.map(u => `<i>${esc(u)}</i>`).join(' · ')}`;
  const saved = reply.data[kind];
  let body;
  if (info.corrected.includes(kind) || corrections.length) {
    // A segmented correction already shows their text, piece by piece.
    const shown = corrections.length && corrections.every(x => (x.segments || []).length);
    body = (shown ? '' : `<div class="answer">${esc(saved?.text)}</div>`)
      + (corrections.map(x => correctionHtml({ ...x, original: '' })).join('')
        || '<p class="note">Corrected. The corrections are in the issue that followed.</p>');
  } else {
    const draft = store.get(`draft.${c.date}.${kind}`);
    const intentDraft = store.get(`draft.${c.date}.${kind}.intent`);
    body = `<textarea id="${kind}-text" lang="fr" spellcheck="false" placeholder="${kind === 'writing' ? 'Écris ici…' : 'Dicte ou écris ici…'}">${esc(draft ?? saved?.text)}</textarea>
      <textarea id="${kind}-intent" class="intent-input" lang="en" placeholder="Optional, in English: what you’re trying to say. It keeps the corrections from changing your meaning.">${esc(intentDraft ?? saved?.intent)}</textarea>
      <div class="answerbar"><button type="button" id="${kind}-save">Enregistrer</button>
      <p class="note" id="${kind}-msg">${saved ? `Saved at ${clock(saved.saved_at)}. ` : ''}${HINTS[kind]}</p></div>`;
  }
  return `<section class="card">
    <div class="label">${kind === 'writing' ? '✍️ À toi d’écrire' : '🎙️ À toi de parler'}</div>
    <p class="prompt">${esc(p.prompt)}</p>
    ${targets ? `<p class="targets">${targets}</p>` : ''}${body}
  </section>`;
}

function statsLines(s) {
  if (!s || s.wordbank_total == null) return [];
  const anki = s.anki || {};
  const lines = [];
  if (anki.reviews_7d != null) lines.push(`${anki.reviews_7d} Anki reviews · studied ${anki.days_studied_7d}/7 days`);
  lines.push(`${s.wordbank_total} words in your bank (+${s.added_7d} this week)`, `${s.captures_7d} captured this week`);
  const ft = anki.frenchtools_cards;
  if (ft) lines.push(`frenchtools deck: ${ft.mature} mature · ${ft.young} young · ${ft.new} new`);
  return lines;
}

async function issuePage(date) {
  if (!state.byDate.has(date)) return { html: `<p class="note">Pas de numéro pour le ${esc(date)}.</p>` };
  const [c, reply, holders] = await Promise.all([
    getIssue(date), getReply(date), Promise.all((state.index.corrections[date] || []).map(getIssue)),
  ]);
  const info = dayInfo(date);
  const later = holders.flatMap(h => (h.corrections || []).filter(x => x.for_date === date));
  const dates = state.index.issues.map(i => i.date);
  const i = dates.indexOf(date);
  const arrow = (to, label) => `<a href="#/d/${to || date}" class="${to ? '' : 'off'}" aria-label="${label}">${label === 'Précédent' ? '‹' : '›'}</a>`;

  const delivered = (c.corrections || []).map(x => correctionHtml(x, x.for_date && state.byDate.has(x.for_date)
    ? `<p class="note"><a href="#/d/${x.for_date}">${esc(longDate(x.for_date))}</a></p>` : '')).join('');

  const b = c.blog;
  const en = b.paragraphs_en || [];
  const paragraphs = b.paragraphs.map((p, n) => `<p>${rich(p)}</p>${en[n] ? `<p class="en">${rich(en[n])}</p>` : ''}`).join('');
  const lexique = (b.glossary || []).map(g => `<b>${esc(g.fr)}</b> ${esc(g.en)}`).join(' · ');
  const showEn = store.get('en') === '1';

  const w = c.word_of_the_day;
  const examples = (w.examples || []).map(x => `<p class="example"><i>${esc(x.fr)}</i><span>${esc(x.en)}</span></p>`).join('');
  const other = later.filter(x => !KINDS.includes(x.kind));

  const html = `
    <div class="dayhead">${arrow(dates[i - 1], 'Précédent')}<div class="date">${esc(longDate(date))} · N° ${i + 1}</div>${arrow(dates[i + 1], 'Suivant')}</div>
    ${delivered ? `<section class="card"><div class="label">Tes réponses, corrigées</div>${delivered}</section>` : ''}
    <section class="card blog${showEn ? ' show-en' : ''}" id="blog">
      <div class="blogbar"><div class="label">Le blog · ${esc(b.topic)}</div>
        ${en.length ? `<button type="button" class="ghost" id="en-toggle">${showEn ? 'Hide' : 'Show'} English</button>` : ''}</div>
      <h1>${esc(b.title)}${b.title_en ? `<span class="en">${esc(b.title_en)}</span>` : ''}</h1>
      ${paragraphs}
      ${b.source?.url ? `<p class="source">Source : <a href="${esc(safeUrl(b.source.url))}" target="_blank" rel="noopener noreferrer">${esc(b.source.name)}</a></p>` : ''}
      ${lexique ? `<div class="lexique"><b>Petit lexique</b><br>${lexique}</div>` : ''}
    </section>
    <section class="card">
      <div class="label">Le mot du jour</div>
      <div class="word">${esc(w.expression)}</div>
      <div class="meaning">${esc(w.meaning)} <span class="chip">${esc(w.register)}</span></div>
      ${w.spoken ? `<div class="sub">🗣 ${esc(w.spoken)}</div>` : ''}${examples}
      ${w.tip ? `<p class="note">${esc(w.tip)}</p>` : ''}
    </section>
    ${KINDS.map(kind => promptHtml(kind, c, reply, info, later.filter(x => x.kind === kind))).join('')}
    ${other.length ? `<section class="card"><div class="label">Corrections</div>${other.map(x => correctionHtml(x)).join('')}</section>` : ''}
    <div class="stats">${statsLines(c.stats).map(esc).join('<br>')}</div>`;

  const bind = () => {
    const toggle = document.getElementById('en-toggle');
    toggle?.addEventListener('click', () => {
      const on = document.getElementById('blog').classList.toggle('show-en');
      toggle.textContent = `${on ? 'Hide' : 'Show'} English`;
      store.set('en', on ? '1' : '0');
    });
    for (const button of view.querySelectorAll('.fix-toggle')) {
      button.addEventListener('click', () => {
        const on = button.closest('.correction').classList.toggle('show-fix');
        button.textContent = `${on ? 'Hide' : 'Show'} improvements`;
      });
    }
    for (const kind of KINDS) {
      const text = document.getElementById(`${kind}-text`);
      if (!text) continue;
      const intent = document.getElementById(`${kind}-intent`);
      for (const [box, key] of [[text, `draft.${date}.${kind}`], [intent, `draft.${date}.${kind}.intent`]]) {
        const grow = () => { box.style.height = 'auto'; box.style.height = `${box.scrollHeight + 2}px`; };
        box.addEventListener('input', () => { store.set(key, box.value); grow(); });
        grow();
      }
      const button = document.getElementById(`${kind}-save`);
      button.addEventListener('click', () => saveAnswer(date, kind, text, intent, button, document.getElementById(`${kind}-msg`)));
    }
    if (!reply.data.opened_at) {
      updateReply(date, d => { if (d.opened_at) return false; d.opened_at = new Date().toISOString(); },
        `site: opened ${date}`).catch(() => {});
    }
  };
  return { html, bind };
}

async function saveAnswer(date, kind, text, intent, button, msg) {
  const answer = text.value.trim();
  const meant = intent.value.trim();
  button.disabled = true;
  msg.className = 'note';
  msg.textContent = 'Saving…';
  try {
    await updateReply(date, d => {
      if (answer) d[kind] = { text: answer, ...(meant && { intent: meant }), saved_at: new Date().toISOString() };
      else delete d[kind];
    }, `site: ${kind} ${date}`);
    store.del(`draft.${date}.${kind}`);
    store.del(`draft.${date}.${kind}.intent`);
    msg.textContent = answer ? `Saved at ${clock(Date.now())}. Corrections come with the next issue.` : 'Answer removed.';
  } catch (err) {
    if (err.status === 401) return fail(err);
    msg.className = 'error';
    msg.textContent = `Not saved. ${explain(err)} Your text is kept on this device.`;
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------- archives

async function archivesPage() {
  const rows = [...state.index.issues].reverse().map(i => `
    <li><a href="#/d/${i.date}"><span class="dot lvl${dayInfo(i.date).level}"></span><div>
      <div class="title">${esc(i.title)}</div>
      <div class="meta">${esc(longDate(i.date))} · ${esc(i.topic)}${i.word ? ` · mot : ${esc(i.word)}` : ''}</div>
    </div></a></li>`).join('');
  return { html: `<section class="card"><div class="label">Tous les numéros</div><ul class="list">${rows}</ul></section>` };
}

// ---------------------------------------------------------------- progrès

function streaks(levels) {  // levels: oldest issue first
  let best = 0, run = 0;
  for (const level of levels) { run = level >= 2 ? run + 1 : 0; best = Math.max(best, run); }
  // Today's issue doesn't break the streak until the next one is out.
  const upTo = levels.at(-1) >= 2 ? levels : levels.slice(0, -1);
  let current = 0;
  while (current < upTo.length && upTo.at(-1 - current) >= 2) current++;
  return { current, best };
}

function monthHtml(year, month, today) {
  const first = new Date(year, month, 1);
  const days = new Date(year, month + 1, 0).getDate();
  let cells = ['L', 'M', 'M', 'J', 'V', 'S', 'D'].map(d => `<div class="wd">${d}</div>`).join('');
  cells += '<span></span>'.repeat((first.getDay() + 6) % 7);
  for (let d = 1; d <= days; d++) {
    const date = toIso(new Date(year, month, d));
    const mark = date === today ? ' today' : '';
    cells += state.byDate.has(date)
      ? `<a class="cell issue lvl${dayInfo(date).level}${mark}" href="#/d/${date}" title="${esc(state.byDate.get(date).title)}">${d}</a>`
      : `<span class="cell${mark}">${d}</span>`;
  }
  return `<div class="month"><h2>${first.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })}</h2><div class="grid">${cells}</div></div>`;
}

async function progressPage() {
  const issues = state.index.issues;
  const infos = issues.map(i => dayInfo(i.date));
  const { current, best } = streaks(infos.map(i => i.level));
  const answers = infos.reduce((n, i) => n + i.answers, 0);
  const read = infos.filter(i => i.level >= 1).length;

  const today = toIso(new Date());
  let months = '';
  if (issues.length) {
    const first = toDate(issues[0].date);
    const last = toDate(issues.at(-1).date > today ? issues.at(-1).date : today);
    for (let y = last.getFullYear(), m = last.getMonth(); y > first.getFullYear() || (y === first.getFullYear() && m >= first.getMonth()); m--) {
      if (m < 0) { m = 11; y--; }
      months += monthHtml(y, m, today);
    }
  }
  const stats = statsLines(state.index.stats).map(esc).join('<br>');
  return { html: `
    <div class="big">
      <div><b>${current}</b><span>${current === 1 ? 'jour' : 'jours'} de suite</span></div>
      <div><b>${answers}</b><span>${answers === 1 ? 'réponse' : 'réponses'}</span></div>
      <div><b>${read}/${issues.length}</b><span>numéros lus</span></div>
    </div>
    <section class="card">${months}
      <div class="legend"><span><i></i>pas ouvert</span><span><i class="lvl1"></i>lu</span><span><i class="lvl2"></i>1 réponse</span><span><i class="lvl3"></i>2 réponses</span></div>
      <p class="note">Meilleure série : ${best} ${best === 1 ? 'jour' : 'jours'}. A day joins the streak once you answer at least one prompt.</p>
    </section>
    ${stats ? `<div class="stats">${stats}</div>` : ''}` };
}

// ---------------------------------------------------------------- mots

function sourceLabel(source = {}) {
  if (source.type === 'capture') return 'capturé';
  if (source.type === 'correction') return 'd’une correction';
  return [source.channel, source.title].filter(Boolean).join(' — ');
}

function entryHtml(e) {
  return `<div class="entry">
    <span class="expr">${esc(e.expression)}</span> <span class="chip">${esc(e.register)}</span>
    <div>${esc(e.meaning)}</div>
    ${e.spoken ? `<div class="sub">🗣 ${esc(e.spoken)}</div>` : ''}
    ${e.example ? `<div class="ex">${esc(e.example)}<span class="sub">${esc(e.example_en)}</span></div>` : ''}
    ${e.notes ? `<div class="sub">${esc(e.notes)}</div>` : ''}
    <div class="sub">${esc([sourceLabel(e.source), e.added].filter(Boolean).join(' · '))}</div>
  </div>`;
}

async function wordsPage() {
  state.wordbank ??= await readJson('data/wordbank.json');
  const bank = [...state.wordbank].reverse();  // newest first
  const haystack = bank.map(e => fold([e.expression, e.meaning, e.spoken, e.example, e.example_en, e.notes].join(' ')));
  const LIMIT = 100;
  const bind = () => {
    const search = document.getElementById('search');
    const draw = () => {
      const q = fold(search.value.trim());
      const hits = bank.filter((e, n) => haystack[n].includes(q));
      document.getElementById('entries').innerHTML =
        `<div class="label">${hits.length} ${hits.length === 1 ? 'mot' : 'mots'}</div>`
        + hits.slice(0, LIMIT).map(entryHtml).join('')
        + (hits.length > LIMIT ? `<p class="note">${hits.length - LIMIT} more. Search to narrow it down.</p>` : '');
    };
    search.addEventListener('input', draw);
    draw();
  };
  return { html: `<input class="search" id="search" type="search" placeholder="Chercher un mot…" autocomplete="off">
    <section class="card" id="entries"></section>`, bind };
}

// ---------------------------------------------------------------- shell

const ROUTES = [
  [/^\/$/, 'today', () => issuePage(state.index.issues.at(-1)?.date)],
  [/^\/d\/(\d{4}-\d\d-\d\d)$/, 'today', m => issuePage(m[1])],
  [/^\/archives$/, 'archives', archivesPage],
  [/^\/progres$/, 'progres', progressPage],
  [/^\/mots$/, 'mots', wordsPage],
];

async function route() {
  if (!state.index) return;
  const path = location.hash.slice(1) || '/';
  const [pattern, tab, page] = ROUTES.find(r => r[0].test(path)) || ROUTES[0];
  for (const a of nav.querySelectorAll('a')) a.classList.toggle('on', a.dataset.tab === tab);
  const ticket = ++state.ticket;
  try {
    const { html, bind } = await page(path.match(pattern) || []);
    if (ticket !== state.ticket) return;  // the user moved on while this was loading
    view.innerHTML = html;
    window.scrollTo(0, 0);
    bind?.();
  } catch (err) {
    if (ticket === state.ticket) fail(err);
  }
}

function fail(err) {
  if (err.status === 401) {
    store.del('token');
    return showSetup('GitHub rejected the token (expired or revoked). Paste a new one.');
  }
  view.innerHTML = `<section class="card"><p class="error">${esc(err.status == null ? `Something went wrong (${err.message}).` : explain(err))}</p>
    <div class="answerbar"><button type="button" id="retry">Réessayer</button></div></section>`;
  document.getElementById('retry').addEventListener('click', start);
}

function showSetup(message = '') {
  state.index = null;
  nav.hidden = foot.hidden = true;
  view.innerHTML = `<section class="card setup">
    <h1>Connect this device</h1>
    <p>This page is only a shell. Your issues and answers live in your private GitHub repository, and this
      browser needs an access token to read them. You do this once per device.</p>
    <ol>
      <li>Open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">GitHub → new fine-grained token</a>.</li>
      <li>Name it (for example “frenchtools site”) and pick the longest expiration offered.</li>
      <li>Repository access → <b>Only select repositories</b> → <b>frenchtools</b>.</li>
      <li>Permissions → Repository permissions → <b>Contents: Read and write</b>.</li>
      <li>Generate the token, copy it and paste it here.</li>
    </ol>
    <form id="setup"><input id="token" type="password" autocomplete="off" placeholder="github_pat_…" required>
      <button>Connect</button></form>
    <p class="${message ? 'error' : 'note'}" id="setup-msg">${esc(message || 'The token is stored only in this browser.')}</p>
  </section>`;
  document.getElementById('setup').addEventListener('submit', async event => {
    event.preventDefault();
    const msg = document.getElementById('setup-msg');
    store.set('token', document.getElementById('token').value.trim());
    msg.className = 'note';
    msg.textContent = 'Checking…';
    try {
      await api('');
      start();
    } catch (err) {
      store.del('token');
      msg.className = 'error';
      msg.textContent = err.status === 401 ? 'GitHub doesn’t recognize this token.' : explain(err);
    }
  });
}

async function start() {
  if (!DEV && !store.get('token')) return showSetup();
  nav.hidden = false;
  foot.hidden = DEV;
  view.innerHTML = '<p class="note">Chargement…</p>';
  try {
    await loadBase();
  } catch (err) {
    return fail(err);
  }
  route();
}

document.getElementById('disconnect').addEventListener('click', () => {
  if (!confirm('Remove the access token from this device?')) return;
  store.del('token');
  showSetup();
});
window.addEventListener('hashchange', route);
// A home-screen app can stay open for days: pick up the new issue when it comes back to the front.
// Unsaved text is restored from its draft.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.index && Date.now() - state.loadedAt > 30 * 60 * 1000) start();
});
start();
