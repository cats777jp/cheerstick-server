#!/usr/bin/env node
// scripts/ranking-battle/local-verify.js
// 対抗戦向け順位発表画面（public/ranking-battle.html）のバックエンド側のローカル動作確認ハーネス。
// scripts/demo/local-verify-demo-mode.js と同じ方式（pg-memで実サーバー src/app.js を起動し、
// HTTP経由で確認）。
//
// ★本番・staging環境には一切接続しない。pg-memはプロセス内で完結するインメモリ実装で、
//   外部ネットワーク接続・ファイル永続化を一切行わない。サーバーは127.0.0.1限定。
//
// 使い方:
//   node scripts/ranking-battle/local-verify.js           # 自動チェックのみ（終了コード=FAIL有無）
//   node scripts/ranking-battle/local-verify.js --serve   # チェック後もサーバーを残し、
//                                                         # public/・assets/images/を静的配信する
//                                                         # （ブラウザでの目視確認用。Ctrl+Cで停止）
//                                                         # URL: http://127.0.0.1:<port>/ranking-battle.html?battle_id=...

'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');

const MIGRATIONS_DIR = path.join(__dirname, '../../migrations');
const PUBLIC_DIR = path.join(__dirname, '../../public');
const IMAGES_DIR = path.join(__dirname, '../../assets/images');
const TEST_PORT = Number(process.env.RANKING_BATTLE_VERIFY_PORT) || 34527;
const SERVE = process.argv.includes('--serve');

const CATEGORY_ID = '90000000-0000-0000-0000-000000000003';
const ORG_A_ID = '90000000-0000-0000-0000-0000000000a3';
const ORG_B_ID = '90000000-0000-0000-0000-0000000000b3';

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

// --- pg-mem セットアップ（scripts/demo/local-verify-demo-mode.jsと同じ方式） -------------
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
    for (const stmt of splitStatements(sql)) {
      const withoutComments = stmt.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
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
    name: 'gen_random_uuid', returns: DataType.uuid,
    implementation: () => require('crypto').randomUUID(), impure: true,
  });
  memDb.public.registerFunction({
    name: 'current_database', returns: DataType.text,
    implementation: () => 'cheerstick_pgmem_ranking_battle_local_verify',
  });
  applyMigrations(memDb);

  const pgAdapter = memDb.adapters.createPg();

  // pg-memはウィンドウ関数（RANK() OVER ...）に未対応のため、順位確定の集計クエリ
  // （computeUserRanking／computeTargetRanking）だけ、ハーネス側で「rank列を0にして実行→
  // cheer_value降順からRANK()相当（同点は同順位・次はスキップ）をJSで計算」に置き換える。
  // 本番コード（src/）は一切変更していない。確認対象の新規コード（対抗戦用GET・metadata PATCH）は
  // このシムを通らず、実SQL（LEFT JOIN・jsonb || / -）がpg-mem上でそのまま動く。
  const RANK_RE = /RANK\(\)\s+OVER\s*\(\s*ORDER BY\s+SUM\([^)]*\)\s+DESC\s*\)\s+AS\s+rank/i;
  function shimRank(origQuery) {
    return async function (text, ...rest) {
      if (typeof text === 'string' && RANK_RE.test(text)) {
        const result = await origQuery.call(this, text.replace(RANK_RE, '0 AS rank'), ...rest);
        const rows = result.rows;
        rows.forEach((r) => {
          r.rank = 1 + rows.filter((o) => Number(o.cheer_value) > Number(r.cheer_value)).length;
        });
        return result;
      }
      return origQuery.call(this, text, ...rest);
    };
  }
  // 同様に、pg-memはjsonbの`||`（マージ）・`-`（キー削除）演算子に未対応（`||`を文字列連結として
  // 扱いjsonのパースに失敗する。変更前から使っているthemeImageUrl 1キーの式でも同じ）。
  // updateEvent()が生成する`metadata = (metadata || $N::jsonb) - 'key'...`／`metadata = metadata - 'key'...`
  // だけ、現在値を読んで同じ結果（マージ→削除）をJSで計算し、確定済みのjsonbを渡す形に置き換える。
  // ※この置き換えのため、`||`/`-`演算子そのもののSQLはこのハーネスでは実行されない。
  //   実PostgreSQL上での確認はstaging等で別途必要（レポートに明記）。
  const META_RE = /metadata = (?:\(metadata \|\| \$(\d+)::jsonb\)|metadata)((?: - '[A-Za-z]+')*)/;
  function shimMetadata(origQuery) {
    return async function (text, params, ...rest) {
      if (typeof text === 'string' && /^\s*UPDATE events SET/.test(text) && META_RE.test(text)) {
        const m = text.match(META_RE);
        const whereId = params[params.length - 1];
        const cur = await origQuery.call(this, 'SELECT metadata FROM events WHERE id = $1', [whereId]);
        if (cur.rows.length === 0) return origQuery.call(this, text, params, ...rest);
        // pg-memは列既定値'{}'を文字列のまま保持することがあるためパースしてから扱う
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
  pgAdapter.Pool.prototype.query = shimMetadata(shimRank(pgAdapter.Pool.prototype.query));
  pgAdapter.Client.prototype.query = shimMetadata(shimRank(pgAdapter.Client.prototype.query));

  const pgModulePath = require.resolve('pg');
  require.cache[pgModulePath] = {
    id: pgModulePath, filename: pgModulePath, loaded: true, exports: pgAdapter,
  };
  return { pgAdapter };
}

// --- フィクスチャ ------------------------------------------------------------------
// チームA：選手12名（上位3名は写真あり）＋ユーザー25名（20位打ち切りの確認）、同点あり。
// チームB：選手なし（cheer_logs.target_id = NULL。スポンサー対抗戦想定）、ユーザー15名。
async function seedFixtures(pool) {
  await pool.query(`INSERT INTO categories (id, name, slug) VALUES ($1, '順位発表確認用', 'ranking-battle-local-verify')`, [CATEGORY_ID]);
  await pool.query(
    `INSERT INTO organizations (id, name, type, category_id, logo_url, color) VALUES ($1, 'チームA（選手あり）', 'football_club', $2, '/images/teams/1.png', '#E63946')`,
    [ORG_A_ID, CATEGORY_ID]
  );
  await pool.query(
    `INSERT INTO organizations (id, name, type, category_id, logo_url, color) VALUES ($1, 'チームB（スポンサー）', 'football_club', $2, NULL, '#3A86FF')`,
    [ORG_B_ID, CATEGORY_ID]
  );

  const evA = (await pool.query(
    `INSERT INTO events (organization_id, title, starts_at, status) VALUES ($1, '対抗戦A', NOW(), 'live') RETURNING id`, [ORG_A_ID]
  )).rows[0].id;
  const evB = (await pool.query(
    `INSERT INTO events (organization_id, title, starts_at, status) VALUES ($1, '対抗戦B', NOW(), 'live') RETURNING id`, [ORG_B_ID]
  )).rows[0].id;

  const targetIds = [];
  for (let i = 1; i <= 12; i++) {
    const img = i <= 3 ? '/images/members/1/1.png' : null;
    const r = await pool.query(
      `INSERT INTO targets (organization_id, name, type, image_url, number) VALUES ($1, $2, 'player', $3, $4) RETURNING id`,
      [ORG_A_ID, `選手${i}`, img, String(i)]
    );
    targetIds.push(r.rows[0].id);
  }

  async function addUserLogs(prefix, count, event, targets, valueOf) {
    const userIds = [];
    for (let i = 1; i <= count; i++) {
      const u = (await pool.query(
        `INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING id`, [`${prefix}${i}@example.invalid`, `${prefix}ユーザー${i}`]
      )).rows[0].id;
      const d = (await pool.query(
        `INSERT INTO devices (mac_address, owner_user_id) VALUES ($1, $2) RETURNING id`,
        [`${prefix === 'a' ? 'AA' : 'BB'}:00:00:00:00:${String(i).padStart(2, '0')}`, u]
      )).rows[0].id;
      const tgt = targets ? targets[(i - 1) % targets.length] : null;
      await pool.query(
        `INSERT INTO cheer_logs (device_id, user_id, event_id, target_id, intensity) VALUES ($1, $2, $3, $4, $5)`,
        [d, u, event, tgt, valueOf(i)]
      );
      userIds.push({ u, d, tgt });
    }
    return userIds;
  }
  // 各ユーザー1行ずつ。valueOf：1位が単独、2・3位が同点になるよう調整（RANK()の同順位確認）。
  const aUsers = await addUserLogs('a', 25, evA, targetIds, (i) => (i === 1 ? 100 : i <= 3 ? 90 : Math.max(1, 90 - i * 3)));
  const bUsers = await addUserLogs('b', 15, evB, null, (i) => (i === 1 ? 100 : Math.max(1, 100 - i * 5)));
  return { evA, evB, targetIds, aUsers, bUsers };
}

async function main() {
  process.env.NODE_ENV = 'development';
  process.env.ALLOWED_ORIGINS = '*';
  process.env.ENABLE_REFERENCE_TOKEN = 'false';
  process.env.DATABASE_URL = 'postgres://local-verify-unused/placeholder';
  process.env.PORT = String(TEST_PORT);
  process.env.SCORE_CACHE_TTL_MS = '0'; // 連続GETの変化を見るためキャッシュ無効

  console.log('[verify] setting up pg-mem and applying migrations...');
  const { pgAdapter } = setupPgMem();
  const pool = new pgAdapter.Pool();
  const fx = await seedFixtures(pool);

  const app = require('../../src/app');
  const server = http.createServer((req, res) => {
    // --serve：APIはapp.jsへ、それ以外は public/ と assets/images/ を静的配信（目視確認用。本番のnginxの代わり）
    if (SERVE && !req.url.startsWith('/api/') && !req.url.startsWith('/health')) {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      const base = urlPath.startsWith('/images/') ? IMAGES_DIR : PUBLIC_DIR;
      const rel = urlPath.startsWith('/images/') ? urlPath.slice('/images/'.length) : urlPath;
      const file = path.normalize(path.join(base, rel));
      if (file.startsWith(base) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg' };
        res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
        return fs.createReadStream(file).pipe(res);
      }
      res.writeHead(404);
      return res.end('not found');
    }
    return app(req, res);
  });
  await new Promise((resolve, reject) => { server.listen(TEST_PORT, '127.0.0.1', resolve); server.once('error', reject); });
  console.log(`[verify] server listening on 127.0.0.1:${TEST_PORT}`);

  const base = `http://127.0.0.1:${TEST_PORT}/api/v1`;
  async function call(method, urlPath, jsonBody) {
    const init = { method };
    if (jsonBody !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(jsonBody);
    }
    const res = await fetch(`${base}${urlPath}`, init);
    let body = null;
    try { body = await res.json(); } catch (e) { /* ボディ無し */ }
    return { status: res.status, body };
  }

  // === 1. 対抗戦ペア作成・未確定状態 ===========================================
  console.log('\n[verify] === step 1: battle + before any snapshot ===');
  const battleRes = await call('POST', '/admin/event-battles', { label: 'テスト対抗戦', event_a_id: fx.evA, event_b_id: fx.evB });
  check('対抗戦ペア作成 201', battleRes.status === 201, JSON.stringify(battleRes.body));
  const battleId = battleRes.body.id;

  const before = await call('GET', `/event-battles/${battleId}/ranking-snapshots/latest`);
  check('未確定でも200', before.status === 200);
  check('未確定：両チームsnapshotId=null・空配列',
    before.body.team_a.snapshot.snapshotId === null && before.body.team_b.snapshot.snapshotId === null &&
    before.body.team_a.snapshot.user.length === 0 && before.body.team_a.snapshot.target.length === 0);
  check('未確定でもチーム色・ロゴ・チーム名は返る',
    before.body.team_a.organization.color === '#E63946' && before.body.team_a.organization.logo_url === '/images/teams/1.png' &&
    before.body.team_b.organization.name === 'チームB（スポンサー）');
  check('decorは未設定でnull', before.body.team_a.decor.background_url === null && before.body.team_a.decor.sponsor_logo_url === null);
  check('theme_image_urlは未設定でnull', before.body.theme_image_url === null);
  check('stage_background_urlは未設定でnull', before.body.stage_background_url === null);

  const bad = await call('GET', `/event-battles/not-a-uuid/ranking-snapshots/latest`);
  check('不正IDは400 INVALID_ID', bad.status === 400 && bad.body.error === 'INVALID_ID');
  const missing = await call('GET', `/event-battles/00000000-0000-4000-8000-000000000000/ranking-snapshots/latest`);
  check('存在しない対抗戦は404 BATTLE_NOT_FOUND', missing.status === 404 && missing.body.error === 'BATTLE_NOT_FOUND');

  // === 2. 両チーム確定（既存の確定APIをA・Bに対して呼ぶ） =======================
  console.log('\n[verify] === step 2: confirm both teams ===');
  const [snapResA, snapResB] = await Promise.all([
    call('POST', `/admin/events/${fx.evA}/ranking-snapshot`),
    call('POST', `/admin/events/${fx.evB}/ranking-snapshot`),
  ]);
  check('チームAの確定 201', snapResA.status === 201, JSON.stringify(snapResA.body).slice(0, 120));
  check('チームBの確定 201', snapResB.status === 201);

  const after = await call('GET', `/event-battles/${battleId}/ranking-snapshots/latest`);
  const a = after.body.team_a.snapshot;
  const b = after.body.team_b.snapshot;
  check('確定後：snapshotIdが入る', !!a.snapshotId && !!b.snapshotId);
  check('チームA：ユーザー別は上位20件で打ち切り', a.user.length === 20, `len=${a.user.length}`);
  check('チームA：選手別は12件（選手数どおり）', a.target.length === 12, `len=${a.target.length}`);
  check('チームA：1位は単独1位（ユーザー）', a.user[0].rank === 1 && a.user[1].rank === 2);
  check('チームA：同点の2・3位は同順位（RANK()方式）', a.user[1].rank === a.user[2].rank, `${a.user[1].rank},${a.user[2].rank}`);
  check('チームA：順位は昇順', a.user.every((e, i) => i === 0 || e.rank >= a.user[i - 1].rank));
  check('チームA選手：写真URL（上位）が補完される', a.target.slice(0, 3).some((e) => e.imageUrl === '/images/members/1/1.png'),
    JSON.stringify(a.target.slice(0, 3)));
  check('チームA選手：写真なしはimageUrl=nullで背番号が付く', a.target.filter((e) => e.imageUrl === null).every((e) => e.number !== null));
  check('チームA選手：displayName・cheerValueが確定時点の値', a.target.every((e) => typeof e.displayName === 'string' && Number.isInteger(e.cheerValue)));
  check('チームA ユーザー明細にimageUrlは付かない', a.user.every((e) => !('imageUrl' in e)));
  check('チームB：選手別は空（target_id NULL）→画面で選手セクション非表示', b.target.length === 0);
  check('チームB：ユーザー別は15件', b.user.length === 15, `len=${b.user.length}`);

  // 既存GET（ranking-user.html / ranking-target.html 用）が従来どおり（フィールド追加なし）
  const legacy = await call('GET', `/events/${fx.evA}/ranking-snapshots/latest?rankingType=target`);
  check('既存GET：従来のキーのまま（rank/displayName/cheerValue のみ）',
    legacy.status === 200 && legacy.body.entries.length === 12 &&
    legacy.body.entries.every((e) => Object.keys(e).sort().join(',') === 'cheerValue,displayName,rank'),
    JSON.stringify(Object.keys(legacy.body.entries[0] || {})));

  // === 3. 装飾枠（events.metadata）：PATCH経由で設定・解除・マージ ================
  console.log('\n[verify] === step 3: decor via PATCH /admin/events/:id ===');
  const p1 = await call('PATCH', `/admin/events/${fx.evA}`, {
    theme_image_url: '/images/teams/1.png', ranking_background_url: '/images/teams/1.png', sponsor_logo_url: '/images/teams/1.png',
  });
  check('3キー同時のPATCH 200', p1.status === 200, JSON.stringify(p1.body));
  check('metadataに3キーが入る',
    p1.body.metadata.themeImageUrl && p1.body.metadata.rankingBackgroundUrl && p1.body.metadata.sponsorLogoUrl);
  const g1 = (await call('GET', `/event-battles/${battleId}/ranking-snapshots/latest`)).body;
  check('GET：背景・スポンサー・テーマ画像が返る',
    g1.team_a.decor.background_url === '/images/teams/1.png' && g1.team_a.decor.sponsor_logo_url === '/images/teams/1.png' &&
    g1.theme_image_url === '/images/teams/1.png');
  check('GET：未設定のチームBはdecor null', g1.team_b.decor.background_url === null && g1.team_b.decor.sponsor_logo_url === null);

  const p2 = await call('PATCH', `/admin/events/${fx.evA}`, { sponsor_logo_url: null, theme_image_url: '/images/teams/2.png' });
  check('1キー解除＋1キー更新を同時に 200', p2.status === 200, JSON.stringify(p2.body));
  check('解除したキーだけ消え、他は維持される',
    !('sponsorLogoUrl' in p2.body.metadata) && p2.body.metadata.rankingBackgroundUrl === '/images/teams/1.png' &&
    p2.body.metadata.themeImageUrl === '/images/teams/2.png');
  const p3 = await call('PATCH', `/admin/events/${fx.evA}`, { title: '対抗戦A（改）' });
  check('metadataを触らないPATCHでmetadataが維持される', p3.status === 200 && p3.body.metadata.rankingBackgroundUrl === '/images/teams/1.png');
  const p4 = await call('PATCH', `/admin/events/${fx.evA}`, { ranking_background_url: { x: 1 } });
  check('文字列でない値は400 INVALID_METADATA_VALUE', p4.status === 400 && p4.body.error === 'INVALID_METADATA_VALUE', JSON.stringify(p4.body));
  const p5 = await call('PATCH', `/admin/events/${fx.evA}`, { theme_image_url: '' });
  check('theme_image_url空文字で解除（既存挙動の維持）', p5.status === 200 && !('themeImageUrl' in p5.body.metadata));
  await call('PATCH', `/admin/events/${fx.evA}`, { theme_image_url: '/images/teams/1.png', sponsor_logo_url: '/images/teams/1.png' });

  // 画面全体の背景（stage_background_url、2026-10-07追加）：テーマ画像と同じ採用ルール（試合A優先、無ければB）
  const sb = await call('PATCH', `/admin/events/${fx.evB}`, { stage_background_url: '/images/stage-b.png' });
  check('stage_background_url をPATCHで設定できる（試合B）', sb.status === 200 && sb.body.metadata.stageBackgroundUrl === '/images/stage-b.png', JSON.stringify(sb.body && sb.body.metadata));
  const gs1 = (await call('GET', `/event-battles/${battleId}/ranking-snapshots/latest`)).body;
  check('試合Aに無ければ試合Bの背景が採用される', gs1.stage_background_url === '/images/stage-b.png', gs1.stage_background_url);
  await call('PATCH', `/admin/events/${fx.evA}`, { stage_background_url: '/images/stage-a.png' });
  const gs2 = (await call('GET', `/event-battles/${battleId}/ranking-snapshots/latest`)).body;
  check('両方にあれば試合Aの背景が優先される', gs2.stage_background_url === '/images/stage-a.png', gs2.stage_background_url);
  const sbBad = await call('PATCH', `/admin/events/${fx.evA}`, { stage_background_url: { x: 1 } });
  check('stage_background_url が文字列以外なら400 INVALID_METADATA_VALUE', sbBad.status === 400 && sbBad.body.error === 'INVALID_METADATA_VALUE');
  const sbClearA = await call('PATCH', `/admin/events/${fx.evA}`, { stage_background_url: '' });
  check('解除（空文字）してもA側の他のキーは維持される', sbClearA.status === 200 && !('stageBackgroundUrl' in sbClearA.body.metadata) && sbClearA.body.metadata.sponsorLogoUrl === '/images/teams/1.png', JSON.stringify(sbClearA.body && sbClearA.body.metadata));
  const gs3 = (await call('GET', `/event-battles/${battleId}/ranking-snapshots/latest`)).body;
  check('Aを解除するとBにフォールバックする', gs3.stage_background_url === '/images/stage-b.png', gs3.stage_background_url);
  await call('PATCH', `/admin/events/${fx.evB}`, { stage_background_url: null });
  const gs4 = (await call('GET', `/event-battles/${battleId}/ranking-snapshots/latest`)).body;
  check('両方解除するとnullに戻る', gs4.stage_background_url === null, String(gs4.stage_background_url));

  // === 4. 再確定で最新に切り替わる ===================================================
  console.log('\n[verify] === step 4: re-confirm picks up the newest snapshot ===');
  const top = fx.aUsers[24];
  await pool.query(`INSERT INTO cheer_logs (device_id, user_id, event_id, target_id, intensity) VALUES ($1, $2, $3, $4, 100)`, [top.d, top.u, fx.evA, top.tgt]);
  await new Promise((r) => setTimeout(r, 15));
  await call('POST', `/admin/events/${fx.evA}/ranking-snapshot`);
  const g2 = (await call('GET', `/event-battles/${battleId}/ranking-snapshots/latest`)).body;
  check('再確定後、チームAのsnapshotIdが新しくなる', g2.team_a.snapshot.snapshotId !== a.snapshotId);
  check('再確定後、チームBは前回確定のまま', g2.team_b.snapshot.snapshotId === b.snapshotId);
  check('再確定後、ユーザー25位だった人が上位に入る', g2.team_a.snapshot.user.some((e) => e.displayName === 'aユーザー25'));

  // 片方だけ未確定のケース（新しい対抗戦を作り、Bだけ確定）
  const evC = (await pool.query(`INSERT INTO events (organization_id, title, starts_at, status) VALUES ($1, '未確定の試合', NOW(), 'scheduled') RETURNING id`, [ORG_A_ID])).rows[0].id;
  const battle2 = await call('POST', '/admin/event-battles', { label: '片側のみ', event_a_id: evC, event_b_id: fx.evB });
  const g3 = (await call('GET', `/event-battles/${battle2.body.id}/ranking-snapshots/latest`)).body;
  check('片側のみ確定：未確定側はsnapshotId=null、確定側は値あり',
    g3.team_a.snapshot.snapshotId === null && g3.team_b.snapshot.snapshotId !== null);
  const evCconfirm = await call('POST', `/admin/events/${evC}/ranking-snapshot`);
  check('scheduledの試合は確定不可 400 INVALID_EVENT_STATUS（既存仕様のまま）', evCconfirm.status === 400 && evCconfirm.body.error === 'INVALID_EVENT_STATUS');

  console.log(`\n[verify] done: PASS=${PASS} FAIL=${FAIL}`);
  console.log(`[verify] screen URL: http://127.0.0.1:${TEST_PORT}/ranking-battle.html?battle_id=${battleId}`);
  console.log(`[verify]   top=20:   http://127.0.0.1:${TEST_PORT}/ranking-battle.html?battle_id=${battleId}&top=20`);
  console.log(`[verify]   片側のみ: http://127.0.0.1:${TEST_PORT}/ranking-battle.html?battle_id=${battle2.body.id}`);

  if (SERVE) {
    console.log('[verify] --serve: サーバーを起動したままにします（Ctrl+Cで停止）');
    return;
  }
  server.close();
  process.exit(FAIL === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[verify] fatal:', err);
  process.exit(1);
});
