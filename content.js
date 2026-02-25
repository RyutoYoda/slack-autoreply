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
let currentUserId = null;
let processedMessages = new Set();

// テストモード: 自分のメンションでも動作する
const TEST_MODE = true;

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

  // TEST_MODE: 既存メッセージもスキャン（5秒後）
  if (TEST_MODE) {
    setTimeout(() => {
      log('[TEST MODE] Scanning existing messages...');
      scanExistingMessages();
    }, 5000);
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

    // Send the reply
    await sendReply(replyText, autoSendEnabled);

    log('Auto-reply process completed');
  } catch (error) {
    console.error(LOG_PREFIX, 'Error in handleAutoReply:', error);
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
