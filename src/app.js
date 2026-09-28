const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');

const routes = require('./routes');
const { defaultIpLimiter } = require('./middleware/rateLimit');

const app = express();

app.set('trust proxy', 1); // Render.com runs behind a reverse proxy

app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') ?? '*',
}));
app.use(morgan('combined'));
app.use(express.json({ limit: '16kb' }));

// 大規模イベント対応のレート制限再設計（トラックA、2026-09-28）：
// 観客の入口（geturl/reference）・スコア系・管理APIは、それぞれ専用のリミッターを
// 各ルートファイル側で適用する（src/routes/webview.js・admin.js・eventBattles.js・
// targetScores.js・rankingSnapshots.js）。ここでの既定リミッターは、それら以外の
// /api/v1ルートと/healthに対する「従来どおり15分500回」を維持する
// （defaultIpLimiterのskipで、専用リミッター対象のパスを除外している。
// 除外しないと二重に数えられ、専用リミッターの緩和が意味を成さなくなるため）。
// 詳細：docs/proposals/large-event-scaling.md、docs/spec.md「大規模イベント対応」節。
app.use(defaultIpLimiter);

app.use('/api/v1', routes);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status ?? 500).json({ error: err.message ?? 'Internal server error' });
});

module.exports = app;
