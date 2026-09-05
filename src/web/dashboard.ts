// Dashboard (M0.5 + M1.3): subjects + timeline live via SSE, pending decisions
// with approve/deny, and a new-subject form — all through the existing API, so it
// is operable from a phone on the tailnet. The token is pasted once and kept in
// localStorage — never in the URL.
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>fleet-manager</title>
<style>
  :root { --bg:#fff; --fg:#1a1a1a; --muted:#667; --line:#e2e2e8; --accent:#0a6b5c; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#14161a; --fg:#e6e6e6; --muted:#99a; --line:#2a2d33; --accent:#3fbfa8; }
  }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:14px/1.5 ui-sans-serif, system-ui, sans-serif; }
  header { padding:12px 20px; border-bottom:1px solid var(--line); display:flex; gap:12px; align-items:center; }
  header h1 { font-size:15px; margin:0; }
  main { display:grid; grid-template-columns: 320px 1fr; gap:0; min-height:calc(100vh - 50px); }
  #subjects-col { border-right:1px solid var(--line); }
  .subject { padding:10px 16px; border-bottom:1px solid var(--line); cursor:pointer; }
  .subject:hover { background:color-mix(in srgb, var(--accent) 8%, transparent); }
  .status { font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:.05em; }
  #timeline { padding:16px 20px; overflow-x:auto; }
  .event { padding:6px 0; border-bottom:1px dashed var(--line); }
  .event time { color:var(--muted); font-size:12px; margin-right:8px; }
  .event .type { color:var(--accent); font-weight:600; margin-right:8px; }
  pre { white-space:pre-wrap; margin:4px 0 0; font-size:12px; color:var(--muted); }
  input { background:var(--bg); color:var(--fg); border:1px solid var(--line); padding:4px 8px; border-radius:4px; }
  #pending { border-bottom:1px solid var(--line); padding:8px 20px; }
  #pending:empty { display:none; }
  .decision { display:flex; gap:10px; align-items:center; padding:6px 0; }
  .decision .q { flex:1; }
  button { background:var(--bg); color:var(--fg); border:1px solid var(--line); padding:4px 10px; border-radius:4px; cursor:pointer; }
  button.ok { border-color:var(--accent); color:var(--accent); }
  #new { display:flex; flex-wrap:wrap; gap:6px; padding:8px 16px; border-bottom:1px solid var(--line); }
  #new input { flex:1 1 140px; min-width:0; }
  @media (max-width: 700px) {
    main { grid-template-columns: 1fr; }
    #subjects-col { border-right:0; border-bottom:1px solid var(--line); }
    header input { flex:1; }
  }
</style>
</head>
<body>
<header>
  <h1>fleet-manager</h1>
  <input id="token" type="password" placeholder="API token" size="28">
  <span id="state" class="status"></span>
</header>
<div id="pending"></div>
<main>
  <div id="subjects-col">
    <form id="new">
      <input name="title" placeholder="Title" required>
      <input name="repo" placeholder="Repo URL (git clone)" required>
      <input name="goal" placeholder="Goal — what done looks like" required style="flex-basis:100%">
      <button class="ok" type="submit">New subject</button>
    </form>
    <div id="subjects"></div>
  </div>
  <div id="timeline"><p class="status">Select a subject.</p></div>
</main>
<script>
const $ = (id) => document.getElementById(id)
let current = null
const token = () => { try { return localStorage.getItem('fleet_token') || '' } catch { return '' } }
$('token').value = token()
$('token').addEventListener('change', () => { try { localStorage.setItem('fleet_token', $('token').value) } catch {} ; load() })
const api = (path) => fetch(path, { headers: { authorization: 'Bearer ' + token() } }).then((r) => {
  if (!r.ok) throw new Error(r.status); return r.json()
})
async function load() {
  try {
    const subjects = await api('/api/subjects')
    $('state').textContent = subjects.length + ' subjects'
    $('subjects').innerHTML = subjects.map((s) =>
      '<div class="subject" data-id="' + s.id + '"><div>' + esc(s.title) + '</div><div class="status">' + s.status + '</div></div>'
    ).join('')
    for (const el of document.querySelectorAll('.subject')) el.addEventListener('click', () => show(el.dataset.id))
    const pending = await api('/api/decisions?status=pending')
    $('pending').innerHTML = pending.map((d) =>
      '<div class="decision"><span class="status">' + esc(d.type) + '</span><span class="q">' + esc(d.question) + '</span>' +
      '<button class="ok" data-id="' + d.id + '" data-act="approve">Approve</button>' +
      '<button data-id="' + d.id + '" data-act="deny">Deny</button></div>'
    ).join('')
    for (const el of document.querySelectorAll('#pending button')) el.addEventListener('click', () => resolve(el.dataset.id, el.dataset.act))
    if (current) show(current)
  } catch (e) { $('state').textContent = 'auth failed — paste token' }
}
$('new').addEventListener('submit', async (ev) => {
  ev.preventDefault()
  const f = ev.target
  const res = await fetch('/api/subjects', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token(), 'content-type': 'application/json' },
    body: JSON.stringify(Object.fromEntries(new FormData(f))),
  })
  if (res.ok) { f.reset(); load() } else { $('state').textContent = 'create failed: ' + res.status }
})
async function resolve(id, act) {
  const note = prompt(act + ' — optional note:')
  if (note === null) return
  await fetch('/api/decisions/' + id + '/' + act, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token(), 'content-type': 'application/json' },
    body: JSON.stringify(note ? { note } : {}),
  })
  load()
}
async function show(id) {
  current = id
  const d = await api('/api/subjects/' + id)
  $('timeline').innerHTML = '<h2 style="font-size:15px">' + esc(d.subject.title) +
    ' <span class="status">' + d.subject.status + '</span></h2>' +
    d.events.map((e) => {
      let extra = ''
      try { const p = JSON.parse(e.payload); if (Object.keys(p).length) extra = '<pre>' + esc(JSON.stringify(p, null, 1).slice(0, 600)) + '</pre>' } catch {}
      return '<div class="event"><time>' + e.ts.slice(11, 19) + '</time><span class="type">' + esc(e.type) + '</span>' + extra + '</div>'
    }).join('')
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])) }
async function stream() {
  while (true) {
    try {
      const res = await fetch('/api/stream', { headers: { authorization: 'Bearer ' + token() } })
      const reader = res.body.getReader()
      while (true) { const { done } = await reader.read(); if (done) break; load() }
    } catch {}
    await new Promise((r) => setTimeout(r, 3000))
  }
}
load(); stream()
</script>
</body>
</html>`
