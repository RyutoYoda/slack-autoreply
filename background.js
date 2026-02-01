// Background script for OpenAI API calls

// Log prefix for filtering - use "SLE:" in browser console filter
const LOG_PREFIX = 'SLE:';
function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'callOpenAI') {
    log('Received callOpenAI request');
    callOpenAI(request.apiKey, request.message, request.surroundingMessages)
      .then(result => {
        log('Sending result back:', result);
        sendResponse(result);
      })
      .catch(error => {
        console.error(LOG_PREFIX, 'OpenAI error:', error);
        sendResponse({ title: '', detail: '', error: error.message });
      });
    return true; // Keep message channel open for async response
  }

  if (request.action === 'generateAutoReply') {
    log('Received generateAutoReply request');
    generateAutoReply(request.apiKey, request.messageText, request.surroundingMessages, request.senderName)
      .then(result => {
        log('Sending auto-reply result back:', result);
        sendResponse(result);
      })
      .catch(error => {
        console.error(LOG_PREFIX, 'Auto-reply error:', error);
        sendResponse({ reply: null, error: error.message });
      });
    return true; // Keep message channel open for async response
  }
});

async function callOpenAI(apiKey, message, surroundingMessages) {
  const prompt = `以下はSlackで「後で」に保存されたメッセージとその前後の会話です。このメッセージに対するネクストアクション（次にやるべきこと）を分析してください。

【対象メッセージ】
${message}

【前後の会話】
${surroundingMessages}

以下のJSON形式で回答してください（日本語で）:
{
  "title": "ネクストアクションのタイトル（20文字以内の簡潔な要約）",
  "detail": "ネクストアクションの詳細（具体的な行動内容を50-100文字程度で）"
}`;

  log('Calling OpenAI API with model gpt-5.2...');

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-5.2',
        messages: [
          {
            role: 'system',
            content: 'あなたはタスク管理のアシスタントです。Slackのメッセージから次にやるべきアクションを提案します。JSON形式で回答してください。'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.7,
        max_completion_tokens: 200
      })
    });

    log('Response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(LOG_PREFIX, 'OpenAI API error:', response.status, errorText);
      return { title: '', detail: '', error: `API error ${response.status}: ${errorText}` };
    }

    const data = await response.json();
    log('OpenAI response data:', JSON.stringify(data).substring(0, 200));
    const content = data.choices?.[0]?.message?.content || '';
    log('Response content:', content);

    // Parse JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      log('Parsed result:', parsed);
      return {
        title: parsed.title || '',
        detail: parsed.detail || ''
      };
    }

    log('No JSON found in response');
    return { title: '', detail: '', error: 'No JSON in response' };
  } catch (error) {
    console.error(LOG_PREFIX, 'Fetch error:', error);
    return { title: '', detail: '', error: error.message };
  }
}

async function generateAutoReply(apiKey, messageText, surroundingMessages, senderName) {
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

  log('Calling OpenAI API for auto-reply with model gpt-4...');

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4',
        messages: [
          {
            role: 'system',
            content: 'あなたはSlackの自動返信アシスタントです。メッセージに対して適切で簡潔な返信を日本語で生成します。'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.7,
        max_completion_tokens: 150
      })
    });

    log('Auto-reply response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(LOG_PREFIX, 'OpenAI API error:', response.status, errorText);
      return { reply: null, error: `API error ${response.status}: ${errorText}` };
    }

    const data = await response.json();
    log('Auto-reply response data:', JSON.stringify(data).substring(0, 200));
    const content = data.choices?.[0]?.message?.content || '';
    log('Auto-reply content:', content);

    return {
      reply: content.trim()
    };
  } catch (error) {
    console.error(LOG_PREFIX, 'Fetch error:', error);
    return { reply: null, error: error.message };
  }
}
