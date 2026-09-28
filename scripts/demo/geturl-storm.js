#!/usr/bin/env node
// scripts/demo/geturl-storm.js
// 大規模イベント対応レート制限再設計（トラックA、cheerstick-track-a-rate-limit-
// 20260928.md 3-2章）の再現用スクリプト。WebARENA VPS等、1つのIPから実行する想定。
//
// 1つのIP（このスクリプトを実行するホストのIP）から、異なるダミーIDでgeturlを
// 大量に呼び、反映（デバイスID単位のキー分離）の前後で挙動を比較できるようにする。
//
// geturl はDBに触れない（webviewController.jsの実装を確認済み。HTMLのmeta refresh
// リダイレクトを返すだけ）。referenceはDBへの読み取りがあるため、既定では呼ばない
// （このスクリプトの対象外。将来必要になれば別オプションとして追加する）。
//
// 使い方:
//   node scripts/demo/geturl-storm.js
//   node scripts/demo/geturl-storm.js --count=200 --duration-sec=20 --concurrency=10 \
//     --url=http://127.0.0.1:3000/api/v1/webview/geturl
//
// Node.js組み込みのfetchのみを使用。新規依存なし。

'use strict';

const { macForIndex } = require('../load-test/mac-range');

function parseArgs(argv) {
  const args = {
    count: 10000,
    durationSec: 300,
    concurrency: 50,
    idPrefix: 'AA:00:00:03',
    url: 'https://api.cheerstick.com/api/v1/webview/geturl',
    repeat: 1,
  };
  for (const raw of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(raw);
    if (!m) continue;
    const [, key, value] = m;
    switch (key) {
      case 'count': args.count = parseInt(value, 10); break;
      case 'duration-sec': args.durationSec = parseFloat(value); break;
      case 'concurrency': args.concurrency = parseInt(value, 10); break;
      case 'id-prefix': args.idPrefix = value; break;
      case 'url': args.url = value; break;
      case 'repeat': args.repeat = parseInt(value, 10); break;
      default:
        throw new Error(`unknown option: --${key}`);
    }
  }
  return args;
}

function buildSchedule(args) {
  // count個の異なるIDそれぞれをrepeat回呼ぶ（再接続の再現）。
  // durationSec全体へ均等に分散させたスケジュール（開始からのオフセットms）を返す。
  const total = args.count * args.repeat;
  const durationMs = args.durationSec * 1000;
  const tasks = [];
  for (let i = 0; i < args.count; i++) {
    const mac = macForIndex(args.idPrefix, i);
    for (let r = 0; r < args.repeat; r++) {
      tasks.push({ mac });
    }
  }
  // タスクをシャッフルせず、生成順（ID0の1回目, ID0の2回目, ..., ID1の1回目, ...）
  // のまま均等オフセットを割り当てる。repeat>1の「再接続の再現」は、同一IDへの
  // 呼び出し同士が時間的に離れる方が実態に近いため、リストをID→repeatの外側ループで
  // 展開したうえで、オフセットはインデックス順に均等割りする（十分にばらける）。
  for (let i = 0; i < tasks.length; i++) {
    tasks[i].offsetMs = Math.floor((i / total) * durationMs);
  }
  return tasks;
}

function percentileSort(values) {
  return [...values].sort((a, b) => a - b);
}

function median(sortedValues) {
  if (sortedValues.length === 0) return 0;
  const mid = Math.floor(sortedValues.length / 2);
  return sortedValues.length % 2 === 0
    ? (sortedValues[mid - 1] + sortedValues[mid]) / 2
    : sortedValues[mid];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tasks = buildSchedule(args);
  const total = tasks.length;

  console.log(
    `[geturl-storm] url=${args.url} count=${args.count} repeat=${args.repeat} ` +
    `total_requests=${total} duration_sec=${args.durationSec} concurrency=${args.concurrency} ` +
    `id_prefix=${args.idPrefix}`
  );

  const startedAt = Date.now();
  let nextIndex = 0;
  let lastRateLimitHeaders = null;

  // 10秒ごとの区間集計
  let windowCounts = { 200: 0, 429: 0, other: 0 };
  let windowTimes = [];
  const REPORT_INTERVAL_MS = 10000;
  let lastReportAt = startedAt;

  // 全体集計
  const totalCounts = { 200: 0, 429: 0, other: 0 };
  const allTimes = [];

  function maybeReport(force) {
    const now = Date.now();
    if (!force && now - lastReportAt < REPORT_INTERVAL_MS) return;
    const sorted = percentileSort(windowTimes);
    const elapsedSec = ((now - startedAt) / 1000).toFixed(1);
    console.log(
      `[geturl-storm] t=${elapsedSec}s 200=${windowCounts[200]} 429=${windowCounts[429]} ` +
      `other=${windowCounts.other} latency_ms(median=${median(sorted).toFixed(1)}, ` +
      `max=${sorted.length ? sorted[sorted.length - 1].toFixed(1) : 0})`
    );
    windowCounts = { 200: 0, 429: 0, other: 0 };
    windowTimes = [];
    lastReportAt = now;
  }

  async function worker() {
    for (;;) {
      const i = nextIndex++;
      if (i >= total) return;
      const task = tasks[i];

      const targetTime = startedAt + task.offsetMs;
      const waitMs = targetTime - Date.now();
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));

      const url = `${args.url}?id=${encodeURIComponent(task.mac)}`;
      const reqStart = Date.now();
      try {
        const res = await fetch(url);
        // レスポンスボディは使わないが、接続を確実に消費してソケットを解放する。
        await res.text().catch(() => {});
        const elapsed = Date.now() - reqStart;

        const bucket = res.status === 200 ? 200 : res.status === 429 ? 429 : 'other';
        windowCounts[bucket] += 1;
        totalCounts[bucket] += 1;
        windowTimes.push(elapsed);
        allTimes.push(elapsed);

        if (res.headers.has('ratelimit-policy') || res.headers.has('ratelimit-limit')) {
          lastRateLimitHeaders = {
            policy: res.headers.get('ratelimit-policy'),
            limit: res.headers.get('ratelimit-limit'),
            remaining: res.headers.get('ratelimit-remaining'),
            reset: res.headers.get('ratelimit-reset'),
          };
        }
      } catch (err) {
        windowCounts.other += 1;
        totalCounts.other += 1;
        console.error(`[geturl-storm] request failed: ${err.message}`);
      }

      maybeReport(false);
    }
  }

  const workers = Array.from({ length: Math.min(args.concurrency, total) }, () => worker());
  await Promise.all(workers);
  maybeReport(true);

  const sortedAll = percentileSort(allTimes);
  console.log('\n=== summary ===============================================');
  console.log(`total: 200=${totalCounts[200]} 429=${totalCounts[429]} other=${totalCounts.other} (of ${total})`);
  console.log(
    `latency_ms: median=${median(sortedAll).toFixed(1)} max=${sortedAll.length ? sortedAll[sortedAll.length - 1].toFixed(1) : 0}`
  );
  if (lastRateLimitHeaders) {
    console.log(
      `last RateLimit-* headers: policy=${lastRateLimitHeaders.policy} limit=${lastRateLimitHeaders.limit} ` +
      `remaining=${lastRateLimitHeaders.remaining} reset=${lastRateLimitHeaders.reset}`
    );
  } else {
    console.log('last RateLimit-* headers: (none observed)');
  }
  console.log('===============================================================');
}

main().catch((err) => {
  console.error('[geturl-storm] failed:', err.stack || err.message);
  process.exit(1);
});
