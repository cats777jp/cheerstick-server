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

  // pg-memはjsonbの`||`（マージ）・`-`（キー削除）演算子に未対応のため、updateEvent()が生成する
  // `metadata = (metadata || $N::jsonb) - 'key'...`だけ、現在値を読んで同じ結果をJS側で計算し、
  // 確定済みのjsonbを渡す形に置き換える（scripts/ranking-battle/local-verify.jsと同じ方式。2026-10-30追加）。
  // デモのsetupが新しい試合A・Bにテーマ画像（PATCH /admin/events/:id の theme_image_url）を設定する経路の
  // 確認に必要。※この置き換えのため、`||`演算子そのもののSQLはこのハーネスでは実行されない
  // （実PostgreSQL上での確認はstaging等で別途必要）。
  const META_RE = /metadata = (?:\(metadata \|\| \$(\d+)::jsonb\)|metadata)((?: - '[A-Za-z]+')*)/;
  function shimMetadata(origQuery) {
    return async function (text, params, ...rest) {
      if (typeof text === 'string' && /^\s*UPDATE events SET/.test(text) && META_RE.test(text)) {
        const m = text.match(META_RE);
        const whereId = params[params.length - 1];
        const cur = await origQuery.call(this, 'SELECT metadata FROM events WHERE id = $1', [whereId]);
        if (cur.rows.length === 0) return origQuery.call(this, text, params, ...rest);
        const curMeta = cur.rows[0].metadata;
        const merged = { ...(typeof curMeta === 'string' ? JSON.parse(curMeta) : curMeta) };
        const newParams = params.slice();
        if (m[1]) Object.assign(merged, JSON.parse(params[Number(m[1]) - 1]));
        for (const k of (m[2].match(/'([A-Za-z]+)'/g) || []).map((s) => s.slice(1, -1))) delete merged[k];
        let replacement;
        if (m[1]) {
          newParams[Number(m[1]) - 1] = JSON.stringify(merged);
          replacement = `metadata = $${m[1]}::jsonb`;
        } else {
          newParams.push(JSON.stringify(merged));
          replacement = `metadata = $${newParams.length}::jsonb`;
        }
        return origQuery.call(this, text.replace(META_RE, () => replacement), newParams, ...rest);
      }
      return origQuery.call(this, text, params, ...rest);
    };
  }
  pgAdapter.Pool.prototype.query = shimMetadata(pgAdapter.Pool.prototype.query);
  pgAdapter.Client.prototype.query = shimMetadata(pgAdapter.Client.prototype.query);

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
  check('setup直後は、実行済みの印（lastEndedAt）が無い（null）', statusAfterSetup.body.lastEndedAt === null, JSON.stringify(statusAfterSetup.body));
  check('恒久デモの試合・ペアが無くてもsetupは成立し、テーマ画像なし（themeImageMissing=true）になる（2026-10-30）',
    statusAfterSetup.body.themeImageMissing === true, JSON.stringify(statusAfterSetup.body));
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
  check('手動停止でも、実行済みの印（lastEndedAt、ISO形式）が立つ（2026-10-30）',
    typeof stopResult.body.lastEndedAt === 'string' && !Number.isNaN(Date.parse(stopResult.body.lastEndedAt)), JSON.stringify(stopResult.body));
  const stoppedStatus = await callDemo('/demo/status', 'GET');
  check('GET /demo/status にも lastEndedAt が出る（ページを開き直しても実行済みと分かる）', stoppedStatus.body.status === 'set' && !!stoppedStatus.body.lastEndedAt, JSON.stringify(stoppedStatus.body));

  const stopWhenNotRunning = await callDemo('/demo/stop', 'POST');
  check('runningでないときのstopは409 DEMO_NOT_RUNNING',
    stopWhenNotRunning.status === 409 && stopWhenNotRunning.body.error === 'DEMO_NOT_RUNNING');

  // === 8. setupを再実行すると、前回のバトルが自動終了し、新しいバトルができる ====
  console.log('\n[verify] === step 8: re-setup finishes the previous battle ===');
  const resetupResult = await callDemo('/demo/setup', 'POST');
  check('再setupは201', resetupResult.status === 201, JSON.stringify(resetupResult.body));
  const secondBattleId = resetupResult.body.battleId;
  check('再setup（setSet）で、実行済みの印（lastEndedAt）が消える', resetupResult.body.lastEndedAt === null, JSON.stringify(resetupResult.body));
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
  check('自然終了でも、実行済みの印（lastEndedAt、ISO形式）が立つ（2026-10-30）',
    typeof statusAfterDuration.body.lastEndedAt === 'string' && !Number.isNaN(Date.parse(statusAfterDuration.body.lastEndedAt)), JSON.stringify(statusAfterDuration.body));

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

  // === 10. テーマ画像：恒久デモの試合のevents.metadataから取得し、新しい試合A・B両方へ入れる（2026-10-30） ===
  // ペア（3d909ed3）は作らない（ペアが存在しなくても動くことの確認）。恒久デモの試合のIDは本番と同じ固定値。
  console.log('\n[verify] === step 10: theme image source = permanent demo events metadata ===');
  const PERM_A = '620f09c5-8ceb-45de-b35d-7bf47821950a';
  const PERM_B = '05efa49a-ca92-4190-94ff-eea24ec5033a';
  const PERM_BATTLE = '3d909ed3-3207-4222-a6f9-a6c39980b910';
  const URL_A = '/images/uploads/theme-permanent-a.png';
  const URL_B = '/images/uploads/theme-permanent-b.png';
  await verifyPool.query(
    `INSERT INTO events (id, organization_id, title, starts_at, status, metadata) VALUES ($1, $2, '恒久デモA', NOW(), 'finished', $3::jsonb)`,
    [PERM_A, ORG_A_ID, JSON.stringify({ themeImageUrl: URL_A })]);
  await verifyPool.query(
    `INSERT INTO events (id, organization_id, title, starts_at, status, metadata) VALUES ($1, $2, '恒久デモB', NOW(), 'finished', $3::jsonb)`,
    [PERM_B, ORG_B_ID, JSON.stringify({ themeImageUrl: URL_B })]);
  const permBattleCount = await verifyPool.query('SELECT COUNT(*)::int AS n FROM event_battles WHERE id = $1', [PERM_BATTLE]);
  check('前提：恒久デモのペア（3d909ed3）は存在しない', permBattleCount.rows[0].n === 0, JSON.stringify(permBattleCount.rows[0]));

  async function battleThemes(battleId) {
    const r = await verifyPool.query(
      `SELECT ea.metadata AS a_meta, ebv.metadata AS b_meta FROM event_battles eb
         JOIN events ea ON ea.id = eb.event_a_id JOIN events ebv ON ebv.id = eb.event_b_id WHERE eb.id = $1`, [battleId]);
    const parse = (m) => (typeof m === 'string' ? JSON.parse(m) : (m || {}));
    return { a: parse(r.rows[0].a_meta).themeImageUrl || null, b: parse(r.rows[0].b_meta).themeImageUrl || null };
  }

  const themeBoth = await callDemo('/demo/setup', 'POST');
  check('恒久デモの試合A・B両方に画像があり、ペアが無くてもsetupは201', themeBoth.status === 201, JSON.stringify(themeBoth.body));
  const themesBoth = await battleThemes(themeBoth.body.battleId);
  check('A優先：新しい試合A・B両方にAの画像が入る', themesBoth.a === URL_A && themesBoth.b === URL_A, JSON.stringify(themesBoth));
  check('画像を取得できたときは themeImageMissing=false', themeBoth.body.themeImageMissing === false, JSON.stringify(themeBoth.body));

  await verifyPool.query(`UPDATE events SET metadata = '{}'::jsonb WHERE id = $1`, [PERM_A]);
  const themeFallbackB = await callDemo('/demo/setup', 'POST');
  const themesFallbackB = await battleThemes(themeFallbackB.body.battleId);
  check('Aに画像が無ければBの画像を使い、新しい試合A・B両方に入る', themesFallbackB.a === URL_B && themesFallbackB.b === URL_B, JSON.stringify(themesFallbackB));
  check('Bの画像で取得できたときも themeImageMissing=false', themeFallbackB.body.themeImageMissing === false);

  await verifyPool.query(`UPDATE events SET metadata = '{}'::jsonb WHERE id = $1`, [PERM_B]);
  const themeNone = await callDemo('/demo/setup', 'POST');
  check('A・Bとも画像が無くてもsetupは201で成立する（無言で止まらず、デモ自体は使える）', themeNone.status === 201, JSON.stringify(themeNone.body));
  const themesNone = await battleThemes(themeNone.body.battleId);
  check('A・Bとも画像が無いと、新しい試合A・Bにも画像は入らず themeImageMissing=true になる',
    themesNone.a === null && themesNone.b === null && themeNone.body.themeImageMissing === true,
    JSON.stringify({ themes: themesNone, missing: themeNone.body.themeImageMissing }));
  const themeNoneStatus = await callDemo('/demo/status', 'GET');
  check('GET /demo/status にも themeImageMissing=true が出る', themeNoneStatus.body.themeImageMissing === true, JSON.stringify(themeNoneStatus.body));
  await verifyPool.query(`DELETE FROM organizations WHERE id = $1`, [THIRD_ORG_ID]);

  // === 12. ランキング見せ用（2026-10-07）：デモ用ダミー選手があると、推しエントリー付きで実行される ====
  // 条件：デモ用チームに、(a)image_urlが/images/demo/players/配下、(b)profile_textが【デモ用ダミー】で
  // 始まる選手がいること。別のMAC帯（AA:00:00:03）のデバイス、選手の推しエントリー、ユーザーごとの熱量差、
  // ひらがな・カタカナの愛称。ここまでの手順（ダミー選手なし）は従来どおりAA:00:00:02帯で動く。
  console.log('\n[verify] === step 12: ranking showcase (dummy players -> oshi entries, separate MAC band) ===');
  const showcaseDef = require('./showcase-players');
  const statusBeforeShowcase = await callDemo('/demo/status', 'GET');
  check('ダミー選手が無い間は、statusのshowcaseはnull（従来どおり）', statusBeforeShowcase.body.showcase === null,
    JSON.stringify(statusBeforeShowcase.body));
  const oldBandBefore = await verifyPool.query(`SELECT count(*)::int AS n FROM devices WHERE mac_address LIKE 'AA:00:00:02:%'`);
  const newBandBefore = await verifyPool.query(`SELECT count(*)::int AS n FROM devices WHERE mac_address LIKE 'AA:00:00:03:%'`);
  check('ダミー選手が無い間は、従来のAA:00:00:02帯のデバイスだけが使われ、AA:00:00:03帯は無い',
    oldBandBefore.rows[0].n > 0 && newBandBefore.rows[0].n === 0, `old=${oldBandBefore.rows[0].n} new=${newBandBefore.rows[0].n}`);

  const orgIdOf = { A: ORG_A_ID, B: ORG_B_ID };
  const dummyIds = { A: [], B: [] };
  for (const p of showcaseDef.PLAYERS) {
    const r = await verifyPool.query(
      `INSERT INTO targets (organization_id, name, type, image_url, number, profile_text, is_active)
       VALUES ($1, $2, 'player', $3, $4, $5, true) RETURNING id`,
      [orgIdOf[p.team], p.name, `https://app.example.invalid${showcaseDef.IMAGE_PATH}${p.file}`, String(p.number), showcaseDef.PROFILE_TEXT]
    );
    dummyIds[p.team].push(r.rows[0].id);
  }
  // 条件を満たさない選手（別の選手：目印なし・無効）は、ダミー選手として扱われないこと
  const normalTarget = await verifyPool.query(
    `INSERT INTO targets (organization_id, name, type, image_url, number, profile_text, is_active)
     VALUES ($1, '通常の選手', 'player', 'https://example.invalid/images/real.png', '99', '通常のプロフィール', true) RETURNING id`, [ORG_A_ID]);
  const inactiveDummy = await verifyPool.query(
    `INSERT INTO targets (organization_id, name, type, image_url, number, profile_text, is_active)
     VALUES ($1, '無効なダミー', 'player', $2, '98', $3, false) RETURNING id`,
    [ORG_A_ID, `https://app.example.invalid${showcaseDef.IMAGE_PATH}a-99.svg`, showcaseDef.PROFILE_TEXT]);

  const showcaseSetup = await callDemo('/demo/setup', 'POST');
  check('ダミー選手があるとsetupは201で、statusのshowcaseに選手数（A:10・B:10）が出る（無効・目印なしの選手は数えない）',
    showcaseSetup.status === 201 && showcaseSetup.body.showcase &&
    showcaseSetup.body.showcase.targetsA === 10 && showcaseSetup.body.showcase.targetsB === 10,
    JSON.stringify(showcaseSetup.body));
  const newBandAfterSetup = await verifyPool.query(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE is_demo)::int AS demo FROM devices WHERE mac_address LIKE 'AA:00:00:03:%'`);
  check('setupで、AA:00:00:03帯のデバイスが200台（100×2）、すべてis_demoで作成される',
    newBandAfterSetup.rows[0].n === 200 && newBandAfterSetup.rows[0].demo === 200, JSON.stringify(newBandAfterSetup.rows[0]));

  const showcaseStart = await callDemo('/demo/start', 'POST');
  check('ダミー選手ありのstartは200でrunning', showcaseStart.status === 200 && showcaseStart.body.status === 'running');
  const showcaseChild = demoModeState.state.childProcess;
  const showcaseArgs = (showcaseChild && showcaseChild.spawnargs) || [];
  check('子プロセスの引数に、MAC帯・選手リスト・熱量差・愛称が渡っている',
    showcaseArgs.includes('--mac-prefix=AA:00:00:03') && showcaseArgs.includes('--energy-spread') &&
    showcaseArgs.includes('--nickname-style=fun') && showcaseArgs.some((a) => a.startsWith('--oshi-targets-a=') && a.split(',').length === 10) &&
    showcaseArgs.some((a) => a.startsWith('--oshi-targets-b=') && a.split(',').length === 10),
    showcaseArgs.filter((a) => a.startsWith('--')).join(' ').slice(0, 300));
  console.log(`[verify] waiting ${TEST_DURATION_MS + 5000}ms for the showcase demo to finish...`);
  await sleep(TEST_DURATION_MS + 5000);

  const scLogs = await verifyPool.query(
    `SELECT count(*)::int AS total, count(cl.target_id)::int AS with_target, count(DISTINCT cl.target_id)::int AS distinct_targets,
            count(cl.user_id)::int AS with_user, min(cl.intensity)::int AS min_i, max(cl.intensity)::int AS max_i,
            count(DISTINCT cl.intensity)::int AS distinct_i
     FROM cheer_logs cl JOIN devices d ON d.id = cl.device_id WHERE d.mac_address LIKE 'AA:00:00:03:%'`);
  const sc = scLogs.rows[0];
  check('ランキング見せ用の応援ログが記録されている', sc.total > 0, JSON.stringify(sc));
  check('全ての応援ログに target_id（推し）と user_id がある', sc.with_target === sc.total && sc.with_user === sc.total, JSON.stringify(sc));
  check('推しが複数の選手に分散している（1人に偏らない）', sc.distinct_targets >= 5 && sc.distinct_targets <= 20, `distinct_targets=${sc.distinct_targets}`);
  check('intensityは1〜100の範囲で、熱量差により値がばらつく', sc.min_i >= 1 && sc.max_i <= 100 && sc.distinct_i >= 10, `min=${sc.min_i} max=${sc.max_i} distinct=${sc.distinct_i}`);
  const scTeamMatch = await verifyPool.query(
    `SELECT count(*)::int AS mismatched FROM cheer_logs cl
       JOIN targets t ON t.id = cl.target_id JOIN events e ON e.id = cl.event_id
       JOIN devices d ON d.id = cl.device_id
      WHERE d.mac_address LIKE 'AA:00:00:03:%' AND t.organization_id <> e.organization_id`);
  check('応援ログの選手は、そのログの試合のチームの選手（チーム違いが0件）', scTeamMatch.rows[0].mismatched === 0, JSON.stringify(scTeamMatch.rows[0]));
  const scNoise = await verifyPool.query(
    `SELECT count(*)::int AS n FROM cheer_logs WHERE target_id = ANY($1::uuid[])`, [[normalTarget.rows[0].id, inactiveDummy.rows[0].id]]);
  check('目印なしの選手・無効なダミー選手は、推しに使われない', scNoise.rows[0].n === 0, JSON.stringify(scNoise.rows[0]));
  // 愛称の判定はJS側で行う（pg-memのLIKEは日本語の接頭辞指定を正しく扱えないため）。
  const scUserRows = (await verifyPool.query(
    `SELECT u.email, u.display_name FROM users u WHERE u.email LIKE 'demo-aa000003%@example.invalid' ORDER BY u.email`)).rows;
  const scPlainNames = scUserRows.filter((r) => String(r.display_name).startsWith('デモ応援団')).length;
  const scDistinctEmails = new Set(scUserRows.map((r) => r.email)).size;
  console.log('[verify] sample users:', JSON.stringify(scUserRows.slice(0, 3)));
  check('AA:00:00:03帯のデモ用ユーザーが200名（メール一意）で、愛称は「デモ応援団」形式ではない',
    scUserRows.length === 200 && scDistinctEmails === 200 && scPlainNames === 0,
    `users=${scUserRows.length} distinct_email=${scDistinctEmails} plain_names=${scPlainNames}`);
  // 愛称は100種で、1チーム100台までは重複せず、数字も付かない（A・Bの境目はMAC帯：チームBは80xx）。
  const scNamesA = scUserRows.filter((r) => /^demo-aa0000030[0-9a-f]{3}@/.test(r.email)).map((r) => r.display_name);
  const scNamesB = scUserRows.filter((r) => /^demo-aa0000038[0-9a-f]{3}@/.test(r.email)).map((r) => r.display_name);
  check('愛称はチームごとに重複せず（A・Bとも100種）、数字が付かない',
    scNamesA.length === 100 && scNamesB.length === 100 && new Set(scNamesA).size === 100 && new Set(scNamesB).size === 100 &&
    [...scNamesA, ...scNamesB].every((n) => !/[0-9]/.test(n)),
    `A=${new Set(scNamesA).size}/${scNamesA.length} B=${new Set(scNamesB).size}/${scNamesB.length}`);
  const oldBandOshi = await verifyPool.query(`SELECT count(*)::int AS n FROM devices WHERE mac_address LIKE 'AA:00:00:02:%' AND current_target_id IS NOT NULL`);
  check('従来のAA:00:00:02帯のデバイスには、推し（current_target_id）が設定されない（帯が混ざらない）', oldBandOshi.rows[0].n === 0, JSON.stringify(oldBandOshi.rows[0]));
  await callDemo('/demo/setup', 'POST'); // 直前のバトルをfinish-run相当で片付ける

  console.log(`\n[verify] ================ RESULT: PASS=${PASS} FAIL=${FAIL} ================`);
  await verifyPool.end();
  server.close();
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[verify] fatal error:', err);
  process.exit(1);
});
