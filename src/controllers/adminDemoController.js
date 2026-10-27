// src/controllers/adminDemoController.js
// お客様向け「デモモード」機能（管理画面へのボタン追加、2026-09-29実装）。
//
// 指示書（cheerstick-demo-mode-impl-20260929.md）の調査結果（docs/proposals/
// demo-mode-admin-ui.md、方式1＝子プロセス起動）に基づく実装。
// scripts/demo/battle-demo-prepare.js・scripts/demo/battle-demo.jsはいずれも
// 改修せず、in-process require / child_process.spawn でそのまま再利用する。
//
// 対象（カテゴリー「デモ用」・チーム・台数100・時間60秒固定）はいずれもこのファイル内で
// 固定し、リクエストボディからは一切受け付けない（安全策、指示書1章・5-4参照）。

'use strict';

const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const demoModeState = require('../services/demoModeState');
const prepare = require('../../scripts/demo/battle-demo-prepare');
const cheerQueries = require('../db/cheerstickQueries');

const PORT = process.env.PORT || 3000;
const API_BASE = `http://127.0.0.1:${PORT}/api/v1`;
const DEMO_CATEGORY_NAME = 'デモ用';

// ランキング見せ用（2026-10-07）：デモ用チームに、次の2つの条件を両方満たす選手（targets）が
// 登録されていれば「デモ用ダミー選手」とみなし、デモで推しエントリーに使う。
//   ・image_urlが /images/demo/players/ 配下（assets/images/demo/players/ の自前SVG）
//   ・profile_textが「【デモ用ダミー】」で始まる
// 選手の作成は scripts/demo/ranking-showcase-prepare.js（手動実行・既定はdry run）が担当する。
// 後から削除するときの識別条件も同じ（docs/proposals/demo-cleanup-2026-10-07.md 付録C）。
const SHOWCASE_IMAGE_PATH = '/images/demo/players/';
const SHOWCASE_PROFILE_PREFIX = '【デモ用ダミー】';

async function listShowcaseTargetIds(organizationId) {
  const targets = await cheerQueries.listTargetsAdmin(organizationId);
  return targets
    .filter((t) => t.is_active &&
      typeof t.image_url === 'string' && t.image_url.includes(SHOWCASE_IMAGE_PATH) &&
      typeof t.profile_text === 'string' && t.profile_text.startsWith(SHOWCASE_PROFILE_PREFIX))
    .map((t) => t.id);
}

function buildScreenUrl(battleId, sparkEffect) {
  // 絶対URL化（APP_BASE、環境ごとに異なるドメイン）はフロント側（common.js）に委ねる。
  // 既存の対抗戦ペア一覧のbattleScreenUrl()と同じ考え方。
  // 火花演出は既定ON（2026-10-06変更）：sparkEffectがfalseのときだけ&fx=noneを付けて無効化する。
  return `/battle.html?battle_id=${battleId}&gauge=recent&poll=1000${sparkEffect ? '' : '&fx=none'}`;
}

// 「デモ用」カテゴリーに属するチームのうち、作成日時が最も古い2件を返す
// （2026-09-29追加）。battle-demo-prepare.js自体はチーム名を直接指定して検索する
// 設計（findOrganization()）のため無改修のまま、こちら側で名前に依存しない方法で
// 対象チームを決めてから、そのチーム名をprepare.main()へ明示的に渡す形にする。
// これにより、将来チーム名を変更してもコード変更なしで動く。
// DB直接参照はcheerQueriesを使う（in-process呼び出しのため、prepare.js自身のような
// HTTP自己ループを経由する必要が無い）。
// 安全策：カテゴリーは名前一致するもの以外を対象にしない・新規作成しない
// （既存のfindCategory()と同じ制約）。
async function resolveDemoTeams() {
  const categories = await cheerQueries.listCategoriesForAdmin();
  const category = categories.find((c) => c.name === DEMO_CATEGORY_NAME);
  if (!category) {
    throw new Error(
      `category "${DEMO_CATEGORY_NAME}" not found. 新規作成は行わない設計のため、事前に管理画面等で作成してください。`
    );
  }

  const organizations = await cheerQueries.listOrganizationsForAdmin(category.id);
  if (organizations.length < 2) {
    throw new Error(
      `category "${DEMO_CATEGORY_NAME}" には2チーム以上の登録が必要です（現在${organizations.length}件）`
    );
  }

  const sorted = [...organizations].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );
  return { category, orgA: sorted[0], orgB: sorted[1] };
}

// 実行中の子プロセスへSIGTERMを送り、終了（'exit'イベント）を待つ。
// 一定時間（5秒）応答が無ければSIGKILLで強制終了する（指示書3-2「stop」・5章-2参照）。
function terminateChild(child, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.once('exit', () => {
      clearTimeout(killTimer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

// POST /admin/demo/setup
exports.setup = async (req, res, next) => {
  if (demoModeState.state.status === 'running') {
    return res.status(409).json({ error: 'DEMO_RUNNING' });
  }
  // ダブルクリック等での二重呼び出し対策（指示書5章-3）。awaitを挟む前の同期チェックのため、
  // 2つのリクエストがほぼ同時に来ても、片方だけがtrueを受け取る。
  if (!demoModeState.beginTransition()) {
    return res.status(409).json({ error: 'DEMO_BUSY' });
  }

  const previousBattleId = demoModeState.state.battleId;
  // 真偽値のfalseのみ火花OFF（省略・その他の値は既定のtrue＝火花ON、2026-10-06変更）。
  const sparkEffect = !(req.body && req.body.sparkEffect === false);

  try {
    // ①「前回のデモ試合があれば自動で終了し」（指示書0章）。
    // 失敗しても（例：前回分が既に手動で片付けられていた等）新規セットアップ自体は
    // 続行する。前回分の後始末に失敗したことは、新しいデモの成立を妨げるべきではないため。
    if (previousBattleId) {
      try {
        await prepare.main([`--api-base=${API_BASE}`, `--finish-run=${previousBattleId}`, '--yes']);
      } catch (err) {
        console.error(
          `[demo] failed to finish previous battle ${previousBattleId} during setup (continuing): ${err.message}`
        );
      }
    }

    // 対象チームは名前に依存せず、「デモ用」カテゴリーの中で作成日時が最も古い2件から
    // 決める（2026-09-29変更）。決めたチーム名をprepare.main()へ明示的に渡す。
    const { orgA: resolvedOrgA, orgB: resolvedOrgB } = await resolveDemoTeams();

    // ランキング見せ用：デモ用ダミー選手がいれば、別のMAC帯（AA:00:00:03）のデバイスを使う。
    // いなければ従来どおり（AA:00:00:02、選手の推しエントリー無し）。
    const [targetIdsA, targetIdsB] = await Promise.all([
      listShowcaseTargetIds(resolvedOrgA.id),
      listShowcaseTargetIds(resolvedOrgB.id),
    ]);
    const showcase = (targetIdsA.length + targetIdsB.length) > 0
      ? { macPrefix: demoModeState.SHOWCASE_MAC_PREFIX, targetIdsA, targetIdsB }
      : null;

    const result = await prepare.main([
      `--api-base=${API_BASE}`,
      '--yes',
      '--pause-other-live',
      `--devices-per-team=${demoModeState.DEVICES_PER_TEAM}`,
      `--team-a-name=${resolvedOrgA.name}`,
      `--team-b-name=${resolvedOrgB.name}`,
      ...(showcase ? [`--mac-prefix=${showcase.macPrefix}`] : []),
    ]);

    const screenUrl = buildScreenUrl(result.battle.id, sparkEffect);
    demoModeState.setSet({
      battleId: result.battle.id,
      orgAId: result.orgA.id,
      orgBId: result.orgB.id,
      screenUrl,
      sparkEffect,
      showcase,
      themeImageMissing: !result.themeImageUrl,
    });

    res.status(201).json(demoModeState.getPublicStatus());
  } catch (err) {
    next(err);
  } finally {
    demoModeState.endTransition();
  }
};

// POST /admin/demo/start
exports.start = async (req, res, next) => {
  const s = demoModeState.state;
  if (s.status === 'running') {
    return res.status(409).json({ error: 'DEMO_RUNNING' });
  }
  if (s.status !== 'set') {
    return res.status(409).json({ error: 'DEMO_NOT_SET' });
  }
  if (!demoModeState.beginTransition()) {
    return res.status(409).json({ error: 'DEMO_BUSY' });
  }

  try {
    const wsUrl = `ws://127.0.0.1:${PORT}/cheer`;
    const scoreUrl = `${API_BASE}/event-battles/${s.battleId}/score`;
    const metricsLogPath = path.join(os.tmpdir(), `cheerstick-demo-metrics-${Date.now()}.jsonl`);

    // battle-demo.jsの「duration-ms経過で自動終了」判定は、reportIntervalMsごとの
    // 定期チェックでのみ行われる（既定10秒）。60秒固定の本番設定では10000/6=10000で
    // 従来と全く同じ間隔になるが、DEMO_MODE_TEST_DURATION_MS_OVERRIDEでdurationMsを
    // 短縮するローカル確認時は、既定の10秒間隔のままだと自動終了の検出が大幅に遅れる
    // （scripts/demo/local-verify-demo-mode.js参照）。durationMsに比例させ、1〜10秒の
    // 範囲でclampする。
    const reportIntervalMs = Math.max(1000, Math.min(10000, Math.floor(demoModeState.DEMO_DURATION_MS / 6)));

    const child = spawn(
      process.execPath,
      [
        path.join(__dirname, '../../scripts/demo/battle-demo.js'),
        `--battle-id=${s.battleId}`,
        `--org-a=${s.orgAId}`,
        `--org-b=${s.orgBId}`,
        `--devices-per-team=${demoModeState.DEVICES_PER_TEAM}`,
        `--duration-ms=${demoModeState.DEMO_DURATION_MS}`,
        `--report-interval-ms=${reportIntervalMs}`,
        `--url=${wsUrl}`,
        `--score-url=${scoreUrl}`,
        `--metrics-log-path=${metricsLogPath}`,
        // 9/28〜29の100 vs 100テストで使用した設定を踏襲（docs/worklog.md参照）。
        '--burst',
        '--target-range=0.35-0.65',
        // ランキング見せ用（デモ用ダミー選手がいるとき）：別のMAC帯、チームごとの選手リストから推しエントリー、
        // ユーザーごとの熱量差、ひらがな・カタカナの愛称。
        ...(s.showcase ? [
          `--mac-prefix=${s.showcase.macPrefix}`,
          `--oshi-targets-a=${s.showcase.targetIdsA.join(',')}`,
          `--oshi-targets-b=${s.showcase.targetIdsB.join(',')}`,
          '--energy-spread',
          '--nickname-style=fun',
        ] : []),
      ],
      {
        cwd: path.join(__dirname, '../..'),
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    // 子プロセスの標準出力・エラー出力は、cheerstick-server自体のpm2ログに
    // 行として混ざるが、"[demo-child]"プレフィックスで区別できるようにする
    // （指示書3-2「実装しながら、既存のログ運用に合わせて判断し、報告する」への対応。
    // 別ファイルへのリダイレクトは行わない設計とした。理由：battle-demo.js自体が
    // --metrics-log-pathで詳細な記録を別途残すため、pm2ログ側は簡易な進捗確認用途で
    // 十分と判断したため）。
    child.stdout.on('data', (chunk) => {
      process.stdout.write(String(chunk).replace(/^/gm, '[demo-child] '));
    });
    child.stderr.on('data', (chunk) => {
      process.stderr.write(String(chunk).replace(/^/gm, '[demo-child] '));
    });

    child.on('exit', (code, signal) => {
      console.log(`[demo] child process exited (code=${code}, signal=${signal})`);
      // このchildが現在追跡中のものと一致する場合のみ状態を戻す（後から新しいデモが
      // 開始されていた場合に、古いプロセスのexitで新しい状態を巻き戻さないため）。
      if (demoModeState.state.childProcess === child) {
        demoModeState.setStoppedBackToSet();
      }
    });

    demoModeState.setRunning(child);
    res.json(demoModeState.getPublicStatus());
  } catch (err) {
    next(err);
  } finally {
    demoModeState.endTransition();
  }
};

// POST /admin/demo/stop
exports.stop = async (req, res, next) => {
  const s = demoModeState.state;
  if (s.status !== 'running') {
    return res.status(409).json({ error: 'DEMO_NOT_RUNNING' });
  }
  if (!demoModeState.beginTransition()) {
    return res.status(409).json({ error: 'DEMO_BUSY' });
  }

  const child = s.childProcess;
  try {
    await terminateChild(child);
  } finally {
    if (demoModeState.state.childProcess === child) {
      demoModeState.setStoppedBackToSet();
    }
    demoModeState.endTransition();
  }
  res.json(demoModeState.getPublicStatus());
};

// GET /admin/demo/status
exports.status = (req, res) => {
  res.json(demoModeState.getPublicStatus());
};

// サーバー終了時（pm2再起動等）に、追跡中の子プロセスを確実に終了させるために
// src/index.jsから呼ばれる（安全策、指示書3-1・5-2参照）。
exports.killRunningChildForShutdown = () => {
  const child = demoModeState.state.childProcess;
  if (child && child.exitCode === null && child.signalCode === null) {
    console.log('[demo] server shutting down; terminating running demo child process');
    try {
      child.kill('SIGTERM');
    } catch (err) {
      // 既に終了している等は無視する
    }
  }
};
