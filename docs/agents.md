# 外部エージェント運用メモ

plan.md 実装を回す際のサブエージェント呼び出し手順と既知の問題。最終更新: 2026-09-05。

## 原則

- opencode Task 機能 (`explore` / `general`) が第一選択。ただしモデル指定欄がなく、
  セッションと同一モデルで動く。z.ai / codex モデルへの振り分けはできない。
- 2026-09-05 時点で Task 機能はセッションDB insert 失敗で起動できない。
  復旧するまで CLI 委譲か直接実装で進める。

## claude 経由で z.ai モデルを使う場合

`claude -p --model <model>` では z.ai 系モデル名 (`glm-5.3-flash` 等) が
`[claude-code:unrecognized_model]` で解決できない。opencode 管理のモデルを使う:

```bash
opencode run -m zai/glm-5.3-flash --dir /home/ubuntu/qstyle "指示..."
```

注意:

- z.ai は残高不足だと `429 Insufficient balance or no resource package` で失敗する。
  失敗時はチャージ待ち (別モデルに切替)。
- `claude -p` に長いプロンプトを引数で渡すと
  `Input must be provided either through stdin or as a prompt argument` になる。
  プロンプトはファイルに書いて stdin リダイレクトで渡す:

```bash
claude -p --allow-dangerously-skip-permissions --add-dir /home/ubuntu/qstyle < /tmp/opencode/prompt.txt
```

- サンドボックス/権限: 非対話 (`-p`) でファイル編集させる場合は
  `--allow-dangerously-skip-permissions` が必要。これを付けないと権限確認で
  停止し、そのままタイムアウトまで無出力になる (2026-09-05 に 10 分 stall を確認)。
  `--add-dir` で作業ディレクトリを明示する。

## タイムアウトの扱い

- ホスト権限 (sandbox 無効) で実行しても、モデルの実行時間自体は短くならない。
  タイムアウト回避にはバックグラウンド実行 + ポーリングを使う:

```bash
nohup claude -p --allow-dangerously-skip-permissions \
  --add-dir /home/ubuntu/qstyle < /tmp/opencode/prompt.txt \
  > /tmp/opencode/agent.log 2>&1 &
echo $! > /tmp/opencode/agent.pid
# ポーリング
tail -5 /tmp/opencode/agent.log
git diff --stat  # 無編集が続く場合は kill して再投球 (luna 等へ)
```

- `codex exec` は 90〜120 秒程度で応答するが、利用上限に達すると
  `You've hit your usage limit ... try again at ...` になる。期限までは使えない。

## ACP について

- `opencode acp` はエディタ連携用の ACP サーバ起動であり、モデル指定付きの
  サブエージェント派遣手段ではない。派遣は `opencode run -m` か Task 機能を使う。

## 委譲時の契約 (毎回プロンプトに含める)

1. 1 件 = 1 単位。whitelist 外のファイルは編集禁止。コミット禁止。
2. 完了報告は (1) 変更ファイル (2) 概要+テスト結果 (3) uncertainties。
3. 終了前に `build / typecheck / test` を自走させて green を確認する。
4. 中央で再検証してからコミットする (成果物を信用しない)。
