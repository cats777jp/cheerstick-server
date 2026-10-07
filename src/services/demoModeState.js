// src/services/demoModeState.js
// お客様向け「デモモード」機能（管理画面へのボタン追加、2026-09-29実装）の実行状態。
//
// cheerstick-serverプロセスのメモリ上（モジュールレベル変数）にのみ持つ。既存に
// 類例が無い設計だが、pm2再起動時は意図的に引き継がず、常にidleから始まる
// （docs/proposals/demo-mode-admin-ui.md「4. 安全策」参照）。

'use strict';

// テスト専用の短縮オーバーライド（環境変数のみ。リクエストボディからは一切
// 受け付けない＝公開APIとしては常に60秒固定。指示書6章「テスト専用の内部フラグを
// 設けてよい」に対応。scripts/demo/local-verify-demo-mode.jsでのみ使用する想定）。
const DEMO_DURATION_MS = Number(process.env.DEMO_MODE_TEST_DURATION_MS_OVERRIDE) || 60000;
const DEVICES_PER_TEAM = 100;
// ランキング見せ用（2026-10-07）：デモ用チームに「デモ用ダミー選手」が登録されているとき、デモは
// 別のMAC帯（従来のAA:00:00:02:*と混ぜない。後片付けを単純にするため）のデバイスを使う。
const SHOWCASE_MAC_PREFIX = 'AA:00:00:03';

const state = {
  status: 'idle', // 'idle' | 'set' | 'running'
  battleId: null,
  orgAId: null,
  orgBId: null,
  screenUrl: null,
  showcase: null, // ランキング見せ用の設定（{ macPrefix, targetIdsA, targetIdsB }）。ダミー選手が無ければnull（従来どおり）
  sparkEffect: true, // 火花演出の有無（2026-10-01追加、2026-10-06に既定ONへ変更）。true=火花ON（既定）、false=OFF（screenUrlに&fx=noneを付与済み）
  startedAt: null, // ms epoch（Date.now()）。runningのときのみ
  durationMs: DEMO_DURATION_MS,
  childProcess: null, // spawnしたChildProcess。runningのときのみ
};

// setup/start/stopの二重呼び出し（ダブルクリック等）で、試合や子プロセスが二重に
// 作られないようにする排他ロック。真偽値の同期チェックのみで実現する（awaitを挟む前に
// 判定できるため、非同期処理の途中で複数リクエストがすり抜けるレースコンディションを防ぐ。
// 指示書5章-3参照）。
let transitioning = false;

function beginTransition() {
  if (transitioning) return false;
  transitioning = true;
  return true;
}

function endTransition() {
  transitioning = false;
}

function setIdle() {
  state.status = 'idle';
  state.battleId = null;
  state.orgAId = null;
  state.orgBId = null;
  state.screenUrl = null;
  state.showcase = null;
  state.sparkEffect = true;
  state.startedAt = null;
  state.childProcess = null;
}

function setSet({ battleId, orgAId, orgBId, screenUrl, sparkEffect = true, showcase = null }) {
  state.status = 'set';
  state.battleId = battleId;
  state.orgAId = orgAId;
  state.orgBId = orgBId;
  state.screenUrl = screenUrl;
  state.showcase = showcase;
  state.sparkEffect = sparkEffect !== false;
  state.startedAt = null;
  state.childProcess = null;
}

function setRunning(childProcess) {
  state.status = 'running';
  state.startedAt = Date.now();
  state.childProcess = childProcess;
}

// battleId・screenUrlは保持したまま、実行中の情報だけ落として'set'へ戻す
// （停止・自動終了いずれも同じ遷移。指示書3-2「子プロセスのexitイベントで、
// 状態をsetに戻す（battleId・screenUrlは保持する）」参照）。
function setStoppedBackToSet() {
  state.status = 'set';
  state.startedAt = null;
  state.childProcess = null;
}

function getPublicStatus() {
  const now = Date.now();
  const elapsedMs = state.status === 'running' ? now - state.startedAt : null;
  const remainingMs = state.status === 'running'
    ? Math.max(0, state.durationMs - elapsedMs)
    : null;
  return {
    status: state.status,
    battleId: state.battleId,
    screenUrl: state.screenUrl,
    sparkEffect: state.sparkEffect,
    // ランキング見せ用（選手の推しエントリー付き）か。管理画面の表示用。IDそのものは返さず件数のみ。
    showcase: state.showcase
      ? { targetsA: state.showcase.targetIdsA.length, targetsB: state.showcase.targetIdsB.length }
      : null,
    elapsedMs,
    remainingMs,
  };
}

module.exports = {
  state,
  setIdle,
  setSet,
  setRunning,
  setStoppedBackToSet,
  getPublicStatus,
  beginTransition,
  endTransition,
  DEMO_DURATION_MS,
  DEVICES_PER_TEAM,
  SHOWCASE_MAC_PREFIX,
};
