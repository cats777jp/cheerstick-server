#!/usr/bin/env node
// scripts/rate-limit/local-verify.js
// 大規模イベント対応レート制限再設計（トラックA、2026-09-28）のローカル動作確認。
// scripts/demo/local-verify.js と同じ方式（pg-memで実サーバーを起動）。
//
// ★本番・staging環境には一切接続しない。pg-memはプロセス内で完結するインメモリ実装。
//
// 確認項目（cheerstick-track-a-rate-limit-20260928.md 3-1章）：
//   1. 同じIP・異なるデバイスIDで(a)を多数呼ぶ → IPの上限まではすべて200
//   2. 同じデバイスIDで上限+1回目 → 429。別のIDは200のまま
//   3. IDが無い・不正な形式 → デバイスの上限が効かず、IPの上限のみ適用される
//   4. IPの上限を超えたとき → 429（IDが正常でも）
//   5. スコアAPI：同一キーのリクエストでDB集計がキャッシュ有効期間ごとに1回になる。
//      SCORE_CACHE_TTL_MS=0で毎回集計される。エラーはキャッシュされない
//   6. 管理APIが一般の上限（500）を超えても429にならない（別の上限まで）
//   7. 環境変数を設定しない場合の既定値・不正な値が既定値に戻ること
//   8. 429のレスポンスの形が現行と同じであること
//   9. 429のログが10秒に1回にまとまること
//
// 使い方: node scripts/rate-limit/local-verify.js

'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawnSync } = require('child_process');

const MIGRATIONS_DIR = path.join(__dirname, '../../migrations');

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
    implementation: () => 'cheerstick_pgmem_rate_limit_local_verify',
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

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  let body = null;
  try {
    body = await res.json();
  } catch (err) {
    // JSONでない場合（429の既定応答はプレーンテキスト）
    body = null;
  }
  return { status: res.status, headers: res.headers, body };
}

function mac(n) {
  // n（0〜0xFFFFFFFFFFFF）から一意なMACアドレス文字列を作る。テスト専用の帯（AA:BB:...)。
  const hex = n.toString(16).toUpperCase().padStart(12, '0');
  return `AA:BB:${hex.slice(4, 6)}:${hex.slice(6, 8)}:${hex.slice(8, 10)}:${hex.slice(10, 12)}`;
}

async function main() {
  process.env.NODE_ENV = 'development';
  process.env.ALLOWED_ORIGINS = '*';
  process.env.ENABLE_REFERENCE_TOKEN = 'false';
  process.env.DATABASE_URL = 'postgres://rate-limit-local-verify-unused/placeholder';
  // このプロセス全体のデフォルトは小さめにしておき、各testで上書きする
  // （requireは最初の1回しか評価されないため、以降はミドルウェアのconfigを直接叩けない
  //   テスト〔1〜6〕は、サーバー起動前にここで確定させた値を前提に進める）。
  process.env.RL_WINDOW_MS = '900000';
  process.env.RL_AUDIENCE_IP_MAX = '1000000'; // 個別テストで上書きする値を優先させるためここでは緩め
  process.env.RL_DEVICE_MAX = '1000000';
  process.env.RL_SCORE_IP_MAX = '1000000';
  process.env.RL_ADMIN_IP_MAX = '1000000';
  process.env.RL_DEFAULT_IP_MAX = '5'; // test 6用に低くしておく（管理APIが別枠であることの確認に使う）
  process.env.SCORE_CACHE_TTL_MS = '1000';

  console.log('[verify] setting up pg-mem and applying migrations...');
  const { pgAdapter } = setupPgMem();
  const { Pool } = pgAdapter;
  const verifyPool = new Pool();

  // --- テスト1〜4は、値を環境変数で個別に絞り込むため、rateLimitモジュールを
  //     一度だけrequireするこの構成では対応できない。そこで、audienceIpLimiter・
  //     audienceDeviceLimiterのみ、テストごとに新しいrateLimit()インスタンスを
  //     直接生成し、専用の小さなExpressアプリへ差し替えて確認する
  //     （本体src/app.jsの構成〔req.ip解決・ミドルウェアの重ね順〕を再現しつつ、
  //     上限値だけをテストごとに変えられるようにするため）。
  const rateLimitLib = require('express-rate-limit');
  const rateLimitModule = require('../../src/middleware/rateLimit');
  const express = require('express');

  function buildAudienceTestApp({ ipMax, deviceMax }) {
    const testApp = express();
    testApp.set('trust proxy', 1);
    const ipLimiter = rateLimitLib({
      windowMs: 900000,
      max: ipMax,
      standardHeaders: true,
      legacyHeaders: false,
      handler: (req, res, _next, options) => res.status(options.statusCode).send(options.message),
    });
    const deviceLimiter = rateLimitLib({
      windowMs: 900000,
      max: deviceMax,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) => rateLimitModule.extractAudienceDeviceKey(req) || 'no-device-key',
      skip: (req) => rateLimitModule.extractAudienceDeviceKey(req) === null,
      handler: (req, res, _next, options) => res.status(options.statusCode).send(options.message),
    });
    testApp.get('/geturl', ipLimiter, deviceLimiter, (req, res) => {
      res.status(200).send('<html></html>');
    });
    return testApp;
  }

  async function listenEphemeral(app) {
    const server = http.createServer(app);
    const port = await new Promise((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve(server.address().port));
      server.once('error', reject);
    });
    return { server, port };
  }

  const xff = (ip) => ({ headers: { 'X-Forwarded-For': ip } });

  // === 1. 同じIP・異なるデバイスIDで多数呼ぶ → IPの上限まではすべて200 ============
  console.log('\n[verify] === 1: same IP, distinct device IDs, up to IP max ===');
  {
    const { server, port } = await listenEphemeral(buildAudienceTestApp({ ipMax: 10, deviceMax: 1000 }));
    const base = `http://127.0.0.1:${port}`;
    const results = [];
    for (let i = 0; i < 10; i++) {
      const r = await fetchJson(`${base}/geturl?id=${encodeURIComponent(mac(1000 + i))}`, xff('203.0.113.1'));
      results.push(r.status);
    }
    check('IP上限(10)までは全て200（異なるデバイスID）', results.every((s) => s === 200), `statuses=${results.join(',')}`);
    await new Promise((resolve) => server.close(resolve));
  }

  // === 2. 同じデバイスIDで上限+1回目 → 429。別IDは200のまま ========================
  console.log('\n[verify] === 2: same device ID over its limit, different ID unaffected ===');
  {
    const { server, port } = await listenEphemeral(buildAudienceTestApp({ ipMax: 1000, deviceMax: 3 }));
    const base = `http://127.0.0.1:${port}`;
    const sameId = mac(2000);
    const results = [];
    for (let i = 0; i < 4; i++) {
      const r = await fetchJson(`${base}/geturl?id=${encodeURIComponent(sameId)}`, xff('203.0.113.2'));
      results.push(r.status);
    }
    check('同一デバイスID: 上限3回までは200、4回目は429',
      results[0] === 200 && results[1] === 200 && results[2] === 200 && results[3] === 429,
      `statuses=${results.join(',')}`);

    const otherId = mac(2001);
    const otherResult = await fetchJson(`${base}/geturl?id=${encodeURIComponent(otherId)}`, xff('203.0.113.2'));
    check('別のデバイスIDは200のまま（同一IP）', otherResult.status === 200, `status=${otherResult.status}`);
    await new Promise((resolve) => server.close(resolve));
  }

  // === 3. IDが無い・不正な形式 → デバイス上限が効かず、IP上限のみ適用 ===============
  console.log('\n[verify] === 3: missing/invalid device ID → device limiter skipped ===');
  {
    const { server, port } = await listenEphemeral(buildAudienceTestApp({ ipMax: 1000, deviceMax: 2 }));
    const base = `http://127.0.0.1:${port}`;
    const results = [];
    for (let i = 0; i < 5; i++) {
      // 不正な形式（16進12桁に正規化できない文字列）を、deviceMax(2)より多い5回送る
      const r = await fetchJson(`${base}/geturl?id=not-a-valid-mac-address`, xff('203.0.113.3'));
      results.push(r.status);
    }
    check('不正な形式のIDは、deviceMaxを超えても429にならない（IP上限が緩いため全て200）',
      results.every((s) => s === 200), `statuses=${results.join(',')}`);

    const noIdResults = [];
    for (let i = 0; i < 5; i++) {
      const r = await fetchJson(`${base}/geturl`, xff('203.0.113.4'));
      noIdResults.push(r.status);
    }
    check('idクエリ自体が無い場合も、deviceMaxを超えても429にならない',
      noIdResults.every((s) => s === 200), `statuses=${noIdResults.join(',')}`);
    await new Promise((resolve) => server.close(resolve));
  }

  // === 4. IPの上限を超えたとき → 429（IDが正常でも） ================================
  console.log('\n[verify] === 4: IP limit exceeded even with distinct valid device IDs ===');
  {
    const { server, port } = await listenEphemeral(buildAudienceTestApp({ ipMax: 3, deviceMax: 1000 }));
    const base = `http://127.0.0.1:${port}`;
    const results = [];
    for (let i = 0; i < 4; i++) {
      const r = await fetchJson(`${base}/geturl?id=${encodeURIComponent(mac(4000 + i))}`, xff('203.0.113.5'));
      results.push(r.status);
    }
    check('IP上限(3)を超えると、デバイスIDが毎回異なっていても4回目は429',
      results[0] === 200 && results[1] === 200 && results[2] === 200 && results[3] === 429,
      `statuses=${results.join(',')}`);
    await new Promise((resolve) => server.close(resolve));
  }

  // === 5. スコアAPIのキャッシュ ====================================================
  console.log('\n[verify] === 5: score API cache (DB query count) ===');
  {
    // フィクスチャ：カテゴリー・チーム2件・試合2件（live）・対抗戦ペア1件
    const categoryId = '90000000-0000-0000-0000-000000000001';
    const orgAId = '90000000-0000-0000-0000-0000000000a1';
    const orgBId = '90000000-0000-0000-0000-0000000000b1';
    const eventAId = '90000000-0000-0000-0000-0000000000e1';
    const eventBId = '90000000-0000-0000-0000-0000000000e2';
    const battleId = '90000000-0000-0000-0000-0000000000b9';
    await verifyPool.query(`INSERT INTO categories (id, name, slug) VALUES ($1, 'デモ用', 'rate-limit-verify')`, [categoryId]);
    await verifyPool.query(
      `INSERT INTO organizations (id, name, type, category_id) VALUES ($1, 'EMUTTO', 'football_club', $2)`,
      [orgAId, categoryId]
    );
    await verifyPool.query(
      `INSERT INTO organizations (id, name, type, category_id) VALUES ($1, 'J SPORTS', 'football_club', $2)`,
      [orgBId, categoryId]
    );
    await verifyPool.query(
      `INSERT INTO events (id, organization_id, title, starts_at, status) VALUES ($1, $2, 'A', NOW(), 'live')`,
      [eventAId, orgAId]
    );
    await verifyPool.query(
      `INSERT INTO events (id, organization_id, title, starts_at, status) VALUES ($1, $2, 'B', NOW(), 'live')`,
      [eventBId, orgBId]
    );
    await verifyPool.query(
      `INSERT INTO event_battles (id, event_a_id, event_b_id, label) VALUES ($1, $2, $3, 'A vs B')`,
      [battleId, eventAId, eventBId]
    );

    // src/db/index.js は要求ごとの新規require ではなくプロセス内シングルトンのため、
    // ここでquery関数をラップしてDBアクセス回数を数える。
    const db = require('../../src/db');
    let dbQueryCount = 0;
    const originalQuery = db.query;
    db.query = (...args) => {
      dbQueryCount += 1;
      return originalQuery(...args);
    };

    const app = require('../../src/app');
    const { server, port } = await listenEphemeral(app);
    const base = `http://127.0.0.1:${port}`;
    const scoreUrl = `${base}/api/v1/event-battles/${battleId}/score`;

    // --- キャッシュ有効（既定1000ms）：同一キーへ100回、DB集計は1回分のみ ---
    const before = dbQueryCount;
    const firstResults = await Promise.all(
      Array.from({ length: 100 }, () => fetchJson(scoreUrl))
    );
    const afterConcurrent = dbQueryCount;
    check('スコアAPI: 同時100リクエストが全て200', firstResults.every((r) => r.status === 200),
      `statuses=${[...new Set(firstResults.map((r) => r.status))].join(',')}`);
    check('スコアAPI: 同時100リクエストのDBクエリ回数が1回分の計算に収まる（in-flight共有）',
      (afterConcurrent - before) <= 3, `delta=${afterConcurrent - before}`);

    // TTL内（1000ms未満）に追い打ちしても、キャッシュから返るため増えない
    await fetchJson(scoreUrl);
    const afterCacheHit = dbQueryCount;
    check('スコアAPI: TTL内の追加リクエストはDBクエリを増やさない（キャッシュヒット）',
      afterCacheHit === afterConcurrent, `before=${afterConcurrent} after=${afterCacheHit}`);

    // TTL経過後は再度DBを叩く
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await fetchJson(scoreUrl);
    const afterTtlExpiry = dbQueryCount;
    check('スコアAPI: TTL経過後は再度DB集計が走る', afterTtlExpiry > afterCacheHit,
      `before=${afterCacheHit} after=${afterTtlExpiry}`);

    // --- 存在しないbattle_id（エラー応答）はキャッシュされない ---
    const missingUrl = `${base}/api/v1/event-battles/00000000-0000-0000-0000-000000000000/score`;
    const beforeMissing = dbQueryCount;
    const missing1 = await fetchJson(missingUrl);
    const afterMissing1 = dbQueryCount;
    const missing2 = await fetchJson(missingUrl);
    const afterMissing2 = dbQueryCount;
    check('存在しないbattle_idは404を返す', missing1.status === 404 && missing2.status === 404,
      `status1=${missing1.status} status2=${missing2.status}`);
    check('エラー応答（404）はキャッシュされない（2回とも個別にDBへ問い合わせる）',
      afterMissing1 > beforeMissing && afterMissing2 > afterMissing1,
      `before=${beforeMissing} after1=${afterMissing1} after2=${afterMissing2}`);

    db.query = originalQuery;
    await new Promise((resolve) => server.close(resolve));
  }

  // === 5(続き). SCORE_CACHE_TTL_MS=0 で毎回集計される ==============================
  console.log('\n[verify] === 5(続き): SCORE_CACHE_TTL_MS=0 disables caching ===');
  {
    const { createScoreCacheMiddleware } = require('../../src/middleware/scoreCache');
    const testApp = require('express')();
    let calls = 0;
    testApp.get('/x', createScoreCacheMiddleware(0), (req, res) => {
      calls += 1;
      res.json({ n: calls });
    });
    const { server, port } = await listenEphemeral(testApp);
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 5; i++) await fetchJson(`${base}/x`);
    check('SCORE_CACHE_TTL_MS=0相当（ttlMs=0）では毎回ハンドラが呼ばれる', calls === 5, `calls=${calls}`);
    await new Promise((resolve) => server.close(resolve));
  }

  // === 6. 管理APIが一般の上限を超えても429にならない ================================
  console.log('\n[verify] === 6: admin routes use a separate, higher limit ===');
  {
    // このプロセス全体のRL_DEFAULT_IP_MAX=5（起動時に設定済み）で、src/app.jsそのものを起動する。
    const app = require('../../src/app');
    const { server, port } = await listenEphemeral(app);
    const base = `http://127.0.0.1:${port}`;
    const results = [];
    for (let i = 0; i < 10; i++) {
      const r = await fetchJson(`${base}/api/v1/admin/categories`, xff('203.0.113.6'));
      results.push(r.status);
    }
    check('管理APIは既定の上限(5)を超えた10回でも429にならない（別枠のRL_ADMIN_IP_MAX）',
      results.every((s) => s === 200), `statuses=${results.join(',')}`);

    // 比較：一般ルート（(d)扱い、/api/v1/devices）は既定の上限(5)ですぐ429になることを確認する。
    const defaultResults = [];
    for (let i = 0; i < 10; i++) {
      const r = await fetchJson(`${base}/api/v1/devices`, xff('203.0.113.7'));
      defaultResults.push(r.status);
    }
    check('一般ルート（(d)）はRL_DEFAULT_IP_MAX(5)で429になる（対比）',
      defaultResults.slice(0, 5).every((s) => s !== 429) && defaultResults.slice(5).some((s) => s === 429),
      `statuses=${defaultResults.join(',')}`);

    await new Promise((resolve) => server.close(resolve));
  }

  // === 7. 環境変数の既定値・不正値の扱い ============================================
  console.log('\n[verify] === 7: env var defaults and invalid-value fallback ===');
  {
    const scriptPath = path.join(__dirname, '../../src/middleware/rateLimit.js');
    function runWithEnv(envOverrides) {
      const cleanEnv = { ...process.env };
      for (const key of Object.keys(cleanEnv)) {
        if (key.startsWith('RL_') || key === 'SCORE_CACHE_TTL_MS') delete cleanEnv[key];
      }
      const result = spawnSync(
        process.execPath,
        ['-e', `console.log(JSON.stringify(require(${JSON.stringify(scriptPath)}).config))`],
        { env: { ...cleanEnv, ...envOverrides }, encoding: 'utf8' }
      );
      let config = null;
      try {
        // console.logは複数行になりうる（起動時ログ＋JSON）。最後の行をJSONとしてパースする。
        const lines = result.stdout.trim().split('\n');
        config = JSON.parse(lines[lines.length - 1]);
      } catch (err) {
        config = null;
      }
      return { config, stderr: result.stderr };
    }

    const defaults = runWithEnv({});
    check('環境変数未設定時、既定値どおり（windowMs=900000, audienceIpMax=50000, deviceMax=60, scoreIpMax=6000, adminIpMax=20000, defaultIpMax=500, scoreCacheTtlMs=1000）',
      defaults.config &&
      defaults.config.windowMs === 900000 &&
      defaults.config.audienceIpMax === 50000 &&
      defaults.config.deviceMax === 60 &&
      defaults.config.scoreIpMax === 6000 &&
      defaults.config.adminIpMax === 20000 &&
      defaults.config.defaultIpMax === 500 &&
      defaults.config.scoreCacheTtlMs === 1000,
      JSON.stringify(defaults.config));

    const invalid = runWithEnv({ RL_AUDIENCE_IP_MAX: 'not-a-number' });
    check('不正な値（数値でない）は既定値(50000)に戻る', invalid.config && invalid.config.audienceIpMax === 50000,
      JSON.stringify(invalid.config));
    check('不正な値のとき、警告がログに出る', /invalid RL_AUDIENCE_IP_MAX/.test(invalid.stderr), invalid.stderr.trim());

    const negative = runWithEnv({ RL_DEVICE_MAX: '-5' });
    check('負の値は既定値(60)に戻る', negative.config && negative.config.deviceMax === 60, JSON.stringify(negative.config));

    const zeroTtl = runWithEnv({ SCORE_CACHE_TTL_MS: '0' });
    check('SCORE_CACHE_TTL_MS=0は有効な値として扱われる（既定値に戻らない）',
      zeroTtl.config && zeroTtl.config.scoreCacheTtlMs === 0, JSON.stringify(zeroTtl.config));
  }

  // === 8. 429のレスポンスの形が現行と同じ ===========================================
  console.log('\n[verify] === 8: 429 response shape matches express-rate-limit default ===');
  {
    const { server, port } = await listenEphemeral(buildAudienceTestApp({ ipMax: 1, deviceMax: 1000 }));
    const base = `http://127.0.0.1:${port}`;
    await fetchJson(`${base}/geturl?id=${encodeURIComponent(mac(8000))}`, xff('203.0.113.8'));
    const res = await fetch(`${base}/geturl?id=${encodeURIComponent(mac(8001))}`, xff('203.0.113.8'));
    const bodyText = await res.text();
    check('429のステータスコード', res.status === 429, `status=${res.status}`);
    check('429の本文が既定メッセージと一致', bodyText === 'Too many requests, please try again later.', bodyText);
    check('RateLimit-Policyヘッダーが付く', res.headers.has('ratelimit-policy'), res.headers.get('ratelimit-policy'));
    check('RateLimit-Limitヘッダーが付く', res.headers.has('ratelimit-limit'), res.headers.get('ratelimit-limit'));
    await new Promise((resolve) => server.close(resolve));
  }

  // === 9. 429のログが10秒に1回にまとまる ============================================
  console.log('\n[verify] === 9: 429 logs are coalesced (at most 1 per limiter per flush) ===');
  {
    rateLimitModule._resetLogStateForTests();
    const originalWarn = console.warn;

    // src/app.js（本物のrateLimitモジュール・実際のdefaultIpLimiterインスタンス）で
    // 429を複数回発生させ、flushRateLimitLogs()でまとめてログが出ることを確認する
    // （buildAudienceTestApp内で作った専用インスタンスはrateLimitModuleのhitCounts状態を
    // 共有しないため、ここでは本物のsrc/app.jsを使う）。
    const app = require('../../src/app');
    const { server: appServer, port: appPort } = await listenEphemeral(app);
    const appBase = `http://127.0.0.1:${appPort}`;
    for (let i = 0; i < 8; i++) {
      await fetchJson(`${appBase}/api/v1/devices`, xff('203.0.113.9')); // (d)扱い、RL_DEFAULT_IP_MAX=5
    }
    const warnCalls2 = [];
    console.warn = (...args) => warnCalls2.push(args.join(' '));
    rateLimitModule.flushRateLimitLogs();
    console.warn = originalWarn;

    const defaultLogLines = warnCalls2.filter((l) => l.includes('[rate-limit] 429 default'));
    check('flush時、defaultリミッターのログが1行にまとまる', defaultLogLines.length === 1, JSON.stringify(warnCalls2));
    check('まとまったログに件数が含まれる（3件＝8回中429だった分）',
      defaultLogLines[0] && /\b3\b/.test(defaultLogLines[0]), defaultLogLines[0]);

    await new Promise((resolve) => appServer.close(resolve));
  }

  await verifyPool.end();
  console.log(`\n[verify] ================ RESULT: PASS=${PASS} FAIL=${FAIL} ================`);
  process.exit(FAIL > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[verify] failed:', err.stack || err.message);
  process.exit(1);
});
