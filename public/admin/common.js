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

// 画像アップロードUI（ドラッグ＆ドロップ／ファイル選択、改善3件フェーズ2、2026-09-16新設）。
// masters.html（チームロゴ）・targets.html（選手/推し対象写真）で共通利用する。
//
// urlInputEl（type="hidden"）にアップロード後のURLを保持する設計にすることで、
// 既存のorganizations/targets create/update送信処理（urlInputEl.valueを読むだけ）を
// 変更せずに済むようにしている。POST /uploads/imageはサイズ制限（413）・形式エラー（400）を
// 返しうるため、ここでもエラー内容に応じたメッセージ分けを行う。
function setupImageUploadWidget({ dropZoneEl, fileInputEl, previewImgEl, urlInputEl, statusEl }) {
  const ALLOWED_TYPES = ['image/jpeg', 'image/png'];
  const MAX_SIZE_BYTES = 5 * 1024 * 1024;

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text || '';
  }

  function setPreview(url) {
    if (url) {
      previewImgEl.src = url;
      previewImgEl.classList.remove('hidden');
    } else {
      previewImgEl.removeAttribute('src');
      previewImgEl.classList.add('hidden');
    }
  }

  async function handleFile(file) {
    if (!file) return;

    if (!ALLOWED_TYPES.includes(file.type)) {
      showError('画像はjpgまたはpngのみアップロードできます');
      return;
    }
    if (file.size > MAX_SIZE_BYTES) {
      showError('画像サイズは5MBまでです');
      return;
    }

    setStatus('アップロード中...');
    const formData = new FormData();
    formData.append('file', file);

    let res;
    try {
      res = await fetch(API_BASE + '/uploads/image', { method: 'POST', body: formData });
    } catch (e) {
      setStatus('');
      showError('サーバーに接続できませんでした: ' + e.message);
      return;
    }

    let body = null;
    try { body = await res.json(); } catch (e) { /* ボディ無しの場合もある */ }

    if (!res.ok) {
      setStatus('');
      if (res.status === 413) {
        showError('画像サイズは5MBまでです');
      } else if (body && body.error === 'UNSUPPORTED_FILE_TYPE') {
        showError('画像はjpgまたはpngのみアップロードできます');
      } else {
        showError('画像のアップロードに失敗しました: ' + ((body && body.error) || `HTTP ${res.status}`));
      }
      return;
    }

    urlInputEl.value = body.url;
    setPreview(body.url);
    setStatus('アップロード完了');
    clearError();
  }

  dropZoneEl.addEventListener('click', () => fileInputEl.click());
  dropZoneEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZoneEl.classList.add('dragover');
  });
  dropZoneEl.addEventListener('dragleave', () => dropZoneEl.classList.remove('dragover'));
  dropZoneEl.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZoneEl.classList.remove('dragover');
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    handleFile(file);
  });
  fileInputEl.addEventListener('change', () => {
    handleFile(fileInputEl.files[0]);
    fileInputEl.value = ''; // 同じファイルを選び直した時もchangeイベントが発火するようにする
  });

  return {
    // 編集モーダルを開く際、既存のURLをプレビュー・隠しフィールドへ反映するために使う。
    setUrl(url) {
      urlInputEl.value = url || '';
      setPreview(url || '');
      setStatus('');
    },
  };
}
