// src/config/cheerstickDefaults.js
// migrations/002_device_target_and_seed.sql で投入したシードデータのID。
// 複数チーム対応時はこの固定値を「イベントに紐づくtarget一覧」取得ロジックに置き換える。

'use strict';

module.exports = {
  DEFAULT_ORGANIZATION_ID: '00000000-0000-0000-0000-000000000001', // V・ファーレン長崎
  DEFAULT_TARGET_ID: '00000000-0000-0000-0000-000000000101', // ヴィヴィくん（マスコット）
};
