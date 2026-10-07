#!/usr/bin/env node
// scripts/demo/local-verify-demo-mode.js
// お客様向け「デモモード」機能（管理画面へのボタン追加）のローカル動作確認ハーネス。
// scripts/demo/local-verify.js と同じ方式（pg-memで実サーバーを起動）で、
// POST/GET /admin/demo/* の一連の流れをHTTP経由（実際のクライアントと同じ経路）で確認する。
//
// ★本番・staging環境には一切接続しない。pg-memはプロセス内で完結するインメモリ実装であり、
//   外部ネットワーク接続・ファイル永続化を一切行わない。起動するサーバーも127.0.0.1限定。
//
// 60秒固定のデモ時間は、DEMO_MODE_TEST_DURATION_MS_OVERRIDE環境変数でのみ短縮できる
// （公開APIのリクエストボディからは受け付けない設計そのものは変えていない。
// docs/proposals/demo-mode-admin-ui.md「4. 安全策」参照）。
//
// 使い方: node scripts/demo/local-verify-demo-mode.js

'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');

const CATEGORY_ID = '90000000-0000-0000-0000-000000000002';
const ORG_A_ID = '90000000-0000-0000-0000-0000000000a2';
const ORG_B_ID = '90000000-0000-0000-0000-0000000000b2';
const MIGRATIONS_DIR = path.join(__dirname, '../../migrations');
const TEST_PORT = Number(process.env.DEMO_MODE_VERIFY_PORT) || 34519;
const TEST_DURATION_MS = 4000; // 本番は60秒固定。テストのみ環境変数で短縮する。

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

// --- pg-mem セットアップ（scripts/demo/local-verify.jsと同じ方式） -----------------
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
  console.log(`[verify] migrations applied (${files.length} files)`);
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
    implementation: () => 'cheerstick_pgmem_demo_mode_local_verify',
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
    `INSERT INTO categories (id, name, slug) VALUES ($1, 'デモ用', 'demo-mode-local-verify')`,
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

async function main() {
  process.env.NODE_ENV = 'development';
  process.env.ALLOWED_ORIGINS = '*';
  process.env.ENABLE_REFERENCE_TOKEN = 'false';
  process.env.DATABASE_URL = 'postgres://local-verify-unused/placeholder';
  // adminDemoController・demoModeStateはモジュール読み込み時にこれらの環境変数を
  // 読むため、src/app等をrequireするより前に必ず設定する。
  process.env.PORT = String(TEST_PORT);
  process.env.DEMO_MODE_TEST_DURATION_MS_OVERRIDE = String(TEST_DURATION_MS);

  console.log('[verify] setting up pg-mem and applying migrations...');
  const { pgAdapter } = setupPgMem();
  const { Pool } = pgAdapter;
  const verifyPool = new Pool();
  await seedFixtures(verifyPool);

  console.log(`[verify] starting CheerStick server (src/app.js + src/websocket) on 127.0.0.1:${TEST_PORT} ...`);
  const app = require('../../src/app');
  const wsServer = require('../../src/websocket');
  const demoModeState = require('../../src/services/demoModeState');
  const adminDemoController = require('../../src/controllers/adminDemoController');

  const server = http.createServer(app);
  wsServer.attach(server, '/cheer');
  await new Promise((resolve, reject) => {
    server.listen(TEST_PORT, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  console.log(`[verify] server listening on 127.0.0.1:${TEST_PORT}`);

  const adminBase = `http://127.0.0.1:${TEST_PORT}/api/v1/admin`;

  async function callDemo(pathSuffix, method, jsonBody) {
    const init = { method };
    if (jsonBody !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(jsonBody);
    }
    const res = await fetch(`${adminBase}${pathSuffix}`, init);
    let body = null;
    try { body = await res.json(); } catch (err) { /* ボディ無しの場合もある */ }
    return { status: res.status, body };
  }

  function isProcessAlive(pid) {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return false;
    }
  }

  // === 1. 初期状態はidle ======================================================
  console.log('\n[verify] === step 1: initial status ===');
  const initialStatus = await callDemo('/demo/status', 'GET');
  check('初期状態はidle', initialStatus.body.status === 'idle', JSON.stringify(initialStatus.body));

  // === 2. idleでstartすると拒否される ==========================================
  console.log('\n[verify] === step 2: start rejected when idle ===');
  const startWhenIdle = await callDemo('/demo/start', 'POST');
  check('idle状態でstartは409 DEMO_NOT_SET', startWhenIdle.status === 409 && startWhenIdle.body.error === 'DEMO_NOT_SET',
    JSON.stringify(startWhenIdle));

  // === 3. setupの二重呼び出し（ダブルクリック相当）が防がれる ==================
  console.log('\n[verify] === step 3: concurrent double setup ===');
  const [setupA, setupB] = await Promise.all([
    callDemo('/demo/setup', 'POST'),
    callDemo('/demo/setup', 'POST'),
  ]);
  const results = [setupA, setupB];
  const successCount = results.filter((r) => r.status === 201).length;
  const busyCount = results.filter((r) => r.status === 409 && r.body.error === 'DEMO_BUSY').length;
  check('同時setupは一方だけ成功する（201が1件）', successCount === 1, `results=${JSON.stringify(results)}`);
  check('同時setupのもう一方は409 DEMO_BUSYになる', busyCount === 1, `results=${JSON.stringify(results)}`);

  const battleCountAfterDoubleSetup = await verifyPool.query('SELECT COUNT(*)::int AS n FROM event_battles');
  check('二重呼び出しでもevent_battlesは1件のみ作成される', battleCountAfterDoubleSetup.rows[0].n === 1,
    `count=${battleCountAfterDoubleSetup.rows[0].n}`);

  const firstBattleId = (setupA.status === 201 ? setupA.body : setupB.body).battleId;

  // === 4. setup後の状態確認 =====================================================
  console.log('\n[verify] === step 4: status after setup ===');
  const statusAfterSetup = await callDemo('/demo/status', 'GET');
  check('setup後はstatus=set', statusAfterSetup.body.status === 'set', JSON.stringify(statusAfterSetup.body));
  check('setup後、battleIdが一致する', statusAfterSetup.body.battleId === firstBattleId);
  check('setup後、screenUrlが battle_id・gauge=recent・poll=1000 を含む',
    statusAfterSetup.body.screenUrl &&
    statusAfterSetup.body.screenUrl.includes(`battle_id=${firstBattleId}`) &&
    statusAfterSetup.body.screenUrl.includes('gauge=recent') &&
    statusAfterSetup.body.screenUrl.includes('poll=1000'),
    statusAfterSetup.body.screenUrl);

  // === 5. start → running、残り秒数、PIDの生存確認 ==============================
  console.log('\n[verify] === step 5: start ===');
  const startResult = await callDemo('/demo/start', 'POST');
  check('startは200でstatus=running', startResult.status === 200 && startResult.body.status === 'running',
    JSON.stringify(startResult.body));
  check('start直後のremainingMsがdurationMs付近', Math.abs(startResult.body.remainingMs - TEST_DURATION_MS) < 500,
    `remainingMs=${startResult.body.remainingMs}`);

  const childPidAfterStart = demoModeState.state.childProcess && demoModeState.state.childProcess.pid;
  check('子プロセスが実際に起動している（PIDが取得できる）', isProcessAlive(childPidAfterStart), `pid=${childPidAfterStart}`);

  // === 6. running中にstart/setupを呼ぶと拒否される ==============================
  console.log('\n[verify] === step 6: rejected while running ===');
  const startWhileRunning = await callDemo('/demo/start', 'POST');
  check('running中のstartは409 DEMO_RUNNING', startWhileRunning.status === 409 && startWhileRunning.body.error === 'DEMO_RUNNING');
  const setupWhileRunning = await callDemo('/demo/setup', 'POST');
  check('running中のsetupは409 DEMO_RUNNING', setupWhileRunning.status === 409 && setupWhileRunning.body.error === 'DEMO_RUNNING');

  // === 7. stopで即座に停止し、実プロセスが終了すること ==========================
  console.log('\n[verify] === step 7: stop ===');
  const stopResult = await callDemo('/demo/stop', 'POST');
  check('stopは200でstatus=set', stopResult.status === 200 && stopResult.body.status === 'set', JSON.stringify(stopResult.body));
  check('stop応答時点で、子プロセスが実際に終了している（PID生存確認）', !isProcessAlive(childPidAfterStart), `pid=${childPidAfterStart}`);

  const stopWhenNotRunning = await callDemo('/demo/stop', 'POST');
  check('runningでないときのstopは409 DEMO_NOT_RUNNING',
    stopWhenNotRunning.status === 409 && stopWhenNotRunning.body.error === 'DEMO_NOT_RUNNING');

  // === 8. setupを再実行すると、前回のバトルが自動終了し、新しいバトルができる ====
  console.log('\n[verify] === step 8: re-setup finishes the previous battle ===');
  const resetupResult = await callDemo('/demo/setup', 'POST');
  check('再setupは201', resetupResult.status === 201, JSON.stringify(resetupResult.body));
  const secondBattleId = resetupResult.body.battleId;
  check('再setupで新しいbattleIdが発行される', secondBattleId && secondBattleId !== firstBattleId,
    `first=${firstBattleId} second=${secondBattleId}`);

  const firstBattleRow = await verifyPool.query(
    `SELECT event_a_status, event_b_status FROM
       (SELECT eb.id, ea.status AS event_a_status, eb2.status AS event_b_status
        FROM event_battles eb
        JOIN events ea ON ea.id = eb.event_a_id
        JOIN events eb2 ON eb2.id = eb.event_b_id
        WHERE eb.id = $1) t`,
    [firstBattleId]
  );
  const firstFinished = firstBattleRow.rows.length > 0 &&
    firstBattleRow.rows[0].event_a_status === 'finished' &&
    firstBattleRow.rows[0].event_b_status === 'finished';
  check('前回のバトルの両試合がfinishedになっている（自動終了）', firstFinished, JSON.stringify(firstBattleRow.rows));

  // === 8b. 火花演出（既定ON。sparkEffect:false のときだけ screenUrlに&fx=none、2026-10-06変更） ===
  console.log('\n[verify] === step 8b: sparkEffect ===');
  check('sparkEffect省略のsetupでは、screenUrlに fx=none が含まれない（既定ON）',
    !resetupResult.body.screenUrl.includes('fx=none') && resetupResult.body.sparkEffect === true,
    JSON.stringify(resetupResult.body));
  const sparkOn = await callDemo('/demo/setup', 'POST', { sparkEffect: true });
  check('sparkEffect:true のsetupでは、screenUrlに fx=none が含まれない（gauge=recentは維持）',
    sparkOn.status === 201 && !sparkOn.body.screenUrl.includes('fx=none') &&
    sparkOn.body.screenUrl.includes('gauge=recent') && sparkOn.body.sparkEffect === true,
    JSON.stringify(sparkOn.body));
  const sparkOnStatus = await callDemo('/demo/status', 'GET');
  check('/demo/status のscreenUrlにも fx=none が含まれない',
    !sparkOnStatus.body.screenUrl.includes('fx=none'), sparkOnStatus.body.screenUrl);
  const sparkOff = await callDemo('/demo/setup', 'POST', { sparkEffect: false });
  check('sparkEffect:false で再setupすると、新しいscreenUrlに &fx=none が含まれる（gauge=recentも維持）',
    sparkOff.status === 201 && sparkOff.body.screenUrl.includes('&fx=none') &&
    sparkOff.body.screenUrl.includes('gauge=recent') && sparkOff.body.sparkEffect === false,
    JSON.stringify(sparkOff.body));
  const sparkTruthy = await callDemo('/demo/setup', 'POST', { sparkEffect: 'true' });
  check('真偽値false以外（文字列"true"）は既定のtrue扱い（fx=noneなし）',
    sparkTruthy.status === 201 && !sparkTruthy.body.screenUrl.includes('fx=none'), JSON.stringify(sparkTruthy.body));
  const sparkFalsy = await callDemo('/demo/setup', 'POST', { sparkEffect: 'false' });
  check('真偽値false以外（文字列"false"）も既定のtrue扱い（fx=noneなし）',
    sparkFalsy.status === 201 && !sparkFalsy.body.screenUrl.includes('fx=none'), JSON.stringify(sparkFalsy.body));

  // === 9. 60秒（テストではTEST_DURATION_MS）経過後、自動的にsetへ戻る ============
  console.log('\n[verify] === step 9: auto-return to "set" after duration elapses ===');
  const secondStart = await callDemo('/demo/start', 'POST');
  check('2回目のstartも200でrunning', secondStart.status === 200 && secondStart.body.status === 'running');
  const secondChildPid = demoModeState.state.childProcess && demoModeState.state.childProcess.pid;

  console.log(`[verify] waiting ${TEST_DURATION_MS + 5000}ms for the demo to finish on its own...`);
  await sleep(TEST_DURATION_MS + 5000);
  const statusAfterDuration = await callDemo('/demo/status', 'GET');
  check(`${TEST_DURATION_MS}ms経過後、自動的にstatus=setへ戻る`,
    statusAfterDuration.body.status === 'set', JSON.stringify(statusAfterDuration.body));
  check('時間経過による終了でも、子プロセスは実際に終了している', !isProcessAlive(secondChildPid), `pid=${secondChildPid}`);

  // === 9b. デモの応援データはregister済みのユーザーに紐づく（2026-10-07追加） ==========
  // battle-demo.jsがselect_teamの前にregisterを送るため、cheer_logs.user_idが埋まる。
  // 埋まっていないと順位確定のユーザー別集計（INNER JOIN users）から全件除外され、
  // ranking-battle.htmlが空になる。
  console.log('\n[verify] === step 9b: demo cheer_logs carry user_id (registered demo users) ===');
  const logStats = await verifyPool.query(`SELECT count(*)::int AS total, count(user_id)::int AS with_user FROM cheer_logs`);
  check('デモのcheer_logsが記録されている', logStats.rows[0].total > 0, JSON.stringify(logStats.rows[0]));
  check('全てのcheer_logs行にuser_idが入っている（NULL 0件）', logStats.rows[0].total === logStats.rows[0].with_user, JSON.stringify(logStats.rows[0]));
  const demoUsers = await verifyPool.query(
    `SELECT count(*)::int AS n, count(DISTINCT email)::int AS distinct_email FROM users WHERE email LIKE 'demo-%@example.invalid'`
  );
  check('デモ用ユーザー（demo-<MAC>@example.invalid）が作成され、メールは一意',
    demoUsers.rows[0].n > 0 && demoUsers.rows[0].n === demoUsers.rows[0].distinct_email, JSON.stringify(demoUsers.rows[0]));
  const ownersAfter9 = await verifyPool.query(`SELECT d.mac_address, d.owner_user_id FROM devices d WHERE d.owner_user_id IS NOT NULL`);
  check('デモ用デバイスにowner_user_idが設定されている（ユーザー数と一致）',
    ownersAfter9.rows.length > 0 && ownersAfter9.rows.length === demoUsers.rows[0].n,
    `owners=${ownersAfter9.rows.length} users=${demoUsers.rows[0].n}`);
  const ownerMapAfter9 = new Map(ownersAfter9.rows.map((r) => [r.mac_address, r.owner_user_id]));

  // === 10. pm2相当の終了シグナル（SIGTERM）で、子プロセスが道連れで終了する =====
  console.log('\n[verify] === step 10: simulated pm2 shutdown kills the running child ===');
  await callDemo('/demo/setup', 'POST'); // 前回分のfinish-run込みで新しいバトルを用意
  const thirdStart = await callDemo('/demo/start', 'POST');
  check('3回目のstartも200でrunning', thirdStart.status === 200 && thirdStart.body.status === 'running');
  const thirdChildPid = demoModeState.state.childProcess && demoModeState.state.childProcess.pid;
  check('3回目の子プロセスが起動している', isProcessAlive(thirdChildPid), `pid=${thirdChildPid}`);

  // src/index.jsのSIGTERM/SIGINTハンドラが実際に呼ぶのと同じ関数を直接呼ぶ
  // （このテストプロセス自体にSIGTERMを送ると、テストハーネスごと終了してしまうため、
  // 「pm2がSIGTERMを送った結果、この関数が呼ばれる」という結線部分はコードレビューで
  // 確認し、ここでは呼ばれた後の結果（子プロセスが実際に終了すること）を確認する）。
  adminDemoController.killRunningChildForShutdown();
  await sleep(1500);
  check('サーバー終了処理相当の呼び出しで、子プロセスが実際に終了する', !isProcessAlive(thirdChildPid), `pid=${thirdChildPid}`);

  // 再実行（別バトルでの3回目）でも、同じMACは同じユーザーを使い回す（ON CONFLICT (email)）
  const ownersAfter10 = await verifyPool.query(`SELECT d.mac_address, d.owner_user_id FROM devices d WHERE d.owner_user_id IS NOT NULL`);
  const ownerMapAfter10 = new Map(ownersAfter10.rows.map((r) => [r.mac_address, r.owner_user_id]));
  const changedOwners = [...ownerMapAfter9].filter(([mac, uid]) => ownerMapAfter10.get(mac) !== uid);
  check('再実行しても、登録済みデバイスの所有ユーザーは変わらない（同じユーザーを使い回す）',
    changedOwners.length === 0, `changed=${changedOwners.length}`);
  const demoUsersAfter10 = await verifyPool.query(
    `SELECT count(*)::int AS n, count(DISTINCT email)::int AS distinct_email FROM users WHERE email LIKE 'demo-%@example.invalid'`
  );
  check('再実行でもデモ用ユーザーのメールは一意のまま（重複行が増えない）',
    demoUsersAfter10.rows[0].n === demoUsersAfter10.rows[0].distinct_email, JSON.stringify(demoUsersAfter10.rows[0]));

  // === 11. チーム名に依存しない取得（作成日時が最も古い2件）の確認 =============
  // 2026-09-29変更：将来チーム名が変わってもコード変更なしで動くことを確認する。
  // (a) 既存の2チーム（EMUTTO・J SPORTS）の名前を、旧デフォルト名と無関係な名前へ変更する
  // (b) デモ用カテゴリーに3チーム目を「後から」追加する。名前はアルファベット順で先頭に
  //     来る（"AAAA"）が、作成日時は最も新しい＝もし実装が「名前順」や「一覧の先頭2件」で
  //     選んでいた場合、この3チーム目が誤って選ばれてしまうはずの罠として設置する
  // (c) setupを実行し、実際に選ばれた2チームが、リネーム後の元の2チーム
  //     （名前非依存で正しく特定できていること）であり、"AAAA"ではないことをDBで確認する
  console.log('\n[verify] === step 11: team resolution is name-independent (oldest 2 by created_at) ===');
  const RENAMED_ORG_A_NAME = 'チームアルファ';
  const RENAMED_ORG_B_NAME = 'チームベータ';
  const THIRD_ORG_ID = '90000000-0000-0000-0000-0000000000c2';

  await verifyPool.query(`UPDATE organizations SET name = $1 WHERE id = $2`, [RENAMED_ORG_A_NAME, ORG_A_ID]);
  await verifyPool.query(`UPDATE organizations SET name = $1 WHERE id = $2`, [RENAMED_ORG_B_NAME, ORG_B_ID]);
  await verifyPool.query(
    `INSERT INTO organizations (id, name, type, category_id) VALUES ($1, 'AAAA', 'football_club', $2)`,
    [THIRD_ORG_ID, CATEGORY_ID]
  );

  const statusBeforeStep11 = await callDemo('/demo/status', 'GET');
  check('step11開始時点でrunningではない（前提条件）', statusBeforeStep11.body.status !== 'running',
    JSON.stringify(statusBeforeStep11.body));

  const step11Setup = await callDemo('/demo/setup', 'POST');
  check('リネーム後・3チーム目追加後もsetupは201', step11Setup.status === 201, JSON.stringify(step11Setup.body));

  const step11BattleId = step11Setup.body.battleId;
  const step11OrgNames = await verifyPool.query(
    `SELECT oa.name AS org_a_name, ob.name AS org_b_name
     FROM event_battles eb
     JOIN events ea ON ea.id = eb.event_a_id
     JOIN organizations oa ON oa.id = ea.organization_id
     JOIN events ebv ON ebv.id = eb.event_b_id
     JOIN organizations ob ON ob.id = ebv.organization_id
     WHERE eb.id = $1`,
    [step11BattleId]
  );
  const resolvedNames = step11OrgNames.rows.length > 0
    ? [step11OrgNames.rows[0].org_a_name, step11OrgNames.rows[0].org_b_name]
    : [];
  const gotRenamedPair = resolvedNames.includes(RENAMED_ORG_A_NAME) && resolvedNames.includes(RENAMED_ORG_B_NAME);
  const gotThirdOrg = resolvedNames.includes('AAAA');
  check('リネーム後の元2チーム（作成日時が古い方）が選ばれている', gotRenamedPair, JSON.stringify(resolvedNames));
  check('後から追加した3チーム目（"AAAA"）は選ばれていない', !gotThirdOrg, JSON.stringify(resolvedNames));

  // 後片付け：3チーム目を削除し、DB状態を元に戻す
  await callDemo('/demo/setup', 'POST'); // 直前のバトルをfinish-run相当で片付ける
  await verifyPool.query(`DELETE FROM organizations WHERE id = $1`, [THIRD_ORG_ID]);

  console.log(`\n[verify] ================ RESULT: PASS=${PASS} FAIL=${FAIL} ================`);
  await verifyPool.end();
  server.close();
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[verify] fatal error:', err);
  process.exit(1);
});
