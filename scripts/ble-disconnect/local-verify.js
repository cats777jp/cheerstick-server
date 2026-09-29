#!/usr/bin/env node
// scripts/ble-disconnect/local-verify.js
// BLE切断のサーバー記録機能（type: "ble_disconnect"、migrations/013）のローカル動作確認。
// scripts/demo/local-verify.js と同じ方式（pg-memで実サーバーを起動）で、
// 実際のWebSocketクライアント（wsパッケージ）からメッセージを送り、
// ble_disconnect_logsへ正しく記録されることを確認する。
//
// ★本番・staging環境には一切接続しない。pg-memはプロセス内で完結するインメモリ実装。
//
// 使い方: node scripts/ble-disconnect/local-verify.js

'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');

const MIGRATIONS_DIR = path.join(__dirname, '../../migrations');
const CATEGORY_ID = '90000000-0000-0000-0000-000000000004';
const ORG_ID = '90000000-0000-0000-0000-0000000000a4';
const LIVE_EVENT_ID = '90000000-0000-0000-0000-0000000000e4';

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- pg-mem セットアップ（scripts/demo/local-verify.jsと同じ方式） ----------------
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
    const ch = sql[i];
    buf += ch;
    if (ch === ';' && !inDollar) {
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
    const statements = splitStatements(sql);
    for (const stmt of statements) {
      const withoutComments = stmt
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim();
      if (!withoutComments) continue;
      try {
        memDb.public.query(stmt);
      } catch (err) {
        if (!SKIP_PATTERN.test(withoutComments)) {
          throw new Error(`migration ${file} failed on statement:\n${withoutComments.slice(0, 200)}\n${err.message}`);
        }
      }
    }
  }
  console.log(`[verify] migrations applied (${files.length} files, includes 013_add_ble_disconnect_logs.sql)`);
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
    implementation: () => 'cheerstick_pgmem_ble_disconnect_local_verify',
  });

  applyMigrations(memDb);

  const pgAdapter = memDb.adapters.createPg();
  const pgModulePath = require.resolve('pg');
  require.cache[pgModulePath] = {
    id: pgModulePath,
    filename: pgModulePath,
    loaded: true,
    exports: pgAdapter,
  };

  return { pgAdapter };
}

async function seedFixtures(pool) {
  await pool.query(
    `INSERT INTO categories (id, name, slug) VALUES ($1, 'テスト用', 'ble-disconnect-local-verify')`,
    [CATEGORY_ID]
  );
  await pool.query(
    `INSERT INTO organizations (id, name, type, category_id) VALUES ($1, 'テストチーム', 'football_club', $2)`,
    [ORG_ID, CATEGORY_ID]
  );
  await pool.query(
    `INSERT INTO events (id, organization_id, title, starts_at, status)
     VALUES ($1, $2, 'liveテスト試合', NOW(), 'live')`,
    [LIVE_EVENT_ID, ORG_ID]
  );
  // select_team（CATEGORY_MISMATCH検証）を通すため、TOFU（connect時の自動作成）に頼らず、
  // category_idを設定済みの状態でデバイスを事前登録しておく。
  await pool.query(
    `INSERT INTO devices (mac_address, category_id, status) VALUES ($1, $2, 'active'), ($3, $2, 'active')`,
    ['AA:BB:CC:00:00:01', CATEGORY_ID, 'AA:BB:CC:00:00:02']
  );
}

function waitForMessage(ws, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for message')), timeoutMs);
    function onMessage(data) {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (err) {
        return;
      }
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(msg);
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

  console.log('[verify] setting up pg-mem and applying migrations...');
  const { pgAdapter } = setupPgMem();
  const { Pool } = pgAdapter;
  const verifyPool = new Pool();
  await seedFixtures(verifyPool);

  console.log('[verify] starting CheerStick server (src/app.js + src/websocket) on 127.0.0.1 ...');
  const app = require('../../src/app');
  const wsServer = require('../../src/websocket');
  const server = http.createServer(app);
  wsServer.attach(server, '/cheer');

  const port = await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    server.once('error', reject);
  });
  console.log(`[verify] server listening on 127.0.0.1:${port}`);

  const wsUrl = `ws://127.0.0.1:${port}/cheer`;

  async function openConnectedSocket(mac) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.send(JSON.stringify({ type: 'connect', id: mac }));
    await waitForMessage(ws, (m) => m.type === 'connect');
    return ws;
  }

  // === 1. selected_organization_idが無いデバイス：event_idがNULLで記録される =======
  console.log('\n[verify] === step 1: ble_disconnect without selected team (event_id should be NULL) ===');
  const mac1 = 'AA:BB:CC:00:00:01';
  const ws1 = await openConnectedSocket(mac1);
  ws1.send(JSON.stringify({ type: 'ble_disconnect', id: mac1 }));
  await sleep(300); // レスポンス無しの非同期処理（DB INSERT）が完了するのを待つ

  const rows1 = await verifyPool.query(
    `SELECT bdl.event_id FROM ble_disconnect_logs bdl
     JOIN devices d ON d.id = bdl.device_id
     WHERE d.mac_address = $1`,
    [mac1]
  );
  check('event_idがNULLで1件記録される', rows1.rows.length === 1 && rows1.rows[0].event_id === null,
    JSON.stringify(rows1.rows));

  // === 2. selected_organization_idがあり、live中の試合がある：event_idが記録される ==
  console.log('\n[verify] === step 2: ble_disconnect with selected team + live event (event_id populated) ===');
  const mac2 = 'AA:BB:CC:00:00:02';
  const ws2 = await openConnectedSocket(mac2);
  ws2.send(JSON.stringify({ type: 'select_team', id: mac2, organization_id: ORG_ID }));
  await waitForMessage(ws2, (m) => m.type === 'connect');
  ws2.send(JSON.stringify({ type: 'ble_disconnect', id: mac2 }));
  await sleep(300);

  const rows2 = await verifyPool.query(
    `SELECT bdl.event_id FROM ble_disconnect_logs bdl
     JOIN devices d ON d.id = bdl.device_id
     WHERE d.mac_address = $1`,
    [mac2]
  );
  check('event_idがlive試合のIDで1件記録される', rows2.rows.length === 1 && rows2.rows[0].event_id === LIVE_EVENT_ID,
    JSON.stringify(rows2.rows));

  // === 3. 未登録デバイス（一度もconnectしていないMAC）：エラーにならず、記録もされない ==
  console.log('\n[verify] === step 3: ble_disconnect for an unknown device (no crash, no row) ===');
  const ws3 = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws3.once('open', resolve);
    ws3.once('error', reject);
  });
  ws3.send(JSON.stringify({ type: 'ble_disconnect', id: 'FF:FF:FF:FF:FF:FF' }));
  await sleep(300);
  check('未登録デバイスへのble_disconnectでソケットが切断されない（クラッシュしない）',
    ws3.readyState === WebSocket.OPEN);
  const rows3 = await verifyPool.query(`SELECT COUNT(*)::int AS n FROM ble_disconnect_logs`);
  check('未登録デバイス分は記録されない（1・2の2件のまま）', rows3.rows[0].n === 2, `count=${rows3.rows[0].n}`);

  // === 4. idが無いメッセージ：エラーにならない =====================================
  console.log('\n[verify] === step 4: ble_disconnect without id (no crash) ===');
  ws3.send(JSON.stringify({ type: 'ble_disconnect' }));
  await sleep(300);
  check('idが無いble_disconnectでもソケットが切断されない', ws3.readyState === WebSocket.OPEN);
  const rows4 = await verifyPool.query(`SELECT COUNT(*)::int AS n FROM ble_disconnect_logs`);
  check('idが無い場合は記録されない（2件のまま）', rows4.rows[0].n === 2, `count=${rows4.rows[0].n}`);

  // === 5. ble_disconnectに対してレスポンスが送られない（既存のcountと同じ設計） ======
  console.log('\n[verify] === step 5: no response is sent for ble_disconnect ===');
  let gotUnexpectedResponse = false;
  const onAnyMessage = () => { gotUnexpectedResponse = true; };
  ws1.on('message', onAnyMessage);
  ws1.send(JSON.stringify({ type: 'ble_disconnect', id: mac1 }));
  await sleep(500);
  ws1.off('message', onAnyMessage);
  check('ble_disconnectに対してレスポンスが送られない', !gotUnexpectedResponse);

  // 上のstep5送信分（mac1、2回目）が記録されていることも確認（立ち上がりエッジ制御は
  // クライアント側の責務のため、サーバー側は送られてきたものをそのまま記録する）
  const rows5 = await verifyPool.query(
    `SELECT COUNT(*)::int AS n FROM ble_disconnect_logs bdl
     JOIN devices d ON d.id = bdl.device_id WHERE d.mac_address = $1`,
    [mac1]
  );
  check('サーバー側は重複排除せず、送られてきた分だけ記録する（mac1で2件）', rows5.rows[0].n === 2,
    `count=${rows5.rows[0].n}`);

  ws1.close();
  ws2.close();
  ws3.close();

  console.log(`\n[verify] ================ RESULT: PASS=${PASS} FAIL=${FAIL} ================`);
  await verifyPool.end();
  server.close();
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[verify] fatal error:', err);
  process.exit(1);
});
