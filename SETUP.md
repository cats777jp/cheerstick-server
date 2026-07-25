# 導入手順（初回のみ・15分程度）

## 1. ファイルを配置する

このキットの中身を `C:\Projects\cheerstick-server` 直下にコピーします。

```
C:\Projects\cheerstick-server\
├── CLAUDE.md                              ← 新規（Claude Codeが毎回自動で読む）
├── docs\
│   ├── spec.md                            ← 新規（仕様の正本）
│   ├── runbook.md                         ← 新規（環境情報）
│   ├── worklog.md                         ← 新規（作業記録）
│   └── archive\
│       ├── 推しフルシステムの仕様書20260630.pdf   ← 既存PDFをここへ
│       ├── handover-v14-20260723.md              ← 既存の引継ぎ書をここへ
│       └── handover-audit-20260723.md            ← 監査結果をここへ
└── .claude\
    └── skills\
        └── handover\
            └── SKILL.md                   ← 新規（/handover コマンド）
```

※ `.claude` は先頭がピリオドのフォルダです。エクスプローラーで作れない場合は
　 Claude Code に「.claude/skills/handover/SKILL.md を作って」と頼めば作成できます。

## 2. コミットする

```bash
cd C:\Projects\cheerstick-server
git add CLAUDE.md docs/ .claude/
git commit -m "docs: 引継ぎドキュメントをリポジトリ管理へ移行"
git push
```

## 3. 動作確認する

Claude Code を起動し、以下を実行します。

```
/context
```

**Memory files** の欄に `CLAUDE.md` が表示されていれば読み込み成功です。
表示されない場合は、Claude Code をリポジトリのルート（`C:\Projects\cheerstick-server`）
から起動しているか確認してください。

続いて `/` を入力し、コマンド一覧に `handover` が出ることを確認します。

## 4. 以後の運用

| タイミング | やること |
|---|---|
| セッション開始時 | 何もしなくてよい（CLAUDE.mdが自動で読まれ、docsを読む指示が入る） |
| 作業中 | 通常どおり |
| セッション終了時 | `/handover` と入力する |

`/handover` を実行すると、Claude Code が作業内容を `docs/` に反映し、
削除行が発生していないかを確認したうえで、`docs:` プレフィックス付きの
単独コミットを作成します。

## 5. 月1回程度おすすめしたい確認

```bash
git log --oneline -- docs/spec.md
git diff HEAD~5 -- docs/spec.md
```

仕様書から意図せず記述が消えていないか、差分で目視確認してください。
今回のカテゴリー機能消失は、この確認があれば防げた種類の事故です。

---

## 補足：なぜこの3段構えなのか

`CLAUDE.md` は「毎回読ませる指示書」であって、システムが強制する設定ではありません。
指示が曖昧だと従わないことがあります。そこで、

1. **CLAUDE.md** … ルールを常時読ませる（土台）
2. **/handover** … 終了時に明示的に起動する（実行の確実性）
3. **git diff** … 消えた行が数字で見える（人間による最終確認）

の3段構えにしています。3が入っていることが重要で、
1と2が万一機能しなくても、削除は必ず差分に現れます。
