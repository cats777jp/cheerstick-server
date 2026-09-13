// public/admin/common.js
// 管理画面 共通ユーティリティ（API_BASE/APP_BASE、fetchラッパー、HTMLエスケープ、
// エラー表示、日時変換ヘルパー）。
//
// 2026-09-13、管理画面のランチャー方式への再構成（index.html / events.html /
// masters.html の3ページ分割）に伴い、旧index.htmlのインラインJS（IIFE内）から、
// 全ページ共通で使う部分のみを切り出した。あえてIIFEで包まず素朴なグローバル関数と
// している（各ページのインライン<script>から素直に参照できるようにするため。
// 本プロジェクトの管理画面はSPAではなくページ遷移のたびに再フェッチするMPA構成であり、
// ビルドツール・モジュールバンドラは導入していないため、この形が最小コストと判断した）。
//
// events.html・masters.html・index.html（ランチャー）の3ファイルすべてで、
// 各ページ固有のインライン<script>より前に <script src="common.js"></script> で読み込む。
// showError/clearErrorはページ側に <div id="errorBar" class="error-bar"></div> が
// 存在することを前提とする。

const API_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? '/api/v1/admin'
  : 'https://api.cheerstick.com/api/v1/admin';

// 対抗戦スクリーン（public/battle.html）はユーザー向け画面（app.cheerstick.com）配下に
// 配置する想定のため、admin.cheerstick.comとは別オリジンになる（本番）。events.htmlの
// 対抗戦ペア一覧（スクリーン表示URL生成）でのみ使用する。
const APP_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? ''
  : 'https://app.cheerstick.com';

function showError(message) {
  const errorBar = document.getElementById('errorBar');
  if (!errorBar) return;
  errorBar.textContent = message;
  errorBar.classList.add('visible');
}

function clearError() {
  const errorBar = document.getElementById('errorBar');
  if (!errorBar) return;
  errorBar.textContent = '';
  errorBar.classList.remove('visible');
}

async function apiFetch(path, options) {
  let res;
  try {
    res = await fetch(API_BASE + path, options);
  } catch (e) {
    showError('サーバーに接続できませんでした: ' + e.message);
    throw e;
  }

  let body = null;
  try {
    body = await res.json();
  } catch (e) {
    // レスポンスボディが無い場合もある
  }

  if (!res.ok) {
    const err = new Error((body && body.error) || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

// datetime-local (ローカル壁時計時刻) <-> ISO文字列(UTC) の変換。
// Dateコンストラクタは "YYYY-MM-DDTHH:mm" 形式をローカル時刻として解釈するため、
// toISOString()でそのままUTCへ変換すればタイムゾーンのずれは起きない。
function datetimeLocalToIso(value) {
  if (!value) return null;
  return new Date(value).toISOString();
}

// サーバーから返るISO文字列を、datetime-local入力欄用の表示形式に変換する。
// ローカルのgetter（getHours等）を使い、ブラウザのローカル時刻表現に揃える。
function isoToDatetimeLocal(value) {
  if (!value) return '';
  const d = new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDisplayDate(value) {
  if (!value) return '';
  return new Date(value).toLocaleString('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}
