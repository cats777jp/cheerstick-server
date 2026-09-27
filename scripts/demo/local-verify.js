#!/usr/bin/env node
// scripts/demo/local-verify.js
// 応援合戦デモ Phase 1・Phase 2 のローカル動作確認ハーネス。
// scripts/load-test/local-verify.js と同じ方式（pg-memで実サーバーを起動）で、
// 準備スクリプト（battle-demo-prepare.js）→デモスクリプト（battle-demo.js）を一気通貫で確認する。
//
// ★本番・staging環境には一切接続しない。pg-memはプロセス内で完結するインメモリ実装であり、
//   外部ネットワーク接続・ファイル永続化を一切行わない。起動するサーバーも127.0.0.1限定。
//   ローカル確認用に作成したデータは本番に一切影響しない。
//
// 確認項目（cheerstick-battle-demo-phase1-2-impl-20260927.md 4章）:
//   1. 準備スクリプトのdry runと--yes実行、2回目の実行で重複作成されないこと
//   2. --pause-other-liveで既存live試合がpausedになり、新しい試合をliveにできること
//   3. 各5台（計10台）でデモスクリプトを短時間実行し、スコアAPIの値が増えること、
//      目標比率の切替と追従が働くこと
//   4. --finish A/B/closeでそれぞれ終盤の比率が想定側に寄ること
//   5. サーバーを途中で停止させて緊急停止が発動すること
//   6. --finish-runで試合がfinishedになること
//
// 使い方: node scripts/demo/local-verify.js

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

const CATEGORY_ID = '90000000-0000-0000-0000-000000000001';
const ORG_A_ID = '90000000-0000-0000-0000-0000000000a1';
const ORG_B_ID = '90000000-0000-0000-0000-0000000000b1';
const PRE_EXISTING_LIVE_EVENT_ID = '90000000-0000-0000-0000-0000000000e0';
const MIGRATIONS_DIR = path.join(__dirname, '../../migrations');
const DEVICES_PER_TEAM = 5;

let PASS = 0;
let FAIL = 0;
function check(label, condition, detail) {
  if (condition) {
    PASS++;
    console.log(`[verify] PASS: ${label}${detail ? ' (' + detail + ')' : ''}`);
  } else {
    FAIL++;
    console.error(`[verify] FAIL: ${label}${detail ? ' (' + detail + ')' : ''}`);
  }
}

// --- pg-mem セットアップ（scripts/load-test/local-verify.jsと同じ方式） -------------
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
    console.log(`[verify] migration applied: ${file}`);
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
    implementation: () => 'cheerstick_pgmem_demo_local_verify',
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
    `INSERT INTO categories (id, name, slug) VALUES ($1, 'デモ用', 'demo-local-verify')`,
    [CATEGORY_ID]
  );
  await pool.query(
    `INSERT INTO organizations (id, name, type, category_id) VALUES ($1, 'EMUTTO', 'football_club', $2)`,
    [ORG_A_ID, CATEGORY_ID]
  );
  await pool.query(
    `INSERT INTO organizations (id, name, type, category_id) VALUES ($1, 'J SPORTS', 'football_club', $2)`,
    [ORG_B_ID, CATEGORY_ID]
  );
}

function waitForExit(child) {
  return new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try { return JSON.parse(l); } catch (err) { return null; }
    })
    .filter(Boolean);
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
  let server = http.createServer(app);
  wsServer.attach(server, '/cheer');

  let port = await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    server.once('error', reject);
  });
  console.log(`[verify] server listening on 127.0.0.1:${port}`);

  const apiBase = () => `http://127.0.0.1:${port}/api/v1`;
  const prepare = require('./battle-demo-prepare');

  // === 1. dry run ============================================================
  console.log('\n[verify] === step 1: prepare dry run ===');
  const dryRunResult = await prepare.main([
    `--api-base=${apiBase()}`,
    `--devices-per-team=${DEVICES_PER_TEAM}`,
  ]);
  check('dry runでは書き込みが行われない（battleが未作成）', dryRunResult.battle.applied === false);

  // === 1(続き). --yes 1回目 ===================================================
  console.log('\n[verify] === step 1(続き): prepare --yes (1st run) ===');
  const firstRun = await prepare.main([
    `--api-base=${apiBase()}`,
    `--devices-per-team=${DEVICES_PER_TEAM}`,
    '--yes',
  ]);
  check('1回目実行でデバイスがcreatedになる', firstRun.teamAResult.summary.created === DEVICES_PER_TEAM &&
    firstRun.teamBResult.summary.created === DEVICES_PER_TEAM,
    `teamA=${JSON.stringify(firstRun.teamAResult.summary)} teamB=${JSON.stringify(firstRun.teamBResult.summary)}`);
  check('1回目実行でbattleが作成される', !!firstRun.battle.id);

  const deviceCountAfterFirst = await verifyPool.query(
    `SELECT COUNT(*)::int AS n FROM devices WHERE mac_address LIKE 'AA:00:00:02%'`
  );

  // === 1(続き). --yes 2回目：重複作成されないこと ==============================
  console.log('\n[verify] === step 1(続き): prepare --yes (2nd run, same mac range) ===');
  const secondRun = await prepare.main([
    `--api-base=${apiBase()}`,
    `--devices-per-team=${DEVICES_PER_TEAM}`,
    '--yes',
    '--pause-other-live', // 1回目実行のevent A/Bがliveのまま残っているため、2回目もこれが無いとLIVE_EVENT_CONFLICTになる
  ]);
  check('2回目実行でデバイスが重複作成されない（createdが0）',
    secondRun.teamAResult.summary.created === 0 && secondRun.teamBResult.summary.created === 0,
    `teamA=${JSON.stringify(secondRun.teamAResult.summary)} teamB=${JSON.stringify(secondRun.teamBResult.summary)}`);
  const deviceCountAfterSecond = await verifyPool.query(
    `SELECT COUNT(*)::int AS n FROM devices WHERE mac_address LIKE 'AA:00:00:02%'`
  );
  check('2回目実行後もデバイス総数が変わらない',
    deviceCountAfterFirst.rows[0].n === deviceCountAfterSecond.rows[0].n,
    `first=${deviceCountAfterFirst.rows[0].n} second=${deviceCountAfterSecond.rows[0].n}`);
  check('2回目実行でも新しいbattleが作成される（試合は毎回新規作成の設計）',
    !!secondRun.battle.id && secondRun.battle.id !== firstRun.battle.id);

  // === 2. --pause-other-live ==================================================
  console.log('\n[verify] === step 2: --pause-other-live ===');
  // このタイミングで初めて、チームAに既存のlive試合を1件作る
  // （step 1のプレーンな1回目/2回目実行を、この試合による干渉なしで確認するため）。
  await verifyPool.query(
    `INSERT INTO events (id, organization_id, title, starts_at, status)
     VALUES ($1, $2, '既存のlive試合（pause-other-live確認用）', NOW(), 'live')`,
    [PRE_EXISTING_LIVE_EVENT_ID, ORG_A_ID]
  );
  const pauseRun = await prepare.main([
    `--api-base=${apiBase()}`,
    `--devices-per-team=${DEVICES_PER_TEAM}`,
    '--yes',
    '--pause-other-live',
  ]);
  const preExisting = await verifyPool.query(`SELECT status FROM events WHERE id = $1`, [PRE_EXISTING_LIVE_EVENT_ID]);
  check('既存のlive試合がpausedになる', preExisting.rows[0].status === 'paused');
  const newEventsStatus = await verifyPool.query(
    `SELECT status FROM events WHERE id = ANY($1)`,
    [[pauseRun.eventA.id, pauseRun.eventB.id]]
  );
  check('新しい2試合がliveになっている', newEventsStatus.rows.every((r) => r.status === 'live'));
  check('pauseResultに変更が記録される', pauseRun.pauseResult.some((c) => c.id === PRE_EXISTING_LIVE_EVENT_ID && c.applied));

  // === 3・4. デモ本体スクリプト（比率追従・終盤演出） ==========================
  // 以降は毎回新しいbattle（=新しいevent）を作るため、前回分がliveのまま残らないよう
  // --pause-other-liveを常に付ける（本番運用でも複数回デモを行う際の想定挙動と同じ）。
  async function freshBattle() {
    return prepare.main([
      `--api-base=${apiBase()}`,
      `--devices-per-team=${DEVICES_PER_TEAM}`,
      '--yes',
      '--pause-other-live',
    ]);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cheerstick-battle-demo-verify-'));

  async function runDemo(battleId, orgA, orgB, finish, durationMs) {
    const metricsPath = path.join(tmpDir, `metrics-${finish}.jsonl`);
    const child = spawn(
      process.execPath,
      [
        path.join(__dirname, 'battle-demo.js'),
        `--battle-id=${battleId}`,
        `--org-a=${orgA}`,
        `--org-b=${orgB}`,
        `--devices-per-team=${DEVICES_PER_TEAM}`,
        `--url=ws://127.0.0.1:${port}/cheer`,
        `--score-url=${apiBase()}/event-battles/${battleId}/score`,
        `--duration-ms=${durationMs}`,
        '--count-interval-ms=300',
        '--report-interval-ms=1000',
        `--metrics-log-path=${metricsPath}`,
        `--finish=${finish}`,
      ],
      { stdio: 'inherit', cwd: path.join(__dirname, '../..') }
    );
    const { code } = await waitForExit(child);
    return { code, metricsPath };
  }

  console.log('\n[verify] === step 3・4: battle-demo.js (finish=close/A/B) ===');
  for (const finish of ['close', 'A', 'B']) {
    console.log(`\n[verify] --- running battle-demo.js --finish=${finish} ---`);
    // 毎回新しいbattle（=新しいevent、スコア0スタート）を用意してから実行する。
    const run = await freshBattle();
    const { code, metricsPath } = await runDemo(run.battle.id, run.orgA.id, run.orgB.id, finish, 45000);
    check(`battle-demo.js --finish=${finish} が正常終了する（exit code）`, code === 0, `code=${code}`);

    const records = readJsonl(metricsPath).filter((r) => r.score);
    check(`--finish=${finish}: メトリクスが記録される`, records.length > 0, `records=${records.length}`);

    if (records.length > 0) {
      const last = records[records.length - 1];
      check(`--finish=${finish}: スコアが増加している（合計>0）`, (last.score.a + last.score.b) > 0,
        `a=${last.score.a} b=${last.score.b}`);

      const targets = records.map((r) => r.score.target_ratio_a);
      const distinctTargets = new Set(targets.map((t) => t.toFixed(4)));
      check(`--finish=${finish}: 目標比率が途中で切り替わっている`, distinctTargets.size > 1,
        `distinct_targets=${[...distinctTargets].join(',')}`);

      if (finish === 'close') {
        check('--finish=close: 終了直前のactual_ratio_aが0.5付近に寄る',
          Math.abs(last.score.actual_ratio_a - 0.5) < 0.15, `actual=${last.score.actual_ratio_a}`);
      } else if (finish === 'A') {
        check('--finish=A: 終了直前のスコアでチームAが優勢', last.score.a > last.score.b,
          `a=${last.score.a} b=${last.score.b}`);
      } else if (finish === 'B') {
        check('--finish=B: 終了直前のスコアでチームBが優勢', last.score.b > last.score.a,
          `a=${last.score.a} b=${last.score.b}`);
      }
    }
  }

  // === 5. 緊急停止 ============================================================
  console.log('\n[verify] === step 5: emergency stop (server killed mid-run) ===');
  const emergencyRunPrepare = await freshBattle();
  const emergencyMetricsPath = path.join(tmpDir, 'metrics-emergency.jsonl');
  const emergencyChild = spawn(
    process.execPath,
    [
      path.join(__dirname, 'battle-demo.js'),
      `--battle-id=${emergencyRunPrepare.battle.id}`,
      `--org-a=${emergencyRunPrepare.orgA.id}`,
      `--org-b=${emergencyRunPrepare.orgB.id}`,
      `--devices-per-team=${DEVICES_PER_TEAM}`,
      `--url=ws://127.0.0.1:${port}/cheer`,
      `--score-url=${apiBase()}/event-battles/${emergencyRunPrepare.battle.id}/score`,
      '--duration-ms=60000',
      '--count-interval-ms=300',
      '--report-interval-ms=1000',
      `--metrics-log-path=${emergencyMetricsPath}`,
    ],
    { stdio: 'inherit', cwd: path.join(__dirname, '../..') }
  );

  // ramp-upが完了し、接続が確立するのを待ってからサーバーを落とす。
  await new Promise((resolve) => setTimeout(resolve, 3000));
  console.log('[verify] closing the local server to trigger emergency stop...');
  // WebSocketへのアップグレード後のソケットはhttp.Serverの接続管理から外れるため、
  // server.close()/closeAllConnections()だけでは切断されない（アップグレード後は
  // ws側のWebSocketServer.clientsが実体を持つ）。wss.clientsを直接terminate()して
  // 「サーバーが落ちて接続が切れる」状況を再現する。
  wsServer.wss.clients.forEach((client) => client.terminate());
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });

  const { code: emergencyExitCode } = await waitForExit(emergencyChild);
  check('サーバー停止後、battle-demo.jsが緊急停止でexit code 1を返す', emergencyExitCode === 1,
    `code=${emergencyExitCode}`);
  const emergencyRecords = readJsonl(emergencyMetricsPath);
  const emergencyEntry = emergencyRecords.find((r) => r.emergency_stop);
  check('緊急停止の理由がJSONLに記録される', !!emergencyEntry, emergencyEntry && emergencyEntry.emergency_stop);

  // --- サーバーを再起動する（step 6のfinish-run確認用） ---
  console.log('\n[verify] restarting local server for step 6...');
  server = http.createServer(app);
  wsServer.attach(server, '/cheer');
  port = await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    server.once('error', reject);
  });
  console.log(`[verify] server re-listening on 127.0.0.1:${port}`);

  // === 6. --finish-run ========================================================
  console.log('\n[verify] === step 6: --finish-run ===');
  const finishTargetRun = await freshBattle();
  await prepare.main([
    `--api-base=${apiBase()}`,
    `--finish-run=${finishTargetRun.battle.id}`,
    '--yes',
  ]);
  const finishedStatus = await verifyPool.query(
    `SELECT status FROM events WHERE id = ANY($1)`,
    [[finishTargetRun.eventA.id, finishTargetRun.eventB.id]]
  );
  check('--finish-run後、両試合がfinishedになる', finishedStatus.rows.every((r) => r.status === 'finished'),
    JSON.stringify(finishedStatus.rows));

  // --- 後片付け ---------------------------------------------------------------
  await new Promise((resolve) => server.close(resolve));
  await verifyPool.end();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\n[verify] ================ RESULT: PASS=${PASS} FAIL=${FAIL} ================`);
  process.exit(FAIL > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[verify] failed:', err.stack || err.message);
  process.exit(1);
});
