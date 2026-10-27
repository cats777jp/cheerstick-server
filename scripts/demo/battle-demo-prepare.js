#!/usr/bin/env node
// scripts/demo/battle-demo-prepare.js
// 応援合戦デモ Phase 2：本番側準備スクリプト（本番EC2上で実行する想定）。
//
// 本番EC2上から http://127.0.0.1:3000/api/v1/admin/... の管理APIを呼ぶ方式。
// nginxのIPアドレス制限（/api/v1/admin/、docs/runbook.md参照）を経由せず、DBへも
// 直接接続しない（2026-09-25のデモ作成時と同じ方式）。
//
// 既定はdry run（実行予定の操作一覧を表示するのみ）。--yes を付けたときだけ実際に書き込む。
// 何度実行しても安全（冪等）：カテゴリー・チームは新規作成せず既存のものを検索して使う。
// デバイスは既存MACをスキップ・category_id/is_demoが異なれば更新する。
// 試合・対抗戦ペアは実行するたびに新規作成する（後片付けは --finish-run 参照）。
//
// 使い方:
//   node scripts/demo/battle-demo-prepare.js                          # dry run
//   node scripts/demo/battle-demo-prepare.js --yes                    # 実際に準備を実行
//   node scripts/demo/battle-demo-prepare.js --yes --pause-other-live # 他のlive試合をpausedにしてから実行
//   node scripts/demo/battle-demo-prepare.js --finish-run=<battle_id> --yes
//
// 詳細は scripts/demo/README.md 参照。

'use strict';

const DEFAULT_API_BASE = 'http://127.0.0.1:3000/api/v1';
const DEFAULT_CATEGORY_NAME = 'デモ用';
const DEFAULT_TEAM_A_NAME = 'EMUTTO';
const DEFAULT_TEAM_B_NAME = 'J SPORTS';
const DEFAULT_DEVICES_PER_TEAM = 500;
const DEFAULT_MAC_PREFIX = 'AA:00:00:02';
const DEFAULT_TEAM_B_START_INDEX = 0x8000; // 32768
// 2026-09-25作成の恒久デモ（docs/spec.md 8.4章）の対抗戦ペア。2026-10-30以降は、テーマ画像の
// 既定の取得元ではなくなった（ペアが管理画面から削除されると画像が無言で入らなくなったため）。
// 他箇所（note表示）の参照用に残す。
const PERMANENT_DEMO_BATTLE_ID = '3d909ed3-3207-4222-a6f9-a6c39980b910';
// テーマ画像の既定の取得元（2026-10-30変更）：ペアではなく、恒久デモの試合の
// events.metadata.themeImageUrl。A（620f09c5）優先、なければB（05efa49a）。
// 試合自体が管理画面から非表示化された場合は取得できない（GET /admin/eventsが返さないため）。
const PERMANENT_DEMO_EVENT_A_ID = '620f09c5-8ceb-45de-b35d-7bf47821950a';
const PERMANENT_DEMO_EVENT_B_ID = '05efa49a-ca92-4190-94ff-eea24ec5033a';
const CREATE_CONCURRENCY = 20;
// 管理API（src/app.js）のレート制限は500リクエスト/15分（トークンではなく固定ウィンドウ）。
// 127.0.0.1:3000へ直接アクセスする本スクリプトはtrust proxy越しのクライアントIP分離が
// 効かず、全リクエストが同一キー（127.0.0.1）に積み上がるため、デバイス登録が多い実行では
// 途中でHTTP 429を受ける前提で動作する（2026-09-28、実運用で確認済み。詳細は
// scripts/demo/README.md参照）。
const RETRY_AFTER_BUFFER_SEC = 5; // Retry-Afterの秒数に上乗せする余裕（指示書どおり「+数秒」）
const RETRY_LOG_INTERVAL_SEC = 30; // 429待機中、残り秒数をログに出す間隔
const DEVICE_LIST_PAGE_SIZE = 200; // src/controllers/adminDeviceController.js の MAX_PAGE_SIZE

function parseArgs(argv) {
  const args = {
    apiBase: DEFAULT_API_BASE,
    categoryName: DEFAULT_CATEGORY_NAME,
    teamAName: DEFAULT_TEAM_A_NAME,
    teamBName: DEFAULT_TEAM_B_NAME,
    devicesPerTeam: DEFAULT_DEVICES_PER_TEAM,
    macPrefix: DEFAULT_MAC_PREFIX,
    teamBStartIndex: DEFAULT_TEAM_B_START_INDEX,
    pauseOtherLive: false,
    themeImageUrl: null,
    themeSourceBattleId: null, // 明示指定（--theme-source-battle-id）時のみ、従来どおりペアのスコアAPIから取得する
    label: null,
    yes: false,
    finishRun: null,
    restore: null,
  };
  for (const raw of argv) {
    if (raw === '--yes') { args.yes = true; continue; }
    if (raw === '--pause-other-live') { args.pauseOtherLive = true; continue; }
    const m = /^--([^=]+)(?:=(.*))?$/.exec(raw);
    if (!m) continue;
    const [, key, value] = m;
    switch (key) {
      case 'api-base': args.apiBase = value; break;
      case 'category-name': args.categoryName = value; break;
      case 'team-a-name': args.teamAName = value; break;
      case 'team-b-name': args.teamBName = value; break;
      case 'devices-per-team': args.devicesPerTeam = parseInt(value, 10); break;
      case 'mac-prefix': args.macPrefix = value; break;
      case 'team-b-start-index': args.teamBStartIndex = parseInt(value, 10); break;
      case 'theme-image-url': args.themeImageUrl = value; break;
      case 'theme-source-battle-id': args.themeSourceBattleId = value; break;
      case 'label': args.label = value; break;
      case 'finish-run': args.finishRun = value; break;
      case 'restore': args.restore = value; break;
      default:
        throw new Error(`unknown option: --${key}`);
    }
  }
  return args;
}

// --- HTTP helper -------------------------------------------------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// HTTP 429（レート制限）を受けたら、Retry-Afterの秒数（+RETRY_AFTER_BUFFER_SEC秒）だけ
// 待ってから同じリクエストをやり直す。待機中はRETRY_LOG_INTERVAL_SECごとに残り秒数を
// ログへ出す。Retry-Afterが無い/数値でない場合は60秒を仮定する。
//
// CREATE_CONCURRENCY（20並列）で同時に多数のリクエストを投げているため、レート制限に
// 達した瞬間は複数の呼び出しがほぼ同時に429を受ける。各呼び出しが個別に待機・ログ出力すると
// 同じ内容が並列数だけ（最大20行）重複して出力されてしまうため、待機中の呼び出しが
// 既にあればそれに相乗りし（activeWaitを共有）、ログは最初の1件のみが出す
// （2026-09-28、ログの重複出力を1回にまとめる修正。待機の動作自体は変えていない）。
let activeWait = null;
async function waitForRateLimit(retryAfterHeader, context) {
  if (activeWait) {
    return activeWait;
  }
  const retryAfterSec = Math.max(parseInt(retryAfterHeader, 10), 0) || 60;
  let remaining = retryAfterSec + RETRY_AFTER_BUFFER_SEC;
  console.log(`[prepare] HTTP 429 (rate limited) on ${context}; waiting ${remaining}s before retrying`);
  activeWait = (async () => {
    while (remaining > 0) {
      const step = Math.min(remaining, RETRY_LOG_INTERVAL_SEC);
      await sleep(step * 1000);
      remaining -= step;
      if (remaining > 0) {
        console.log(`[prepare] still waiting on rate limit (${context}): ${remaining}s remaining`);
      }
    }
    console.log(`[prepare] resuming ${context} after rate-limit wait`);
  })();
  try {
    await activeWait;
  } finally {
    activeWait = null;
  }
}

async function apiCall(apiBase, method, path, body) {
  const context = `${method} ${path}`;
  for (;;) {
    const res = await fetch(`${apiBase}${path}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
      await waitForRateLimit(res.headers.get('retry-after'), context);
      continue;
    }
    let json = null;
    try {
      json = await res.json();
    } catch (err) {
      // レスポンスボディが無い/JSONでない場合はnullのまま
    }
    return { status: res.status, ok: res.ok, body: json };
  }
}

async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await fn(items[current], current);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function macForIndex(prefix, index) {
  const hex = index.toString(16).toUpperCase().padStart(4, '0');
  return `${prefix}:${hex.slice(0, 2)}:${hex.slice(2, 4)}`;
}

// --- 各ステップ ---------------------------------------------------------------

async function findCategory(apiBase, name) {
  const { ok, body } = await apiCall(apiBase, 'GET', '/admin/categories');
  if (!ok) throw new Error(`GET /admin/categories failed: ${JSON.stringify(body)}`);
  const found = (body || []).find((c) => c.name === name);
  if (!found) {
    throw new Error(
      `category "${name}" not found. 新規作成は行わない設計のため、事前に管理画面等で作成してください。 ` +
      `既存カテゴリー: ${(body || []).map((c) => c.name).join(', ')}`
    );
  }
  return found;
}

async function findOrganization(apiBase, categoryId, name) {
  const { ok, body } = await apiCall(apiBase, 'GET', `/admin/organizations?category_id=${categoryId}`);
  if (!ok) throw new Error(`GET /admin/organizations failed: ${JSON.stringify(body)}`);
  const found = (body || []).find((o) => o.name === name);
  if (!found) {
    throw new Error(
      `organization "${name}" not found under category ${categoryId}. ` +
      `既存チーム: ${(body || []).map((o) => o.name).join(', ')}`
    );
  }
  return found;
}

async function listOtherLiveOrPausedEvents(apiBase, orgAId, orgBId) {
  const { ok, body } = await apiCall(apiBase, 'GET', '/admin/events');
  if (!ok) throw new Error(`GET /admin/events failed: ${JSON.stringify(body)}`);
  return (body || []).filter(
    (e) => (e.organization_id === orgAId || e.organization_id === orgBId) &&
      (e.status === 'live' || e.status === 'paused')
  );
}

async function pauseLiveEvents(apiBase, events, yes) {
  const changed = [];
  for (const ev of events) {
    if (ev.status !== 'live') continue; // pausedは変更不要
    if (!yes) {
      changed.push({ id: ev.id, title: ev.title, previousStatus: ev.status, applied: false });
      continue;
    }
    const { ok, body } = await apiCall(apiBase, 'PATCH', `/admin/events/${ev.id}/status`, { status: 'paused' });
    if (!ok) throw new Error(`failed to pause event ${ev.id}: ${JSON.stringify(body)}`);
    changed.push({ id: ev.id, title: ev.title, previousStatus: 'live', applied: true });
  }
  return changed;
}

// デバイス登録：単体登録API（POST /admin/devices）を採用した。
// 理由：CSV取込（POST /admin/devices/import）はcategory_id/is_demoをその場で設定できず
// （2段階運用：取込後にPATCH /admin/devices/bulkで確定する設計、adminDeviceController.js
// のコメント参照）、bulk側のmacQueryはILIKE部分一致で下位2バイトの跨ぎを扱いにくい。
// 単体登録APIはcategory_id/is_demoを作成時に直接指定でき、1台ずつの冪等処理が素直に
// 書けるため、今回はこちらを選んだ。リクエストサイズ上限（16kb、express.json）の制約も
// 単体登録なら関係しない。
//
// 既存デバイスの確認は、2026-09-28以前は1台ずつGET（またはPOST 409時にGET）していたが、
// 台数分だけAPIリクエストを消費しレート制限（500req/15分、src/app.js）に達しやすいため、
// mac部分一致（ILIKE、src/db/cheerstickQueries.js listDevicesAdmin）を使い、対象prefix配下を
// ページング（DEVICE_LIST_PAGE_SIZE件ずつ）でまとめて取得する方式に変更した。

async function fetchExistingDevicesByPrefix(apiBase, macPrefix) {
  const existing = new Map();
  let page = 1;
  let total = Infinity;
  let fetched = 0;
  for (;;) {
    const { ok, body } = await apiCall(
      apiBase, 'GET',
      `/admin/devices?mac=${encodeURIComponent(macPrefix)}&page=${page}&page_size=${DEVICE_LIST_PAGE_SIZE}`
    );
    if (!ok) throw new Error(`GET /admin/devices (mac=${macPrefix}, page=${page}) failed: ${JSON.stringify(body)}`);
    const rows = body.devices || [];
    for (const row of rows) existing.set(row.mac_address, row);
    total = typeof body.total === 'number' ? body.total : rows.length;
    fetched += rows.length;
    if (rows.length === 0 || fetched >= total) break;
    page += 1;
  }
  return existing;
}

async function ensureDevice(apiBase, mac, categoryId, yes, existingMap) {
  const row = existingMap.get(mac);
  const alreadyOk = !!row && row.category_id === categoryId && row.is_demo === true;

  if (!yes) {
    if (alreadyOk) return { mac, action: 'dry-run(already-ok)', applied: false };
    return { mac, action: row ? 'dry-run(would-update)' : 'dry-run(would-create)', applied: false };
  }

  if (alreadyOk) {
    return { mac, action: 'skipped(already-ok)', applied: false };
  }

  if (row) {
    const patched = await apiCall(apiBase, 'PATCH', `/admin/devices/${row.id}`, {
      category_id: categoryId,
      is_demo: true,
    });
    if (!patched.ok) throw new Error(`failed to update device ${mac}: ${JSON.stringify(patched.body)}`);
    return { mac, action: 'updated', applied: true };
  }

  const created = await apiCall(apiBase, 'POST', '/admin/devices', {
    mac_address: mac,
    category_id: categoryId,
    is_demo: true,
  });
  if (created.ok) {
    return { mac, action: 'created', applied: true };
  }
  if (created.status === 409) {
    // 稀なレース対策：まとめて取得した一覧の後に他プロセスが同じMACを作成した場合のみ、
    // 該当1件だけを個別に確認する（通常経路ではここには来ない）。
    const existingLookup = await apiCall(apiBase, 'GET', `/admin/devices?mac=${encodeURIComponent(mac)}&page_size=5`);
    if (!existingLookup.ok) throw new Error(`failed to look up existing device ${mac}: ${JSON.stringify(existingLookup.body)}`);
    const foundRow = (existingLookup.body.devices || []).find((d) => d.mac_address === mac);
    if (!foundRow) throw new Error(`device ${mac} reported as existing (409) but not found by exact lookup`);
    if (foundRow.category_id === categoryId && foundRow.is_demo === true) {
      return { mac, action: 'skipped(already-ok)', applied: false };
    }
    const patched = await apiCall(apiBase, 'PATCH', `/admin/devices/${foundRow.id}`, {
      category_id: categoryId,
      is_demo: true,
    });
    if (!patched.ok) throw new Error(`failed to update device ${mac}: ${JSON.stringify(patched.body)}`);
    return { mac, action: 'updated', applied: true };
  }
  throw new Error(`failed to create device ${mac}: HTTP ${created.status} ${JSON.stringify(created.body)}`);
}

async function ensureDevices(apiBase, prefix, startIndex, count, categoryId, yes, label, existingMap) {
  const macs = Array.from({ length: count }, (_, i) => macForIndex(prefix, startIndex + i));
  console.log(
    `[prepare] ${label}: ${count} devices, mac ${macs[0]} .. ${macs[macs.length - 1]} ` +
    `(${yes ? 'applying' : 'dry run'})`
  );
  const results = await mapWithConcurrency(macs, CREATE_CONCURRENCY, (mac) => ensureDevice(apiBase, mac, categoryId, yes, existingMap));
  const summary = { created: 0, updated: 0, skipped: 0, dryRun: 0 };
  for (const r of results) {
    if (r.action === 'created') summary.created++;
    else if (r.action === 'updated') summary.updated++;
    else if (r.action.startsWith('dry-run')) summary.dryRun++;
    else summary.skipped++;
  }
  console.log(`[prepare] ${label} result:`, JSON.stringify(summary));
  return { macs, results, summary };
}

async function fetchThemeImageUrl(apiBase, battleId) {
  if (!battleId) return null;
  try {
    const { ok, body } = await apiCall(apiBase, 'GET', `/event-battles/${battleId}/score`);
    if (!ok) return null;
    return body.theme_image_url || null;
  } catch (err) {
    return null;
  }
}

// テーマ画像のURLを決める。戻り値は { url, source }。取得できなければ url=null
// （呼び出し側が警告ログ・デモ状態（themeImageMissing）へ反映する。無言では通過しない）。
//   1) --theme-image-url（明示指定）
//   2) --theme-source-battle-id（明示指定時のみ。従来どおりペアの公開スコアAPI経由）
//   3) 既定：恒久デモの試合のevents.metadata.themeImageUrl（A優先、なければB）。ペアの有無に依存しない
async function resolveThemeImageUrl(args) {
  if (args.themeImageUrl) return { url: args.themeImageUrl, source: '--theme-image-url' };
  if (args.themeSourceBattleId) {
    const url = await fetchThemeImageUrl(args.apiBase, args.themeSourceBattleId);
    return { url, source: `battle ${args.themeSourceBattleId}` };
  }
  try {
    const { ok, body } = await apiCall(args.apiBase, 'GET', '/admin/events');
    if (ok) {
      const byId = new Map((body || []).map((e) => [e.id, e]));
      for (const id of [PERMANENT_DEMO_EVENT_A_ID, PERMANENT_DEMO_EVENT_B_ID]) {
        const ev = byId.get(id);
        const url = ev && ev.metadata && ev.metadata.themeImageUrl;
        if (typeof url === 'string' && url) return { url, source: `permanent demo event ${id.slice(0, 8)}` };
      }
    }
  } catch (err) {
    // 取得できなかったものとして、下の戻り値（url=null）に集約する
  }
  return { url: null, source: 'permanent demo events (not found / no themeImageUrl)' };
}

async function createEvent(apiBase, title, organizationId, yes) {
  if (!yes) return { title, organizationId, applied: false };
  const { ok, body } = await apiCall(apiBase, 'POST', '/admin/events', {
    title,
    organization_id: organizationId,
    starts_at: new Date().toISOString(),
  });
  if (!ok) throw new Error(`failed to create event "${title}": ${JSON.stringify(body)}`);
  return body;
}

async function setEventTheme(apiBase, eventId, themeImageUrl, yes) {
  if (!yes || !themeImageUrl) return;
  const { ok, body } = await apiCall(apiBase, 'PATCH', `/admin/events/${eventId}`, {
    theme_image_url: themeImageUrl,
  });
  if (!ok) throw new Error(`failed to set theme image for event ${eventId}: ${JSON.stringify(body)}`);
}

async function createBattle(apiBase, label, eventAId, eventBId, yes) {
  if (!yes) return { label, eventAId, eventBId, applied: false };
  const { ok, body } = await apiCall(apiBase, 'POST', '/admin/event-battles', {
    label,
    event_a_id: eventAId,
    event_b_id: eventBId,
  });
  if (!ok) throw new Error(`failed to create event battle: ${JSON.stringify(body)}`);
  return body;
}

async function setEventLive(apiBase, eventId, yes) {
  if (!yes) return;
  const { ok, body } = await apiCall(apiBase, 'PATCH', `/admin/events/${eventId}/status`, { status: 'live' });
  if (!ok) throw new Error(`failed to set event ${eventId} live: ${JSON.stringify(body)}`);
}

// --- 通常モード ---------------------------------------------------------------

async function runPrepare(args) {
  console.log(`[prepare] mode=${args.yes ? 'APPLY (--yes)' : 'DRY RUN'} api_base=${args.apiBase}`);

  const category = await findCategory(args.apiBase, args.categoryName);
  console.log(`[prepare] category: ${category.name} (${category.id})`);

  const orgA = await findOrganization(args.apiBase, category.id, args.teamAName);
  const orgB = await findOrganization(args.apiBase, category.id, args.teamBName);
  console.log(`[prepare] team A: ${orgA.name} (${orgA.id})`);
  console.log(`[prepare] team B: ${orgB.name} (${orgB.id})`);

  const otherEvents = await listOtherLiveOrPausedEvents(args.apiBase, orgA.id, orgB.id);
  console.log(`[prepare] existing live/paused events for these teams: ${otherEvents.length}`);
  otherEvents.forEach((e) => console.log(`  - ${e.id} "${e.title}" status=${e.status} org=${e.organization_name}`));
  if (otherEvents.some((e) => e.id === '3d909ed3-3207-4222-a6f9-a6c39980b910')) {
    console.log('[prepare] note: permanent demo battle id listed above by coincidence check skipped (battle id != event id).');
  }

  let pauseResult = [];
  if (args.pauseOtherLive) {
    pauseResult = await pauseLiveEvents(args.apiBase, otherEvents, args.yes);
    pauseResult.forEach((c) =>
      console.log(`[prepare] ${c.applied ? 'paused' : '(dry-run) would pause'}: ${c.id} "${c.title}" (was ${c.previousStatus})`)
    );
  } else {
    const liveOnes = otherEvents.filter((e) => e.status === 'live');
    if (liveOnes.length > 0) {
      console.log(
        `[prepare] warning: ${liveOnes.length} event(s) are live for these organizations and ` +
        '--pause-other-live was not given. Setting the new demo events live may fail with LIVE_EVENT_CONFLICT.'
      );
    }
  }

  console.log(`[prepare] fetching existing devices for prefix "${args.macPrefix}" (bulk, page_size=${DEVICE_LIST_PAGE_SIZE})...`);
  const existingMap = await fetchExistingDevicesByPrefix(args.apiBase, args.macPrefix);
  console.log(`[prepare] found ${existingMap.size} existing device(s) matching prefix "${args.macPrefix}"`);

  const plannedMacsA = Array.from({ length: args.devicesPerTeam }, (_, i) => macForIndex(args.macPrefix, i));
  const plannedMacsB = Array.from({ length: args.devicesPerTeam }, (_, i) => macForIndex(args.macPrefix, args.teamBStartIndex + i));
  let willCreate = 0;
  let willUpdate = 0;
  let willSkip = 0;
  for (const mac of [...plannedMacsA, ...plannedMacsB]) {
    const row = existingMap.get(mac);
    if (!row) willCreate++;
    else if (row.category_id === category.id && row.is_demo === true) willSkip++;
    else willUpdate++;
  }
  // レート制限（500req/15分、src/app.js）の見込み消費数。ここまでの実際の呼び出し回数
  // （pauseの適用分を含む）とこれからの見込みを足し合わせる。
  const pauseCallsSoFar = args.yes ? pauseResult.filter((c) => c.applied).length : 0;
  const fixedCallsSoFar = 1 /* categories */ + 2 /* organizations */ + 1 /* events list */ + pauseCallsSoFar;
  const deviceListPages = Math.max(1, Math.ceil((existingMap.size || 1) / DEVICE_LIST_PAGE_SIZE));
  const remainingFixedCalls = 1 /* theme fetch */ + 2 /* create event A/B */ + 2 /* theme set A/B */ + 1 /* create battle */ + 2 /* set live x2 */;
  const estimatedTotal = fixedCallsSoFar + deviceListPages + willCreate + willUpdate + remainingFixedCalls;
  console.log(
    '[prepare] request estimate for this run: ' +
    `device writes(create=${willCreate}, update=${willUpdate}, skip=${willSkip}), ` +
    `device-list pages=${deviceListPages}, other fixed calls≈${fixedCallsSoFar + remainingFixedCalls}, ` +
    `total≈${estimatedTotal} requests (excludes 429リトライ分)`
  );
  if (estimatedTotal > 500) {
    console.log(
      '[prepare] note: total exceeds the 500req/15min admin API rate limit (src/app.js). ' +
      'This run is expected to hit HTTP 429 at least once; it will wait on Retry-After and resume automatically ' +
      '(see scripts/demo/README.md).'
    );
  }

  const teamAResult = await ensureDevices(
    args.apiBase, args.macPrefix, 0, args.devicesPerTeam, category.id, args.yes, 'team A devices', existingMap
  );
  const teamBResult = await ensureDevices(
    args.apiBase, args.macPrefix, args.teamBStartIndex, args.devicesPerTeam, category.id, args.yes, 'team B devices', existingMap
  );

  const theme = await resolveThemeImageUrl(args);
  const themeImageUrl = theme.url;
  console.log(`[prepare] theme image url: ${themeImageUrl || '(none)'} (source: ${theme.source})`);
  if (!themeImageUrl) {
    console.warn('[prepare] WARNING: テーマ画像を取得できませんでした。画像なしの試合A・Bを作成します（恒久デモの試合のevents.metadata.themeImageUrlを確認してください）');
  }

  const runStamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 13); // YYYYMMDDTHHMM
  const titleA = `デモ対抗戦 ${args.teamAName} vs ${args.teamBName} ${runStamp}`;
  const titleB = `デモ対抗戦 ${args.teamBName} vs ${args.teamAName} ${runStamp}`;

  const eventA = await createEvent(args.apiBase, titleA, orgA.id, args.yes);
  const eventB = await createEvent(args.apiBase, titleB, orgB.id, args.yes);

  if (args.yes) {
    await setEventTheme(args.apiBase, eventA.id, themeImageUrl, args.yes);
    await setEventTheme(args.apiBase, eventB.id, themeImageUrl, args.yes);
    console.log(`[prepare] created event A: ${eventA.id} "${eventA.title}"`);
    console.log(`[prepare] created event B: ${eventB.id} "${eventB.title}"`);
  } else {
    console.log(`[prepare] (dry-run) would create event A "${titleA}" for org ${orgA.id}`);
    console.log(`[prepare] (dry-run) would create event B "${titleB}" for org ${orgB.id}`);
  }

  const battle = await createBattle(
    args.apiBase,
    args.label || `${args.teamAName} vs ${args.teamBName} (${runStamp})`,
    args.yes ? eventA.id : null,
    args.yes ? eventB.id : null,
    args.yes
  );
  if (args.yes) {
    console.log(`[prepare] created event battle: ${battle.id}`);
  } else {
    console.log('[prepare] (dry-run) would create event battle pairing the two events above');
  }

  if (args.yes) {
    await setEventLive(args.apiBase, eventA.id, args.yes);
    await setEventLive(args.apiBase, eventB.id, args.yes);
    console.log('[prepare] both events set to live');
  } else {
    console.log('[prepare] (dry-run) would set both events live');
  }

  console.log('\n=== summary ===============================================');
  console.log(`category_id      : ${category.id}`);
  console.log(`org_a (${args.teamAName})       : ${orgA.id}`);
  console.log(`org_b (${args.teamBName})     : ${orgB.id}`);
  console.log(`devices team A   : ${JSON.stringify(teamAResult.summary)}`);
  console.log(`devices team B   : ${JSON.stringify(teamBResult.summary)}`);
  if (args.yes) {
    console.log(`battle_id        : ${battle.id}`);
    console.log(`screen URL       : https://app.cheerstick.com/battle.html?battle_id=${battle.id}`);
    console.log('\nWebARENA VPS上で実行するコマンド例:');
    console.log(
      `  node scripts/demo/battle-demo.js --battle-id=${battle.id} ` +
      `--org-a=${orgA.id} --org-b=${orgB.id} --devices-per-team=${args.devicesPerTeam} ` +
      `--mac-prefix=${args.macPrefix} --team-b-start-index=${args.teamBStartIndex}`
    );
    console.log('\n後片付け（デモ終了後）:');
    console.log(`  node scripts/demo/battle-demo-prepare.js --finish-run=${battle.id} --yes` +
      (pauseResult.some((c) => c.applied)
        ? ` --restore=${pauseResult.filter((c) => c.applied).map((c) => `${c.id}:live`).join(',')}`
        : ''));
  } else {
    console.log('\ndry runのため battle_id 等は未確定。--yes を付けて再実行してください。');
  }
  console.log('===============================================================\n');

  return { category, orgA, orgB, teamAResult, teamBResult, eventA, eventB, battle, pauseResult, themeImageUrl };
}

// --- 後片付けモード -----------------------------------------------------------

async function runFinish(args) {
  console.log(`[prepare] finish-run mode battle_id=${args.finishRun} (${args.yes ? 'APPLY (--yes)' : 'DRY RUN'})`);

  const { ok, body } = await apiCall(args.apiBase, 'GET', '/admin/event-battles');
  if (!ok) throw new Error(`GET /admin/event-battles failed: ${JSON.stringify(body)}`);
  const battle = (body || []).find((b) => b.id === args.finishRun);
  if (!battle) throw new Error(`event battle ${args.finishRun} not found`);

  console.log(`[prepare] found battle: event_a=${battle.event_a_id} (${battle.event_a_status}) event_b=${battle.event_b_id} (${battle.event_b_status})`);

  for (const [eventId, status, label] of [
    [battle.event_a_id, battle.event_a_status, 'event A'],
    [battle.event_b_id, battle.event_b_status, 'event B'],
  ]) {
    if (status === 'finished') {
      console.log(`[prepare] ${label} already finished, skipping`);
      continue;
    }
    if (!args.yes) {
      console.log(`[prepare] (dry-run) would set ${label} (${eventId}) to finished (currently ${status})`);
      continue;
    }
    const res = await apiCall(args.apiBase, 'PATCH', `/admin/events/${eventId}/status`, { status: 'finished' });
    if (!res.ok) throw new Error(`failed to finish ${label} (${eventId}): ${JSON.stringify(res.body)}`);
    console.log(`[prepare] ${label} (${eventId}) set to finished`);
  }

  console.log('[prepare] note: cheer_logs for this run were not deleted (deferred, per instructions).');

  if (args.restore) {
    const pairs = args.restore.split(',').map((p) => p.trim()).filter(Boolean);
    for (const pair of pairs) {
      const [eventId, status] = pair.split(':');
      if (!eventId || !status) {
        console.log(`[prepare] skipping malformed --restore entry: "${pair}"`);
        continue;
      }
      if (!args.yes) {
        console.log(`[prepare] (dry-run) would restore ${eventId} to status=${status}`);
        continue;
      }
      const res = await apiCall(args.apiBase, 'PATCH', `/admin/events/${eventId}/status`, { status });
      if (!res.ok) {
        console.error(`[prepare] failed to restore ${eventId} to ${status}: ${JSON.stringify(res.body)}`);
        continue;
      }
      console.log(`[prepare] restored ${eventId} to status=${status}`);
    }
  }
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.finishRun) {
    return runFinish(args);
  }
  return runPrepare(args);
}

module.exports = { main, parseArgs, macForIndex };

if (require.main === module) {
  main().catch((err) => {
    console.error('[prepare] failed:', err.message);
    process.exit(1);
  });
}
