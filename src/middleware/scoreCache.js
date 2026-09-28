// src/middleware/scoreCache.js
// スコア・閲覧系API（(b)、docs/proposals/large-event-scaling.md C-2参照）向けの、
// プロセス内・短時間キャッシュ（トラックA、2026-09-28）。
//
// 対象は「応答が全員同じ」ルート（event-battlesスコア・target-scores・
// ranking-snapshots）に限定する。応答をres.jsonの引数から取得してキャッシュし、
// 有効期間内は同じ値を返す。同時に届いた同一キーのリクエストは、1回のDB集計
// （実際にはコントローラの処理そのもの）を共有する（in-flightの共有）。
//
// 依存追加なし（express-rate-limitと同じくプロセス内メモリのみ）。DBスキーマ変更もしない。

'use strict';

// in-flight共有が異常終了（res.jsonが呼ばれないまま接続断）した場合に、
// 待機側を永遠に待たせないための安全弁。SCORE_CACHE_TTL_MSとは独立した固定値。
const IN_FLIGHT_SAFETY_TIMEOUT_MS = 5000;

function createScoreCacheMiddleware(ttlMs) {
  const cache = new Map(); // key -> { expiresAt, status, body }
  const inFlight = new Map(); // key -> Promise<{ status, body }>

  return function scoreCacheMiddleware(req, res, next) {
    if (!ttlMs || ttlMs <= 0) {
      return next();
    }

    const key = req.originalUrl;
    const now = Date.now();

    const cached = cache.get(key);
    if (cached && cached.expiresAt > now) {
      return res.status(cached.status).json(cached.body);
    }

    const pending = inFlight.get(key);
    if (pending) {
      Promise.race([
        pending,
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('score-cache: in-flight timeout')), IN_FLIGHT_SAFETY_TIMEOUT_MS);
        }),
      ])
        .then(({ status, body }) => res.status(status).json(body))
        .catch(() => next()); // 共有先が失敗/タイムアウトした場合は自前で計算し直す
      return;
    }

    let resolvePending;
    const promise = new Promise((resolve) => {
      resolvePending = resolve;
    });
    inFlight.set(key, promise);

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      const status = res.statusCode;
      if (status >= 200 && status < 300) {
        cache.set(key, { expiresAt: Date.now() + ttlMs, status, body });
      }
      // エラー応答（4xx/5xx）はキャッシュしないが、待機中のリクエストへは
      // 同じ結果を返す（重複計算はさせない。指示書2-1(b)の「1回のDB集計を共有」の対象は
      // 成功時のみと限定されていないため、エラー時も共有してよいと判断した）。
      if (inFlight.get(key) === promise) inFlight.delete(key);
      resolvePending({ status, body });
      return originalJson(body);
    };

    res.on('close', () => {
      // res.jsonが呼ばれないまま接続が切れた場合の後始末。
      // 待機側はIN_FLIGHT_SAFETY_TIMEOUT_MSのタイムアウトで自前計算に切り替わるため、
      // ここではエントリを消すだけでよい（誰も解決しない）。
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });

    next();
  };
}

module.exports = { createScoreCacheMiddleware, IN_FLIGHT_SAFETY_TIMEOUT_MS };
