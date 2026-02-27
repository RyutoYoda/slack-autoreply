// Background script for Ollama API calls (Qwen3)

const LOG_PREFIX = 'SLACK-AI:';
const OLLAMA_URL = 'http://localhost:11434';
const MODEL_NAME = 'qwen3:8b';

function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'generateAutoReply') {
    log('Received generateAutoReply request');
    generateAutoReply(request.messageText, request.surroundingMessages, request.senderName)
      .then(result => {
        log('Sending auto-reply result back:', result);
        sendResponse(result);
      })
      .catch(error => {
        console.error(LOG_PREFIX, 'Auto-reply error:', error);
        sendResponse({ reply: null, error: error.message });
      });
    return true;
  }

  if (request.action === 'testOllamaConnection') {
    log('Testing Ollama connection');
    testOllamaConnection()
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
});

async function testOllamaConnection() {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!response.ok) {
      return { success: false, error: 'Ollama is not running' };
    }
    const data = await response.json();
    const models = data.models || [];
    const hasQwen = models.some(m => m.name.includes('qwen3'));

    if (!hasQwen) {
      return { success: false, error: 'Qwen3 model not found. Run: ollama pull qwen3:8b' };
    }

    return { success: true, models: models.map(m => m.name) };
  } catch (error) {
    return { success: false, error: 'Cannot connect to Ollama. Run: brew services start ollama' };
  }
}

async function generateAutoReply(messageText, surroundingMessages, senderName) {
  log('generateAutoReply called with:', { messageText: messageText?.substring(0, 50), senderName });

  const prompt = `あなたは私の代わりにSlackで返信を書きます。私になりきって、自然な返信を作成してください。

【状況】
${senderName}さんから以下のメッセージが届きました。
${surroundingMessages ? `\n【会話の流れ】\n${surroundingMessages}\n` : ''}
【受信メッセージ】
${messageText}

【返信ルール】
- ビジネスカジュアル（丁寧だけど堅すぎない、普段の仕事のやり取り風）
- 「です・ます」調、でも「〜ですね！」「承知です！」のような柔らかさOK
- 1〜2文で簡潔に
- 質問には「確認します」「〇〇ですね」など具体的に反応
- 依頼には「承知です」「対応します」など明確に応答
- 挨拶・報告には「ありがとうございます」「確認しました」など
- 不明点があれば素直に聞き返す
- 絵文字は使わない

返信文のみ出力（説明不要）:`;

  log(`Calling Ollama API with model ${MODEL_NAME}...`);

  try {
    const response = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL_NAME,
        prompt: prompt,
        stream: false,
        think: false,
        options: {
          temperature: 0.7,
          num_predict: 300
        }
      })
    });

    log('Response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(LOG_PREFIX, 'Ollama API error:', response.status, errorText);
      return { reply: null, error: `API error ${response.status}: ${errorText}` };
    }

    const data = await response.json();
    log('Ollama response:', JSON.stringify(data).substring(0, 300));

    let content = data.response || '';

    // Clean up: remove thinking tags if present (Qwen3 sometimes adds these)
    content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    content = content.replace(/<\/think>/g, '').trim();

    // If response is empty but thinking exists, log warning
    if (!content && data.thinking) {
      log('Warning: Response empty but thinking present, increasing num_predict may help');
    }

    log('Auto-reply content:', content);

    return {
      reply: content.trim()
    };
  } catch (error) {
    console.error(LOG_PREFIX, 'Fetch error:', error);
    return { reply: null, error: error.message };
  }
}
