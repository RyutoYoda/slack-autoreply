// Slack Later Export - Content Script

// Log prefix for filtering - use "SLE:" in browser console filter
const LOG_PREFIX = 'SLE:';
function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

// Progress callback for sending updates to popup
let progressCallback = null;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const limit = request.limit || 0;
  const apiKey = request.apiKey || null;
  if (request.action === 'exportCSV') {
    exportMessages('csv', false, limit, apiKey).then(sendResponse);
    return true; // Keep message channel open for async response
  }
  if (request.action === 'copyTSV') {
    exportMessages('tsv', false, limit, apiKey).then(sendResponse);
    return true;
  }
  if (request.action === 'exportCSVDetailed') {
    exportMessages('csv', true, limit, apiKey).then(sendResponse);
    return true;
  }
  if (request.action === 'copyTSVDetailed') {
    exportMessages('tsv', true, limit, apiKey).then(sendResponse);
    return true;
  }
});

// Listen for port connection from popup for progress updates
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'progress') {
    progressCallback = (current, total, message) => {
      port.postMessage({ current, total, message });
    };
    port.onDisconnect.addListener(() => {
      progressCallback = null;
    });
  }
});

function sendProgress(current, total, message = '') {
  if (progressCallback) {
    progressCallback(current, total, message);
  }
}

async function exportMessages(format = 'csv', detailed = false, limit = 0, apiKey = null) {
  try {
    // Check if we're on the "Later" page
    if (!window.location.href.includes('/later')) {
      return { success: false, error: '「後で」ページを開いてください' };
    }

    // Find the list container
    const listContainer = document.querySelector('[role="list"]');
    if (!listContainer) {
      return { success: false, error: 'メッセージリストが見つかりません' };
    }

    // Find the scrollable container (parent with c-scrollbar__hider class)
    const scrollContainer = listContainer.closest('.c-scrollbar__hider')
      || findScrollableParent(listContainer);
    if (!scrollContainer) {
      return { success: false, error: 'スクロールコンテナが見つかりません' };
    }

    // Scroll and collect all items (virtual list - items change as we scroll)
    let messages;
    if (detailed) {
      messages = await collectAllMessagesDetailed(listContainer, scrollContainer, limit, apiKey);
    } else {
      messages = await collectAllMessages(listContainer, scrollContainer, limit);
    }

    if (messages.length === 0) {
      return { success: false, error: 'メッセージデータを抽出できませんでした' };
    }

    if (format === 'tsv') {
      // Generate TSV and return data for popup to copy
      const tsvContent = generateTSV(messages);
      return { success: true, count: messages.length, tsvData: tsvContent };
    } else {
      // Generate and download CSV
      downloadCSV(messages);
      return { success: true, count: messages.length };
    }
  } catch (error) {
    console.error('Export error:', error);
    return { success: false, error: error.message };
  }
}

function findScrollableParent(element) {
  let el = element.parentElement;
  while (el && el !== document.body) {
    const style = getComputedStyle(el);
    if ((style.overflowY === 'scroll' || style.overflowY === 'auto') &&
        el.scrollHeight > el.clientHeight) {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

async function collectAllMessages(listContainer, scrollContainer, limit = 0) {
  const messagesMap = new Map(); // Use Map to deduplicate by ID
  let lastScrollTop = -1;
  let stableCount = 0;
  const maxStableIterations = 3;

  // Start from top
  scrollContainer.scrollTop = 0;
  await sleep(300);

  while (true) {
    // Collect currently visible items
    const items = listContainer.querySelectorAll('[role="listitem"]');
    items.forEach(item => {
      const id = item.getAttribute('id') || item.getAttribute('data-item-key');
      if (id && !messagesMap.has(id)) {
        const data = extractMessageData(item);
        if (data) {
          messagesMap.set(id, data);
        }
      }
    });

    // Check limit
    if (limit > 0 && messagesMap.size >= limit) {
      break;
    }

    // Scroll down
    const previousScrollTop = scrollContainer.scrollTop;
    scrollContainer.scrollTop += scrollContainer.clientHeight * 0.8;
    await sleep(400);

    // Check if we've reached the bottom (scroll position didn't change)
    if (scrollContainer.scrollTop === previousScrollTop) {
      stableCount++;
      if (stableCount >= maxStableIterations) {
        break;
      }
    } else {
      stableCount = 0;
    }

    // Safety limit
    if (messagesMap.size > 1000) {
      break;
    }
  }

  // Convert Map values to array (respect limit)
  const allMessages = Array.from(messagesMap.values());
  return limit > 0 ? allMessages.slice(0, limit) : allMessages;
}

async function collectAllMessagesDetailed(listContainer, scrollContainer, limit = 0, apiKey = null) {
  // Step 1: Collect all item IDs by scrolling through the list
  const itemIds = new Set();
  let stableCount = 0;
  const maxStableIterations = 3;

  sendProgress(0, 0, 'メッセージ一覧を取得中...');

  // Start from top
  scrollContainer.scrollTop = 0;
  await sleep(300);

  // If limit is set, only collect that many items without full scroll
  const collectLimit = limit > 0 ? limit : 500;

  while (true) {
    const items = listContainer.querySelectorAll('[role="listitem"]');
    items.forEach(item => {
      const id = item.getAttribute('id') || item.getAttribute('data-item-key');
      if (id) itemIds.add(id);
    });

    sendProgress(0, itemIds.size, `${itemIds.size}件を検出中...`);

    // Check limit early
    if (limit > 0 && itemIds.size >= limit) break;

    const previousScrollTop = scrollContainer.scrollTop;
    scrollContainer.scrollTop += scrollContainer.clientHeight * 0.8;
    await sleep(400);

    if (scrollContainer.scrollTop === previousScrollTop) {
      stableCount++;
      if (stableCount >= maxStableIterations) break;
    } else {
      stableCount = 0;
    }

    if (itemIds.size >= collectLimit) break;
  }

  // Step 2: For each item, click and extract full message + surrounding messages
  const messages = [];
  let itemIdArray = Array.from(itemIds);

  // Apply limit
  if (limit > 0) {
    itemIdArray = itemIdArray.slice(0, limit);
  }

  const total = itemIdArray.length;

  sendProgress(0, total, `${total}件のメッセージを取得開始...`);
  log(` Starting detailed extraction for ${total} items`);

  for (let i = 0; i < itemIdArray.length; i++) {
    const itemId = itemIdArray[i];
    sendProgress(i + 1, total, `${i + 1}/${total} 件処理中...`);

    // Scroll to make the item visible
    scrollContainer.scrollTop = 0;
    await sleep(200);

    // Find the item (may need to scroll to find it)
    let item = findItemById(listContainer, itemId);
    let scrollAttempts = 0;
    while (!item && scrollAttempts < 20) {
      scrollContainer.scrollTop += scrollContainer.clientHeight * 0.5;
      await sleep(300);
      item = findItemById(listContainer, itemId);
      scrollAttempts++;
    }

    if (!item) {
      log(` Item not found: ${itemId}`);
      continue;
    }

    // Extract basic info from list item
    const basicData = extractMessageData(item);
    if (!basicData) {
      log(` Failed to extract basic data: ${itemId}`);
      continue;
    }

    // Click on the channel link to open the message in channel view
    const clickTarget = item.querySelector('.p-saved_item__link') ||
                        item.querySelector('[data-qa="activity-item-container"]') ||
                        item;
    clickTarget.click();
    await sleep(1000); // Wait for channel view to load

    // Extract full message and surrounding messages from channel view
    const extractedData = await extractFullMessageAndContext(basicData.url);
    log(` ${i + 1}/${total}: ${itemId} -> ${extractedData.fullMessage ? 'OK' : 'FAILED'}`);

    if (extractedData.fullMessage) {
      basicData.message = extractedData.fullMessage;
    }
    basicData.surroundingMessages = extractedData.surroundingMessages || '';

    // Generate next action using ChatGPT if API key is provided
    log(` API Key provided: ${apiKey ? 'Yes (' + apiKey.substring(0, 10) + '...)' : 'No'}`);
    log(` Message: ${basicData.message?.substring(0, 50) || 'empty'}`);
    log(` Surrounding: ${basicData.surroundingMessages?.substring(0, 50) || 'empty'}`);

    if (apiKey && (basicData.message || basicData.surroundingMessages)) {
      sendProgress(i + 1, total, `${i + 1}/${total} AI分析中...`);
      log(` Calling OpenAI API...`);
      const aiResult = await generateNextAction(apiKey, basicData.message, basicData.surroundingMessages);
      log(` AI Result:`, aiResult);
      basicData.nextActionTitle = aiResult.title || '';
      basicData.nextActionDetail = aiResult.detail || '';
    } else {
      log(` Skipping AI: apiKey=${!!apiKey}, message=${!!basicData.message}, surrounding=${!!basicData.surroundingMessages}`);
      basicData.nextActionTitle = '';
      basicData.nextActionDetail = '';
    }

    messages.push(basicData);
  }

  log(` Completed: ${messages.length} messages extracted`);
  return messages;
}

function findItemById(listContainer, itemId) {
  return listContainer.querySelector(`[id="${itemId}"]`) ||
         listContainer.querySelector(`[data-item-key="${itemId}"]`);
}

async function extractFullMessageFromChannelView(messageUrl) {
  // Parse timestamp from URL to find the correct message
  // URL format: https://slack.com/archives/{channelId}/p{timestamp}
  const match = messageUrl.match(/\/p(\d+)$/);
  if (!match) return null;

  const targetTimestamp = match[1];

  // Wait a bit for content to render
  await sleep(300);

  // Find messages in the channel view (right side, left > 400px)
  const messageKits = document.querySelectorAll('.c-message_kit__background');

  for (const msg of messageKits) {
    const rect = msg.getBoundingClientRect();
    if (rect.left < 400) continue; // Skip left panel messages

    // Check if this message matches our target timestamp
    const messageContainer = msg.closest('[data-item-key]');
    if (messageContainer) {
      const itemKey = messageContainer.getAttribute('data-item-key');
      // Item key format includes timestamp
      if (itemKey && itemKey.includes(targetTimestamp.substring(0, 10))) {
        // Found the message, extract full text
        const textEl = msg.querySelector('.c-message_kit__blocks');
        if (textEl) {
          return textEl.textContent.trim();
        }
      }
    }
  }

  // Fallback: try to find by looking at visible messages with bookmark indicator
  for (const msg of messageKits) {
    const rect = msg.getBoundingClientRect();
    if (rect.left < 400) continue;

    // Look for highlighted/bookmarked message indicator (multiple selectors for reliability)
    const messageContainer = msg.closest('[data-item-key]');
    const isBookmarked = messageContainer?.querySelector('.c-icon--bookmark-filled') ||
                         messageContainer?.querySelector('[data-qa="bookmark-filled"]') ||
                         messageContainer?.querySelector('.c-message_kit__labels__text');
    if (isBookmarked) {
      const textEl = msg.querySelector('.c-message_kit__blocks');
      if (textEl) {
        return textEl.textContent.trim();
      }
    }
  }

  return null;
}

async function extractFullMessageAndContext(messageUrl) {
  // Parse timestamp from URL to find the correct message
  const match = messageUrl.match(/\/p(\d+)$/);
  if (!match) return { fullMessage: null, surroundingMessages: '' };

  const targetTimestamp = match[1];

  // Wait a bit for content to render
  await sleep(500);

  // Find all messages in the channel view (right side, left > 400px)
  const messageKits = document.querySelectorAll('.c-message_kit__background');
  const rightPanelMessages = [];

  for (const msg of messageKits) {
    const rect = msg.getBoundingClientRect();
    if (rect.left < 400) continue; // Skip left panel messages

    const messageContainer = msg.closest('[data-item-key]');
    const textEl = msg.querySelector('.c-message_kit__blocks');
    const senderEl = msg.querySelector('.c-message__sender_link, .c-message_kit__sender');

    if (textEl) {
      const itemKey = messageContainer?.getAttribute('data-item-key') || '';
      rightPanelMessages.push({
        itemKey,
        text: textEl.textContent.trim(),
        sender: senderEl?.textContent.trim() || '',
        element: msg
      });
    }
  }

  // Find the target message index
  let targetIndex = -1;
  let fullMessage = null;

  for (let i = 0; i < rightPanelMessages.length; i++) {
    const msg = rightPanelMessages[i];
    // Check if this message matches our target timestamp
    if (msg.itemKey && msg.itemKey.includes(targetTimestamp.substring(0, 10))) {
      targetIndex = i;
      fullMessage = msg.text;
      break;
    }
  }

  // If not found by timestamp, try to find by bookmark indicator
  if (targetIndex === -1) {
    for (let i = 0; i < rightPanelMessages.length; i++) {
      const msg = rightPanelMessages[i];
      const messageContainer = msg.element.closest('[data-item-key]');
      const isBookmarked = messageContainer?.querySelector('.c-icon--bookmark-filled') ||
                           messageContainer?.querySelector('[data-qa="bookmark-filled"]') ||
                           messageContainer?.querySelector('.c-message_kit__labels__text');
      if (isBookmarked) {
        targetIndex = i;
        fullMessage = msg.text;
        break;
      }
    }
  }

  // Collect surrounding messages (3 before and 3 after)
  const surroundingRange = 3;
  const surroundingMessages = [];

  if (targetIndex !== -1) {
    const startIdx = Math.max(0, targetIndex - surroundingRange);
    const endIdx = Math.min(rightPanelMessages.length - 1, targetIndex + surroundingRange);

    for (let i = startIdx; i <= endIdx; i++) {
      const msg = rightPanelMessages[i];
      const prefix = i === targetIndex ? '【対象】' : '';
      const senderInfo = msg.sender ? `${msg.sender}: ` : '';
      surroundingMessages.push(`${prefix}${senderInfo}${msg.text}`);
    }
  }

  return {
    fullMessage,
    surroundingMessages: surroundingMessages.join('\n---\n')
  };
}

async function generateNextAction(apiKey, message, surroundingMessages) {
  try {
    log('Sending request to background script...');

    // Call background script to make the API request (avoids CORS issues)
    const result = await chrome.runtime.sendMessage({
      action: 'callOpenAI',
      apiKey,
      message,
      surroundingMessages
    });

    log('Result from background:', result);

    // Check if there was an error from background
    if (result && result.error) {
      log('Background returned error:', result.error);
    }

    return result || { title: '', detail: '' };
  } catch (error) {
    console.error(LOG_PREFIX, 'Error generating next action:', error);
    return { title: '', detail: '' };
  }
}

function extractMessageData(item) {
  try {
    const id = item.getAttribute('id') || item.getAttribute('data-item-key');
    if (!id) return null;

    // Parse ID: {channelId}-{timestamp}.{microseconds}_{index}
    const match = id.match(/^([A-Z0-9]+)-(\d+)\.(\d+)_\d+$/);
    if (!match) return null;

    const channelId = match[1];
    const timestampInt = match[2];
    const timestampDecimal = match[3];

    // Build URL: https://slack.com/archives/{channelId}/p{timestamp without dot}
    const messageUrl = `https://slack.com/archives/${channelId}/p${timestampInt}${timestampDecimal}`;

    // Convert timestamp to readable date
    const unixTimestamp = parseFloat(`${timestampInt}.${timestampDecimal}`);
    const date = new Date(unixTimestamp * 1000);
    const formattedDate = formatDate(date);

    // Extract text content
    // Channel name: usually in a button element
    let channelName = '';
    const buttons = item.querySelectorAll('button');
    for (const btn of buttons) {
      const text = btn.textContent.trim();
      if (text && !text.includes('完了') && !text.includes('その他')) {
        channelName = text;
        break;
      }
    }

    // Sender and message: look in the content area
    let senderName = '';
    let messageText = '';

    // Find all text nodes that might contain sender/message
    const textElements = item.querySelectorAll('[role="presentation"] span, [data-qa] span');
    const texts = [];
    textElements.forEach(el => {
      const text = el.textContent.trim();
      if (text && text.length > 0) {
        texts.push(text);
      }
    });

    // Alternative: get all direct text content
    if (texts.length === 0) {
      const allText = item.textContent;
      const parts = allText.split(/\s{2,}/);
      texts.push(...parts.filter(p => p.trim()));
    }

    // Try to identify sender (usually contains name pattern)
    // and message (usually longer text)
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
      // Skip common UI elements
      if (text === '完了' || text === 'その他' || text === channelName) continue;

      // Sender is typically shorter and might contain Japanese name or slash
      if (!senderName && (text.includes('/') || text.match(/^[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF\w\s]+$/))) {
        if (text.length < 50) {
          senderName = text;
          continue;
        }
      }

      // Message is typically the longer content
      if (!messageText || text.length > messageText.length) {
        if (text !== senderName && text !== channelName) {
          messageText = text;
        }
      }
    }

    // If we couldn't find structured data, use raw text
    if (!messageText) {
      const rawText = item.textContent.replace(/\s+/g, ' ').trim();
      // Remove known UI elements
      messageText = rawText
        .replace(/完了/g, '')
        .replace(/その他/g, '')
        .replace(channelName, '')
        .replace(senderName, '')
        .trim();
    }

    return {
      channel: channelName || channelId,
      sender: senderName || '不明',
      message: messageText || '',
      url: messageUrl,
      timestamp: formattedDate
    };
  } catch (error) {
    console.error('Error extracting message:', error);
    return null;
  }
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function downloadCSV(messages) {
  // CSV header - check if detailed mode (has surroundingMessages field)
  const isDetailed = messages.length > 0 && 'surroundingMessages' in messages[0];
  const headers = isDetailed
    ? ['チャンネル', '送信者', 'メッセージ', '前後のメッセージ', 'ネクストアクションタイトル', 'ネクストアクション詳細', 'URL', 'タイムスタンプ']
    : ['チャンネル', '送信者', 'メッセージ', 'URL', 'タイムスタンプ'];

  // Build CSV content
  const rows = [headers];
  messages.forEach(msg => {
    if (isDetailed) {
      rows.push([
        escapeCSV(msg.channel),
        escapeCSV(msg.sender),
        escapeCSV(msg.message),
        escapeCSV(msg.surroundingMessages),
        escapeCSV(msg.nextActionTitle),
        escapeCSV(msg.nextActionDetail),
        escapeCSV(msg.url),
        escapeCSV(msg.timestamp)
      ]);
    } else {
      rows.push([
        escapeCSV(msg.channel),
        escapeCSV(msg.sender),
        escapeCSV(msg.message),
        escapeCSV(msg.url),
        escapeCSV(msg.timestamp)
      ]);
    }
  });

  const csvContent = rows.map(row => row.join(',')).join('\n');

  // Add BOM for Excel compatibility
  const bom = '\uFEFF';
  const blob = new Blob([bom + csvContent], { type: 'text/csv;charset=utf-8' });

  // Create download link
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `slack_later_${formatDateForFilename(new Date())}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function escapeCSV(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  // If value contains comma, newline, or quote, wrap in quotes and escape quotes
  if (str.includes(',') || str.includes('\n') || str.includes('"')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function generateTSV(messages) {
  // TSV header - check if detailed mode (has surroundingMessages field)
  const isDetailed = messages.length > 0 && 'surroundingMessages' in messages[0];
  const headers = isDetailed
    ? ['チャンネル', '送信者', 'メッセージ', '前後のメッセージ', 'ネクストアクションタイトル', 'ネクストアクション詳細', 'URL', 'タイムスタンプ']
    : ['チャンネル', '送信者', 'メッセージ', 'URL', 'タイムスタンプ'];

  // Build TSV content
  const rows = [headers];
  messages.forEach(msg => {
    if (isDetailed) {
      rows.push([
        escapeTSV(msg.channel),
        escapeTSV(msg.sender),
        escapeTSV(msg.message),
        escapeTSV(msg.surroundingMessages),
        escapeTSV(msg.nextActionTitle),
        escapeTSV(msg.nextActionDetail),
        escapeTSV(msg.url),
        escapeTSV(msg.timestamp)
      ]);
    } else {
      rows.push([
        escapeTSV(msg.channel),
        escapeTSV(msg.sender),
        escapeTSV(msg.message),
        escapeTSV(msg.url),
        escapeTSV(msg.timestamp)
      ]);
    }
  });

  return rows.map(row => row.join('\t')).join('\n');
}

function escapeTSV(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  // Replace tabs and newlines with spaces for TSV
  return str.replace(/\t/g, ' ').replace(/\n/g, ' ').replace(/\r/g, '');
}

function formatDateForFilename(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}${month}${day}_${hours}${minutes}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// Auto-reply functionality
// ============================================================

let autoReplyEnabled = false;
let messageObserver = null;
let currentUserId = null;
let processedMessages = new Set(); // Track processed messages to avoid duplicates

// Listen for toggle auto-reply message from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'toggleAutoReply') {
    autoReplyEnabled = request.enabled;
    log(`Auto-reply ${autoReplyEnabled ? 'enabled' : 'disabled'}`);

    if (autoReplyEnabled) {
      initAutoReply();
    } else {
      stopAutoReply();
    }
    sendResponse({ success: true });
  }
});

// Initialize auto-reply on page load if enabled
chrome.storage.local.get(['autoReplyEnabled'], (result) => {
  if (result.autoReplyEnabled) {
    autoReplyEnabled = true;
    log('Auto-reply enabled from storage');
    // Wait a bit for Slack to load before initializing
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
  // Try to get user ID from the Slack workspace data
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

  // Method 2: Check localStorage for user info
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
            // Check if this is a message element
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
  // Look for message elements that might contain mentions
  const messages = element.querySelectorAll ? element.querySelectorAll('.c-message_kit__background, [data-qa="message_container"]') : [];

  // Also check if the element itself is a message
  const allMessages = [element, ...Array.from(messages)];

  for (const msg of allMessages) {
    if (!msg.querySelector) continue;

    // Get message ID to avoid processing duplicates
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

      // Check if the mention is for the current user
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

      // Cleanup old processed messages (keep last 100)
      if (processedMessages.size > 100) {
        const entries = Array.from(processedMessages);
        processedMessages = new Set(entries.slice(-100));
      }
    }
  }
}

async function handleAutoReply(messageElement, messageText, senderName) {
  try {
    // Get API key from storage
    const storage = await chrome.storage.local.get(['openaiApiKey']);
    const apiKey = storage.openaiApiKey;

    if (!apiKey) {
      log('Error: No API key configured');
      return;
    }

    log('Generating auto-reply...');

    // Get context - surrounding messages
    const surroundingMessages = await getContextMessages(messageElement);

    // Generate reply using OpenAI
    const replyText = await generateAutoReply(apiKey, messageText, surroundingMessages, senderName);

    if (!replyText) {
      log('Error: No reply generated');
      return;
    }

    log(`Generated reply: ${replyText}`);

    // Send the reply
    await sendReply(replyText);

    log('Auto-reply sent successfully');
  } catch (error) {
    console.error(LOG_PREFIX, 'Error in handleAutoReply:', error);
  }
}

async function getContextMessages(messageElement) {
  // Try to get surrounding messages for context
  const messages = [];
  const messageContainer = messageElement.closest('[role="list"]') || document.querySelector('[role="list"]');

  if (messageContainer) {
    const allMessages = messageContainer.querySelectorAll('.c-message_kit__background');
    const targetIndex = Array.from(allMessages).indexOf(messageElement);

    if (targetIndex !== -1) {
      // Get 3 messages before the mention
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
  // Call background script to generate reply
  const result = await chrome.runtime.sendMessage({
    action: 'generateAutoReply',
    apiKey,
    messageText,
    surroundingMessages,
    senderName
  });

  return result?.reply || null;
}

async function sendReply(replyText) {
  // Find the message input box
  const inputBox = document.querySelector('[data-qa="message_input"]') ||
                   document.querySelector('.ql-editor[contenteditable="true"]') ||
                   document.querySelector('[role="textbox"][contenteditable="true"]');

  if (!inputBox) {
    log('Error: Could not find message input box');
    return;
  }

  // Focus the input box
  inputBox.focus();
  await sleep(100);

  // Insert the reply text
  inputBox.textContent = replyText;

  // Trigger input event to update Slack's state
  const inputEvent = new Event('input', { bubbles: true });
  inputBox.dispatchEvent(inputEvent);

  await sleep(200);

  // Find and click the send button
  const sendButton = document.querySelector('[data-qa="texty_send_button"]') ||
                     document.querySelector('button[aria-label*="送信"]') ||
                     document.querySelector('button[aria-label*="Send"]');

  if (sendButton && !sendButton.disabled) {
    sendButton.click();
    log('Send button clicked');
  } else {
    log('Warning: Send button not found or disabled, trying Enter key');
    // Fallback: try pressing Enter
    const enterEvent = new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true
    });
    inputBox.dispatchEvent(enterEvent);
  }
}
