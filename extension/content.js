// content.js — injected into each supported chatbot page. Listens for
// messages from the background worker and drives the page UI: inserts
// prompts, clicks send, waits for generation to finish, and reads out the
// latest assistant response.

(function () {
  const relay = window.__chatbotRelay;
  if (!relay) return;
  const { sleep, waitFor, insertIntoComposer, pickAdapter } = relay;

  const adapter = pickAdapter();
  if (!adapter) return;

  // Announce this tab to the background service worker.
  try {
    chrome.runtime.sendMessage({
      type: 'hello',
      site: adapter.site,
      url: location.href,
      title: document.title,
    });
  } catch (_) { /* extension context may not be ready on first load */ }

  function reportStatus(status) {
    try { chrome.runtime.sendMessage({ type: 'statusUpdate', status }); } catch (_) {}
  }

  async function insertText(text) {
    const composer = await waitFor(adapter.findComposer, { timeout: 10000 });
    if (!composer) throw new Error('Composer not found for ' + adapter.site);
    insertIntoComposer(composer, text);
  }

  async function clickSend() {
    // Wait until the send button exists and is enabled.
    const btn = await waitFor(() => {
      const b = adapter.findSendButton();
      if (!b) return null;
      const disabled = b.disabled || b.getAttribute('aria-disabled') === 'true';
      return disabled ? null : b;
    }, { timeout: 8000 });
    if (!btn) throw new Error('Send button not available for ' + adapter.site);
    btn.click();
  }

  async function waitForResponseEnd(maxMs = 180000) {
    const start = Date.now();
    // Wait briefly for generation to START (stop button to appear).
    await waitFor(() => adapter.findStopButton(), { timeout: 10000 });
    // Then wait for it to END: two consecutive checks with no stop button.
    let clear = 0;
    while (Date.now() - start < maxMs) {
      await sleep(500);
      if (!adapter.findStopButton()) {
        if (++clear >= 2) break;
      } else {
        clear = 0;
      }
    }
    // Allow final render flush.
    await sleep(400);
    return adapter.findLastResponse();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        switch (msg?.type) {
          case 'ping':
            return sendResponse({ ok: true, site: adapter.site, title: document.title });

          case 'insertOnly':
            await insertText(msg.text);
            return sendResponse({ ok: true });

          case 'send': {
            reportStatus('sending');
            await insertText(msg.text);
            await sleep(150);
            await clickSend();
            reportStatus('waiting');
            // Acknowledge quickly; the actual response is reported asynchronously.
            sendResponse({ ok: true });
            try {
              const text = await waitForResponseEnd();
              chrome.runtime.sendMessage({ type: 'responseReady', text });
            } catch (e) {
              chrome.runtime.sendMessage({ type: 'responseReady', text: null, error: String(e) });
            }
            return;
          }

          case 'readLatest':
            return sendResponse({ ok: true, text: adapter.findLastResponse() });

          default:
            return sendResponse({ ok: false, error: 'unknown type' });
        }
      } catch (e) {
        reportStatus('error');
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true; // async sendResponse
  });
})();
