// adapters.js — per-site DOM knowledge for finding the composer, send button,
// stop button, and latest assistant message.
//
// These selectors are the fragile part of this extension: the three chat UIs
// change their markup frequently. If a site stops working, inspect the page
// in devtools and tweak the selectors below. Each adapter exposes:
//   match()            -> boolean, is this adapter for the current page?
//   findComposer()     -> the contenteditable element that accepts user text
//   findSendButton()   -> the submit button (must be enabled to click)
//   findStopButton()   -> the "stop generating" button (present while streaming)
//   findLastResponse() -> text of the most recent assistant message

(function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, { timeout = 15000, interval = 150 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const v = fn();
        if (v) return v;
      } catch (_) { /* ignore */ }
      await sleep(interval);
    }
    return null;
  }

  // Insert text into a contenteditable / textarea so that the host framework
  // (React / Lexical / ProseMirror) registers the change.
  function insertIntoComposer(el, text) {
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
                  || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter ? setter.call(el, text) : (el.value = text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    // contenteditable
    try {
      const sel = window.getSelection();
      sel.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.addRange(range);
      // execCommand is deprecated but still the most reliable way to trigger
      // synthetic React/Lexical input handling inside contenteditable editors.
      if (document.execCommand('insertText', false, text)) return true;
    } catch (_) { /* fall through */ }
    // Fallback: set textContent and dispatch an input event.
    el.textContent = text;
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true, cancelable: true, inputType: 'insertText', data: text,
    }));
    return true;
  }

  function firstVisible(nodeList) {
    for (const n of nodeList) {
      const rect = n.getBoundingClientRect?.();
      if (rect && rect.width > 0 && rect.height > 0) return n;
    }
    return nodeList[nodeList.length - 1] || null;
  }

  const claude = {
    site: 'claude',
    match: () => location.hostname === 'claude.ai',
    findComposer: () =>
      document.querySelector('div[contenteditable="true"].ProseMirror') ||
      document.querySelector('fieldset div[contenteditable="true"]') ||
      document.querySelector('div[contenteditable="true"]'),
    findSendButton: () =>
      document.querySelector('button[aria-label="Send message"]') ||
      document.querySelector('button[aria-label="Send Message"]') ||
      document.querySelector('button[aria-label*="Send" i]'),
    findStopButton: () =>
      document.querySelector('button[aria-label="Stop response"]') ||
      document.querySelector('button[aria-label*="Stop" i]'),
    findLastResponse: () => {
      const msgs = document.querySelectorAll('.font-claude-message, [data-testid="message-content"]');
      const el = firstVisible(msgs);
      return el ? el.innerText.trim() : null;
    },
  };

  const chatgpt = {
    site: 'chatgpt',
    match: () => /(^|\.)chatgpt\.com$/.test(location.hostname)
              || /(^|\.)chat\.openai\.com$/.test(location.hostname),
    findComposer: () =>
      document.querySelector('#prompt-textarea') ||
      document.querySelector('div[contenteditable="true"][data-virtualkeyboard]') ||
      document.querySelector('form div[contenteditable="true"]') ||
      document.querySelector('div[contenteditable="true"]'),
    findSendButton: () =>
      document.querySelector('button[data-testid="send-button"]') ||
      document.querySelector('button[aria-label="Send prompt"]') ||
      document.querySelector('button[aria-label*="Send" i]'),
    findStopButton: () =>
      document.querySelector('button[data-testid="stop-button"]') ||
      document.querySelector('button[aria-label="Stop generating"]') ||
      document.querySelector('button[aria-label*="Stop" i]'),
    findLastResponse: () => {
      const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
      const el = msgs[msgs.length - 1];
      if (!el) return null;
      // Prefer the markdown container when present so we avoid button labels.
      const md = el.querySelector('.markdown, [data-message-content], .prose');
      return (md || el).innerText.trim();
    },
  };

  const gemini = {
    site: 'gemini',
    match: () => location.hostname === 'gemini.google.com',
    findComposer: () =>
      document.querySelector('rich-textarea div[contenteditable="true"]') ||
      document.querySelector('div.ql-editor[contenteditable="true"]') ||
      document.querySelector('div[contenteditable="true"]'),
    findSendButton: () =>
      document.querySelector('button.send-button:not([aria-disabled="true"])') ||
      document.querySelector('button[aria-label*="Send" i]:not([disabled])') ||
      document.querySelector('button[mattooltip*="Send" i]'),
    findStopButton: () =>
      document.querySelector('button.stop') ||
      document.querySelector('button[aria-label*="Stop" i]'),
    findLastResponse: () => {
      const msgs = document.querySelectorAll('model-response message-content, model-response .markdown, message-content .markdown');
      const el = msgs[msgs.length - 1];
      return el ? el.innerText.trim() : null;
    },
  };

  const adapters = [claude, chatgpt, gemini];

  window.__chatbotRelay = {
    sleep,
    waitFor,
    insertIntoComposer,
    pickAdapter: () => adapters.find((a) => a.match()) || null,
  };
})();
