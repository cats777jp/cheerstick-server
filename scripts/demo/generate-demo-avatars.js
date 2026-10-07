#!/usr/bin/env node
// scripts/demo/generate-demo-avatars.js
// ランキング見せ用の「デモ用ダミー選手」の顔写真（自前のSVGイラスト）を生成する（2026-10-07）。
//
// 実在の人物の写真は使わない。外部サービス（DiceBear等）にも依存しない（会場の回線・サービス停止の
// 影響を受けず、権利の問題も無い）。チームカラーのユニフォームに背番号を入れた、頭と肩のイラストを
// 肌の色・髪型・髪の色を変えて20枚（A10名＋B10名）作る。同じ入力から必ず同じ画像ができる。
//
// 出力先：assets/images/demo/players/（画像の正本。git管理、デプロイ時に
// /var/www/cheerstick-app/images/demo/players/ へコピー。docs/runbook.md参照）。
//
// 使い方: node scripts/demo/generate-demo-avatars.js

'use strict';

const fs = require('fs');
const path = require('path');
const { PLAYERS, TEAM_COLORS } = require('./showcase-players');

const OUT_DIR = path.join(__dirname, '../../assets/images/demo/players');

const SKIN = ['#f5cfa0', '#e8b98a', '#d9a066', '#c68642', '#8d5524'];
const HAIR_COLORS = ['#2b1b12', '#5a3825', '#8b5a2b', '#1a1a1a', '#c9a227', '#3b2f6b'];
// 髪型4種（頭の上半分にかぶせる形）
const HAIR_PATHS = [
  'M80 104 C78 62 104 50 128 50 C152 50 178 62 176 104 C166 84 150 76 128 76 C106 76 90 84 80 104 Z', // 短髪
  'M80 108 C74 60 112 44 140 50 C168 56 182 78 176 108 C170 90 156 80 132 78 C112 90 96 92 80 108 Z', // 流し前髪
  'M78 100 L84 56 L102 78 L114 44 L128 74 L142 44 L154 78 L172 56 L178 100 C164 82 148 76 128 76 C108 76 92 82 78 100 Z', // ツンツン
  'M76 126 C66 62 100 44 128 44 C156 44 190 62 180 126 L172 126 C172 92 156 76 128 76 C100 76 84 92 84 126 Z', // ボブ
];

// '#rrggbb' を白と混ぜて明るくする（背景用）。ratio=白の割合
function tint(hex, ratio) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c) => Math.round(c + (255 - c) * ratio);
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function darken(hex, ratio) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c) => Math.round(c * (1 - ratio));
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function buildSvg(player) {
  const jersey = TEAM_COLORS[player.team];
  const skin = SKIN[(player.index * 3 + 1) % SKIN.length];
  const hairColor = HAIR_COLORS[(player.index * 5 + 2) % HAIR_COLORS.length];
  const hairPath = HAIR_PATHS[player.index % HAIR_PATHS.length];
  const bg = tint(jersey, 0.78);
  const neck = darken(skin, 0.1);
  const numberText = String(player.number);
  const fontSize = numberText.length > 1 ? 40 : 46;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256" role="img" aria-label="デモ用ダミー選手 ${numberText}番">
  <rect width="256" height="256" fill="${bg}"/>
  <path d="M28 256 C28 196 78 176 128 176 C178 176 228 196 228 256 Z" fill="${jersey}"/>
  <path d="M28 256 C28 232 36 214 52 202 L52 256 Z" fill="${darken(jersey, 0.18)}"/>
  <path d="M228 256 C228 232 220 214 204 202 L204 256 Z" fill="${darken(jersey, 0.18)}"/>
  <rect x="112" y="150" width="32" height="34" rx="10" fill="${neck}"/>
  <path d="M104 178 Q128 208 152 178" fill="none" stroke="#ffffff" stroke-width="7" stroke-linecap="round"/>
  <circle cx="80" cy="116" r="9" fill="${skin}"/>
  <circle cx="176" cy="116" r="9" fill="${skin}"/>
  <ellipse cx="128" cy="112" rx="48" ry="54" fill="${skin}"/>
  <path d="${hairPath}" fill="${hairColor}"/>
  <circle cx="110" cy="118" r="5" fill="#222222"/>
  <circle cx="146" cy="118" r="5" fill="#222222"/>
  <path d="M114 140 Q128 152 142 140" fill="none" stroke="#7a3b2e" stroke-width="4" stroke-linecap="round"/>
  <text x="128" y="238" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="800" font-size="${fontSize}" fill="#ffffff" stroke="${darken(jersey, 0.35)}" stroke-width="1.5" paint-order="stroke">${numberText}</text>
</svg>
`;
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const p of PLAYERS) {
    fs.writeFileSync(path.join(OUT_DIR, p.file), buildSvg(p));
  }
  console.log(`[avatars] ${PLAYERS.length} files written to ${OUT_DIR}`);
}

if (require.main === module) main();

module.exports = { buildSvg };
