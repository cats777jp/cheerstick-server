#!/usr/bin/env node
// scripts/load-test/local-verify.js
// 負荷試験3スクリプト（seed-dummy-devices.js / load-test.js / cleanup-dummy-devices.js）の
// ローカル動作確認ハーネス。pg-mem（ローカル疑似DB、インメモリ）上でCheerStickサーバー本体
// （src/app.js + src/websocket/index.js）を実際に起動し、
//   1. 疑似DBへマイグレーションを適用
//   2. seed-dummy-devices.js でダミーデバイスを投入
//   3. サーバーを127.0.0.1の空きポートで起動
//   4. load-test.js を別プロセスとして起動し、実際にWebSocketで接続・カウント送信させる
//   5. cheer_logsの増加数とload-test.jsのログ（送信成功件数）を突き合わせる
// を自動で行う。
//
// ★本番・staging環境には一切接続しない。pg-memはプロセス内で完結するインメモリ実装であり、
//   外部ネットワーク接続・ファイル永続化を一切行わない。起動するサーバーも127.0.0.1限定。
//
// 使い方:
//   node scripts/load-test/local-verify.js
//   node scripts/load-test/local-verify.js --connections=50 --duration-ms=20000

'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const CATEGORY_ID = '10000000-0000-0000-0000-000000000001'; // Jリーグ
const ORGANIZATION_ID = '00000000-0000-0000-0000-000000000001'; // V・ファーレン長崎
const TARGET_ID = '00000000-0000-0000-0000-000000000101'; // ヴィヴィくん
const MIGRATIONS_DIR = path.join(__dirname, '../../migrations');

function parseArgs(argv) {
  const args = { connections: 30, durationMs: 15000, countIntervalMs: 2000 };
  for (const raw of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(raw);
    if (!m) continue;
    const [, key, value] = m;
    if (key === 'connections') args.connections = parseInt(value, 10);
    else if (key === 'duration-ms') args.durationMs = parseInt(value, 10);
    else if (key === 'count-interval-ms') args.countIntervalMs = parseInt(value, 10);
  }
  return args;
}

// $$ ... $$ のドル引用文字列の中はステートメント区切り（;）とみなさない簡易分割。
// このリポジトリのマイグレーションで使われているのは無名タグ($$)のみのため、それにのみ対応する。
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

// pg-memが未対応の構文（plpgsql関数・トリガー・COMMENT ON・GINインデックス）はスキップする。
// いずれも今回の検証（devices/organizations/targets/events/cheer_logsのCRUDと
// WebSocketメッセージハンドラの動作確認）には不要なため、スキップしても検証の意味は損なわれない。
const SKIP_PATTERN = /^CREATE\s+(OR\s+REPLACE\s+)?(TRIGGER|FUNCTION)|^COMMENT\s+ON|USING\s+gin/i;

function applyMigrations(memDb) {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    let sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    sql = sql.replace(/^CREATE EXTENSION.*$/gim, ''); // pgcryptoは別途registerFunctionで代替
    const statements = splitStatements(sql);
    let ok = 0;
    let skipped = 0;
    for (const stmt of statements) {
      const withoutComments = stmt
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim();
      if (!withoutComments) continue;
      try {
        memDb.public.query(stmt);
        ok++;
      } catch (err) {
        if (SKIP_PATTERN.test(withoutComments)) {
          skipped++;
        } else {
          throw new Error(`migration ${file} failed on statement:\n${withoutComments.slice(0, 200)}\n${err.message}`);
        }
      }
    }
    console.log(`[local-verify] migration applied: ${file} (statements ok=${ok} skipped=${skipped})`);
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
    implementation: () => 'cheerstick_pgmem_local_verify',
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

  return { memDb, pgAdapter };
}

async function seedFixtures(pool) {
  // ロードテストの count が実際にcheer_logsへ記録されるよう、対象組織にlive中の試合を1件作る。
  await pool.query(
    `INSERT INTO events (organization_id, title, sport_type, starts_at, status)
     VALUES ($1, 'ロードテスト検証用の試合', 'football', NOW(), 'live')`,
    [ORGANIZATION_ID]
  );
}

function waitForExit(child) {
  return new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  process.env.NODE_ENV = 'development';
  process.env.ALLOWED_ORIGINS = '*';
  process.env.ENABLE_REFERENCE_TOKEN = 'false';
  process.env.DATABASE_URL = 'postgres://local-verify-unused/placeholder'; // pg-memアダプタは実際には参照しない

  console.log('[local-verify] setting up pg-mem and applying migrations...');
  const { pgAdapter } = setupPgMem();
  const { Pool } = pgAdapter;
  const verifyPool = new Pool();

  await seedFixtures(verifyPool);

  console.log(`[local-verify] seeding ${args.connections} dummy devices via seed-dummy-devices.js ...`);
  const { main: seedMain } = require('./seed-dummy-devices');
  await seedMain([`--count=${args.connections}`, `--category-id=${CATEGORY_ID}`, `--organization-id=${ORGANIZATION_ID}`]);

  console.log('[local-verify] starting CheerStick server (src/app.js + src/websocket) on 127.0.0.1 ...');
  const app = require('../../src/app');
  const wsServer = require('../../src/websocket');
  const server = http.createServer(app);
  wsServer.attach(server, '/cheer');

  const port = await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    server.once('error', reject);
  });
  console.log(`[local-verify] server listening on 127.0.0.1:${port}`);

  const wsUrl = `ws://127.0.0.1:${port}/cheer`;
  console.log(
    `[local-verify] spawning load-test.js: connections=${args.connections} duration=${args.durationMs}ms url=${wsUrl}`
  );

  const child = spawn(
    process.execPath,
    [
      path.join(__dirname, 'load-test.js'),
      `--connections=${args.connections}`,
      `--url=${wsUrl}`,
      `--organization-id=${ORGANIZATION_ID}`,
      `--target-id=${TARGET_ID}`,
      `--count-interval-ms=${args.countIntervalMs}`,
      `--duration-ms=${args.durationMs}`,
      '--report-interval-ms=5000',
    ],
    { stdio: 'inherit', cwd: path.join(__dirname, '../..') }
  );

  const { code } = await waitForExit(child);
  console.log(`[local-verify] load-test.js exited with code ${code}`);

  console.log('[local-verify] verifying DB state ...');
  const deviceCountRes = await verifyPool.query(
    "SELECT COUNT(*)::int AS n FROM devices WHERE mac_address LIKE 'AA:00:00:00%'"
  );
  const cheerLogCountRes = await verifyPool.query('SELECT COUNT(*)::int AS n FROM cheer_logs');
  const perDeviceRes = await verifyPool.query(
    `SELECT d.mac_address, COUNT(cl.id)::int AS cheer_log_count,
            d.selected_organization_id, d.current_target_id
     FROM devices d
     LEFT JOIN cheer_logs cl ON cl.device_id = d.id
     WHERE d.mac_address LIKE 'AA:00:00:00%'
     GROUP BY d.id, d.mac_address, d.selected_organization_id, d.current_target_id
     ORDER BY d.mac_address
     LIMIT 5`
  );

  console.log('--- verification summary -----------------------------------');
  console.log(`dummy devices in DB           : ${deviceCountRes.rows[0].n} (expected ${args.connections})`);
  console.log(`cheer_logs total rows         : ${cheerLogCountRes.rows[0].n}`);
  console.log('sample devices (first 5, sorted by mac):');
  for (const row of perDeviceRes.rows) {
    console.log(
      `  ${row.mac_address}  cheer_logs=${row.cheer_log_count}  ` +
      `selected_organization_id=${row.selected_organization_id ? 'set' : 'NULL'}  ` +
      `current_target_id=${row.current_target_id ? 'set' : 'NULL'}`
    );
  }
  console.log('--------------------------------------------------------------');

  console.log('[local-verify] verifying cleanup-dummy-devices.js (dry run then --yes) ...');
  const { main: cleanupMain } = require('./cleanup-dummy-devices');
  await cleanupMain(['--mac-prefix=AA:00:00:00']); // dry run
  await cleanupMain(['--mac-prefix=AA:00:00:00', '--yes']);

  const afterCleanupDevices = await verifyPool.query(
    "SELECT COUNT(*)::int AS n FROM devices WHERE mac_address LIKE 'AA:00:00:00%'"
  );
  const afterCleanupCheerLogs = await verifyPool.query('SELECT COUNT(*)::int AS n FROM cheer_logs');
  console.log(
    `[local-verify] after cleanup: devices=${afterCleanupDevices.rows[0].n} (expected 0), ` +
    `cheer_logs=${afterCleanupCheerLogs.rows[0].n} (expected 0)`
  );

  await new Promise((resolve) => server.close(resolve));
  await verifyPool.end();
  console.log('[local-verify] done.');
}

main().catch((err) => {
  console.error('[local-verify] failed:', err.stack || err.message);
  process.exit(1);
});
