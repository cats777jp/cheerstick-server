// scripts/demo/showcase-players.js
// ランキング見せ用の「デモ用ダミー選手」の定義（2026-10-07）。
// generate-demo-avatars.js（SVG生成）と ranking-showcase-prepare.js（選手の登録）が共通で使う。
//
// 実在の人物ではない。名前はカタカナの下の名前のみ（実在の特定の人物に結びつかないようにするため）、
// 顔写真は自前で生成したSVGイラスト（assets/images/demo/players/）。
//
// 識別条件（後から確実に棚卸し・削除するための目印。docs/proposals/demo-cleanup-2026-10-07.md 付録C）：
//   ・所属がデモ専用のチーム（カテゴリー「デモ用」のEMUTTO・J SPORTS）
//   ・image_url が /images/demo/players/ 配下
//   ・profile_text が「【デモ用ダミー】」で始まる
// 名前には目印を付けない（ランキング画面にそのまま表示されるため）。

'use strict';

const IMAGE_PATH = '/images/demo/players/';
const PROFILE_PREFIX = '【デモ用ダミー】';
const PROFILE_TEXT = `${PROFILE_PREFIX}ランキング表示の確認用の、架空の選手です。`;

// ユニフォームの色：デモ用チームの登録色（docs/worklog.md 2026-09-25）。
const TEAM_COLORS = { A: '#DC2626', B: '#2563EB' };

const NAMES = {
  A: ['ハヤテ', 'ソラ', 'ケンタ', 'リク', 'ユウト', 'ダイキ', 'ショウ', 'ルイ', 'タクミ', 'カケル'],
  B: ['ヒカル', 'レン', 'カイト', 'ナオキ', 'マサト', 'ツバサ', 'ジン', 'コウタ', 'イブキ', 'リョウ'],
};

// [{ team: 'A', number: 1, name: 'ハヤテ', file: 'a-01.svg', index: 0 }, ...]（A10名→B10名）
const PLAYERS = [];
['A', 'B'].forEach((team, teamIdx) => {
  NAMES[team].forEach((name, i) => {
    PLAYERS.push({
      team,
      number: i + 1,
      name,
      file: `${team.toLowerCase()}-${String(i + 1).padStart(2, '0')}.svg`,
      index: teamIdx * 10 + i,
    });
  });
});

module.exports = { IMAGE_PATH, PROFILE_PREFIX, PROFILE_TEXT, TEAM_COLORS, NAMES, PLAYERS };
