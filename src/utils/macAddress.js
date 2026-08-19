// src/utils/macAddress.js
// MACアドレス表記の正規化ユーティリティ。
//
// devices.mac_address は "AA:BB:CC:DD:EE:FF" 形式（大文字16進数、コロン区切り、VARCHAR(17)）
// に統一する。既存11件・指示書内の全MAC例（Vanstone様検証機、デモ機DE:AD:BE:EF:00:01）が
// いずれもこの形式であるため、CSV取り込み・単体登録の両方でこの形式へ変換してから保存する。
//
// 2026-08-19、B-5（devices管理機能）実装時に新設。それ以前はensureDevice()等、
// 受け取った値を無変換でINSERTしていた（正規化処理はこれが最初）。

'use strict';

/**
 * 任意の表記のMACアドレス文字列を "AA:BB:CC:DD:EE:FF" 形式へ正規化する。
 * 区切り文字（コロン・ハイフン・無し等）や大文字小文字を問わない。
 * 16進数6バイト（英数字12文字）ちょうどにならない場合はnullを返す
 * （CSVのヘッダー行や不正な行の判別に使う）。
 */
function normalizeMacAddress(raw) {
  if (raw == null) return null;
  const hex = String(raw).trim().toUpperCase().replace(/[^0-9A-F]/g, '');
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g).join(':');
}

module.exports = { normalizeMacAddress };
