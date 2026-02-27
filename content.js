// Slack AI Auto-Reply - Content Script
console.log('=== SLACK-AI EXTENSION LOADED ===');

// Log prefix for filtering
const LOG_PREFIX = 'SLACK-AI:';
function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

// 即座にログ出力
log('Content script starting...');

// Auto-reply state
let autoReplyEnabled = false;
let autoSendEnabled = false;
let messageObserver = null;
let activityObserver = null;
let currentUserId = null;
let processedMessages = new Set();
let processedActivityItems = new Set();
let pendingReply = null; // アクティビティから遷移後に返信するための情報

// テストモード: 自分のメンションでも動作する（本番はfalse）
const TEST_MODE = false;

// アクティビティ監視用のObserver
let activityListObserver = null;
let activityScanInterval = null;

// 定期スキャンの間隔（ミリ秒）- 0で無効
const ACTIVITY_SCAN_INTERVAL = 30000; // 30秒

// 前回チェックした一番上のアクティビティのキー
let lastTopActivityKey = null;

// 1回のスキャンで処理するメンションの最大数（最新1件のみ）
const MAX_MENTIONS_PER_SCAN = 1;

// Listen for toggle auto-reply message from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'toggleAutoReply') {
    autoReplyEnabled = request.enabled;
    autoSendEnabled = request.autoSend !== undefined ? request.autoSend : false;

    log(`Auto-reply ${autoReplyEnabled ? 'enabled' : 'disabled'} (auto-send: ${autoSendEnabled})`);

    if (autoReplyEnabled) {
      initAutoReply();
    } else {
      stopAutoReply();
    }
    sendResponse({ success: true });
  }
});

// Initialize auto-reply on page load if enabled
chrome.storage.local.get(['autoReplyEnabled', 'autoSendEnabled'], (result) => {
  if (result.autoReplyEnabled) {
    autoReplyEnabled = true;
    autoSendEnabled = result.autoSendEnabled || false;
    log('Auto-reply enabled from storage');

    // Wait for Slack to load
    setTimeout(() => {
      initAutoReply();
    }, 3000);
  }
});

function initAutoReply() {
  log('Initializing auto-reply...');

  // Get current user ID
  getCurrentUserId();

  // Start observing for new messages
  startMessageObserver();

  // アクティビティ画面の監視を開始
  startActivityMonitor();

  // TEST_MODE: 既存メッセージもスキャン（5秒後）
  if (TEST_MODE) {
    setTimeout(() => {
      log('[TEST MODE] Scanning existing messages...');
      scanExistingMessages();
    }, 5000);
  }

  // ページ遷移後の返信処理をチェック
  checkPendingReply();
}

// アクティビティ画面かどうかを判定
function isActivityPage() {
  return document.querySelector('.p-activity_ia4_page__item_container') !== null ||
         document.querySelector('[data-qa="activity-item-container"]') !== null;
}

// メンションタブが選択されているかを判定
function isMentionsTabActive() {
  // メンションタブがアクティブかチェック
  const mentionsTab = document.querySelector('[data-qa="mentions-tab"][aria-selected="true"]') ||
                      document.querySelector('button[aria-selected="true"]:has-text("メンション")') ||
                      document.querySelector('.p-activity_ia4_page__tab--selected[data-tab="mentions"]');
  return mentionsTab !== null;
}

// アクティビティ画面の監視を開始
function startActivityMonitor() {
  log('Starting activity monitor...');

  // === 1. イベント駆動: 新しいメンションが来たら即反応 ===
  const setupActivityObserver = () => {
    if (activityListObserver) {
      activityListObserver.disconnect();
    }

    const activityList = document.querySelector('.p-activity_ia4_page__item_container') ||
                         document.querySelector('[data-qa="activity-list"]') ||
                         document.querySelector('.p-activity_ia4_page');

    if (!activityList) {
      setTimeout(setupActivityObserver, 2000);
      return;
    }

    log('[ACTIVITY] Event listener ready - waiting for new mentions...');

    activityListObserver = new MutationObserver((mutations) => {
      if (!autoReplyEnabled) return;

      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          log('[ACTIVITY] New mention detected!');
          setTimeout(() => scanActivityMentions(), 500);
          break;
        }
      }
    });

    activityListObserver.observe(activityList, {
      childList: true,
      subtree: true
    });
  };

  // ページ変更を監視
  const pageObserver = new MutationObserver(() => {
    if (isActivityPage() && !activityListObserver) {
      setupActivityObserver();
    }
  });

  pageObserver.observe(document.body, { childList: true, subtree: true });

  if (isActivityPage()) {
    setupActivityObserver();
  }

  // === 2. 定期スキャン: テスト用（ACTIVITY_SCAN_INTERVAL > 0 の場合のみ） ===
  if (ACTIVITY_SCAN_INTERVAL > 0) {
    log(`[ACTIVITY] Periodic scan enabled: every ${ACTIVITY_SCAN_INTERVAL / 1000}s`);
    activityScanInterval = setInterval(() => {
      if (autoReplyEnabled && isActivityPage()) {
        log('[ACTIVITY] Periodic scan...');
        scanActivityMentions();
      }
    }, ACTIVITY_SCAN_INTERVAL);
  }
}

// アクティビティ画面のメンションをスキャン（最新1件のみ）
async function scanActivityMentions() {
  log('[ACTIVITY] Checking top activity...');

  // アクティビティアイテムを取得
  const activityItems = document.querySelectorAll('[data-qa="activity-item-container"]');

  if (activityItems.length === 0) {
    log('[ACTIVITY] No activity items found');
    return;
  }

  // 一番上を取得（アプリなら次を「一番上」とする）
  let item = activityItems[0];
  let itemKey = item.closest('[data-item-key]')?.getAttribute('data-item-key');

  // アプリかチェック
  const isApp = item.querySelector('.c-app_icon, [data-qa="app-icon"], .p-activity_ia4_page__item__app_icon') ||
                item.querySelector('[data-qa="activity-item-sender-app"]');

  if (isApp && activityItems.length > 1) {
    log('[ACTIVITY] Top is app, using next as top');
    item = activityItems[1];
    itemKey = item.closest('[data-item-key]')?.getAttribute('data-item-key');
  }

  // 前回と同じなら何もしない
  if (itemKey === lastTopActivityKey) {
    log('[ACTIVITY] Same as last, skipping');
    return;
  }

  // 既に処理済みならスキップ
  if (processedActivityItems.has(itemKey)) {
    log('[ACTIVITY] Already processed');
    lastTopActivityKey = itemKey;
    return;
  }

  // メンションが含まれているかチェック
  const mentionElement = item.querySelector('.c-member_slug--mention, [data-stringify-type="mention"], .c-member_slug');
  if (!mentionElement) {
    log('[ACTIVITY] No mention in top item');
    lastTopActivityKey = itemKey;
    return;
  }

  log(`[ACTIVITY] New mention found: ${itemKey}`);
  lastTopActivityKey = itemKey;
  processedActivityItems.add(itemKey);

  // メッセージ情報を取得
  const messageText = item.querySelector('[data-qa="activity-item-message"]')?.textContent.trim() || '';
  const senderName = item.querySelector('.p-activity_ia4_page__item__senders')?.textContent.trim() || 'Unknown';

  log(`[ACTIVITY] From: ${senderName}`);

  // 1. 開く - メッセージ部分をクリック
  log('[ACTIVITY] Opening thread...');
  const messageArea = item.querySelector('[data-qa="activity-item-message"]') || item;
  messageArea.click();

  // スレッドが開くのを待つ
  let threadInput = null;
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    threadInput = document.querySelector('[data-qa="texty_input"][contenteditable="true"]');
    if (threadInput) {
      log('[ACTIVITY] Thread opened!');
      break;
    }
  }

  if (!threadInput) {
    log('[ACTIVITY] Thread did not open');
    return;
  }

  // 2. スレッド全体を読む（親メッセージ + 全返信）
  await sleep(500);

  // スレッド内の全メッセージを取得
  const messageContainers = document.querySelectorAll('.c-message_kit__background, [data-qa="message_container"]');
  const threadContext = [];
  let lastMentionMessage = '';
  let lastMentionSender = senderName;

  for (const container of messageContainers) {
    // 送信者を取得
    const senderEl = container.querySelector('.c-message__sender_link, .c-message_kit__sender');
    const sender = senderEl?.textContent.trim() || 'Unknown';

    // メッセージ本文を取得
    const messageBlock = container.querySelector('.c-message_kit__blocks, .p-rich_text_section');
    const msgText = messageBlock?.textContent.trim() || '';

    if (msgText) {
      threadContext.push(`${sender}: ${msgText}`);

      // メンションが含まれているかチェック（最後のメンションを記録）
      const hasMention = messageBlock?.querySelector('.c-member_slug--mention, [data-stringify-type="mention"]');
      if (hasMention) {
        lastMentionMessage = msgText;
        lastMentionSender = sender;
      }
    }
  }

  // フォールバック
  if (!lastMentionMessage) {
    lastMentionMessage = messageText;
  }

  // 文脈を結合（最大10メッセージ）
  const contextMessages = threadContext.slice(-10).join('\n');

  log(`[ACTIVITY] Thread context (${threadContext.length} messages)`);
  log(`[ACTIVITY] Last mention from: ${lastMentionSender}`);
  log(`[ACTIVITY] Last mention: "${lastMentionMessage.substring(0, 60)}..."`);

  // 3. 返信を生成（文脈付き）
  log('[ACTIVITY] Generating reply with context...');
  const replyText = await generateAutoReply(lastMentionMessage, contextMessages, lastMentionSender);

  if (replyText) {
    log(`[ACTIVITY] Reply: ${replyText.substring(0, 50)}...`);

    // Quillエディタに入力
    threadInput.focus();
    await sleep(100);
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, replyText);

    await sleep(500);
    log(`[ACTIVITY] Input done`);

    // 送信
    await sleep(500);
    const sendButton = document.querySelector('[data-qa="texty_send_button"][aria-disabled="false"]');

    if (autoSendEnabled && sendButton) {
      sendButton.click();
      log('[ACTIVITY] Sent!');
      await sleep(500);
    } else {
      log('[ACTIVITY] Draft ready');
    }
  }

  // 4. 閉じる
  await sleep(1000);
  const closeButton = document.querySelector('button[aria-label="閉じる"]') ||
                      document.querySelector('button[data-qa="close"]');

  if (closeButton) {
    closeButton.click();
    log('[ACTIVITY] Closed');
  } else {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }

  log('[ACTIVITY] Done');
}

// ページ遷移後の返信処理をチェック
async function checkPendingReply() {
  // localStorageから保留中の返信情報を取得
  const savedReply = localStorage.getItem('slack_ai_pending_reply');
  if (!savedReply) {
    return;
  }

  const replyInfo = JSON.parse(savedReply);

  // 古すぎる場合は無視（5分以上前）
  if (Date.now() - replyInfo.timestamp > 5 * 60 * 1000) {
    localStorage.removeItem('slack_ai_pending_reply');
    return;
  }

  // アクティビティ画面の場合は処理しない（チャンネルに遷移するまで待つ）
  if (isActivityPage()) {
    return;
  }

  log('[PENDING] Processing pending reply...');

  // 保留中の返信情報をクリア
  localStorage.removeItem('slack_ai_pending_reply');
  const shouldReturnToActivity = replyInfo.returnToActivity;
  pendingReply = null;

  // 少し待ってからメッセージを探す
  await sleep(2000);

  try {
    // ハイライトされているメッセージを探す（遷移直後はハイライトされている）
    let targetMessage = document.querySelector('.c-message_kit--highlight') ||
                        document.querySelector('[data-qa="message_container"].c-message_kit--highlight');

    // ハイライトがない場合、最新のメンションを含むメッセージを探す
    if (!targetMessage) {
      const mentionElements = document.querySelectorAll('.c-member_slug--mention, [data-stringify-type="mention"]');
      for (const mention of mentionElements) {
        const msgContainer = mention.closest('[data-qa="virtual-list-item"]') ||
                             mention.closest('.c-message_kit__background');
        if (msgContainer) {
          targetMessage = msgContainer;
          // 最後（最新）のものを使う
        }
      }
    }

    log(`[PENDING] Target message found: ${targetMessage ? 'yes' : 'no'}`);

    // 返信を生成
    const replyText = await generateAutoReply(replyInfo.messageText, '', replyInfo.senderName);

    if (!replyText) {
      log('[PENDING] Error: No reply generated');
      if (shouldReturnToActivity) {
        returnToActivityPage();
      }
      return;
    }

    log(`[PENDING] Generated reply: ${replyText}`);

    // スレッドで返信
    if (targetMessage) {
      await sendReplyInThread(targetMessage, replyText, autoSendEnabled);
    } else {
      log('[PENDING] Target message not found, using channel input...');
      await sendReply(replyText, autoSendEnabled);
    }

    log('[PENDING] Reply completed');

    // アクティビティ画面に戻って次のメンションを処理
    if (shouldReturnToActivity) {
      await sleep(2000);
      returnToActivityPage();
    }
  } catch (error) {
    console.error(LOG_PREFIX, '[PENDING] Error:', error);
    if (shouldReturnToActivity) {
      returnToActivityPage();
    }
  }
}

// アクティビティ画面に戻る
function returnToActivityPage() {
  log('[PENDING] Returning to activity page...');

  // アクティビティボタンをクリック
  const activityButton = document.querySelector('[data-qa="activity"]') ||
                         document.querySelector('button[aria-label*="アクティビティ"]') ||
                         document.querySelector('button[aria-label*="Activity"]') ||
                         document.querySelector('.p-ia4_home_nav__item--activity');

  if (activityButton) {
    activityButton.click();
    log('[PENDING] Clicked activity button');
  } else {
    log('[PENDING] Activity button not found');
  }
}

// 既存のメッセージをスキャン
function scanExistingMessages() {
  // メンションを含む要素を直接探す
  const mentionElements = document.querySelectorAll('.c-member_slug--mention, [data-stringify-type="mention"]');
  log(`[TEST MODE] Found ${mentionElements.length} mentions on page`);

  // 各メンションの親メッセージを処理
  const processedParents = new Set();
  for (const mention of mentionElements) {
    // メッセージのコンテナを探す
    const msgContainer = mention.closest('[data-qa="virtual-list-item"]') ||
                         mention.closest('.c-message_kit__background') ||
                         mention.closest('[data-qa="message_container"]') ||
                         mention.closest('.p-rich_text_block')?.parentElement?.parentElement;

    if (msgContainer && !processedParents.has(msgContainer)) {
      processedParents.add(msgContainer);
      log(`[TEST MODE] Processing message with mention: "${mention.textContent}"`);
      checkForMentions(msgContainer);
    }
  }
}

function stopAutoReply() {
  log('Stopping auto-reply...');
  if (messageObserver) {
    messageObserver.disconnect();
    messageObserver = null;
  }
  if (activityObserver) {
    activityObserver.disconnect();
    activityObserver = null;
  }
  if (activityListObserver) {
    activityListObserver.disconnect();
    activityListObserver = null;
  }
  if (activityScanInterval) {
    clearInterval(activityScanInterval);
    activityScanInterval = null;
  }
  // 保留中の返信もクリア
  localStorage.removeItem('slack_ai_pending_reply');
  pendingReply = null;
}

function getCurrentUserId() {
  // Try to get user ID from Slack workspace data

  // Method 1: Check for user menu button
  const userButton = document.querySelector('[data-qa="user-button"]');
  if (userButton) {
    const userId = userButton.getAttribute('data-user-id');
    if (userId) {
      currentUserId = userId;
      log(`Current user ID: ${currentUserId}`);
      return;
    }
  }

  // Method 2: Check localStorage
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.includes('localConfig')) {
        const data = JSON.parse(localStorage.getItem(key));
        if (data && data.teams) {
          const teams = Object.values(data.teams);
          if (teams.length > 0 && teams[0].self_id) {
            currentUserId = teams[0].self_id;
            log(`Current user ID from localStorage: ${currentUserId}`);
            return;
          }
        }
      }
    }
  } catch (e) {
    log('Error reading localStorage:', e);
  }

  // Method 3: Parse from page data
  const scripts = document.querySelectorAll('script');
  for (const script of scripts) {
    if (script.textContent.includes('"self_id"')) {
      const match = script.textContent.match(/"self_id":"([^"]+)"/);
      if (match) {
        currentUserId = match[1];
        log(`Current user ID from script: ${currentUserId}`);
        return;
      }
    }
  }

  log('Warning: Could not determine current user ID');
}

function startMessageObserver() {
  // Find the message container
  const messageContainer = document.querySelector('[role="main"]') ||
                          document.querySelector('.c-virtual_list__scroll_container') ||
                          document.body;

  if (!messageContainer) {
    log('Error: Could not find message container');
    return;
  }

  log('Starting message observer on:', messageContainer.tagName);

  // Create observer to watch for new messages
  messageObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        mutation.addedNodes.forEach(node => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            checkForMentions(node);
          }
        });
      }
    }
  });

  messageObserver.observe(messageContainer, {
    childList: true,
    subtree: true
  });

  log('Message observer started');
}

async function checkForMentions(element) {
  // Look for message elements
  const messages = element.querySelectorAll ? element.querySelectorAll('.c-message_kit__background, [data-qa="message_container"]') : [];
  const allMessages = [element, ...Array.from(messages)];

  log(`Checking ${allMessages.length} elements for mentions`);

  for (const msg of allMessages) {
    if (!msg.querySelector) continue;

    // Get message ID to avoid duplicates
    const messageId = msg.closest('[data-item-key]')?.getAttribute('data-item-key');

    // デバッグ: メッセージのテキストを表示
    const msgText = msg.textContent?.substring(0, 50) || '';
    log(`Message: "${msgText}..." ID: ${messageId || 'none'}`);

    if (!messageId || processedMessages.has(messageId)) {
      continue;
    }

    // Check for mentions - 新しいセレクタ
    const mentions = msg.querySelectorAll('.c-member_slug--mention, [data-stringify-type="mention"], .c-mention');
    log(`Found ${mentions.length} mention elements in message`);
    let isMentioned = false;

    for (const mention of mentions) {
      const mentionText = mention.textContent.trim();
      const mentionUserId = mention.getAttribute('data-member-id') || mention.getAttribute('data-user-id');

      // TEST_MODE: 全てのメンションに反応 / 通常: 自分宛てのみ
      if (TEST_MODE) {
        // テストモード: どのメンションでも反応
        if (mentions.length > 0) {
          isMentioned = true;
          log(`[TEST MODE] Mention found: ${mentionText}`);
          break;
        }
      } else {
        // 通常モード: 自分宛てのメンションのみ
        if (mentionUserId === currentUserId || mentionText === '@channel' || mentionText === '@here') {
          isMentioned = true;
          break;
        }
      }
    }

    if (isMentioned) {
      log(`Mention detected in message: ${messageId}`);
      processedMessages.add(messageId);

      // Extract message info
      const messageText = msg.querySelector('.c-message_kit__blocks')?.textContent.trim() || '';
      const senderName = msg.querySelector('.c-message__sender_link, .c-message_kit__sender')?.textContent.trim() || 'Unknown';

      log(`Message from ${senderName}: ${messageText.substring(0, 50)}...`);

      // Generate and send auto-reply
      await handleAutoReply(msg, messageText, senderName);

      // Cleanup old processed messages
      if (processedMessages.size > 100) {
        const entries = Array.from(processedMessages);
        processedMessages = new Set(entries.slice(-100));
      }
    }
  }
}

async function handleAutoReply(messageElement, messageText, senderName) {
  try {
    log('Generating auto-reply with Ollama...');

    // Get context messages
    const surroundingMessages = await getContextMessages(messageElement);

    // Generate reply (no API key needed for local Ollama)
    const replyText = await generateAutoReply(messageText, surroundingMessages, senderName);

    if (!replyText) {
      log('Error: No reply generated');
      return;
    }

    log(`Generated reply: ${replyText}`);

    // スレッドで返信
    await sendReplyInThread(messageElement, replyText, autoSendEnabled);

    log('Auto-reply process completed');
  } catch (error) {
    console.error(LOG_PREFIX, 'Error in handleAutoReply:', error);
  }
}

// スレッドで返信
async function sendReplyInThread(messageElement, replyText, shouldSend) {
  log('Opening thread for reply...');

  // スレッドボタンを探す
  const threadButton = messageElement.querySelector('[data-qa="message_content"] button[data-qa="start_thread"], [data-qa="reply_thread_button"]') ||
                       messageElement.querySelector('button[aria-label*="スレッド"], button[aria-label*="thread"], button[aria-label*="返信"]');

  // または、メッセージにホバーして表示されるツールバーのスレッドボタン
  if (!threadButton) {
    // メッセージをホバー状態にしてツールバーを表示
    const hoverContainer = messageElement.closest('.c-message_kit__hover, [data-qa="message_container"]');
    if (hoverContainer) {
      hoverContainer.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      await sleep(300);
    }
  }

  // 再度スレッドボタンを探す
  let threadBtn = messageElement.querySelector('button[data-qa="start_thread"], button[data-qa="reply_thread_button"]') ||
                  document.querySelector('.c-message_kit__hover_actions button[aria-label*="スレッド"]') ||
                  document.querySelector('.c-message_kit__hover_actions button[aria-label*="thread"]');

  if (threadBtn) {
    log('Found thread button, clicking...');
    threadBtn.click();
    await sleep(1000);
  } else {
    log('Thread button not found, trying to find existing thread or reply in channel...');
  }

  // スレッドパネルの入力欄を探す
  let inputBox = document.querySelector('[data-qa="message_input"][data-message-input="true"]') ||
                 document.querySelector('.p-thread_view__input .ql-editor') ||
                 document.querySelector('.p-flexpane__inside_body .ql-editor[contenteditable="true"]');

  // スレッドパネルが見つからない場合はチャンネルの入力欄を使う
  if (!inputBox) {
    log('Thread input not found, using channel input...');
    inputBox = document.querySelector('[data-qa="message_input"]') ||
               document.querySelector('.ql-editor[contenteditable="true"]');
  }

  if (!inputBox) {
    log('Error: Could not find any input box');
    return;
  }

  // 入力欄にフォーカス
  inputBox.focus();
  await sleep(100);

  // テキストを入力
  document.execCommand('selectAll', false, null);
  document.execCommand('insertText', false, replyText);

  await sleep(300);

  if (shouldSend) {
    await sleep(500);

    // 送信ボタンを探す（スレッドパネル内を優先）
    const sendButton = document.querySelector('.p-flexpane__inside_body [data-qa="texty_send_button"]:not([aria-disabled="true"])') ||
                       document.querySelector('[data-qa="texty_send_button"]:not([aria-disabled="true"])');

    if (sendButton) {
      sendButton.click();
      log('Message sent in thread automatically');
    } else {
      log('Send button disabled, trying Cmd+Enter...');
      const enterEvent = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        metaKey: true,
        bubbles: true,
        cancelable: true
      });
      inputBox.dispatchEvent(enterEvent);
    }
  } else {
    log('Draft created in thread (auto-send disabled)');
  }
}

async function getContextMessages(messageElement) {
  // Get surrounding messages for context
  const messages = [];
  const messageContainer = messageElement.closest('[role="list"]') || document.querySelector('[role="list"]');

  if (messageContainer) {
    const allMessages = messageContainer.querySelectorAll('.c-message_kit__background');
    const targetIndex = Array.from(allMessages).indexOf(messageElement);

    if (targetIndex !== -1) {
      // Get 3 messages before
      const startIdx = Math.max(0, targetIndex - 3);
      for (let i = startIdx; i < targetIndex; i++) {
        const msg = allMessages[i];
        const text = msg.querySelector('.c-message_kit__blocks')?.textContent.trim();
        const sender = msg.querySelector('.c-message__sender_link, .c-message_kit__sender')?.textContent.trim();
        if (text && sender) {
          messages.push(`${sender}: ${text}`);
        }
      }
    }
  }

  return messages.join('\n---\n');
}

async function generateAutoReply(messageText, surroundingMessages, senderName) {
  // Call background script (Ollama - no API key needed)
  const result = await chrome.runtime.sendMessage({
    action: 'generateAutoReply',
    messageText,
    surroundingMessages,
    senderName
  });

  return result?.reply || null;
}

async function sendReply(replyText, shouldSend) {
  // Find message input box
  const inputBox = document.querySelector('[data-qa="message_input"]') ||
                   document.querySelector('.ql-editor[contenteditable="true"]') ||
                   document.querySelector('[role="textbox"][contenteditable="true"]') ||
                   document.querySelector('.p-message_input_field .ql-editor');

  if (!inputBox) {
    log('Error: Could not find message input box');
    return;
  }

  // Focus
  inputBox.focus();
  await sleep(100);

  // Clear existing content and insert new text using execCommand
  document.execCommand('selectAll', false, null);
  document.execCommand('insertText', false, replyText);

  await sleep(300);

  if (shouldSend) {
    // Wait for Slack to enable send button
    await sleep(500);

    // Try clicking send button
    const sendButton = document.querySelector('[data-qa="texty_send_button"]:not([aria-disabled="true"])') ||
                       document.querySelector('button[aria-label*="送信"]:not([aria-disabled="true"])') ||
                       document.querySelector('button[aria-label*="Send"]:not([aria-disabled="true"])');

    if (sendButton) {
      sendButton.click();
      log('Message sent automatically');
    } else {
      log('Send button disabled, trying Cmd+Enter...');
      // Fallback: Cmd+Enter (Mac) to send
      const enterEvent = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        metaKey: true,
        bubbles: true,
        cancelable: true
      });
      inputBox.dispatchEvent(enterEvent);
    }
  } else {
    log('Reply inserted (semi-auto mode - manual send required)');
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
