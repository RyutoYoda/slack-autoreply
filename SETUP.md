# Slack自動返信 セットアップ手順（Qwen3 + Ollama）

## 完了した作業

```bash
# 1. Ollamaインストール
brew install ollama

# 2. Ollamaサービス起動
brew services start ollama

# 3. Qwen3モデルダウンロード（8B、約5GB）
ollama pull qwen3:8b

# 4. Chrome拡張をOllama対応に修正済み
```

## Chrome拡張のインストール

```bash
# 1. Chromeで以下を開く
chrome://extensions/

# 2. 右上の「デベロッパーモード」をオン

# 3. 「パッケージ化されていない拡張機能を読み込む」をクリック

# 4. このフォルダを選択
/Users/s27928/slack-autoreply
```

## 使い方

1. Chromeの拡張機能アイコンをクリック
2. 「接続テスト」でOllamaが動作していることを確認
3. 「自動返信を有効化」をオン
4. Slackを開いてメンションされると自動返信

## 確認コマンド

```bash
# Ollamaサービス状態確認
brew services list | grep ollama

# インストール済みモデル確認
ollama list

# Qwen3動作テスト
ollama run qwen3:8b "こんにちは"

# Ollama API動作テスト
curl http://localhost:11434/api/generate -d '{
  "model": "qwen3:8b",
  "prompt": "こんにちは",
  "stream": false
}'
```

## Ollamaサービス管理

```bash
# 起動（CORS有効化必須）
OLLAMA_ORIGINS="*" ollama serve

# または、バックグラウンドで起動
OLLAMA_ORIGINS="*" ollama serve &

# 停止
pkill ollama
```

**注意**: `brew services start ollama` では CORS が有効にならないため、手動で起動する必要があります。

## トラブルシューティング

```bash
# ログ確認
tail -f ~/.ollama/logs/server.log

# ポート確認（11434）
lsof -i :11434

# モデル再ダウンロード
ollama pull qwen3:8b --force

# Chrome拡張を再読み込み
# chrome://extensions/ で拡張機能の更新ボタンをクリック
```

## 変更したファイル

- `manifest.json` - Ollama接続許可を追加、バージョン2.0
- `background.js` - OpenAI API → Ollama APIに変更
- `content.js` - APIキー不要に変更
- `popup.html` - APIキー入力 → 接続テストボタンに変更
- `popup.js` - Ollama接続テスト機能追加
