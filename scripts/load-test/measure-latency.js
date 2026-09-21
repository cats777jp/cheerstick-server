#!/usr/bin/env node
// scripts/load-test/measure-latency.js
// load-test.js --sent-log-path で記録した送信時刻（sentAt）と、cheer_logs.cheered_at
// （cheer_logsのタイムスタンプ列。列名はcreated_atではなくcheered_at。DEFAULT NOW()で
// サーバーのINSERT時刻が入る）を突き合わせ、送信〜DB記録までのレイテンシを算出する。
//
// ペアリング方式：同一デバイス（mac_address）内で、sent-log.jsonlの送信順と
// cheer_logsのcheered_at昇順を、同じ並び順同士で1対1に対応させる（インデックスでzip）。
// サーバーはWebSocketの1メッセージを受信し終えてから次のメッセージを処理するため
// （awaitで直列化）、かつ本ツールは1デバイスあたり数秒に1回しかcountを送らない設計のため、
// 同一デバイス内で送信順とDB書き込み順が入れ替わることは実運用上想定していない。
//
// 前提：--event-id で指定したイベントに紐づくcheer_logsのみを対象にする
// （同じダミーデバイスを複数回の負荷試験で使い回すため、過去の試験のcheer_logsが
// 混入しないよう、試験ごとに新しいevent_idでスコープを区切ること）。
//
// 使い方:
//   node scripts/load-test/measure-latency.js --sent-log-path=sent-log.jsonl --event-id=<uuid>

'use strict';

const fs = require('fs');
const readline = require('readline');
const { createPool } = require('./db');
const { DEFAULT_MAC_PREFIX } = require('./mac-range');

function parseArgs(argv) {
  const args = { sentLogPath: null, eventId: null, macPrefix: DEFAULT_MAC_PREFIX };
  for (const raw of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(raw);
    if (!m) continue;
    const [, key, value] = m;
    if (key === 'sent-log-path') args.sentLogPath = value;
    else if (key === 'event-id') args.eventId = value;
    else if (key === 'mac-prefix') args.macPrefix = value;
    else throw new Error(`unknown option: --${key}`);
  }
  if (!args.sentLogPath) throw new Error('--sent-log-path is required');
  if (!args.eventId) throw new Error('--event-id is required');
  return args;
}

async function readSentLog(path) {
  const byMac = new Map(); // mac -> [sentAt, ...]（ファイル内の出現順＝送信順）
  const rl = readline.createInterface({ input: fs.createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const { mac, sentAt } = JSON.parse(line);
    if (!byMac.has(mac)) byMac.set(mac, []);
    byMac.get(mac).push(sentAt);
  }
  return byMac;
}

function percentileStats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const median = n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const max = sorted[n - 1];
  const min = sorted[0];
  return { mean, median, max, min, n };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  console.log(`[measure-latency] reading sent log: ${args.sentLogPath}`);
  const sentByMac = await readSentLog(args.sentLogPath);
  console.log(`[measure-latency] devices in sent log: ${sentByMac.size}`);

  const pool = createPool();
  try {
    const { rows } = await pool.query(
      `SELECT d.mac_address, cl.cheered_at
       FROM cheer_logs cl
       JOIN devices d ON d.id = cl.device_id
       WHERE cl.event_id = $1 AND d.mac_address LIKE $2
       ORDER BY d.mac_address, cl.cheered_at ASC`,
      [args.eventId, `${args.macPrefix}%`]
    );

    const createdByMac = new Map();
    for (const row of rows) {
      if (!createdByMac.has(row.mac_address)) createdByMac.set(row.mac_address, []);
      createdByMac.get(row.mac_address).push(row.cheered_at.getTime());
    }
    console.log(`[measure-latency] devices with cheer_logs for this event: ${createdByMac.size}`);

    const diffs = [];
    let mismatchedDevices = 0;
    let totalSent = 0;
    let totalMatched = 0;

    for (const [mac, sentTimes] of sentByMac.entries()) {
      totalSent += sentTimes.length;
      const createdTimes = createdByMac.get(mac) || [];
      const pairCount = Math.min(sentTimes.length, createdTimes.length);
      if (createdTimes.length !== sentTimes.length) mismatchedDevices++;
      for (let i = 0; i < pairCount; i++) {
        diffs.push(createdTimes[i] - sentTimes[i]);
      }
      totalMatched += pairCount;
    }

    if (diffs.length === 0) {
      console.log('[measure-latency] no pairs to measure (sent log and cheer_logs did not match on any device).');
      return;
    }

    const stats = percentileStats(diffs);
    console.log('--- latency summary (cheered_at - sentAt, ms) ---');
    console.log(`pairs matched   : ${stats.n} / ${totalSent} sent (${mismatchedDevices} device(s) had a count mismatch)`);
    console.log(`mean            : ${stats.mean.toFixed(1)} ms`);
    console.log(`median          : ${stats.median.toFixed(1)} ms`);
    console.log(`max             : ${stats.max} ms`);
    console.log(`min             : ${stats.min} ms`);
  } finally {
    await pool.end();
  }
}

module.exports = { main, parseArgs, percentileStats };

if (require.main === module) {
  main().catch((err) => {
    console.error('[measure-latency] failed:', err.message);
    process.exit(1);
  });
}
