document.addEventListener('DOMContentLoaded', () => {
  const apiKeyInput = document.getElementById('apiKey');
  const saveApiKeyBtn = document.getElementById('saveApiKey');
  const apiKeyStatus = document.getElementById('apiKeyStatus');
  const autoReplyEnabled = document.getElementById('autoReplyEnabled');
  const autoSendEnabled = document.getElementById('autoSendEnabled');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');

  // Load saved settings
  chrome.storage.local.get(['openaiApiKey', 'autoReplyEnabled', 'autoSendEnabled'], (result) => {
    if (result.openaiApiKey) {
      apiKeyInput.value = result.openaiApiKey;
      showStatus('✓ APIキー設定済み', 'success');
    }

    if (result.autoReplyEnabled) {
      autoReplyEnabled.checked = true;
      updateStatusDisplay(true, result.autoSendEnabled);
    }

    if (result.autoSendEnabled !== undefined) {
      autoSendEnabled.checked = result.autoSendEnabled;
    } else {
      // Default to false for safety (semi-auto mode)
      autoSendEnabled.checked = false;
    }
  });

  // Save API key
  saveApiKeyBtn.addEventListener('click', () => {
    const apiKey = apiKeyInput.value.trim();
    if (apiKey) {
      if (!apiKey.startsWith('sk-')) {
        showStatus('❌ 無効なAPIキー形式です', 'error');
        return;
      }
      chrome.storage.local.set({ openaiApiKey: apiKey }, () => {
        showStatus('✓ APIキーを保存しました', 'success');
      });
    } else {
      chrome.storage.local.remove('openaiApiKey', () => {
        showStatus('APIキーを削除しました', 'error');
      });
    }
  });

  // Save auto-reply setting
  autoReplyEnabled.addEventListener('change', async () => {
    const enabled = autoReplyEnabled.checked;
    chrome.storage.local.set({ autoReplyEnabled: enabled });

    updateStatusDisplay(enabled, autoSendEnabled.checked);

    // Send message to content script to enable/disable auto-reply
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab.url && tab.url.includes('app.slack.com')) {
      chrome.tabs.sendMessage(tab.id, {
        action: 'toggleAutoReply',
        enabled: enabled,
        autoSend: autoSendEnabled.checked
      }).catch(() => {
        // Ignore errors if content script is not ready
      });
    }
  });

  // Save auto-send setting
  autoSendEnabled.addEventListener('change', async () => {
    const autoSend = autoSendEnabled.checked;
    chrome.storage.local.set({ autoSendEnabled: autoSend });

    updateStatusDisplay(autoReplyEnabled.checked, autoSend);

    // Send message to content script to update auto-send setting
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab.url && tab.url.includes('app.slack.com')) {
      chrome.tabs.sendMessage(tab.id, {
        action: 'toggleAutoReply',
        enabled: autoReplyEnabled.checked,
        autoSend: autoSend
      }).catch(() => {
        // Ignore errors if content script is not ready
      });
    }
  });

  function showStatus(message, type) {
    apiKeyStatus.textContent = message;
    apiKeyStatus.className = `status-indicator ${type}`;

    // Auto-hide after 3 seconds
    setTimeout(() => {
      apiKeyStatus.className = 'status-indicator';
    }, 3000);
  }

  function updateStatusDisplay(enabled, autoSend) {
    if (enabled) {
      statusDot.className = 'status-dot active';
      if (autoSend) {
        statusText.textContent = '自動返信: 有効（完全自動）';
      } else {
        statusText.textContent = '自動返信: 有効（半自動）';
      }
    } else {
      statusDot.className = 'status-dot inactive';
      statusText.textContent = '自動返信: オフ';
    }
  }
});
