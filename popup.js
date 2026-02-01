document.addEventListener('DOMContentLoaded', () => {
  const downloadBtn = document.getElementById('downloadBtn');
  const copyBtn = document.getElementById('copyBtn');
  const detailedMode = document.getElementById('detailedMode');
  const limitCount = document.getElementById('limitCount');
  const status = document.getElementById('status');
  const progress = document.getElementById('progress');
  const apiKeyInput = document.getElementById('apiKey');
  const saveApiKeyBtn = document.getElementById('saveApiKey');
  const apiKeyStatus = document.getElementById('apiKeyStatus');
  const autoReplyEnabled = document.getElementById('autoReplyEnabled');
  const autoSendEnabled = document.getElementById('autoSendEnabled');

  // Load saved settings
  chrome.storage.local.get(['openaiApiKey', 'autoReplyEnabled', 'autoSendEnabled'], (result) => {
    if (result.openaiApiKey) {
      apiKeyInput.value = result.openaiApiKey;
      apiKeyStatus.textContent = '✓ APIキー保存済み';
    }
    if (result.autoReplyEnabled) {
      autoReplyEnabled.checked = true;
    }
    if (result.autoSendEnabled !== undefined) {
      autoSendEnabled.checked = result.autoSendEnabled;
    } else {
      // Default to true for backward compatibility
      autoSendEnabled.checked = true;
    }
  });

  // Save auto-reply setting
  autoReplyEnabled.addEventListener('change', async () => {
    const enabled = autoReplyEnabled.checked;
    chrome.storage.local.set({ autoReplyEnabled: enabled });

    // Send message to content script to enable/disable auto-reply
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab.url && tab.url.includes('app.slack.com')) {
      chrome.tabs.sendMessage(tab.id, {
        action: 'toggleAutoReply',
        enabled: enabled,
        autoSend: autoSendEnabled.checked
      });
    }
  });

  // Save auto-send setting
  autoSendEnabled.addEventListener('change', async () => {
    const autoSend = autoSendEnabled.checked;
    chrome.storage.local.set({ autoSendEnabled: autoSend });

    // Send message to content script to update auto-send setting
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab.url && tab.url.includes('app.slack.com')) {
      chrome.tabs.sendMessage(tab.id, {
        action: 'toggleAutoReply',
        enabled: autoReplyEnabled.checked,
        autoSend: autoSend
      });
    }
  });

  // Save API key
  saveApiKeyBtn.addEventListener('click', () => {
    const apiKey = apiKeyInput.value.trim();
    if (apiKey) {
      chrome.storage.local.set({ openaiApiKey: apiKey }, () => {
        apiKeyStatus.textContent = '✓ APIキーを保存しました';
      });
    } else {
      chrome.storage.local.remove('openaiApiKey', () => {
        apiKeyStatus.textContent = 'APIキーを削除しました';
      });
    }
  });

  function setStatus(message, type) {
    status.textContent = message;
    status.className = type;
  }

  function setProgress(message) {
    progress.textContent = message;
  }

  function setButtonsDisabled(disabled) {
    downloadBtn.disabled = disabled;
    copyBtn.disabled = disabled;
  }

  async function executeAction(action, successMessage, copyToClipboard = false) {
    setButtonsDisabled(true);
    setStatus('処理中...', 'info');
    setProgress('');

    let port = null;

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab.url || !tab.url.includes('app.slack.com')) {
        setStatus('Slackのページで実行してください', 'error');
        setButtonsDisabled(false);
        return;
      }

      // Establish connection for progress updates (for detailed mode)
      if (action.includes('Detailed')) {
        port = chrome.tabs.connect(tab.id, { name: 'progress' });
        port.onMessage.addListener((msg) => {
          if (msg.message) {
            setProgress(msg.message);
          } else if (msg.total > 0) {
            setProgress(`${msg.current} / ${msg.total} 件処理中...`);
          }
        });
      }

      const limit = parseInt(limitCount.value, 10) || 0;

      // Get API key for detailed mode
      let apiKey = null;
      if (action.includes('Detailed')) {
        const stored = await chrome.storage.local.get(['openaiApiKey']);
        apiKey = stored.openaiApiKey || null;
      }

      const response = await chrome.tabs.sendMessage(tab.id, { action, limit, apiKey });

      if (response.success) {
        if (copyToClipboard && response.tsvData) {
          await navigator.clipboard.writeText(response.tsvData);
        }
        setStatus(`${response.count}件のメッセージを${successMessage}`, 'success');
        setProgress('');
      } else {
        setStatus(response.error || 'エラーが発生しました', 'error');
        setProgress('');
      }
    } catch (error) {
      console.error('Error:', error);
      setStatus('エラー: ページを再読み込みしてください', 'error');
      setProgress('');
    } finally {
      if (port) port.disconnect();
    }

    setButtonsDisabled(false);
  }

  downloadBtn.addEventListener('click', () => {
    const action = detailedMode.checked ? 'exportCSVDetailed' : 'exportCSV';
    executeAction(action, 'ダウンロードしました');
  });

  copyBtn.addEventListener('click', () => {
    const action = detailedMode.checked ? 'copyTSVDetailed' : 'copyTSV';
    executeAction(action, 'コピーしました', true);
  });
});
