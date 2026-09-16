// src/controllers/uploadController.js
// 管理画面：チームロゴ・選手/推し対象写真の画像アップロード（改善3件フェーズ2、2026-09-16新設）。
//
// 従来はorganizations.logo_url／targets.image_urlへURLを直接入力する方式のみだったが、
// ドラッグ＆ドロップ／ファイル選択によるアップロードに対応するため新設。
// 保存先は本番では/var/www/cheerstick-app/images/uploads/（既存のassets/images/正本方式とは別の、
// 運用中に随時追加されるアップロード画像専用のディレクトリ。docs/runbook.md参照）。
// UPLOAD_DIR・UPLOAD_URL_BASE環境変数で保存先・公開URLのベースを切り替える
// （ローカル開発時は本番と異なるパス・オリジンになるため）。

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);

/**
 * ファイル内容の先頭バイト（マジックバイト）から実際の画像形式を判定する。
 * 拡張子の詐称（例：実体はexeだが拡張子だけ.pngにする）を防ぐため、
 * 拡張子チェックとは別に必ずこちらも確認する。
 */
function detectImageType(buffer) {
  if (buffer.length >= JPEG_MAGIC.length && buffer.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) {
    return 'jpg';
  }
  if (buffer.length >= PNG_MAGIC.length && buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    return 'png';
  }
  return null;
}

function getUploadDir() {
  return process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'public', 'uploads');
}

function getUploadUrlBase() {
  return process.env.UPLOAD_URL_BASE || 'http://localhost:3000/uploads';
}

/**
 * POST /api/v1/admin/uploads/image
 * multipart/form-data、フィールド名 file。jpg/pngのみ受け付ける。
 * ルート側（src/routes/admin.js）でmulter（メモリストレージ、5MB上限）を通した後に呼ばれる。
 */
exports.uploadImage = async (req, res, next) => {
  if (!req.file) {
    return res.status(400).json({ error: 'FILE_REQUIRED' });
  }

  const ext = path.extname(req.file.originalname || '').toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return res.status(400).json({ error: 'UNSUPPORTED_FILE_TYPE', message: 'jpg/pngのみアップロードできます' });
  }

  const detectedType = detectImageType(req.file.buffer);
  if (!detectedType) {
    return res.status(400).json({ error: 'UNSUPPORTED_FILE_TYPE', message: 'ファイルの内容が画像として認識できません' });
  }
  // 拡張子側は.jpg/.jpegどちらもJPEGとして許容するため、判定結果はdetectedType（jpg/png）を正とする。

  try {
    const dir = getUploadDir();
    fs.mkdirSync(dir, { recursive: true });

    const filename = `${crypto.randomUUID()}.${detectedType}`;
    fs.writeFileSync(path.join(dir, filename), req.file.buffer);

    const url = `${getUploadUrlBase()}/${filename}`;
    res.status(201).json({ url });
  } catch (err) {
    next(err);
  }
};
