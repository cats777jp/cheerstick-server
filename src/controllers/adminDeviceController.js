// src/controllers/adminDeviceController.js
// 管理画面：devices（デバイス）のジャンル(category_id)・is_demo設定、CSV一括取り込みを
// 扱う管理用コントローラー（B-5、2026-08-19新設）。
//
// 実装1（デバイス登録とホワイトリスト化）のA-1（一括SQL投入）は本セッションでは保留され、
// 本機能（CSVインポート＋一括ジャンル設定）が投入経路そのものになる想定のため、
// CSV取り込みはジャンル未設定のまま登録し、ジャンル確定後にPATCH /devices/bulkで
// 絞り込み→一括設定する2段階のフローを前提に設計している。
//
// 判断済み（2026-08-18時点）：アプリケーションレベルの認証は追加しない。理由・詳細は
// src/routes/admin.jsのコメント、docs/spec.md 8章参照（B-3、2026-08-19）。

'use strict';

const cheerQueries = require('../db/cheerstickQueries');
const { normalizeMacAddress } = require('../utils/macAddress');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

exports.listCategories = async (req, res, next) => {
  try {
    const categories = await cheerQueries.listCategoriesForAdmin();
    res.json(categories);
  } catch (err) {
    next(err);
  }
};

exports.list = async (req, res, next) => {
  const { category_id: categoryIdParam, mac, page: pageParam, page_size: pageSizeParam } = req.query;

  const page = Math.max(parseInt(pageParam, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(pageSizeParam, 10) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);

  // category_id=null（文字列）は「未設定のみ」を意味する（一覧画面のプルダウンから送られる）。
  const unsetOnly = categoryIdParam === 'null';
  const categoryId = !unsetOnly && categoryIdParam ? categoryIdParam : null;

  try {
    const { rows, total } = await cheerQueries.listDevicesAdmin({
      categoryId,
      unsetOnly,
      macQuery: mac || null,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    res.json({ devices: rows, total, page, page_size: pageSize });
  } catch (err) {
    next(err);
  }
};

exports.update = async (req, res, next) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    return res.status(400).json({ error: 'INVALID_ID' });
  }

  const { category_id: categoryId, is_demo: isDemo } = req.body || {};
  const fields = {};
  if (categoryId !== undefined) fields.categoryId = categoryId;
  if (isDemo !== undefined) fields.isDemo = isDemo;

  try {
    const updated = await cheerQueries.updateDeviceAdmin(id, fields);
    if (!updated) {
      return res.status(404).json({ error: 'DEVICE_NOT_FOUND' });
    }
    res.json(updated);
  } catch (err) {
    if (err.code === 'CATEGORY_NOT_FOUND') {
      return res.status(400).json({ error: 'CATEGORY_NOT_FOUND' });
    }
    next(err);
  }
};

/**
 * PATCH /admin/devices/bulk
 * body: { ids: [...] } または { filter: { category_id, mac } } のいずれかに加え、
 *       category_id（変更する場合のみ。未設定に戻すならnull） / is_demo
 *
 * ids指定：指定したid群のみ更新（一覧画面での複数選択チェックボックス用、最大でも
 *          1ページ分＝MAX_PAGE_SIZE件程度を想定）。
 * filter指定：ページをまたいだ「絞り込み条件に一致する全件」への一括適用用。
 *             条件無し（devices全件が対象になるケース）はDB層でFILTER_REQUIREDとして拒否する。
 */
exports.bulkUpdate = async (req, res, next) => {
  const { ids, filter, category_id: categoryId, is_demo: isDemo } = req.body || {};

  const fields = {};
  if (categoryId !== undefined) fields.categoryId = categoryId;
  if (isDemo !== undefined) fields.isDemo = isDemo;

  if (Object.keys(fields).length === 0) {
    return res.status(400).json({ error: 'category_id or is_demo is required' });
  }

  try {
    if (fields.categoryId != null) {
      await cheerQueries.assertCategoryExists(fields.categoryId);
    }

    if (Array.isArray(ids) && ids.length > 0) {
      if (!ids.every((id) => UUID_RE.test(id))) {
        return res.status(400).json({ error: 'INVALID_ID' });
      }
      const updated = await cheerQueries.bulkUpdateDevicesByIds(ids, fields);
      return res.status(200).json({ updated });
    }

    if (filter && typeof filter === 'object') {
      const updated = await cheerQueries.bulkUpdateDevicesByFilter(
        {
          unsetOnly: filter.category_id === null,
          categoryId: filter.category_id || null,
          macQuery: filter.mac || null,
        },
        fields
      );
      return res.status(200).json({ updated });
    }

    return res.status(400).json({ error: 'ids or filter is required' });
  } catch (err) {
    if (err.code === 'CATEGORY_NOT_FOUND') {
      return res.status(400).json({ error: 'CATEGORY_NOT_FOUND' });
    }
    if (err.code === 'FILTER_REQUIRED') {
      return res.status(400).json({ error: 'FILTER_REQUIRED' });
    }
    next(err);
  }
};

exports.create = async (req, res, next) => {
  const { mac_address: macRaw, category_id: categoryId, is_demo: isDemo } = req.body || {};
  const mac = normalizeMacAddress(macRaw);
  if (!mac) {
    return res.status(400).json({ error: 'INVALID_MAC_ADDRESS' });
  }

  try {
    const created = await cheerQueries.createDeviceAdmin({
      macAddress: mac,
      categoryId: categoryId || null,
      isDemo: !!isDemo,
    });
    res.status(201).json(created);
  } catch (err) {
    if (err.code === 'CATEGORY_NOT_FOUND') {
      return res.status(400).json({ error: 'CATEGORY_NOT_FOUND' });
    }
    if (err.code === 'DEVICE_ALREADY_EXISTS') {
      return res.status(409).json({ error: 'DEVICE_ALREADY_EXISTS' });
    }
    next(err);
  }
};

/**
 * POST /admin/devices/import
 * body: 生のCSVテキスト（Content-Type問わず、src/routes/admin.jsでexpress.textにより
 *       req.bodyへ文字列として渡される）。1列目のみを見る（他の列は無視）。
 *
 * 1行目が有効なMAC形式でなければヘッダー行とみなしてスキップする
 * （検査ログCSVからMAC列のみを抜き出した想定のフォーマットのため、ヘッダー有無は問わない）。
 * category_idはここでは設定しない（ジャンル未確定のまま取り込み、確定後に
 * PATCH /admin/devices/bulkで一括設定する運用のため）。
 */
exports.importDevices = async (req, res, next) => {
  const rawText = typeof req.body === 'string' ? req.body : '';
  if (!rawText.trim()) {
    return res.status(400).json({ error: 'CSV_BODY_REQUIRED' });
  }

  const lines = rawText
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) {
    return res.status(400).json({ error: 'CSV_BODY_REQUIRED' });
  }

  const firstField = (line) => line.split(',')[0];

  const headerSkipped = normalizeMacAddress(firstField(lines[0])) === null;
  const startIndex = headerSkipped ? 1 : 0;

  const seen = new Set();
  const validMacs = [];
  let invalidCount = 0;
  const invalidSamples = [];

  for (let idx = startIndex; idx < lines.length; idx += 1) {
    const mac = normalizeMacAddress(firstField(lines[idx]));
    if (!mac) {
      invalidCount += 1;
      if (invalidSamples.length < 10) invalidSamples.push(lines[idx].slice(0, 50));
      continue;
    }
    if (!seen.has(mac)) {
      seen.add(mac);
      validMacs.push(mac);
    }
  }

  const totalDataRows = lines.length - startIndex;
  const withinCsvDuplicates = totalDataRows - invalidCount - validMacs.length;

  try {
    const insertedMacs = await cheerQueries.importDevices(validMacs);
    const dbDuplicateSkipped = validMacs.length - insertedMacs.length;

    res.status(200).json({
      header_skipped: headerSkipped,
      total_rows: totalDataRows,
      inserted: insertedMacs.length,
      duplicate_skipped: withinCsvDuplicates + dbDuplicateSkipped,
      invalid_skipped: invalidCount,
      invalid_samples: invalidSamples,
    });
  } catch (err) {
    next(err);
  }
};
