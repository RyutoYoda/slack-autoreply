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

  const prompt = `あなたはSlackで自動返信を行うアシスタントです。以下のメッセージに対して、適切な返信を日本語で生成してください。

【送信者】
${senderName}

【メッセージ】
${messageText}

${surroundingMessages ? `【前後の会話】\n${surroundingMessages}` : ''}

返信のガイドライン:
- 簡潔に(1-3文程度)
- 丁寧な口調で
- 質問には具体的に答える
- 必要に応じて確認や追加情報を求める
- 返信文のみを出力し、説明文は不要

返信:`;

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
        options: {
          temperature: 0.7,
          num_predict: 150
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
    log('Ollama response:', JSON.stringify(data).substring(0, 200));

    let content = data.response || '';

    // Clean up: remove thinking tags if present (Qwen3 sometimes adds these)
    content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    log('Auto-reply content:', content);

    return {
      reply: content.trim()
    };
  } catch (error) {
    console.error(LOG_PREFIX, 'Fetch error:', error);
    return { reply: null, error: error.message };
  }
}
