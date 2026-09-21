// scripts/load-test/mac-range.js
// 負荷試験用ダミーMACアドレスの採番ルール。
// seed-dummy-devices.js / load-test.js / cleanup-dummy-devices.js の3スクリプトが
// 同じ採番を参照できるよう、ここに1箇所だけ定義する。
//
// 形式: <prefix>:XX:XX （下位2バイトを連番、0x0000〜0xFFFF = 最大65536本）
// 既定prefix "AA:00:00:00" はローカル管理アドレス（先頭バイト最下位2ビット判定）ではないが、
// 実機のMACアドレス帯とは明確に区別できる採番であればよいため、ダミー・テスト用途と
// 一目で分かる固定prefixとして採用する。

'use strict';

const DEFAULT_MAC_PREFIX = 'AA:00:00:00';
const MAX_INDEX = 0xffff; // prefix以降2バイト分

function macForIndex(prefix, index) {
  if (index < 0 || index > MAX_INDEX) {
    throw new Error(`index must be between 0 and ${MAX_INDEX} (got ${index})`);
  }
  const hex = index.toString(16).toUpperCase().padStart(4, '0');
  return `${prefix}:${hex.slice(0, 2)}:${hex.slice(2, 4)}`;
}

module.exports = { DEFAULT_MAC_PREFIX, MAX_INDEX, macForIndex };
