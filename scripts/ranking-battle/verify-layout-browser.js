// 順位発表画面（ranking-battle.html）のスクロール範囲の回帰確認。実ファイルを、モックAPI＋遅延テーマ画像で実ブラウザ（Chrome headless）に表示し、
// 最下位（10位）のカードが表示領域に入るかを、画像なし／速い／遅い × view × rows × 自動／手動で確認する。本番・DBには接続しない。
// 使い方: node scripts/ranking-battle/verify-layout-browser.js   （QUICK=1 で代表1ケースのみ）
const http = require('http'), fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const HTML = path.resolve(process.argv[2] || path.join(__dirname, '../../public/ranking-battle.html'));
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 34600, DBG = 9333;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="400"><rect width="1600" height="400" fill="#246"/><text x="800" y="220" fill="#fff" font-size="120" text-anchor="middle">THEME</text></svg>`;
const mk = (n, pre) => Array.from({ length: n }, (_, i) => ({ rank: i + 1, target_id: 't' + i, name: pre + (i + 1) + '位', nickname: pre + (i + 1), display_name: pre + (i + 1), total_count: 1000 - i * 10, count: 1000 - i * 10, total_score: 1000 - i * 10, score: 1000 - i * 10 }));
const team = (id, nm) => ({ event_id: id, event_title: nm, organization: { name: nm, color: id === 'a' ? '#e63946' : '#2a9d8f' }, decor: {}, snapshot: { snapshotId: 's' + id, triggeredAt: new Date().toISOString(), target: mk(10, nm), user: mk(10, nm) } });
const api = { label: 'テスト', team_a: team('a', 'A'), team_b: team('b', 'B') };
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/ranking-battle.html') { res.setHeader('content-type', 'text/html; charset=utf-8'); return res.end(fs.readFileSync(HTML)); }
  if (u.pathname.endsWith('/ranking-snapshots/latest')) {
    const d = JSON.parse(JSON.stringify(api));
    const mode = global.MODE;
    d.theme_image_url = mode === 'none' ? null : `http://127.0.0.1:${PORT}/theme.svg`;
    res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(d));
  }
  if (u.pathname === '/theme.svg') { const delay = global.MODE === 'slow' ? 4000 : 0; return setTimeout(() => { res.setHeader('content-type', 'image/svg+xml'); res.setHeader('cache-control', 'no-store'); res.end(svg); }, delay); }
  res.statusCode = 404; res.end();
}).listen(PORT);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function cdp() {
  const list = await (await fetch(`http://127.0.0.1:${DBG}/json`)).json();
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = {};
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend[d.id]) pend[d.id](d); };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.result.value;
  return { send, ev, close: () => ws.close() };
}
// 最下部まで送ったとき、最後（10位）のカードが表示領域に完全に入っているか
const PROBE = `(()=>{const out=[];document.querySelectorAll('.list-viewport').forEach(v=>{const cs=[...v.querySelectorAll('.rank-card')];const last=cs[cs.length-1];const vr=v.getBoundingClientRect(),lr=last.getBoundingClientRect();out.push({n:cs.length,lastBottom:Math.round(lr.bottom),vpBottom:Math.round(vr.bottom),vpH:Math.round(vr.height)});});return out;})()`;
async function run(mode, view, rows, w, h, action) {
  global.MODE = mode;
  const ch = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DBG}`, `--window-size=${w},${h}`, '--user-data-dir=' + path.join(process.env.TEMP, 'chp' + Date.now()), '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  await sleep(2500);
  const c = await cdp();
  await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await c.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/ranking-battle.html?battle_id=x&view=${view}&rows=${rows}` });
  await sleep(mode === 'slow' ? 7000 : 2500); // 遅い画像は4秒後に読み込み完了
  let r;
  if (action === 'manual') {
    await c.ev(`document.getElementById('battleGrid').dispatchEvent(new WheelEvent('wheel',{deltaY:99999,bubbles:true,cancelable:true}))`);
    await sleep(200);
    r = await c.ev(PROBE);
  } else { // 自動：先頭6秒停止＋送り＋余裕。最下部の停止中（4秒）に測る
    await sleep(6000);
    const t0 = Date.now(); r = null;
    while (Date.now() - t0 < 30000) { const p = await c.ev(PROBE); if (p.every((x) => x.lastBottom <= x.vpBottom)) { r = p; break; } await sleep(300); }
    r = r || await c.ev(PROBE);
  }
  c.close(); ch.kill(); await sleep(500);
  return r;
}
(async () => {
  const cases = [];
  for (const mode of ['none', 'fast', 'slow']) for (const view of ['target', 'user']) for (const rows of [3, 5, 10]) for (const action of ['manual', 'auto']) {
    if (action === 'auto' && rows === 10) continue; // rows=10はスクロール不要（全件表示）
    if (process.env.QUICK && !(view === 'target' && rows === 5)) continue;
    cases.push([mode, view, rows, action]);
  }
  let fail = 0;
  for (const [mode, view, rows, action] of cases) {
    const r = await run(mode, view, rows, 1920, 1080, action);
    const ok = r.every((x) => x.n === 10 && x.lastBottom <= x.vpBottom + 1);
    if (!ok) fail++;
    console.log(ok ? 'PASS' : 'FAIL', mode, view, 'rows=' + rows, action, JSON.stringify(r));
  }
  console.log(fail ? `FAILED ${fail}` : 'ALL PASS'); srv.close(); process.exit(fail ? 1 : 0);
})();
