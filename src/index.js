require('dotenv').config();
const http = require('http');
const app = require('./app');
const wsServer = require('./websocket');

const PORT = process.env.PORT || 3000;

const server = http.createServer(app);

wsServer.attach(server, '/cheer');

server.listen(PORT, () => {
  console.log(`CheerStick server running on port ${PORT}`);
});
