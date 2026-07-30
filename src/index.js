require('dotenv').config();
const http = require('http');
const app = require('./app');
const wsServer = require('./websocket');
const { assertNotConnectedToProduction } = require('./db/productionGuard');

const PORT = process.env.PORT || 3000;

async function main() {
  await assertNotConnectedToProduction();

  const server = http.createServer(app);

  wsServer.attach(server, '/cheer');

  server.listen(PORT, () => {
    console.log(`CheerStick server running on port ${PORT}`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
