// src/controllers/webviewController.js
// アプリからのgeturl呼び出しに対応するコントローラー。
// Vanstone確定仕様：常にHTML（meta refresh）でWebView URLへリダイレクトする。

'use strict';

const WEBVIEW_BASE_URL = process.env.WEBVIEW_BASE_URL || 'https://app.cheerstick.com/index.html';

exports.geturl = async (req, res) => {
  const macAddress = req.query.id;

  if (!macAddress) {
    return res.status(400).send('id (MAC address) is required');
  }

  const target = `${WEBVIEW_BASE_URL}?id=${encodeURIComponent(macAddress)}`;

  res.set('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(`<!DOCTYPE html>
<html>
<head>
<meta http-equiv="refresh" content="0;URL=${target}">
</head>
<body>
</body>
</html>`);
};
