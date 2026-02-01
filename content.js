// Slack AI Auto-Reply - Content Script

// Log prefix for filtering
const LOG_PREFIX = 'SLACK-AI:';
function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

// Auto-reply state
let autoReplyEnabled = false;
let autoSendEnabled = false;
let messageObserver = null;
let currentUserId = null;
let processedMessages = new Set();

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
        mutation.addNodes.forEach(node => {
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

  for (const msg of allMessages) {
    if (!msg.querySelector) continue;

    // Get message ID to avoid duplicates
    const messageId = msg.closest('[data-item-key]')?.getAttribute('data-item-key');
    if (!messageId || processedMessages.has(messageId)) {
      continue;
    }

    // Check for mentions
    const mentions = msg.querySelectorAll('.c-mention, [data-qa="mention"]');
    let isMentioned = false;

    for (const mention of mentions) {
      const mentionText = mention.textContent.trim();
      const mentionUserId = mention.getAttribute('data-user-id');

      // Check if mention is for current user
      if (mentionUserId === currentUserId || mentionText === '@channel' || mentionText === '@here') {
        isMentioned = true;
        break;
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
    // Get API key
    const storage = await chrome.storage.local.get(['openaiApiKey']);
    const apiKey = storage.openaiApiKey;

    if (!apiKey) {
      log('Error: No API key configured');
      return;
    }

    log('Generating auto-reply...');

    // Get context messages
    const surroundingMessages = await getContextMessages(messageElement);

    // Generate reply
    const replyText = await generateAutoReply(apiKey, messageText, surroundingMessages, senderName);

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

async function generateAutoReply(apiKey, messageText, surroundingMessages, senderName) {
  // Call background script
  const result = await chrome.runtime.sendMessage({
    action: 'generateAutoReply',
    apiKey,
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
                   document.querySelector('[role="textbox"][contenteditable="true"]');

  if (!inputBox) {
    log('Error: Could not find message input box');
    return;
  }

  // Focus and insert text
  inputBox.focus();
  await sleep(100);

  inputBox.textContent = replyText;

  // Trigger input event
  const inputEvent = new Event('input', { bubbles: true });
  inputBox.dispatchEvent(inputEvent);

  await sleep(200);

  if (shouldSend) {
    // Auto-send mode: click send button
    const sendButton = document.querySelector('[data-qa="texty_send_button"]') ||
                       document.querySelector('button[aria-label*="送信"]') ||
                       document.querySelector('button[aria-label*="Send"]');

    if (sendButton && !sendButton.disabled) {
      sendButton.click();
      log('Message sent automatically');
    } else {
      log('Warning: Send button not found or disabled');
      // Fallback: press Enter
      const enterEvent = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true
      });
      inputBox.dispatchEvent(enterEvent);
    }
  } else {
    // Semi-auto mode: just insert text
    log('Reply inserted (semi-auto mode - manual send required)');
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
