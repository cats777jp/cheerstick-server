require('dotenv').config();
const http = require('http');
const app = require('./app');
const wsServer = require('./websocket');
const { assertNotConnectedToProduction } = require('./db/productionGuard');
const { killRunningChildForShutdown } = require('./controllers/adminDemoController');

const PORT = process.env.PORT || 3000;

async function main() {
  await assertNotConnectedToProduction();

  const server = http.createServer(app);

  wsServer.attach(server, '/cheer');

  server.listen(PORT, () => {
    console.log(`CheerStick server running on port ${PORT}`);
  });
}

// デモモード機能（2026-09-29追加）：pm2の再起動・終了（SIGINT/SIGTERM）で、
// 実行中のデモ子プロセス（scripts/demo/battle-demo.js）がorphan化して残り続けない
// ようにする（docs/proposals/demo-mode-admin-ui.md「4. 安全策」参照）。
// 従来このプロセスにSIGINT/SIGTERMのハンドラは無く、pm2からの終了要求は既定動作
// （即時終了）に任せていた。ここで明示的にハンドラを追加し、子プロセスの後始末を
// 行ってから、従来と同じ即時終了（process.exit）を行う。
function shutdown(signal) {
  killRunningChildForShutdown();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
