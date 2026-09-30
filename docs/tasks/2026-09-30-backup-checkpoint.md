# 定期バックアップ（コード・DB・画像）手順書

作成日：2026-09-30
対象：岩村様（TeraTermでの手動実行。本番EC2へのSSH・実行はすべて岩村様が行う）
関連：`cheerstick-backup-checkpoint-20260930.md`（指示書）、
　　　`docs/runbook.md`「リポジトリバックアップ手順（gitタグ方式）」「アップロード画像のバックアップ」

---

## 0. 前提

- 目的：トラックBの検討に入る前の区切りとして、本番環境のバックアップを取得する。
  2026-09-28〜29に4件の反映（トラックA、ゲージ調整、デモモード機能、BLE切断記録）を
  行った直後のタイミング
- 本番の現在のHEAD：`44bf748`（2026-09-29、BLE切断記録機能を反映済み）
- **本手順の範囲は、バックアップの取得のみ。コード・設定の変更は一切行わない。**
  STEP 1〜2はローカルPC、STEP 3〜5は本番EC2での実行（いずれも読み取り、またはバックアップ
  ファイルの新規作成のみ）
- タグ名：`feature-reference-data-20260930ver`
  （`<ブランチ名の/を-に変換>-<YYYYMMDDver>`。既存タグは`...-20260913ver`／`-20260920ver`／
  `-20260923ver`で、同名の衝突は無いことを確認済み）
- STEP 2でタグが指すのは、本手順書のコミット（`docs:`単独コミット）を含む、その時点の
  `feature/reference-data`のHEAD。`44bf748`より新しくなるが、差分は`docs/`のみ
  （本番デプロイ済みのコードと同一）

### 作成時点のローカル状態確認（Claude Codeが実施済み）

```
$ git status --short
?? cheerstick-ws          ← 未追跡（runbook「未確認・保留中のファイル」記載の下書き。今回は対象外）
$ git log --oneline -3
44bf748 docs: BLE切断のサーバー記録機能の本番反映手順書を作成
c9e5466 docs: BLE切断のサーバー記録・LED送信調査結果を記録
7f0d35c feat: BLE切断のサーバー通知・記録を実装
$ git fetch origin && git log feature/reference-data..origin/feature/reference-data --oneline
（空）
$ git log origin/feature/reference-data..feature/reference-data --oneline
（空）
```

未コミット・未pushの変更は無し。ローカルとoriginは完全一致（本手順書のコミット前）。

---

## STEP 1：ローカルの最終確認（ローカルPC）

```bash
cd C:\Projects\cheerstick-server
git fetch origin
git log feature/reference-data..origin/feature/reference-data --oneline
git log origin/feature/reference-data..feature/reference-data --oneline
```

- **両方とも出力が空**であること（ローカルとoriginが完全一致）
- 差分が出た場合はタグを打たず、Claude Codeへ報告する（ズレたまま打つと
  「バックアップのつもりが古い/新しい版だった」事故になる）

## STEP 2：gitタグの作成・push（ローカルPC）

```bash
git tag feature-reference-data-20260930ver feature/reference-data
git push origin feature-reference-data-20260930ver
git ls-remote --tags origin feature-reference-data-20260930ver
```

- `ls-remote`の出力が1行返り、そのハッシュが `git rev-parse feature/reference-data` の
  結果と一致すること（`44bf748`より新しい、本手順書のコミットを指す）
- タグ名の後ろにブランチ名を明示しているのは、runbookの標準手順に合わせ、
  現在チェックアウト中のブランチに依存しないため

## STEP 3：本番DBバックアップ（本番EC2）

```bash
mkdir -p ~/backups
FILE=~/backups/cheerstick_production_$(date +%Y%m%d_%H%M%S).sql
sudo -u postgres pg_dump cheerstick_production > $FILE
ls -la $FILE
```

- サイズが**非ゼロ**であること。直近の反映時が約13.7MBだったので、**それ以上**が目安
  （応援ログの蓄積で通常は増える。大きく下回る場合は異常の可能性があるため報告する）
- ファイル名・サイズを控える（worklog記録用）

## STEP 4：アップロード画像のバックアップ（本番EC2）

まず`uploads/`の中身を確認する（空かどうかを事前に把握するため）：

```bash
ls -la /var/www/cheerstick-app/images/uploads | head -20
du -sh /var/www/cheerstick-app/images/uploads
```

そのうえでバックアップを取得する：

```bash
mkdir -p ~/backups
FILE=~/backups/cheerstick_uploads_$(date +%Y%m%d_%H%M%S).tar.gz
tar czf $FILE -C /var/www/cheerstick-app/images uploads
ls -la $FILE
```

- `uploads/`が空の場合、tar.gzはほぼ0バイト（数百バイト程度）になる。**それ自体は異常ではない。**
  事前確認の結果（空／N件）とあわせて控える
- ファイル名・サイズを控える

## STEP 5：バックアップ一覧の確認（本番EC2）

```bash
ls -la ~/backups/
du -sh ~/backups/
df -h /
```

- 今回作成した、DBダンプ（STEP 3）と画像のtar.gz（STEP 4）が**両方とも存在する**こと
- 過去のバックアップの蓄積状況（ファイル数・合計サイズ）と、`/`の空き容量を報告する
  （ディスクを圧迫していないかの目安。本番はEC2上にPostgreSQLも同居しているため）

---

## STEP 6：リカバリー手順（万が一の際の復元方法）

**いずれも実際に実施する前に、KMT様と方針を相談すること。** 本書は手順の記録であり、
実行の承認ではない。

### コードの復元

ローカルPCでの取得：

```bash
git fetch origin
git checkout feature-reference-data-20260930ver   # detached HEADになる。閲覧・比較用
```

本番EC2上でこのタグの状態に戻す場合（過去のロールバック・反映時の方式に倣い、
`git pull`ではなく`git reset --hard`を使う。`docs/worklog.md` 2026-09-24エントリ参照）：

```bash
cd /home/ubuntu/cheerstick-server-new
git fetch origin --tags
git reset --hard feature-reference-data-20260930ver
git log --oneline -1                         # タグの指すコミットになったことを確認
```

コード復元後に**必ず追加で必要な作業**（`git reset`だけでは本番に反映されない）：

1. 静的ファイルの2箇所配置：`docs/runbook.md`「デプロイ手順」の`cp`と、直後の`diff`確認・
   新規ファイルの所有者確認を実施する
2. `pm2 restart cheerstick-server`
3. `package.json`が復元先と現在で異なる場合のみ`npm install`
4. **DBのスキーマ（マイグレーション）はコードの`reset`では戻らない。** 復元先より
   後に追加されたマイグレーションのテーブル・列はそのまま残る（通常は残っていても
   古いコードが参照しないだけで動作に支障は無いが、要確認）

### DBの復元

```bash
# 本番EC2上。既存のDBの状態を必ず確認してから実施すること（上書きに注意）
sudo -u postgres psql -d cheerstick_production < ~/backups/cheerstick_production_<日時>.sql
```

> **注意：これは「空のDB」へリストアする手順である。** 既存のデータが入っている状態で
> そのまま流すと、**エラー（既存オブジェクトとの衝突）になる、またはデータが重複する
> 可能性がある。** 実際にリストアが必要になった場合は、**事前にKMT様と方法
> （DBを作り直すか、個別のテーブルのみ戻すか）を相談してから実施すること。**
> 本番DBに対してこのコマンドを独断で実行しない。

### 画像の復元

```bash
# 本番EC2上
tar xzf ~/backups/cheerstick_uploads_<日時>.tar.gz -C /var/www/cheerstick-app/images
```

- 同名ファイルは上書きされる。実行前に`ls -la /var/www/cheerstick-app/images/uploads`で
  現状を確認する
- 展開後、所有者が`ubuntu:ubuntu`であることを確認する（`ls -la`。`root`で展開した場合は
  `docs/runbook.md`「新規ファイルをコピーした場合は所有者も確認する」に倣い`chown`する）

---

## 完了後の報告（岩村様→Claude Code）

Claude Codeが`docs/worklog.md`へ実績を記録するため、以下を共有する：

- STEP 2：`git ls-remote`の出力（タグ名とコミットハッシュ）
- STEP 3：DBダンプのファイル名とサイズ
- STEP 4：`uploads/`の事前確認結果（空／件数）、tar.gzのファイル名とサイズ
- STEP 5：`~/backups/`の蓄積状況（ファイル数・合計サイズ）と`df -h /`の空き容量
- 実施日時
