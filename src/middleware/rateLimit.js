// src/middleware/rateLimit.js
// 大規模イベント（8,000〜10,000接続、会場Wi-Fiが1つの公開IPに集約される想定）に向けた
// レート制限の再設計（トラックA、2026-09-28）。
//
// 背景：`docs/proposals/large-event-scaling.md`（コミットc367952）参照。従来の
// 「/api/v1全体を同一IPから15分500回」という単一の制限では、1つのIPに1万人分の
// アクセスが集約される会場Wi-Fi環境で、観客のほとんどが429になってしまう。
//
// 対応：ルートを4系統に分け、それぞれ別のリミッターを適用する。
//   (a) 観客の入口（geturl・reference）：IPごとの上限＋デバイスごとの上限を両方適用
//   (b) スコア・閲覧系（会場スクリーン用の読み取りAPI）：別枠のIP上限＋短時間キャッシュ
//       （キャッシュ本体は src/middleware/scoreCache.js）
//   (c) 管理API：別枠のIP上限（nginxのオフィスIP制限はそのまま。触らない）
//   (d) それ以外の/api/v1と/health：従来どおりの上限（既定値は変更していない）
//
// cluster mode（トラックB）との関係：以下の各リミッターは`express-rate-limit`の既定の
// `MemoryStore`（プロセス内メモリ）を使っている。pm2 cluster modeで複数プロセスに
// なると、プロセスごとに別々にカウントされるため、実質の上限は「値×プロセス数」になる
// （docs/spec.md「大規模イベント対応」節参照）。共有ストア（Redis等）の導入はトラックBの
// 範囲外で、当面はプロセス数に合わせて環境変数の値を調整する運用とする。

'use strict';

const rateLimit = require('express-rate-limit');

// --- 環境変数の読み込み・検証 -------------------------------------------------
// 「数値でない・負の値は、既定値に戻して警告をログに出す」（指示書2-2）。
// 0は有効な値として扱う（SCORE_CACHE_TTL_MSの「0で無効」等のため）。
function parseNonNegativeInt(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.warn(
      `[rate-limit] invalid ${name}="${raw}" (must be a non-negative number); using default ${defaultValue}`
    );
    return defaultValue;
  }
  return Math.floor(n);
}

const config = {
  windowMs: parseNonNegativeInt('RL_WINDOW_MS', 15 * 60 * 1000),
  audienceIpMax: parseNonNegativeInt('RL_AUDIENCE_IP_MAX', 50000),
  deviceMax: parseNonNegativeInt('RL_DEVICE_MAX', 60),
  scoreIpMax: parseNonNegativeInt('RL_SCORE_IP_MAX', 6000),
  adminIpMax: parseNonNegativeInt('RL_ADMIN_IP_MAX', 20000),
  defaultIpMax: parseNonNegativeInt('RL_DEFAULT_IP_MAX', 500),
  scoreCacheTtlMs: parseNonNegativeInt('SCORE_CACHE_TTL_MS', 1000),
};

// 起動時に有効な値を1行でログに出す（秘密情報は含まない、指示書2-2）。
console.log(
  '[rate-limit] config: ' +
  `windowMs=${config.windowMs} audienceIpMax=${config.audienceIpMax} deviceMax=${config.deviceMax} ` +
  `scoreIpMax=${config.scoreIpMax} adminIpMax=${config.adminIpMax} defaultIpMax=${config.defaultIpMax} ` +
  `scoreCacheTtlMs=${config.scoreCacheTtlMs}`
);

// --- デバイスキーの抽出（(a)のデバイスごとの上限用） --------------------------

// MACアドレスを大文字・コロン区切り（XX:XX:XX:XX:XX:XX）へ正規化する。
// 区切り文字の有無・大小文字は問わないが、16進12桁に一致しない場合はnull
// （指示書2-1(a)：「ランダムな文字列を大量に送って、キーを無限に作られないようにする」ため、
// 正規化できないIDはデバイスキー無し＝IP側の上限のみ適用される）。
function normalizeMac(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const hex = raw.replace(/[^0-9a-fA-F]/g, '');
  if (hex.length !== 12) return null;
  return hex.toUpperCase().match(/.{2}/g).join(':');
}

// geturl・reference（idクエリ方式）／reference（token方式、ENABLE_REFERENCE_TOKEN=true時）
// のいずれからもデバイスキーを取り出せるようにする。referenceController.jsの
// resolveDeviceId()と同じ分岐（TOKEN_ENABLEDで判定）を踏襲している。
function extractAudienceDeviceKey(req) {
  const tokenEnabled = process.env.ENABLE_REFERENCE_TOKEN === 'true';

  if (!tokenEnabled && req.query && req.query.id) {
    const mac = normalizeMac(String(req.query.id));
    if (mac) return `mac:${mac}`;
    return null;
  }

  if (tokenEnabled && req.query && req.query.token) {
    try {
      // 遅延require：ENABLE_REFERENCE_TOKEN=false（既定）の環境で
      // REFERENCE_TOKEN_SECRET未設定でもモジュール読み込み時点でエラーにしないため。
      const { verifyReferenceToken } = require('../utils/referenceToken');
      const payload = verifyReferenceToken(String(req.query.token));
      const mac = payload && payload.mac ? normalizeMac(String(payload.mac)) : null;
      if (mac) return `mac:${mac}`;
      if (payload && payload.device_id) return `device:${payload.device_id}`;
    } catch (err) {
      // トークン不正・期限切れ：デバイスキー無し（IP側のみ適用）。401自体は
      // referenceController.js側の通常処理に委ねる（ここでは判定しない）。
      return null;
    }
  }

  // geturlはtoken方式を持たないため、tokenEnabled時でもidクエリを見る
  // （geturlは常にidクエリのみで呼ばれる。webviewController.js参照）。
  if (req.query && req.query.id) {
    const mac = normalizeMac(String(req.query.id));
    if (mac) return `mac:${mac}`;
  }

  return null;
}

// --- 429ログの間引き（指示書2-4：同じリミッターのログは10秒に1回まで） ----------

const LOG_INTERVAL_MS = 10000;
const hitCounts = new Map(); // limiterName -> { count, lastIp, lastDeviceKey }

function recordRateLimitHit(limiterName, ip, deviceKey) {
  const entry = hitCounts.get(limiterName) || { count: 0, lastIp: null, lastDeviceKey: null };
  entry.count += 1;
  entry.lastIp = ip;
  entry.lastDeviceKey = deviceKey;
  hitCounts.set(limiterName, entry);
}

function flushRateLimitLogs() {
  for (const [limiterName, entry] of hitCounts.entries()) {
    if (entry.count > 0) {
      console.warn(
        `[rate-limit] 429 ${limiterName}: ${entry.count} hit(s) in the last ${LOG_INTERVAL_MS / 1000}s ` +
        `(last ip=${entry.lastIp}${entry.lastDeviceKey ? ' device=' + entry.lastDeviceKey : ''})`
      );
    }
  }
  hitCounts.clear();
}

const logFlushTimer = setInterval(flushRateLimitLogs, LOG_INTERVAL_MS);
// テスト・短命プロセス（scripts/等）がこのタイマーのせいで終了しないようにする。
if (typeof logFlushTimer.unref === 'function') logFlushTimer.unref();

// 429応答の形（ボディ・ヘッダー）は現行と同じにする（指示書2-4）。express-rate-limitの
// 既定ハンドラは`res.status(options.statusCode).send(options.message)`を行うだけなので、
// message・statusCodeを独自に指定せず、既定値のままログだけ追加する。
// RateLimit-*ヘッダーはhandlerが呼ばれる前に既にセットされているため、ここでは触らない。
function makeHandler(limiterName, deviceKeyFn) {
  return (req, res, _next, options) => {
    const deviceKey = deviceKeyFn ? deviceKeyFn(req) : null;
    recordRateLimitHit(limiterName, req.ip, deviceKey);
    res.status(options.statusCode).send(options.message);
  };
}

// --- パス判定（app.jsの既定リミッターが(a)〜(c)を二重に数えないためのskip判定） -----

function isAudiencePath(path) {
  return path === '/api/v1/webview/geturl' || path === '/api/v1/webview/reference';
}

function isScorePath(path) {
  return (
    /^\/api\/v1\/event-battles\/[^/]+\/score$/.test(path) ||
    path === '/api/v1/target-scores' ||
    /^\/api\/v1\/events\/[^/]+\/target-scores$/.test(path) ||
    /^\/api\/v1\/events\/[^/]+\/ranking-snapshots\/latest$/.test(path)
  );
}

function isAdminPath(path) {
  return path.startsWith('/api/v1/admin/');
}

// --- リミッター本体 -----------------------------------------------------------

const audienceIpLimiter = rateLimit({
  windowMs: config.windowMs,
  max: config.audienceIpMax,
  standardHeaders: true,
  legacyHeaders: false,
  handler: makeHandler('audience-ip', null),
});

const audienceDeviceLimiter = rateLimit({
  windowMs: config.windowMs,
  max: config.deviceMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => extractAudienceDeviceKey(req) || 'no-device-key',
  // デバイスキーが取れないリクエストは、このリミッター自体をスキップする
  // （IP側のリミッターだけが効く。指示書2-1(a)）。
  skip: (req) => extractAudienceDeviceKey(req) === null,
  handler: makeHandler('audience-device', extractAudienceDeviceKey),
});

const scoreIpLimiter = rateLimit({
  windowMs: config.windowMs,
  max: config.scoreIpMax,
  standardHeaders: true,
  legacyHeaders: false,
  handler: makeHandler('score', null),
});

const adminIpLimiter = rateLimit({
  windowMs: config.windowMs,
  max: config.adminIpMax,
  standardHeaders: true,
  legacyHeaders: false,
  handler: makeHandler('admin', null),
});

const defaultIpLimiter = rateLimit({
  windowMs: config.windowMs,
  max: config.defaultIpMax,
  standardHeaders: true,
  legacyHeaders: false,
  // (a)〜(c)は専用リミッターが別途効くため、既定リミッターの対象から除外する
  // （除外しないと、より厳しい500req/15分が常に先に効いてしまい専用リミッターの
  // 意味が無くなる）。/healthは従来どおり対象のまま（指示書2-1(d)）。
  skip: (req) => isAudiencePath(req.path) || isScorePath(req.path) || isAdminPath(req.path),
  handler: makeHandler('default', null),
});

module.exports = {
  config,
  normalizeMac,
  extractAudienceDeviceKey,
  isAudiencePath,
  isScorePath,
  isAdminPath,
  audienceIpLimiter,
  audienceDeviceLimiter,
  scoreIpLimiter,
  adminIpLimiter,
  defaultIpLimiter,
  flushRateLimitLogs,
  _resetLogStateForTests: () => hitCounts.clear(),
};
