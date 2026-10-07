#!/usr/bin/env node
// scripts/demo/ranking-showcase-prepare.js
// ランキング見せ用：デモ用チーム（カテゴリー「デモ用」の、作成日時が古い2チーム）に、
// 「デモ用ダミー選手」を各10名登録する（2026-10-07）。
//
// 本番EC2上から http://127.0.0.1:3000/api/v1/admin/... の管理APIを呼ぶ方式
// （battle-demo-prepare.js と同じ。nginxのIP制限を経由せず、DBへも直接接続しない）。
//
// 既定は dry run（実行予定の操作一覧を表示するのみ）。--yes を付けたときだけ実際に書き込む。
// 何度実行しても安全（冪等）：同じ名前の選手が既にあれば作成しない。
// デモモード（管理画面の「デモをセット」）は、このスクリプトで作った選手を自動で検出し、
// 推しエントリー付き（ランキング見せ用）で実行する。選手がいなければ従来どおり。
//
// 事前準備：顔写真（assets/images/demo/players/*.svg）を /var/www/cheerstick-app/images/demo/players/ に
// 配置しておくこと（docs/runbook.md「デモ用ダミー選手の画像」参照）。
//
// 使い方:
//   node scripts/demo/ranking-showcase-prepare.js          # dry run
//   node scripts/demo/ranking-showcase-prepare.js --yes    # 実際に登録
//   オプション: --api-base=<url> --image-base=<url> --category-name=<名前>

'use strict';

const { PLAYERS, IMAGE_PATH, PROFILE_PREFIX, PROFILE_TEXT } = require('./showcase-players');

const DEFAULT_API_BASE = 'http://127.0.0.1:3000/api/v1';
const DEFAULT_IMAGE_BASE = `https://app.cheerstick.com${IMAGE_PATH.replace(/\/$/, '')}`;
const DEFAULT_CATEGORY_NAME = 'デモ用';

function parseArgs(argv) {
  const args = { apiBase: DEFAULT_API_BASE, imageBase: DEFAULT_IMAGE_BASE, categoryName: DEFAULT_CATEGORY_NAME, yes: false };
  for (const raw of argv) {
    if (raw === '--yes') { args.yes = true; continue; }
    const m = /^--([^=]+)=(.*)$/.exec(raw);
    if (!m) throw new Error(`unknown argument: ${raw}`);
    const [, key, value] = m;
    switch (key) {
      case 'api-base': args.apiBase = value; break;
      case 'image-base': args.imageBase = value.replace(/\/$/, ''); break;
      case 'category-name': args.categoryName = value; break;
      default: throw new Error(`unknown option: --${key}`);
    }
  }
  return args;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// HTTP 429（レート制限）はRetry-Afterの秒数だけ待って再試行する（件数が20件と少ないため単純な実装）。
async function apiCall(apiBase, method, path, body) {
  for (;;) {
    const res = await fetch(`${apiBase}${path}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
      const wait = (parseInt(res.headers.get('retry-after'), 10) || 60) + 5;
      console.log(`[showcase] HTTP 429 on ${method} ${path}; waiting ${wait}s`);
      await sleep(wait * 1000);
      continue;
    }
    let json = null;
    try { json = await res.json(); } catch (e) { /* ボディ無し */ }
    return { ok: res.ok, status: res.status, body: json };
  }
}

// battle-demo-prepare.js／デモモード（adminDemoController.resolveDemoTeams）と同じ決め方：
// カテゴリー名が一致するものだけを対象にし、その中で作成日時が最も古い2チームをA・Bとする。
async function resolveDemoTeams(args) {
  const cats = await apiCall(args.apiBase, 'GET', '/admin/categories');
  if (!cats.ok) throw new Error(`failed to list categories: HTTP ${cats.status}`);
  const category = (cats.body || []).find((c) => c.name === args.categoryName);
  if (!category) throw new Error(`category "${args.categoryName}" not found (新規作成は行いません)`);

  const orgs = await apiCall(args.apiBase, 'GET', `/admin/organizations?category_id=${encodeURIComponent(category.id)}`);
  if (!orgs.ok) throw new Error(`failed to list organizations: HTTP ${orgs.status}`);
  const sorted = [...(orgs.body || [])].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  if (sorted.length < 2) throw new Error(`category "${args.categoryName}" には2チーム以上の登録が必要です（現在${sorted.length}件）`);
  return { A: sorted[0], B: sorted[1] };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  console.log(`[showcase] mode: ${args.yes ? 'APPLY (--yes)' : 'dry run（--yesで実際に登録）'}`);
  console.log(`[showcase] api: ${args.apiBase}  image-base: ${args.imageBase}`);

  const teams = await resolveDemoTeams(args);
  console.log(`[showcase] team A: ${teams.A.name} (${teams.A.id})`);
  console.log(`[showcase] team B: ${teams.B.name} (${teams.B.id})`);

  const summary = { created: 0, skipped: 0, conflicts: 0, dryRun: 0 };
  for (const team of ['A', 'B']) {
    const org = teams[team];
    const existing = await apiCall(args.apiBase, 'GET', `/admin/targets?organization_id=${encodeURIComponent(org.id)}`);
    if (!existing.ok) throw new Error(`failed to list targets of ${org.name}: HTTP ${existing.status}`);
    const byName = new Map((existing.body || []).map((t) => [t.name, t]));

    for (const p of PLAYERS.filter((x) => x.team === team)) {
      const found = byName.get(p.name);
      if (found) {
        const tagged = typeof found.profile_text === 'string' && found.profile_text.startsWith(PROFILE_PREFIX) &&
          typeof found.image_url === 'string' && found.image_url.includes(IMAGE_PATH);
        if (tagged) {
          console.log(`[showcase] skip (already exists): ${org.name} #${p.number} ${p.name}`);
          summary.skipped++;
        } else {
          // 同名だが、デモ用ダミー選手の目印が無い＝別の選手の可能性。触らない。
          console.log(`[showcase] CONFLICT (same name, not a demo dummy; left untouched): ${org.name} #${p.number} ${p.name} (${found.id})`);
          summary.conflicts++;
        }
        continue;
      }
      const payload = {
        name: p.name,
        organization_id: org.id,
        type: 'player',
        image_url: `${args.imageBase}/${p.file}`,
        number: String(p.number),
        profile_text: PROFILE_TEXT,
        is_active: true,
      };
      if (!args.yes) {
        console.log(`[showcase] (dry-run) would create: ${org.name} #${p.number} ${p.name}  ${payload.image_url}`);
        summary.dryRun++;
        continue;
      }
      const created = await apiCall(args.apiBase, 'POST', '/admin/targets', payload);
      if (!created.ok) throw new Error(`failed to create ${p.name}: HTTP ${created.status} ${JSON.stringify(created.body)}`);
      console.log(`[showcase] created: ${org.name} #${p.number} ${p.name} (${created.body.id})`);
      summary.created++;
    }
  }
  console.log('[showcase] summary:', JSON.stringify(summary));
  return summary;
}

module.exports = { main, parseArgs };

if (require.main === module) {
  main().catch((err) => {
    console.error('[showcase] failed:', err.message);
    process.exit(1);
  });
}
