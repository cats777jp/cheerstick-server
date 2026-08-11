# 応援量カウント算出ロジック仕様書

> **【位置づけに関する注記、2026-08-11追加】** 本資料は旧Node-RED版WebViewの
> クライアント側（振動データ→count算出）ロジックの参照資料であり、**現行の
> サーバー側集計仕様ではない。** ペイロード形状（`count`+`num_min/max`等の
> バッチ統計形式）も現行実装（`docs/spec.md` 4.3、`{type:"count", id, value,
> duration_ms}`）と異なる。誤って現行仕様として参照しないこと。

> 旧Node-RED版 WebView からの抽出。Vanstone様へのAPP側実装リファレンスとして共有

- 抽出元: `nodered-backup/20260724/extracted/user-registration-form.html`
  （Node-RED flows-export内 templateノード「ユーザー登録フォーム」(`6a5d4f5b38adea96`) を復元したもの）
- 本書はコードを一切改変せず、原文の抽出と日本語化した仕様説明のみを行っている。
- 行番号は上記抽出ファイル基準（総行数992行）。

---

## 1. 対象処理の所在

| 処理 | 行番号 |
|---|---|
| 加速度データから `count` を算出する処理（`analyzeVibrationData`） | 783〜807行目 |
| ネイティブアプリからのデータ受信処理全体（`receiveFromApp`） | 850〜935行目 |
| `count` を5件バッチでWebSocket送信する処理（`handleCountForWebSocket` / `sendCountToWebSocket`） | 660〜686行目、735〜781行目 |
| バッチ用の状態変数の初期宣言 | 378〜388行目 |

---

## 2. 算出アルゴリズム仕様（再実装可能な粒度）

### 2.1 入力

ネイティブアプリ（Swift / Kotlin）からWebViewへ、BLEで受信した振動データがJSON文字列として1秒間隔で渡される（`receiveFromApp(jsonString)` の引数）。

```json
{
  "num": <整数、通番>,
  "accel": {
    "x": [<数値>, <数値>, ...],
    "y": [<数値>, <数値>, ...],
    "z": [<数値>, <数値>, ...]
  },
  "volt": <小数、電圧>,
  "rssi": <整数、電波強度>
}
```

- `accel.x` / `accel.y` / `accel.z` はそれぞれ軸ごとの加速度サンプル配列。サンプル数は仕様コメント（末尾）では10件想定だが、コード側は配列長を固定していない（可変長を許容する実装）。
- BLE切断時はネイティブアプリから `{"num":0, "accel":{"x":[0],"y":[0],"z":[0]}, "volt":0.0, "rssi":0}`（各軸1件ずつ）が送られる特別パターンとして扱われる。

### 2.2 判定に使用している閾値・定数（数値をすべて明記）

| 定数 | 値 | 用途 | 該当行 |
|---|---|---|---|
| 加速度しきい値 | `25`（絶対値） | 各サンプルが「振動あり」とみなされる閾値 | 789, 795, 801行目 |
| countの上限クランプ | `21` | 算出したcountの最大値 | 806行目 |
| バッチサイズ | `5` | WebSocket送信をまとめる件数 | 751行目 |
| BLE切断連続許容回数 | `5` | 連続切断5回でユーザーへアラート表示 | 880行目 |
| BLE切断判定条件 | `num===0 かつ volt===0.0 かつ rssi===0 かつ (x.length+y.length+z.length)===3` | 切断通知パターンの検知 | 865行目 |
| LEDのPWM係数 | `12` | count 1件あたりのPWM増分の係数 | 914〜916行目 |
| LEDカラー正規化の除数 | `255` | サーバー指定色(0-255)を0または1に丸める除数（`Math.trunc`） | 914〜916行目 |

### 2.3 算出手順

**Step A：軸ごとの振動検知カウント（`analyzeVibrationData`、783〜807行目）**

1. `count = 0` で初期化する。
2. `accel.x` の全サンプルを走査し、`Math.abs(el) > 25` を満たす要素ごとに `count` を1増やす。
3. `accel.y` についても同様に走査し、条件を満たすたびに `count` を1増やす（xのカウントに加算していく）。
4. `accel.z` についても同様に走査し、条件を満たすたびに `count` を1増やす（同上）。
5. 3軸合計の `count` を `Math.min(count, 21)` で **上限21にクランプ**して返す。
   - **クランプ適用位置**: 3軸すべての走査が完了した「最後」に一度だけ適用される（軸ごとのクランプではない）。

**Step B：受信処理全体のフロー（`receiveFromApp`、850〜935行目）**

1. 受信JSON文字列をログに記録し、`JSON.parse` でパースする。
2. `volt` / `accel` / `rssi` / `num` を取り出す。
3. **BLE切断判定**：`num===0 && volt===0.0 && rssi===0 && accel.x.length+accel.y.length+accel.z.length===3` が真の場合、
   - LEDを消灯（`{r:0,g:0,b:0}`）し `stat:"BleRetry"` をネイティブアプリへ返す。
   - 切断連続カウンタ `disconnectCount` を1増やし、`bleWasDisconnected = true` にする。
   - `sendBleDisconnectToWebSocket(disconnectCount)` でサーバーへ切断通知。
   - `disconnectCount >= 5` ならアラート表示の上、カウンタをリセット。
   - **以降のcount算出・LED計算はスキップ**して関数を終了する（`return`）。
4. 直前が切断状態（`bleWasDisconnected===true`）から通常データに復帰した最初の1回だけ、`sendBleRecoveredToWebSocket` でサーバーへ復帰通知を送る。
5. `disconnectCount = 0` にリセットする（通常データを受信できた時点で切断カウンタは解除）。
6. **Step A** の `analyzeVibrationData(accel)` を呼び出し、`count`（0〜21）を得る。
7. `handleCountForWebSocket(count, {num, volt, rssi})` を呼び出し、5件バッチでのWebSocket送信を試みる（詳細はStep C）。
8. サーバー指定色 `currentColor`（`[r,g,b]`、初期値 `[0,255,0]`、WebSocket経由で更新される）をもとに、LEDのPWM値を算出する：
   ```
   r = count * 12 * Math.trunc(currentColor[0] / 255)
   g = count * 12 * Math.trunc(currentColor[1] / 255)
   b = count * 12 * Math.trunc(currentColor[2] / 255)
   ```
   `Math.trunc(colorChannel / 255)` は 0〜255の色成分を **0または1** に丸める効果を持つ（255未満は0、255ちょうどは1）。つまり `currentColor` は実質的に「どのチャンネルを点灯させるか」のオンオフマスクとして働き、実際の輝度は `count * 12`（最大 `21*12=252`）で決まる。
9. `{"LED": {r,g,b}, "stat": "OK"}` をネイティブアプリへ送信する。
10. JSON解析等で例外が発生した場合は `catch` でログのみ記録し、受信内容をそのまま画面表示する（LED送信は行われない）。

**Step C：5件バッチ送信（`handleCountForWebSocket` / `sendCountToWebSocket`、735〜781行目・660〜686行目）**

状態変数（378〜388行目で初期化）：
- `pendingCountSum = 0`：バッチ内のcount合計
- `pendingCountSize = 0`：バッチ内の件数
- `countSendPending = false`：送信リトライ中フラグ
- `pendingNumMin/Max`, `pendingVoltMin/Max`, `pendingRssiMin/Max`：バッチ内の各値の最小・最大（初期値 `null`）

手順：
1. `countSendPending` が `false`（新規バッチ蓄積中）の場合のみ、
   - `pendingCountSum` に今回の `count` を加算し、`pendingCountSize` を1増やす。
   - `num` / `volt` / `rssi` それぞれについて、`null` なら今回値で初期化、そうでなければ `Math.min`/`Math.max` で最小・最大を更新する。
   - `pendingCountSize < 5` ならこの回はまだ送信せず、蓄積のみ行って終了（`return`）。
   - 5件溜まったら `countSendPending = true` にして次の送信処理へ進む。
2. `sendCountToWebSocket(pendingCountSum, {numMin, numMax, voltMin, voltMax, rssiMin, rssiMax})` を呼び出す。
   - WebSocketが接続中（`ws.readyState === WebSocket.OPEN`）なら、
     ```json
     {
       "type": "count",
       "id": queryId,
       "count": <5件分のcount合計>,
       "num_min": ..., "num_max": ...,
       "volt_min": ..., "volt_max": ...,
       "rssi_min": ..., "rssi_max": ...,
       "ts": <送信時刻(ms)>
     }
     ```
     を送信し、`true` を返す。
   - 未接続なら送信せず `false` を返す。
3. 送信成功（`true`）の場合：`pendingCountSum`/`pendingCountSize`/`countSendPending` および min/max群をすべて初期値にリセットする。
4. 送信失敗（`false`）の場合：状態を**保持**し（`countSendPending = true` のまま）、次回の呼び出し時に同じ合計値で再送を試みる（データを失わない設計）。

### 2.4 出力の形式と送信タイミング

| 出力 | 宛先 | 送信タイミング | 形式 |
|---|---|---|---|
| LED指示 + stat | ネイティブアプリ（`sendMessageToApp`経由） | データ受信のたび（切断時／通常時のいずれも）に毎回 | `{"LED": {"r":n,"g":n,"b":n}, "stat": "OK"\|"BleRetry"}` |
| count集計 | サーバー（WebSocket） | 通常データ5件受信ごと（バッチ）。WebSocket未接続時は次回接続後にまとめて再送 | `{"type":"count", "id":queryId, "count":合計, "num_min/max":..., "volt_min/max":..., "rssi_min/max":..., "ts":ミリ秒} ` |
| BLE切断通知 | サーバー（WebSocket） | 切断パターン検知ごとに毎回 | `{"type":"ble_disconnect", "id":queryId, "consecutive":連続回数, "ts":ミリ秒}` |
| BLE復帰通知 | サーバー（WebSocket） | 切断→復帰した最初の1回のみ | `{"type":"ble_recovered", "id":queryId, "num":..., "volt":..., "rssi":..., "accel":..., "ts":ミリ秒}` |

---

## 3. 原文コード（改変なし）

### 3.1 加速度データからcountを算出する処理（783〜807行目）

```javascript
        // 加速度データの解析
        // 各軸でしきい値(絶対値25)を超えた回数を合算し、最大21に丸める
        function analyzeVibrationData(accel) {
            let count = 0;

            for (const el of accel.x) {
                if (Math.abs(el) > 25) {
                    count++;
                }
            }

            for (const el of accel.y) {
                if (Math.abs(el) > 25) {
                    count++;
                }
            }

            for (const el of accel.z) {
                if (Math.abs(el) > 25) {
                    count++;
                }
            }

            return Math.min(count, 21);
        }
```

### 3.2 `receiveFromApp` 全体（850〜935行目）

```javascript
        // アプリ (Swift / Kotlin) から呼び出される関数
        // ネイティブ側から受信したJSONを解析し、LED指示を返す
        function receiveFromApp(jsonString) {
            addLog("receiveFromApp: " + jsonString);

            try {
                const data = JSON.parse(jsonString);
                document.getElementById('received').textContent = formatKeyValuePairs(data);
                const volt = data.volt;
                const accel = data.accel;
                const rssi = data.rssi;
                const num = data.num;

                // BLE切断通知の判定
                // num/volt/rssiが0、かつ3軸データが各1件のとき切断通知とみなす
                if (num === 0 && volt === 0.0 && rssi === 0 && accel.x.length + accel.y.length + accel.z.length === 3) {
                    addLog("BLE disconnected");

                    // 切断時はLED消灯 + BleRetry を返し、ネイティブ側に再接続試行を促す
                    sendMessageToApp({
                        "LED": { "r": 0, "g": 0, "b": 0 },
                        "stat": "BleRetry"
                    });
                    disconnectCount++;
                    bleWasDisconnected = true;

                    // 切断イベントをサーバーへ通知
                    sendBleDisconnectToWebSocket(disconnectCount);

                    // 切断が連続した場合は端末確認を促す
                    if (disconnectCount >= 5) {
                        alert("BLE接続が5回切断されました。デバイスを確認してください。");
                        disconnectCount = 0;
                    }

                    // 切断通知は通常解析の対象外
                    return;
                }

                // 切断状態から通常データへ戻った最初の1回だけ復帰通知を送る
                if (bleWasDisconnected) {
                    sendBleRecoveredToWebSocket({
                        num: num,
                        volt: volt,
                        rssi: rssi,
                        accel: accel
                    });
                    bleWasDisconnected = false;
                }

                // 正常データ受信時は切断カウンタをリセット
                disconnectCount = 0;

                // 振動データを解析して強度countを算出
                const count = analyzeVibrationData(accel);

                // countは5件単位でWebSocketへ送信する
                handleCountForWebSocket(count, {
                    num: num,
                    volt: volt,
                    rssi: rssi
                });

                // サーバー指定色(currentColor)の有効チャネルだけを点灯し、countに応じてPWM値を計算
                const r = count * 12 * Math.trunc(currentColor[0] / 255)
                const g = count * 12 * Math.trunc(currentColor[1] / 255)
                const b = count * 12 * Math.trunc(currentColor[2] / 255)
                const led = { "r": r, "g": g, "b": b }

                // 処理結果をアプリに送り返す
                sendMessageToApp({
                    "LED": led,
                    "stat": "OK"
                });

            } catch (e) {
                addLog("Error parsing message: " + e.message);
                document.getElementById('received').textContent = jsonString;
                console.error('receiveFromApp error:', e);
            }
        }

        // 「終了」ボタン押下時はネイティブへ終了通知を送る
        document.getElementById('btn-end').addEventListener('click', function () {
            sendMessageToApp({ "stat": "end" });
        });
```

### 3.3 5件バッチでWebSocket送信する処理

#### 状態変数の初期宣言（378〜388行目）

```javascript
        let pendingCountSum = 0;
        let pendingCountSize = 0;
        let countSendPending = false;

        // countバッチと同じ5件単位で num/volt/rssi の最小値・最大値を保持
        let pendingNumMin = null;
        let pendingNumMax = null;
        let pendingVoltMin = null;
        let pendingVoltMax = null;
        let pendingRssiMin = null;
        let pendingRssiMax = null;
```

#### `sendCountToWebSocket`（660〜686行目）

```javascript
        // countをWebSocketへ送信
        // 送信成功可否を呼び出し元へ返し、再送制御に使う
        function sendCountToWebSocket(count, stats) {
            const payload = {
                type: 'count',
                id: queryId,
                count: count,
                num_min: stats.numMin,
                num_max: stats.numMax,
                volt_min: stats.voltMin,
                volt_max: stats.voltMax,
                rssi_min: stats.rssiMin,
                rssi_max: stats.rssiMax,
                ts: Date.now()
            };
            const countMessage = JSON.stringify(payload);

            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(countMessage);
                updateWebSocketDisplay('send', countMessage);
                addLog('Sent count via WebSocket: ' + count);
                return true;
            } else {
                addLog('WebSocket not connected. count=' + count);
                return false;
            }
        }
```

#### `handleCountForWebSocket`（735〜781行目）

```javascript
        // count値を5件分まとめて送信する制御
        // 未接続時は保持し、接続復帰後に同じ合計値を送る
        function handleCountForWebSocket(count, sensorInfo) {
            if (!countSendPending) {
                pendingCountSum += count;
                pendingCountSize += 1;

            // 5件バッチ内の最小値・最大値を逐次更新
            pendingNumMin = pendingNumMin === null ? sensorInfo.num : Math.min(pendingNumMin, sensorInfo.num);
            pendingNumMax = pendingNumMax === null ? sensorInfo.num : Math.max(pendingNumMax, sensorInfo.num);
            pendingVoltMin = pendingVoltMin === null ? sensorInfo.volt : Math.min(pendingVoltMin, sensorInfo.volt);
            pendingVoltMax = pendingVoltMax === null ? sensorInfo.volt : Math.max(pendingVoltMax, sensorInfo.volt);
            pendingRssiMin = pendingRssiMin === null ? sensorInfo.rssi : Math.min(pendingRssiMin, sensorInfo.rssi);
            pendingRssiMax = pendingRssiMax === null ? sensorInfo.rssi : Math.max(pendingRssiMax, sensorInfo.rssi);
                updatePendingCountDisplay();

                if (pendingCountSize < 5) {
                    addLog('Accumulating count batch: ' + pendingCountSize + '/5, sum=' + pendingCountSum);
                    return;
                }

                countSendPending = true;
            }

            const sent = sendCountToWebSocket(pendingCountSum, {
                numMin: pendingNumMin,
                numMax: pendingNumMax,
                voltMin: pendingVoltMin,
                voltMax: pendingVoltMax,
                rssiMin: pendingRssiMin,
                rssiMax: pendingRssiMax
            });
            if (sent) {
                pendingCountSum = 0;
                pendingCountSize = 0;
                countSendPending = false;
                pendingNumMin = null;
                pendingNumMax = null;
                pendingVoltMin = null;
                pendingVoltMax = null;
                pendingRssiMin = null;
                pendingRssiMax = null;
                updatePendingCountDisplay();
            } else {
                addLog('Pending count sum retained until send succeeds: ' + pendingCountSum);
            }
        }
```

---

## 4. 補足・注意点

- `count` の意味は「加速度x/y/z合計サンプルのうち、絶対値25を超えたサンプルの個数（最大21）」であり、時間窓ではなく**1回の受信データ（約1秒分）内での閾値超過回数**である。
- LED出力の輝度計算 `count * 12 * Math.trunc(currentColor[ch] / 255)` は、`currentColor` の各チャンネルが255未満であれば常に0となり、255の場合のみ `count * 12` がそのまま出力される、という「オンオフマスク＋輝度」構造になっている点は実装依存の挙動であり、他の色指定値（例: 128）が来た場合は消灯扱いになる。
- 5件バッチ送信はWebSocket切断時に**送信をスキップして状態を保持**し、次に呼ばれたタイミングで再送を試みる設計。バッチが5件溜まった後も接続が回復しない限り、`pendingCountSum` はリセットされず加算もされない（`countSendPending===true` の間は蓄積処理自体がスキップされる）。
