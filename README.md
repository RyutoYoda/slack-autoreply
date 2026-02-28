# Slack AI Auto-Reply (Qwen3 + Ollama)

<img src="https://img.shields.io/badge/Chrome_Extension-4285F4?style=flat&logo=googlechrome&logoColor=white" /> <img src="https://img.shields.io/badge/JavaScript-F7DF1E?style=flat&logo=javascript&logoColor=black" /> <img src="https://img.shields.io/badge/Ollama-000000?style=flat&logo=ollama&logoColor=white" /> <img src="https://img.shields.io/badge/Qwen3-7C3AED?style=flat&logoColor=white" /> <img src="https://img.shields.io/badge/macOS-000000?style=flat&logo=apple&logoColor=white" />

ローカルLLM（Qwen3）を使ったSlack自動返信Chrome拡張機能。ローカル動作。

<img width="358" height="586" alt="スクリーンショット 2026-02-28 9 12 01" src="https://github.com/user-attachments/assets/3f97cadd-7b82-4a3f-8da9-b9fdcdeed896" />

## 機能

- Slackのメンションタブでメンションを検知
- ローカルLLM（Qwen3）で自然な返信を自動生成
- スレッド全体の文脈を理解して返信
- 自動送信 or 下書き作成を選択可能
- アプリからのメンションは自動スキップ
- 自分宛ての最新メンションのみに返信
- 必ずスレッド内で返信

## セットアップ手順

### 1. リポジトリをクローン

```bash
git clone https://github.com/RyutoYoda/slack-autoreply.git
cd slack-autoreply
```

### 2. Ollamaをインストール

```bash
# macOS
brew install ollama

# または公式サイトからダウンロード
# https://ollama.com/download
```

### 3. Qwen3モデルをダウンロード

```bash
ollama pull qwen3:8b
```

※ 約5GBのダウンロードが必要です

### 4. OllamaをCORS有効で起動

```bash
OLLAMA_ORIGINS="*" ollama serve
```

**重要**: `brew services start ollama` ではCORSが有効にならないため、上記コマンドで起動してください。

### 5. Chrome拡張機能をインストール

1. Chromeで `chrome://extensions/` を開く
2. 右上の「デベロッパーモード」をオン
3. 「パッケージ化されていない拡張機能を読み込む」をクリック
4. クローンした `slack-autoreply` フォルダを選択

## 使い方

1. Chromeツールバーの拡張機能アイコンをクリック
2. 「接続テスト」ボタンでOllamaが動作していることを確認
3. 「自動返信を有効化」をオン
4. Slackを開き、**アクティビティ → メンションタブ**を表示
5. メンションが来ると自動で返信を生成

### モード

- **自動送信オフ**: 下書きを作成（確認してから手動送信）
- **自動送信オン**: 自動で送信まで実行

## 動作の仕組み

1. メンションタブの最新メッセージをチェック
2. アプリからのメッセージはスキップ
3. 自分宛てのメンションを検知したらスレッドを開く
4. スレッド全体を読んで文脈を理解
5. Qwen3で返信を生成
6. スレッド内に返信を入力（自動送信オンなら送信まで）
7. スレッドパネルを閉じる

## トラブルシューティング

### Ollamaに接続できない

```bash
# Ollamaが起動しているか確認
lsof -i :11434

# CORS有効で再起動
pkill ollama
OLLAMA_ORIGINS="*" ollama serve
```

### モデルが見つからない

```bash
# インストール済みモデル確認
ollama list

# 再ダウンロード
ollama pull qwen3:8b
```

### 拡張機能が動作しない

1. `chrome://extensions/` で拡張機能を再読み込み（更新ボタン）
2. Slackページをリロード
3. コンソール（F12）で `SLACK-AI:` のログを確認

## ファイル構成

```
slack-autoreply/
├── manifest.json    # Chrome拡張の設定
├── background.js    # Ollama API呼び出し
├── content.js       # Slack DOM操作・メンション検知
├── popup.html       # 拡張機能のUI
├── popup.js         # ポップアップの動作
├── README.md        # このファイル
└── LICENSE          # MITライセンス
```

## 技術スタック

- Chrome Extension Manifest V3
- Ollama + Qwen3:8b (ローカルLLM)
- Vanilla JavaScript

## 注意事項

- 本拡張機能は個人利用を想定しています
- Slackの利用規約を確認の上、自己責任でご使用ください
- 自動送信を有効にする場合は、生成される返信内容に注意してください

## License

MIT License - 詳細は [LICENSE](LICENSE) を参照
