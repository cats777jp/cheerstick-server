#!/usr/bin/env node
// scripts/demo/battle-demo.js
// 応援合戦デモ Phase 1：デモ本体スクリプト（WebARENA VPS等、負荷試験対象の外部環境で実行する）。
//
// scripts/load-test/load-test.js の構造（VirtualDevice、分散開始、指数バックオフ再接続、
// Stats、logOnce、uncaughtException対策）を土台とし、以下を追加している。
//   - connect -> select_team -> [set_oshi（--set-oshi指定時のみ）] -> count の送信シーケンス
//     （register は送らない。デバイスはPhase 2の準備スクリプトで事前登録済みの前提）
//   - 「目標比率追従方式」の拮抗演出ロジック（cheerstick-battle-demo-phase1-2-impl-20260927.md
//     2-3節、KMT様承認済み）
//   - 緊急停止（同2-5節）
//   - 負荷試験としてのメトリクス記録（同2-4節）
//
// 使い方:
//   node scripts/demo/battle-demo.js --battle-id=<uuid> --org-a=<uuid> --org-b=<uuid>
//   node scripts/demo/battle-demo.js --battle-id=... --org-a=... --org-b=... \
//     --devices-per-team=50 --duration-ms=90000 --count-interval-ms=1000 --finish=A
//
// 詳細は scripts/demo/README.md 参照。

'use strict';

const fs = require('fs');
const WebSocket = require('ws');
const { macForIndex } = require('../load-test/mac-range');

// --- 拮抗演出ロジックの定数（ファイル先頭にまとめる。調整しやすくするため） -------------
const RATIO_MIN = 0.45;
const RATIO_MAX = 0.55;
const RATIO_CHANGE_INTERVAL_MIN_MS = 20000;
const RATIO_CHANGE_INTERVAL_MAX_MS = 40000;
const OPPOSITE_SIDE_BIAS = 0.7; // 前回と反対側を選ぶ確率
const DEADZONE_E = 0.005; // |e| がこれ未満なら両チーム自然な揺らぎ
const K_DENOMINATOR = 0.05;
const BASE_LOW = 30;
const BASE_HIGH = 70;
const BOOST_LOW_SLOPE = 20; // 遅れている側: low = 30 + 20k
const BOOST_HIGH_SLOPE = 30; // 遅れている側: high = 70 + 30k
const SUPPRESS_LOW_SLOPE = 29; // 進みすぎている側: low = 30 - 29k
const SUPPRESS_HIGH_SLOPE = 30; // 進みすぎている側: high = 70 - 30k
const FINISH_WINDOW_MS = 30000; // 終盤演出の残り時間
const FINISH_CLOSE_MIN = 0.49;
const FINISH_CLOSE_MAX = 0.51;
const FINISH_WIN_RATIO = 0.53;
const SCORE_POLL_INTERVAL_MS = 3000;
const MIN_INTENSITY = 1;
const MAX_INTENSITY = 100;

// --- 緊急停止の定数 ---------------------------------------------------------
const CONNECTION_LOW_CONSECUTIVE_INTERVALS = 2; // 目標の95%を下回る状態が何区間連続したら停止するか
const CONNECTION_LOW_RATIO = 0.95;

function parseArgs(argv) {
  const args = {
    battleId: null,
    orgA: null,
    orgB: null,
    devicesPerTeam: 500,
    durationMs: 180000,
    countIntervalMs: 5000,
    rampUpMs: null,
    finish: 'close',
    url: 'wss://ws.cheerstick.com/cheer',
    scoreUrl: null,
    macPrefix: 'AA:00:00:02',
    teamBStartIndex: 0x8000,
    setOshiTargetId: null,
    reportIntervalMs: 10000,
    metricsLogPath: null,
    sentLogPath: null,
    stopThreshold: 0.05,
  };
  for (const raw of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(raw);
    if (!m) continue;
    const [, key, value] = m;
    switch (key) {
      case 'battle-id': args.battleId = value; break;
      case 'org-a': args.orgA = value; break;
      case 'org-b': args.orgB = value; break;
      case 'devices-per-team': args.devicesPerTeam = parseInt(value, 10); break;
      case 'duration-ms': args.durationMs = parseInt(value, 10); break;
      case 'count-interval-ms': args.countIntervalMs = parseInt(value, 10); break;
      case 'ramp-up-ms': args.rampUpMs = parseInt(value, 10); break;
      case 'finish':
        if (!['close', 'A', 'B', 'none'].includes(value)) {
          throw new Error(`--finish must be one of close/A/B/none (got ${value})`);
        }
        args.finish = value;
        break;
      case 'url': args.url = value; break;
      case 'score-url': args.scoreUrl = value; break;
      case 'mac-prefix': args.macPrefix = value; break;
      case 'team-b-start-index': args.teamBStartIndex = parseInt(value, 10); break;
      case 'set-oshi': args.setOshiTargetId = value; break;
      case 'report-interval-ms': args.reportIntervalMs = parseInt(value, 10); break;
      case 'metrics-log-path': args.metricsLogPath = value; break;
      case 'sent-log-path': args.sentLogPath = value; break;
      case 'stop-threshold': args.stopThreshold = parseFloat(value); break;
      default:
        throw new Error(`unknown option: --${key}`);
    }
  }

  if (!args.battleId) throw new Error('--battle-id is required');
  if (!args.orgA) throw new Error('--org-a is required');
  if (!args.orgB) throw new Error('--org-b is required');
  if (!Number.isInteger(args.devicesPerTeam) || args.devicesPerTeam <= 0) {
    throw new Error('--devices-per-team must be a positive integer');
  }
  if (!args.scoreUrl) {
    args.scoreUrl = `https://api.cheerstick.com/api/v1/event-battles/${args.battleId}/score`;
  }
  if (args.rampUpMs === null) {
    const totalConnections = args.devicesPerTeam * 2;
    args.rampUpMs = Math.min(totalConnections * 5, 60000);
  }
  if (!args.metricsLogPath) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    args.metricsLogPath = `./battle-demo-${ts}.jsonl`;
  }
  return args;
}

function nextReconnectDelay(attempt) {
  const base = Math.min(2000 * Math.pow(1.5, attempt), 10000);
  const jitter = base * 0.5 * (Math.random() * 2 - 1);
  return Math.max(1000, Math.round(base + jitter));
}

function formatMb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function randIntInRange(low, high) {
  const lo = Math.max(MIN_INTENSITY, Math.round(low));
  const hi = Math.min(MAX_INTENSITY, Math.round(high));
  if (hi <= lo) return Math.min(Math.max(lo, MIN_INTENSITY), MAX_INTENSITY);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

// --- 拮抗演出ロジック本体 -----------------------------------------------------
class BattleRatio {
  constructor(ctx) {
    this.ctx = ctx;
    this.targetRatioA = 0.5; // チームAの目標比率
    this.actualRatioA = 0.5;
    this.usingFallback = false;
    this.lastScoreResponseTimeMs = null;
    this.scoreA = 0;
    this.scoreB = 0;
    this.inFinishWindow = false;
    this._scheduleNextTargetChange();
  }

  _scheduleNextTargetChange() {
    const delay = RATIO_CHANGE_INTERVAL_MIN_MS +
      Math.random() * (RATIO_CHANGE_INTERVAL_MAX_MS - RATIO_CHANGE_INTERVAL_MIN_MS);
    this.targetChangeTimer = setTimeout(() => {
      if (this.ctx.stopping) return;
      if (!this.inFinishWindow) this._rerollTarget();
      this._scheduleNextTargetChange();
    }, delay);
  }

  _rerollTarget() {
    const currentlyAbove = this.targetRatioA >= 0.5;
    const goOpposite = Math.random() < OPPOSITE_SIDE_BIAS;
    const wantAbove = goOpposite ? !currentlyAbove : currentlyAbove;
    const half = (RATIO_MAX - RATIO_MIN) / 2;
    const mid = (RATIO_MIN + RATIO_MAX) / 2;
    this.targetRatioA = wantAbove
      ? mid + Math.random() * half
      : mid - Math.random() * half;
  }

  enterFinishWindowIfDue(msRemaining) {
    if (msRemaining > FINISH_WINDOW_MS) return;
    if (this.inFinishWindow) return;
    this.inFinishWindow = true;
    if (this.targetChangeTimer) clearTimeout(this.targetChangeTimer);
    this._applyFinishTarget();
  }

  _applyFinishTarget() {
    if (this.ctx.args.finish === 'close') {
      this.targetRatioA = FINISH_CLOSE_MIN + Math.random() * (FINISH_CLOSE_MAX - FINISH_CLOSE_MIN);
    } else if (this.ctx.args.finish === 'A') {
      this.targetRatioA = FINISH_WIN_RATIO;
    } else if (this.ctx.args.finish === 'B') {
      this.targetRatioA = 1 - FINISH_WIN_RATIO;
    }
    // 'none' の場合は通常ロジックのまま何もしない。
  }

  async pollActualRatio() {
    const startedAt = Date.now();
    try {
      const res = await fetch(this.ctx.args.scoreUrl);
      const responseTimeMs = Date.now() - startedAt;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const a = body.team_a && typeof body.team_a.total_intensity === 'number' ? body.team_a.total_intensity : 0;
      const b = body.team_b && typeof body.team_b.total_intensity === 'number' ? body.team_b.total_intensity : 0;
      this.scoreA = a;
      this.scoreB = b;
      this.actualRatioA = a + b > 0 ? a / (a + b) : 0.5;
      this.usingFallback = false;
      this.lastScoreResponseTimeMs = responseTimeMs;
    } catch (err) {
      this.usingFallback = true;
      this.lastScoreResponseTimeMs = null;
      const totalLocal = this.ctx.stats.localSentTotalA + this.ctx.stats.localSentTotalB;
      this.actualRatioA = totalLocal > 0
        ? this.ctx.stats.localSentTotalA / totalLocal
        : 0.5;
      this.scoreA = this.ctx.stats.localSentTotalA;
      this.scoreB = this.ctx.stats.localSentTotalB;
      this.ctx.stats.logOnce('score_poll_error:' + err.message, `score API poll failed, using local fallback: ${err.message}`);
    }
  }

  // team: 'A' | 'B'。その時点の目標・実績の差から送信するintensityの範囲を返す。
  getRange(team) {
    const e = this.targetRatioA - this.actualRatioA; // A基準の誤差
    const k = Math.min(Math.abs(e) / K_DENOMINATOR, 1);

    if (Math.abs(e) < DEADZONE_E) {
      return [BASE_LOW, BASE_HIGH];
    }

    // e > 0: Aが目標より低い（Aが遅れている）→ Aを後押し、Bを抑制
    // e < 0: Bが遅れている → Bを後押し、Aを抑制
    const aIsBehind = e > 0;
    const isBoosted = (team === 'A' && aIsBehind) || (team === 'B' && !aIsBehind);

    if (isBoosted) {
      return [BASE_LOW + BOOST_LOW_SLOPE * k, BASE_HIGH + BOOST_HIGH_SLOPE * k];
    }
    return [BASE_LOW - SUPPRESS_LOW_SLOPE * k, BASE_HIGH - SUPPRESS_HIGH_SLOPE * k];
  }

  stop() {
    if (this.targetChangeTimer) clearTimeout(this.targetChangeTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
  }
}

class Stats {
  constructor(targetPerTeam) {
    this.targetPerTeam = targetPerTeam;
    this.targetTotal = targetPerTeam * 2;
    this.connectionsOpenA = 0;
    this.connectionsOpenB = 0;
    this.connectAttempts = 0;
    this.connectSuccess = 0;
    this.connectFailures = 0;
    this.sendSuccess = 0;
    this.sendFailures = 0;
    this.appErrors = 0;
    this.unexpectedDisconnects = 0;
    this.code4000Disconnects = 0;
    this.localSentTotalA = 0;
    this.localSentTotalB = 0;
    this._loggedOnce = new Set();
    this._resetInterval();
  }

  _resetInterval() {
    this.iv = {
      sendSuccess: 0,
      sendFailures: 0,
      serverErrors: {}, // message -> count
      unexpectedDisconnects: 0,
      code4000Disconnects: 0,
    };
  }

  recordServerError(message) {
    this.appErrors++;
    const key = String(message || 'unknown');
    this.iv.serverErrors[key] = (this.iv.serverErrors[key] || 0) + 1;
  }

  logOnce(key, message) {
    if (this._loggedOnce.has(key)) return;
    this._loggedOnce.add(key);
    console.error(`[battle-demo] ${message} (このメッセージは種類ごとに初回のみ表示します)`);
  }

  get connectionsOpenTotal() {
    return this.connectionsOpenA + this.connectionsOpenB;
  }
}

class VirtualDevice {
  constructor(index, team, ctx) {
    this.index = index;
    this.team = team; // 'A' | 'B'
    this.ctx = ctx;
    const baseIndex = team === 'A' ? index : ctx.args.teamBStartIndex + index;
    this.mac = macForIndex(ctx.args.macPrefix, baseIndex);
    this.organizationId = team === 'A' ? ctx.args.orgA : ctx.args.orgB;
    this.stage = 'idle';
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
      if (this.team === 'A') this.ctx.stats.connectionsOpenA++;
      else this.ctx.stats.connectionsOpenB++;
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

    ws.on('close', (code) => {
      if (this._openReported) {
        if (this.team === 'A') this.ctx.stats.connectionsOpenA = Math.max(0, this.ctx.stats.connectionsOpenA - 1);
        else this.ctx.stats.connectionsOpenB = Math.max(0, this.ctx.stats.connectionsOpenB - 1);
      }
      this.clearCountTimer();
      if (this.ctx.stopping) return;
      if (code === 4000) {
        this.ctx.stats.code4000Disconnects++;
        this.ctx.stats.iv.code4000Disconnects++;
      } else {
        this.ctx.stats.unexpectedDisconnects++;
        this.ctx.stats.iv.unexpectedDisconnects++;
      }
      this.stage = 'idle';
      this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      this.ctx.stats.connectFailures++;
      this.ctx.stats.logOnce('socket_error:' + (err.code || err.message), `socket error: ${err.code || err.message}`);
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
      this.ctx.stats.recordServerError(msg.message);
      this.ctx.stats.logOnce('app_error:' + msg.message, `server returned error: ${msg.message}`);
      return;
    }
    if (msg.type !== 'connect') return;

    switch (this.stage) {
      case 'connect_sent':
        this.stage = 'select_team_sent';
        this.sendJson({ type: 'select_team', id: this.mac, organization_id: this.organizationId });
        break;
      case 'select_team_sent':
        if (this.ctx.args.setOshiTargetId) {
          this.stage = 'set_oshi_sent';
          this.sendJson({ type: 'set_oshi', id: this.mac, target_id: this.ctx.args.setOshiTargetId });
        } else {
          this.stage = 'ready';
          this.scheduleNextCount(Math.random() * this.ctx.args.countIntervalMs);
        }
        break;
      case 'set_oshi_sent':
        this.stage = 'ready';
        this.scheduleNextCount(Math.random() * this.ctx.args.countIntervalMs);
        break;
      default:
        break;
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

    const [low, high] = this.ctx.battle.getRange(this.team);
    const value = randIntInRange(low, high);

    const sent = this.sendJson({ type: 'count', id: this.mac, value, duration_ms: durationMs });
    if (sent) {
      if (this.team === 'A') this.ctx.stats.localSentTotalA += value;
      else this.ctx.stats.localSentTotalB += value;
      if (this.ctx.sentLogStream) {
        this.ctx.sentLogStream.write(JSON.stringify({ mac: this.mac, team: this.team, sentAt: now, value }) + '\n');
      }
    }

    const jitter = this.ctx.args.countIntervalMs * 0.25 * (Math.random() * 2 - 1);
    this.scheduleNextCount(this.ctx.args.countIntervalMs + jitter);
  }

  sendJson(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.ctx.stats.sendFailures++;
      this.ctx.stats.iv.sendFailures++;
      return false;
    }
    try {
      this.ws.send(JSON.stringify(payload));
      this.ctx.stats.sendSuccess++;
      this.ctx.stats.iv.sendSuccess++;
      return true;
    } catch (err) {
      this.ctx.stats.sendFailures++;
      this.ctx.stats.iv.sendFailures++;
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
        this.ws.close(1000, 'battle-demo finished');
      } catch (err) {
        // 終了間際の失敗は無視してよい
      }
    }
  }
}

async function validateOrganizations(args) {
  const res = await fetch(args.scoreUrl);
  if (!res.ok) {
    throw new Error(`score API returned HTTP ${res.status} for pre-flight check (${args.scoreUrl})`);
  }
  const body = await res.json();
  const orgAId = body.team_a && body.team_a.organization && body.team_a.organization.id;
  const orgBId = body.team_b && body.team_b.organization && body.team_b.organization.id;
  if (orgAId !== args.orgA || orgBId !== args.orgB) {
    throw new Error(
      'organization mismatch between --org-a/--org-b and the score API response. ' +
      `expected org-a=${args.orgA} org-b=${args.orgB}, ` +
      `got team_a.organization.id=${orgAId} team_b.organization.id=${orgBId}. ` +
      '対抗戦ペアと --org-a/--org-b の対応を確認してください。'
    );
  }
  return body;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[battle-demo] argument error: ${err.message}`);
    process.exit(1);
  }

  const stats = new Stats(args.devicesPerTeam);
  const ctx = { args, stats, stopping: false, sentLogStream: null };

  if (args.sentLogPath) {
    ctx.sentLogStream = fs.createWriteStream(args.sentLogPath, { flags: 'w' });
  }
  const metricsStream = fs.createWriteStream(args.metricsLogPath, { flags: 'w' });
  console.log(`[battle-demo] metrics log: ${args.metricsLogPath}`);

  validateOrganizations(args)
    .then((scoreBody) => {
      console.log(
        `[battle-demo] pre-flight OK: team_a=${scoreBody.team_a.organization.name} ` +
        `team_b=${scoreBody.team_b.organization.name}`
      );
      startRun();
    })
    .catch((err) => {
      console.error(`[battle-demo] pre-flight check failed, aborting without connecting: ${err.message}`);
      process.exit(1);
    });

  function startRun() {
    ctx.battle = new BattleRatio(ctx);
    ctx.battle.pollActualRatio();
    ctx.battle.pollTimer = setInterval(() => ctx.battle.pollActualRatio(), SCORE_POLL_INTERVAL_MS);

    console.log(
      `[battle-demo] starting: devices_per_team=${args.devicesPerTeam} url=${args.url} ` +
      `duration_ms=${args.durationMs} ramp_up_ms=${args.rampUpMs} finish=${args.finish} ` +
      `mac_a=${macForIndex(args.macPrefix, 0)}.. mac_b=${macForIndex(args.macPrefix, args.teamBStartIndex)}..`
    );

    const devices = [];
    const total = args.devicesPerTeam * 2;
    for (let i = 0; i < args.devicesPerTeam; i++) {
      devices.push(new VirtualDevice(i, 'A', ctx));
      devices.push(new VirtualDevice(i, 'B', ctx));
    }
    devices.forEach((device, idx) => {
      const delay = total > 1 ? (idx / (total - 1)) * args.rampUpMs : 0;
      setTimeout(() => device.start(), delay);
    });

    const startedAt = Date.now();
    const rampUpCompleteAt = startedAt + args.rampUpMs;
    const finishDeadlineAt = rampUpCompleteAt + args.durationMs; // 「ramp-up後からの計測」

    let consecutiveLowConnections = 0;
    let maxConnections = 0;
    let minConnectionsAfterRampUp = Infinity;

    const reportTimer = setInterval(() => {
      const now = Date.now();
      const elapsedSec = Math.round((now - startedAt) / 1000);
      const rampedUp = now >= rampUpCompleteAt;

      if (rampedUp) {
        ctx.battle.enterFinishWindowIfDue(finishDeadlineAt - now);
      }

      const mem = process.memoryUsage();
      const record = {
        time: new Date(now).toISOString(),
        elapsed_sec: elapsedSec,
        connections: {
          a: stats.connectionsOpenA,
          b: stats.connectionsOpenB,
          total: stats.connectionsOpenTotal,
        },
        connect_cumulative: {
          attempts: stats.connectAttempts,
          success: stats.connectSuccess,
          failures: stats.connectFailures,
        },
        unexpected_disconnects: {
          cumulative: stats.unexpectedDisconnects,
          interval: stats.iv.unexpectedDisconnects,
        },
        code4000_disconnects: {
          cumulative: stats.code4000Disconnects,
          interval: stats.iv.code4000Disconnects,
        },
        send: {
          success_cumulative: stats.sendSuccess,
          failures_cumulative: stats.sendFailures,
          success_interval: stats.iv.sendSuccess,
          failures_interval: stats.iv.sendFailures,
        },
        server_errors_interval: stats.iv.serverErrors,
        score: {
          a: ctx.battle.scoreA,
          b: ctx.battle.scoreB,
          actual_ratio_a: Number(ctx.battle.actualRatioA.toFixed(4)),
          target_ratio_a: Number(ctx.battle.targetRatioA.toFixed(4)),
          source: ctx.battle.usingFallback ? 'fallback' : 'api',
          response_time_ms: ctx.battle.lastScoreResponseTimeMs,
        },
        memory: { rss_mb: Number((mem.rss / 1024 / 1024).toFixed(1)), heap_used_mb: Number((mem.heapUsed / 1024 / 1024).toFixed(1)) },
      };
      metricsStream.write(JSON.stringify(record) + '\n');
      console.log(
        `[${record.time}] t=${elapsedSec}s open=${record.connections.total}/${total} ` +
        `(A=${record.connections.a} B=${record.connections.b}) ` +
        `score(A=${record.score.a} B=${record.score.b} actual=${record.score.actual_ratio_a} target=${record.score.target_ratio_a} src=${record.score.source}) ` +
        `send(ok_iv=${record.send.success_interval} ng_iv=${record.send.failures_interval}) ` +
        `disconnects(unexpected_iv=${record.unexpected_disconnects.interval} code4000_iv=${record.code4000_disconnects.interval})`
      );

      maxConnections = Math.max(maxConnections, stats.connectionsOpenTotal);
      if (rampedUp) {
        minConnectionsAfterRampUp = Math.min(minConnectionsAfterRampUp, stats.connectionsOpenTotal);

        // --- 緊急停止判定（rampedUp後のみ） ---
        if (stats.connectionsOpenTotal < CONNECTION_LOW_RATIO * total) {
          consecutiveLowConnections++;
        } else {
          consecutiveLowConnections = 0;
        }
        const intervalAttempts = stats.iv.sendSuccess + stats.iv.sendFailures;
        const intervalServerErrors = Object.values(stats.iv.serverErrors).reduce((a, b) => a + b, 0);
        const failureRate = intervalAttempts > 0
          ? (stats.iv.sendFailures + intervalServerErrors) / intervalAttempts
          : 0;

        if (consecutiveLowConnections >= CONNECTION_LOW_CONSECUTIVE_INTERVALS) {
          emergencyStop(
            `connections dropped below ${Math.round(CONNECTION_LOW_RATIO * 100)}% of target ` +
            `for ${consecutiveLowConnections} consecutive intervals (open=${stats.connectionsOpenTotal}/${total})`
          );
          return;
        }
        if (failureRate > args.stopThreshold) {
          emergencyStop(
            `send/server-error rate ${(failureRate * 100).toFixed(1)}% exceeded threshold ` +
            `${(args.stopThreshold * 100).toFixed(1)}% in this interval`
          );
          return;
        }
      }

      stats._resetInterval();

      if (now >= finishDeadlineAt) {
        shutdown('duration elapsed', 0);
      }
    }, args.reportIntervalMs);

    function emergencyStop(reason) {
      console.error(`[battle-demo] EMERGENCY STOP: ${reason}`);
      metricsStream.write(JSON.stringify({ time: new Date().toISOString(), emergency_stop: reason }) + '\n');
      shutdown(`emergency stop: ${reason}`, 1);
    }

    function shutdown(reason, exitCode) {
      if (ctx.stopping) return;
      ctx.stopping = true;
      console.log(`\n[battle-demo] shutting down (${reason})...`);
      clearInterval(reportTimer);
      ctx.battle.stop();
      devices.forEach((d) => d.stop());

      const summary = {
        reason,
        total_send_success: stats.sendSuccess,
        total_send_failures: stats.sendFailures,
        total_server_errors: stats.appErrors,
        max_connections: maxConnections,
        min_connections_after_ramp_up: minConnectionsAfterRampUp === Infinity ? null : minConnectionsAfterRampUp,
        final_score: { a: ctx.battle.scoreA, b: ctx.battle.scoreB },
      };
      console.log('[battle-demo] summary:', JSON.stringify(summary));
      metricsStream.write(JSON.stringify({ time: new Date().toISOString(), summary }) + '\n');

      setTimeout(() => {
        metricsStream.end(() => {
          if (ctx.sentLogStream) {
            ctx.sentLogStream.end(() => process.exit(exitCode));
          } else {
            process.exit(exitCode);
          }
        });
      }, 500);
    }

    process.on('SIGINT', () => shutdown('SIGINT', 0));
    process.on('SIGTERM', () => shutdown('SIGTERM', 0));

    process.on('uncaughtException', (err) => {
      stats.logOnce('uncaught:' + err.message, `uncaught exception (ignored to keep the demo running): ${err.stack || err.message}`);
    });
    process.on('unhandledRejection', (reason) => {
      const message = reason instanceof Error ? reason.message : String(reason);
      stats.logOnce('unhandled_rejection:' + message, `unhandled rejection (ignored to keep the demo running): ${message}`);
    });
  }
}

main();
