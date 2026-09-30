#!/usr/bin/env node
// scripts/cheer-log-write/local-verify.js
// トラックB-①（CHEER_LOG_WRITE_MODE=legacy|cached）のローカル動作確認。
// scripts/ble-disconnect/local-verify.js と同じ方式（pg-memで実サーバーを起動）で、
// 実際のWebSocketクライアントからcountを送り、DB往復回数・記録内容・キャッシュの
// 古さによる影響範囲・即時破棄を確認する。
//
// ★本番・staging環境には一切接続しない。pg-memはプロセス内で完結するインメモリ実装。
//
// 使い方: node scripts/cheer-log-write/local-verify.js

'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');

const MIGRATIONS_DIR = path.join(__dirname, '../../migrations');
const CATEGORY_ID = '90000000-0000-0000-0000-000000000005';
const ORG1 = '90000000-0000-0000-0000-0000000000b1';
const ORG2 = '90000000-0000-0000-0000-0000000000b2';
const EV1 = '90000000-0000-0000-0000-0000000000c1';
const EV2 = '90000000-0000-0000-0000-0000000000c2';
const T1 = '90000000-0000-0000-0000-0000000000d1';
const T2 = '90000000-0000-0000-0000-0000000000d2';
const T3 = '90000000-0000-0000-0000-0000000000d3';

let PASS = 0;
let FAIL = 0;
function check(label, condition, detail) {
  if (condition) {
    PASS++;
    console.log(`[verify] PASS: ${label}${detail !== undefined ? ' (' + detail + ')' : ''}`);
  } else {
    FAIL++;
    console.error(`[verify] FAIL: ${label}${detail !== undefined ? ' (' + detail + ')' : ''}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- pg-mem セットアップ（scripts/ble-disconnect/local-verify.jsと同じ方式） ------
function splitStatements(sql) {
  const statements = [];
  let buf = '';
  let inDollar = false;
  for (let i = 0; i < sql.length; i++) {
    if (sql[i] === '$' && sql[i + 1] === '$') {
      inDollar = !inDollar;
      buf += '$$';
      i++;
      continue;
    }
    buf += sql[i];
    if (sql[i] === ';' && !inDollar) {
      statements.push(buf);
      buf = '';
    }
  }
  if (buf.trim()) statements.push(buf);
  return statements;
}

const SKIP_PATTERN = /^CREATE\s+(OR\s+REPLACE\s+)?(TRIGGER|FUNCTION)|^COMMENT\s+ON|USING\s+gin/i;

function applyMigrations(memDb) {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    let sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    sql = sql.replace(/^CREATE EXTENSION.*$/gim, '');
    for (const stmt of splitStatements(sql)) {
      const body = stmt.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
      if (!body) continue;
      try {
        memDb.public.query(stmt);
      } catch (err) {
        if (!SKIP_PATTERN.test(body)) {
          throw new Error(`migration ${file} failed:\n${body.slice(0, 200)}\n${err.message}`);
        }
      }
    }
  }
}

function setupPgMem() {
  const { newDb, DataType } = require('pg-mem');
  const memDb = newDb();
  memDb.public.registerFunction({
    name: 'gen_random_uuid',
    returns: DataType.uuid,
    implementation: () => require('crypto').randomUUID(),
    impure: true,
  });
  memDb.public.registerFunction({
    name: 'current_database',
    returns: DataType.text,
    implementation: () => 'cheerstick_pgmem_cheer_log_write_local_verify',
  });
  applyMigrations(memDb);
  const pgAdapter = memDb.adapters.createPg();
  const pgModulePath = require.resolve('pg');
  require.cache[pgModulePath] = { id: pgModulePath, filename: pgModulePath, loaded: true, exports: pgAdapter };
  return { pgAdapter };
}

async function seedFixtures(pool) {
  await pool.query(`INSERT INTO categories (id, name, slug) VALUES ($1, 'テスト用', 'cheer-log-write-local-verify')`, [CATEGORY_ID]);
  for (const [id, name] of [[ORG1, 'テストチーム1'], [ORG2, 'テストチーム2']]) {
    await pool.query(`INSERT INTO organizations (id, name, type, category_id) VALUES ($1, $2, 'football_club', $3)`, [id, name, CATEGORY_ID]);
  }
  await pool.query(`INSERT INTO events (id, organization_id, title, starts_at, status) VALUES ($1, $2, '試合1', NOW(), 'live')`, [EV1, ORG1]);
  await pool.query(`INSERT INTO events (id, organization_id, title, starts_at, status) VALUES ($1, $2, '試合2', NOW(), 'live')`, [EV2, ORG2]);
  for (const [id, org, name] of [[T1, ORG1, '選手1'], [T2, ORG1, '選手2'], [T3, ORG2, '選手3']]) {
    await pool.query(`INSERT INTO targets (id, organization_id, name, type) VALUES ($1, $2, $3, 'player')`, [id, org, name]);
  }
  for (let i = 1; i <= 30; i++) {
    const mac = `AA:BB:CC:00:01:${String(i).padStart(2, '0')}`;
    await pool.query(`INSERT INTO devices (mac_address, category_id, status) VALUES ($1, $2, 'active')`, [mac, CATEGORY_ID]);
  }
}
const mac = (i) => `AA:BB:CC:00:01:${String(i).padStart(2, '0')}`;

function waitForMessage(ws, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for message')), timeoutMs);
    function onMessage(data) {
      let m;
      try { m = JSON.parse(data.toString()); } catch (e) { return; }
      if (predicate(m)) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(m);
      }
    }
    ws.on('message', onMessage);
  });
}

async function main() {
  process.env.NODE_ENV = 'development';
  process.env.ALLOWED_ORIGINS = '*';
  process.env.ENABLE_REFERENCE_TOKEN = 'false';
  process.env.DATABASE_URL = 'postgres://local-verify-unused/placeholder';
  delete process.env.CHEER_LOG_WRITE_MODE; // 既定値（legacy）の確認から始める

  const { pgAdapter } = setupPgMem();
  const pool = new pgAdapter.Pool();
  await seedFixtures(pool);

  // --- DB往復回数のカウンタ（db.queryをラップ） -----------------------------------
  const db = require('../../src/db');
  const origQuery = db.query;
  const counts = { device_profile: 0, live_lookup: 0, insert: 0, other: 0 };
  let inflight = 0;
  let liveLookupDelayMs = 0;
  db.query = async (text, params) => {
    inflight++;
    const t = String(text);
    if (/INSERT INTO cheer_logs/.test(t)) counts.insert++;
    else if (/FROM events/.test(t) && /status = 'live'/.test(t)) counts.live_lookup++;
    else if (/FROM devices d/.test(t) && /LEFT JOIN/.test(t)) counts.device_profile++;
    else counts.other++;
    try {
      const res = await origQuery(text, params);
      if (liveLookupDelayMs && /FROM events/.test(t) && /status = 'live'/.test(t)) await sleep(liveLookupDelayMs);
      return res;
    } finally {
      inflight--;
    }
  };
  const resetCounts = () => { for (const k of Object.keys(counts)) counts[k] = 0; };
  const total = () => counts.device_profile + counts.live_lookup + counts.insert;
  async function quiesce() {
    let quiet = 0;
    while (quiet < 3) {
      await sleep(30);
      quiet = inflight === 0 ? quiet + 1 : 0;
    }
  }

  const app = require('../../src/app');
  const wsServer = require('../../src/websocket');
  const cheerQueries = require('../../src/db/cheerstickQueries');
  const server = http.createServer(app);
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); origLog(...a); };
  wsServer.attach(server, '/cheer');
  console.log = origLog;
  const port = await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    server.once('error', reject);
  });
  const wsUrl = `ws://127.0.0.1:${port}/cheer`;
  const httpBase = `http://127.0.0.1:${port}`;

  async function openConnected(m) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    ws.send(JSON.stringify({ type: 'connect', id: m }));
    await waitForMessage(ws, (x) => x.type === 'connect');
    return ws;
  }
  async function rpc(ws, msg) {
    const p = waitForMessage(ws, (x) => x.type === 'connect' || x.type === 'error');
    ws.send(JSON.stringify(msg));
    return p;
  }
  async function setup(ws, m, org, target) {
    await rpc(ws, { type: 'select_team', id: m, organization_id: org });
    await rpc(ws, { type: 'set_oshi', id: m, target_id: target });
  }
  const sendCount = (ws, m, v = 1) => ws.send(JSON.stringify({ type: 'count', id: m, value: v, duration_ms: 100 }));
  async function logRows(m) {
    const r = await pool.query(
      `SELECT cl.event_id, cl.target_id, cl.user_id, d.id AS device_id, d.selected_organization_id AS org
       FROM cheer_logs cl JOIN devices d ON d.id = cl.device_id WHERE d.mac_address = $1 ORDER BY cl.cheered_at, cl.intensity`,
      [m]
    );
    return r.rows;
  }
  async function totalLogs() {
    return (await pool.query(`SELECT COUNT(*)::int AS n FROM cheer_logs`)).rows[0].n;
  }
  async function adminPatchStatus(eventId, status) {
    const res = await fetch(`${httpBase}/api/v1/admin/events/${eventId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    return res.status;
  }

  // ============================ 0. 起動ログ ============================
  console.log('\n[verify] === step 0: startup log / default mode ===');
  check('起動ログにcheer-log-write configが出る（既定mode=legacy）',
    logs.some((l) => /\[WS\] cheer-log-write config: mode=legacy device_cache_ttl_ms=60000 live_event_cache_ttl_ms=2000/.test(l)),
    logs.find((l) => /cheer-log-write config/.test(l)));

  // ============================ A. legacy ============================
  console.log('\n[verify] === step A: legacy mode (default, env unset) ===');
  const wsA = await openConnected(mac(1));
  await setup(wsA, mac(1), ORG1, T1);
  await quiesce();
  resetCounts();
  for (let i = 0; i < 10; i++) sendCount(wsA, mac(1));
  await quiesce();
  const legacyLive = { ...counts };
  check('legacy/live試合あり：1countあたり3往復（device 1 + live 1 + insert 1）',
    counts.device_profile === 10 && counts.live_lookup === 10 && counts.insert === 10 && total() === 30,
    JSON.stringify(counts));
  check('legacy/live試合あり：10件がcheer_logsに記録される', (await logRows(mac(1))).length === 10);

  await adminPatchStatus(EV1, 'paused');
  await quiesce();
  resetCounts();
  const before = await totalLogs();
  for (let i = 0; i < 10; i++) sendCount(wsA, mac(1));
  await quiesce();
  check('legacy/liveなし：1countあたり2往復（device 1 + live 1）、INSERTなし',
    counts.device_profile === 10 && counts.live_lookup === 10 && counts.insert === 0 && total() === 20,
    JSON.stringify(counts));
  check('legacy/liveなし：cheer_logsに記録されない', (await totalLogs()) === before);
  await adminPatchStatus(EV1, 'live');
  wsA.close();

  // ============================ B. cached ============================
  process.env.CHEER_LOG_WRITE_MODE = 'cached';
  console.log('\n[verify] === step B: cached mode — round trips ===');
  const wsB = await openConnected(mac(2));
  await setup(wsB, mac(2), ORG1, T1);
  await quiesce();
  resetCounts();
  sendCount(wsB, mac(2)); // ウォームアップ（キャッシュミス）
  await quiesce();
  check('cached/初回count（キャッシュミス）：3往復', total() === 3, JSON.stringify(counts));
  resetCounts();
  for (let i = 0; i < 10; i++) sendCount(wsB, mac(2));
  await quiesce();
  check('cached/live試合あり（定常）：1countあたり1往復（INSERTのみ）',
    counts.device_profile === 0 && counts.live_lookup === 0 && counts.insert === 10 && total() === 10,
    JSON.stringify(counts));
  check('cached/live試合あり：11件がcheer_logsに記録される', (await logRows(mac(2))).length === 11);

  // 管理画面（HTTP PATCH）から paused：即時破棄
  console.log('\n[verify] === step G: admin status change invalidates cache immediately ===');
  const st1 = await adminPatchStatus(EV1, 'paused');
  check('管理API PATCH status=paused が成功', st1 === 200, `status=${st1}`);
  resetCounts();
  const b1 = await totalLogs();
  sendCount(wsB, mac(2));
  await quiesce();
  check('paused直後（2秒を待たず）のcountはINSERTされない＝即時反映', (await totalLogs()) === b1, JSON.stringify(counts));
  check('cached/liveなしの初回：live確認のみ1往復（デバイス情報はキャッシュ済み）',
    counts.device_profile === 0 && counts.live_lookup === 1 && total() === 1, JSON.stringify(counts));
  resetCounts();
  for (let i = 0; i < 10; i++) sendCount(wsB, mac(2));
  await quiesce();
  check('cached/liveなし（定常）：1countあたり0往復', total() === 0, JSON.stringify(counts));
  const st2 = await adminPatchStatus(EV1, 'live');
  check('管理API PATCH status=live が成功', st2 === 200, `status=${st2}`);
  const b2 = await totalLogs();
  sendCount(wsB, mac(2));
  await quiesce();
  check('live直後（2秒を待たず）のcountが記録される＝即時反映', (await totalLogs()) === b2 + 1);

  // ============================ C. select_team / set_oshi ============================
  console.log('\n[verify] === step C: cached — select_team / set_oshi reflected in count ===');
  const wsC = await openConnected(mac(3));
  await setup(wsC, mac(3), ORG1, T1);
  sendCount(wsC, mac(3), 5);
  await quiesce();
  await rpc(wsC, { type: 'set_oshi', id: mac(3), target_id: T2 });
  sendCount(wsC, mac(3), 6);
  await quiesce();
  await rpc(wsC, { type: 'select_team', id: mac(3), organization_id: ORG2 });
  sendCount(wsC, mac(3), 7); // set_oshi前：target_idはNULL（チーム変更で推しはリセットされる）
  await quiesce();
  await rpc(wsC, { type: 'set_oshi', id: mac(3), target_id: T3 });
  sendCount(wsC, mac(3), 8);
  await quiesce();
  const rc = await logRows(mac(3));
  check('count 4件が記録される', rc.length === 4, `rows=${rc.length}`);
  check('①ORG1/T1 → 試合1・選手1', rc[0] && rc[0].event_id === EV1 && rc[0].target_id === T1);
  check('②set_oshi(T2)後 → 試合1・選手2', rc[1] && rc[1].event_id === EV1 && rc[1].target_id === T2);
  check('③select_team(ORG2)後 → 試合2・target NULL', rc[2] && rc[2].event_id === EV2 && rc[2].target_id === null);
  check('④set_oshi(T3)後 → 試合2・選手3', rc[3] && rc[3].event_id === EV2 && rc[3].target_id === T3);
  check('device_idが全件同一デバイス', rc.every((r) => r.device_id === rc[0].device_id));

  // register後のuser_id反映
  const wsR = await openConnected(mac(4));
  await setup(wsR, mac(4), ORG1, T1);
  sendCount(wsR, mac(4));
  await quiesce();
  await rpc(wsR, { type: 'register', id: mac(4), name: 'テスト太郎', email: 'cheer-log-write@example.invalid' });
  sendCount(wsR, mac(4));
  await quiesce();
  const rr = await logRows(mac(4));
  check('register前のcountはuser_id NULL、register後のcountはuser_idが入る（キャッシュ破棄）',
    rr.length === 2 && rr[0].user_id === null && rr[1].user_id !== null, JSON.stringify(rr.map((r) => r.user_id)));

  // ============================ D. 再接続 ============================
  console.log('\n[verify] === step D: cached — reconnect (old connection closed) ===');
  const wsOld = await openConnected(mac(5));
  await setup(wsOld, mac(5), ORG1, T1);
  sendCount(wsOld, mac(5));
  await quiesce();
  const oldClosed = new Promise((res) => wsOld.once('close', (code) => res(code)));
  const wsNew = await openConnected(mac(5));
  const code = await oldClosed;
  check('旧接続がcode 4000でcloseされる', code === 4000, `code=${code}`);
  resetCounts();
  sendCount(wsNew, mac(5));
  await quiesce();
  check('新接続は自分のキャッシュ（未取得）から始まり、3往復で記録される（旧接続のキャッシュを引き継がない）',
    counts.device_profile === 1 && counts.insert === 1, JSON.stringify(counts));
  check('再接続後もチーム・推しが正しく記録される',
    (await logRows(mac(5))).length === 2 && (await logRows(mac(5)))[1].target_id === T1);

  // ============================ E. キャッシュの古さ ============================
  console.log('\n[verify] === step E: staleness (direct SQL bypasses invalidation) ===');
  // ORG1のキャッシュを「live」にする（EV1はlive）。ORG2(EV2)は別組織として影響を受けないことも確認する
  const wsE1 = await openConnected(mac(6));
  await setup(wsE1, mac(6), ORG1, T1);
  const wsE2 = await openConnected(mac(7));
  await setup(wsE2, mac(7), ORG2, T3);
  sendCount(wsE1, mac(6));
  sendCount(wsE2, mac(7));
  await quiesce();
  check('準備：両組織のcountが記録されキャッシュが温まる', (await logRows(mac(6))).length === 1 && (await logRows(mac(7))).length === 1);

  // E-1: liveだったEV1をSQLで直接finishedにする（invalidateされない）
  await pool.query(`UPDATE events SET status = 'finished' WHERE id = $1`, [EV1]);
  sendCount(wsE1, mac(6)); // TTL内 → 古いキャッシュ(live)のまま記録され続ける
  sendCount(wsE2, mac(7));
  await quiesce();
  check('E-1: finished化直後（TTL内）はORG1のcountが記録され続ける（古いキャッシュ、想定どおり）',
    (await logRows(mac(6))).length === 2);
  check('E-1: ORG2（別組織）は影響なく記録される', (await logRows(mac(7))).length === 2);
  await sleep(2200);
  sendCount(wsE1, mac(6));
  sendCount(wsE2, mac(7));
  await quiesce();
  check('E-1: 2秒経過後はORG1のcountが記録されなくなる（影響は最大TTLで解消）', (await logRows(mac(6))).length === 2);
  check('E-1: ORG2は引き続き記録される', (await logRows(mac(7))).length === 3);

  // E-2: 「liveなし」がキャッシュされている状態で、SQLで直接liveにする
  await pool.query(`UPDATE events SET status = 'live' WHERE id = $1`, [EV1]);
  sendCount(wsE1, mac(6)); // TTL内 → 古いキャッシュ(liveなし)のまま記録されない
  await quiesce();
  check('E-2: live化直後（TTL内）はORG1のcountが記録されない（古いキャッシュ、想定どおり）',
    (await logRows(mac(6))).length === 2);
  await sleep(2200);
  sendCount(wsE1, mac(6));
  await quiesce();
  check('E-2: 2秒経過後は記録が再開される（試合をまたいだ影響は残らない）', (await logRows(mac(6))).length === 3);

  // ============================ F. 同時取得の共有 / 破棄後の古い結果の非保存 ============================
  console.log('\n[verify] === step F: coalescing of concurrent live lookups / in-flight invalidation ===');
  cheerQueries.invalidateLiveEventCache();
  const sockets = [];
  for (let i = 10; i < 30; i++) {
    const w = await openConnected(mac(i));
    await setup(w, mac(i), ORG1, T1);
    sockets.push([w, mac(i)]);
  }
  await quiesce();
  cheerQueries.invalidateLiveEventCache();
  resetCounts();
  for (const [w, m] of sockets) sendCount(w, m);
  await quiesce();
  check('F-1: キャッシュが空の状態で20デバイスが同時にcount → live確認SELECTは1回だけ',
    counts.live_lookup === 1 && counts.insert === 20, JSON.stringify(counts));

  // 取得中に破棄された場合、その結果はキャッシュに保存されない
  cheerQueries.invalidateLiveEventCache();
  liveLookupDelayMs = 300;
  const inflight1 = cheerQueries.findLiveEventForOrganizationCached(ORG1); // EV1(live)を読む
  await sleep(50);
  await pool.query(`UPDATE events SET status = 'paused' WHERE id = $1`, [EV1]);
  cheerQueries.invalidateLiveEventCache(); // 管理画面の状態変更相当
  const r1 = await inflight1;
  liveLookupDelayMs = 0;
  resetCounts();
  const r2 = await cheerQueries.findLiveEventForOrganizationCached(ORG1);
  check('F-2: 破棄前に始まった取得の結果（古いlive）は呼び出し元には返るが、キャッシュには残らない',
    r1 && r1.id === EV1 && r2 === null && counts.live_lookup === 1, `r1=${r1 && r1.id} r2=${r2} lookups=${counts.live_lookup}`);
  await pool.query(`UPDATE events SET status = 'live' WHERE id = $1`, [EV1]);
  cheerQueries.invalidateLiveEventCache();

  // ============================ H. legacy復帰 / 不正な値 ============================
  console.log('\n[verify] === step H: switching back to legacy / invalid value ===');
  process.env.CHEER_LOG_WRITE_MODE = 'legacy';
  resetCounts();
  sendCount(wsB, mac(2));
  await quiesce();
  check('legacyに戻すと再び3往復', total() === 3, JSON.stringify(counts));
  process.env.CHEER_LOG_WRITE_MODE = 'bogus';
  resetCounts();
  sendCount(wsB, mac(2));
  await quiesce();
  check('不正な値はlegacy扱い（3往復）', total() === 3, JSON.stringify(counts));

  console.log('\n[verify] --- 往復回数まとめ（1countあたり） ---');
  console.log(`[verify]   legacy / live試合あり : 3 (device 1 + live 1 + insert 1)  ※実測 ${legacyLive.device_profile / 10}+${legacyLive.live_lookup / 10}+${legacyLive.insert / 10}`);
  console.log('[verify]   legacy / liveなし     : 2 (device 1 + live 1)');
  console.log('[verify]   cached / live試合あり : 1 (insert のみ)');
  console.log('[verify]   cached / liveなし     : 0');

  for (const w of [wsB, wsC, wsR, wsNew, wsE1, wsE2, ...sockets.map((s) => s[0])]) w.close();
  console.log(`\n[verify] ================ RESULT: PASS=${PASS} FAIL=${FAIL} ================`);
  db.query = origQuery;
  await pool.end();
  server.close();
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[verify] fatal error:', err);
  process.exit(1);
});
