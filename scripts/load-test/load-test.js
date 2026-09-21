#!/usr/bin/env node
// scripts/load-test/load-test.js
// CheerStick WebSocketサーバーの負荷試験スクリプト（2,000〜20,000接続規模を想定）。
//
// 「簡略版」の再現度について：
//   事前に seed-dummy-devices.js でDBへ投入済み・category_id設定済みのダミーデバイス
//   （MACアドレスは mac-range.js の採番規則に従う）を使う前提。接続確立後、実際のクライアント
//   （public/index.html）が辿る register → team_selection → player_selection の3画面遷移は
//   スキップし、connect直後に select_team → set_oshi → count の順で送信する。
//   WebSocketサーバー側（src/websocket/index.js）はメッセージ種別ごとに独立したハンドラで、
//   status（connect応答のstatus文字列）による送信可否の制御は行っていないため、
//   このシーケンスはサーバー側の実装を変更せずに成立する（詳細はコードリーディングで確認済み）。
//
// 使い方:
//   node scripts/load-test/load-test.js --connections=100
//   node scripts/load-test/load-test.js --connections=2000 --url=ws://localhost:3000/cheer --duration-ms=120000
//
// 主なオプション（すべて --key=value 形式）:
//   --connections       同時接続数（必須）
//   --url               接続先WebSocket URL（既定: ws://localhost:3000/cheer）
//   --organization-id   select_teamで送るorganization_id（既定: V・ファーレン長崎）
//   --target-id         set_oshiで送るtarget_id（既定: ヴィヴィくん）
//   --mac-prefix        ダミーMACアドレスのprefix（既定: AA:00:00:00、seed側と揃えること）
//   --start-index       採番の開始インデックス（既定: 0、seed側と揃えること）
//   --count-interval-ms countメッセージの平均送信間隔（既定: 5000＝5秒に1回程度）
//   --ramp-up-ms        全接続の開始をこの時間内に分散させる（既定: connections数に応じ自動計算）
//   --report-interval-ms 状況表示の間隔（既定: 10000）
//   --duration-ms       指定した場合、この時間経過後に全接続を閉じて終了する（既定: 無期限）
//   --sent-log-path     指定した場合、countメッセージ送信のたびに{mac, sentAt}を1行1件で
//                        追記する（レイテンシ計測用、measure-latency.js参照）。既定は記録しない

'use strict';

const fs = require('fs');
const WebSocket = require('ws');
const { DEFAULT_MAC_PREFIX, macForIndex } = require('./mac-range');

const DEFAULT_ORGANIZATION_ID = '00000000-0000-0000-0000-000000000001'; // V・ファーレン長崎
const DEFAULT_TARGET_ID = '00000000-0000-0000-0000-000000000101'; // ヴィヴィくん

function parseArgs(argv) {
  const args = {
    connections: null,
    url: 'ws://localhost:3000/cheer',
    organizationId: DEFAULT_ORGANIZATION_ID,
    targetId: DEFAULT_TARGET_ID,
    macPrefix: DEFAULT_MAC_PREFIX,
    startIndex: 0,
    countIntervalMs: 5000,
    rampUpMs: null,
    reportIntervalMs: 10000,
    durationMs: null,
    sentLogPath: null,
  };
  for (const raw of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(raw);
    if (!m) continue;
    const [, key, value] = m;
    switch (key) {
      case 'connections': args.connections = parseInt(value, 10); break;
      case 'url': args.url = value; break;
      case 'organization-id': args.organizationId = value; break;
      case 'target-id': args.targetId = value; break;
      case 'mac-prefix': args.macPrefix = value; break;
      case 'start-index': args.startIndex = parseInt(value, 10); break;
      case 'count-interval-ms': args.countIntervalMs = parseInt(value, 10); break;
      case 'ramp-up-ms': args.rampUpMs = parseInt(value, 10); break;
      case 'report-interval-ms': args.reportIntervalMs = parseInt(value, 10); break;
      case 'duration-ms': args.durationMs = parseInt(value, 10); break;
      case 'sent-log-path': args.sentLogPath = value; break;
      default:
        throw new Error(`unknown option: --${key}`);
    }
  }
  if (!Number.isInteger(args.connections) || args.connections <= 0) {
    throw new Error('--connections is required and must be a positive integer');
  }
  if (args.rampUpMs === null) {
    // 接続を一瞬に集中させないための既定値：5ms/接続、上限60秒。
    args.rampUpMs = Math.min(args.connections * 5, 60000);
  }
  return args;
}

// public/index.html の nextReconnectDelay() と同じ考え方（2s基点、1.5倍ずつ、上限10s、±50%ジッター）。
function nextReconnectDelay(attempt) {
  const base = Math.min(2000 * Math.pow(1.5, attempt), 10000);
  const jitter = base * 0.5 * (Math.random() * 2 - 1);
  return Math.max(1000, Math.round(base + jitter));
}

function formatMb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

class Stats {
  constructor(targetConnections) {
    this.targetConnections = targetConnections;
    this.connectionsOpen = 0;
    this.connectAttempts = 0;
    this.connectSuccess = 0;
    this.connectFailures = 0;
    this.sendSuccess = 0;
    this.sendFailures = 0;
    this.appErrors = 0;
    this._loggedOnce = new Set();
  }

  logOnce(key, message) {
    if (this._loggedOnce.has(key)) return;
    this._loggedOnce.add(key);
    console.error(`[load-test] ${message} (このメッセージは種類ごとに初回のみ表示します)`);
  }

  report() {
    const mem = process.memoryUsage();
    const now = new Date().toISOString();
    console.log(
      `[${now}] open=${this.connectionsOpen}/${this.targetConnections} ` +
      `connect(ok=${this.connectSuccess} ng=${this.connectFailures} attempts=${this.connectAttempts}) ` +
      `send(ok=${this.sendSuccess} ng=${this.sendFailures}) app_errors=${this.appErrors} ` +
      `mem(rss=${formatMb(mem.rss)} heapUsed=${formatMb(mem.heapUsed)})`
    );
  }
}

class VirtualDevice {
  constructor(index, ctx) {
    this.index = index;
    this.ctx = ctx;
    this.mac = macForIndex(ctx.args.macPrefix, ctx.args.startIndex + index);
    this.stage = 'idle'; // idle -> connect_sent -> select_team_sent -> set_oshi_sent -> ready
    this.reconnectAttempts = 0;
    this.ws = null;
    this.countTimer = null;
    this.reconnectTimer = null;
    this.lastCountAt = null;
  }

  start() {
    this.connect();
  }

  connect() {
    if (this.ctx.stopping) return;
    this.ctx.stats.connectAttempts++;

    let ws;
    try {
      ws = new WebSocket(this.ctx.args.url);
    } catch (err) {
      this.ctx.stats.connectFailures++;
      this.ctx.stats.logOnce('construct:' + err.message, `WebSocket construction failed: ${err.message}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.stage = 'connect_sent';
    this._openReported = false;

    ws.on('open', () => {
      this.ctx.stats.connectSuccess++;
      this.ctx.stats.connectionsOpen++;
      this._openReported = true;
      this.reconnectAttempts = 0;
      this.sendJson({ type: 'connect', id: this.mac });
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
        this.ctx.stats.appErrors++;
        this.ctx.stats.logOnce('parse_error', `failed to parse server message as JSON: ${err.message}`);
        return;
      }
      this.handleMessage(msg);
    });

    ws.on('close', (code, reasonBuf) => {
      const reason = reasonBuf ? reasonBuf.toString() : '';
      if (this._openReported) {
        this.ctx.stats.connectionsOpen = Math.max(0, this.ctx.stats.connectionsOpen - 1);
      }
      this.clearCountTimer();
      if (this.ctx.stopping) return;
      this.ctx.stats.logOnce('close:' + code, `connection closed (code=${code} reason=${reason || '(none)'}), will retry`);
      this.stage = 'idle';
      this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      this.ctx.stats.connectFailures++;
      this.ctx.stats.logOnce('socket_error:' + (err.code || err.message), `socket error: ${err.code || err.message}`);
      // 'close' が後続して発火し、再接続はそちらで処理される。
    });
  }

  scheduleReconnect() {
    if (this.ctx.stopping) return;
    const delay = nextReconnectDelay(this.reconnectAttempts);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  handleMessage(msg) {
    if (msg.type === 'error') {
      this.ctx.stats.appErrors++;
      this.ctx.stats.logOnce('app_error:' + msg.message, `server returned error: ${msg.message}`);
      return;
    }
    if (msg.type !== 'connect') return; // count応答等、想定外種別は無視

    switch (this.stage) {
      case 'connect_sent':
        this.stage = 'select_team_sent';
        this.sendJson({ type: 'select_team', id: this.mac, organization_id: this.ctx.args.organizationId });
        break;
      case 'select_team_sent':
        this.stage = 'set_oshi_sent';
        this.sendJson({ type: 'set_oshi', id: this.mac, target_id: this.ctx.args.targetId });
        break;
      case 'set_oshi_sent':
        this.stage = 'ready';
        this.scheduleNextCount(Math.random() * this.ctx.args.countIntervalMs); // 送信タイミングを分散
        break;
      default:
        break; // 'ready'到達後のconnect応答（無いはずだが）は無視
    }
  }

  scheduleNextCount(delay) {
    if (this.ctx.stopping) return;
    this.countTimer = setTimeout(() => this.sendCount(), delay);
  }

  sendCount() {
    if (this.ctx.stopping || this.stage !== 'ready') return;
    const now = Date.now();
    const durationMs = this.lastCountAt ? now - this.lastCountAt : this.ctx.args.countIntervalMs;
    this.lastCountAt = now;

    const value = Math.floor(Math.random() * 101); // 0-100のintensity
    const sent = this.sendJson({ type: 'count', id: this.mac, value, duration_ms: durationMs });
    if (sent && this.ctx.sentLogStream) {
      this.ctx.sentLogStream.write(JSON.stringify({ mac: this.mac, sentAt: now }) + '\n');
    }

    // 平均 countIntervalMs、±25%のジッターを付けて次回送信をスケジュール
    const jitter = this.ctx.args.countIntervalMs * 0.25 * (Math.random() * 2 - 1);
    this.scheduleNextCount(this.ctx.args.countIntervalMs + jitter);
  }

  sendJson(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.ctx.stats.sendFailures++;
      return false;
    }
    try {
      this.ws.send(JSON.stringify(payload));
      this.ctx.stats.sendSuccess++;
      return true;
    } catch (err) {
      this.ctx.stats.sendFailures++;
      this.ctx.stats.logOnce('send_error:' + err.message, `ws.send failed: ${err.message}`);
      return false;
    }
  }

  clearCountTimer() {
    if (this.countTimer) {
      clearTimeout(this.countTimer);
      this.countTimer = null;
    }
  }

  stop() {
    this.clearCountTimer();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close(1000, 'load-test finished');
      } catch (err) {
        // クローズ自体の失敗は無視してよい（プロセス終了間際のため）
      }
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const stats = new Stats(args.connections);
  const ctx = { args, stats, stopping: false, sentLogStream: null };

  if (args.sentLogPath) {
    ctx.sentLogStream = fs.createWriteStream(args.sentLogPath, { flags: 'w' });
    console.log(`[load-test] logging sent count timestamps to ${args.sentLogPath}`);
  }

  console.log(
    `[load-test] starting: connections=${args.connections} url=${args.url} ` +
    `organization_id=${args.organizationId} target_id=${args.targetId} ` +
    `mac_range=${macForIndex(args.macPrefix, args.startIndex)}..${macForIndex(args.macPrefix, args.startIndex + args.connections - 1)} ` +
    `ramp_up_ms=${args.rampUpMs} count_interval_ms=${args.countIntervalMs}`
  );

  const devices = [];
  for (let i = 0; i < args.connections; i++) {
    const device = new VirtualDevice(i, ctx);
    devices.push(device);
    const delay = args.connections > 1 ? (i / (args.connections - 1)) * args.rampUpMs : 0;
    setTimeout(() => device.start(), delay);
  }

  const reportTimer = setInterval(() => stats.report(), args.reportIntervalMs);

  function shutdown(reason) {
    if (ctx.stopping) return;
    ctx.stopping = true;
    console.log(`\n[load-test] shutting down (${reason})...`);
    clearInterval(reportTimer);
    devices.forEach((d) => d.stop());
    stats.report();
    setTimeout(() => {
      if (ctx.sentLogStream) {
        ctx.sentLogStream.end(() => process.exit(0));
      } else {
        process.exit(0);
      }
    }, 500);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  if (args.durationMs) {
    setTimeout(() => shutdown(`duration ${args.durationMs}ms elapsed`), args.durationMs + args.rampUpMs);
  }

  // スクリプト自体のクラッシュ防止（最終防衛線）。個々のエラーは上記の各所で処理済みのはずだが、
  // 万一の見落としでプロセス全体が落ちて負荷試験が中断することだけは避ける。
  process.on('uncaughtException', (err) => {
    stats.logOnce('uncaught:' + err.message, `uncaught exception (ignored to keep the load test running): ${err.stack || err.message}`);
  });
  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    stats.logOnce('unhandled_rejection:' + message, `unhandled rejection (ignored to keep the load test running): ${message}`);
  });
}

main();
