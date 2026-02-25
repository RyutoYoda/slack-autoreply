document.addEventListener('DOMContentLoaded', () => {
  const testConnectionBtn = document.getElementById('testConnection');
  const connectionStatus = document.getElementById('connectionStatus');
  const autoReplyEnabled = document.getElementById('autoReplyEnabled');
  const autoSendEnabled = document.getElementById('autoSendEnabled');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');

  // Load saved settings
  chrome.storage.local.get(['autoReplyEnabled', 'autoSendEnabled'], (result) => {
    if (result.autoReplyEnabled) {
      autoReplyEnabled.checked = true;
      updateStatusDisplay(true, result.autoSendEnabled);
    }

    if (result.autoSendEnabled !== undefined) {
      autoSendEnabled.checked = result.autoSendEnabled;
    } else {
      autoSendEnabled.checked = false;
    }
  });

  // Test Ollama connection on load
  testOllamaConnection();

  // Test connection button
  testConnectionBtn.addEventListener('click', () => {
    testOllamaConnection();
  });

  async function testOllamaConnection() {
    showStatus('接続テスト中...', 'success');
    try {
      const result = await chrome.runtime.sendMessage({ action: 'testOllamaConnection' });
      if (result.success) {
        showStatus('✓ Ollama接続OK (Qwen3)', 'success');
      } else {
        showStatus('❌ ' + result.error, 'error');
      }
    } catch (error) {
      showStatus('❌ 拡張機能エラー: ' + error.message, 'error');
    }
  }

  // Save auto-reply setting
  autoReplyEnabled.addEventListener('change', async () => {
    const enabled = autoReplyEnabled.checked;
    chrome.storage.local.set({ autoReplyEnabled: enabled });

    updateStatusDisplay(enabled, autoSendEnabled.checked);

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab.url && tab.url.includes('app.slack.com')) {
      chrome.tabs.sendMessage(tab.id, {
        action: 'toggleAutoReply',
        enabled: enabled,
        autoSend: autoSendEnabled.checked
      }).catch(() => {});
    }
  });

  // Save auto-send setting
  autoSendEnabled.addEventListener('change', async () => {
    const autoSend = autoSendEnabled.checked;
    chrome.storage.local.set({ autoSendEnabled: autoSend });

    updateStatusDisplay(autoReplyEnabled.checked, autoSend);

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab.url && tab.url.includes('app.slack.com')) {
      chrome.tabs.sendMessage(tab.id, {
        action: 'toggleAutoReply',
        enabled: autoReplyEnabled.checked,
        autoSend: autoSend
      }).catch(() => {});
    }
  });

  function showStatus(message, type) {
    connectionStatus.textContent = message;
    connectionStatus.className = `status-indicator ${type}`;
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
