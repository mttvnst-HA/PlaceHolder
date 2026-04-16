// background.js — service worker: keeps a registry of chatbot tabs and routes
// messages between the popup and per-tab content scripts.

const MATCH_PATTERNS = [
  'https://claude.ai/*',
  'https://chatgpt.com/*',
  'https://chat.openai.com/*',
  'https://gemini.google.com/*',
];

// tabId -> { site, title, url, status, lastResponse, lastPrompt, updatedAt }
const tabs = new Map();

function siteFromUrl(url) {
  if (!url) return null;
  if (url.includes('claude.ai')) return 'claude';
  if (url.includes('gemini.google.com')) return 'gemini';
  if (url.includes('chatgpt.com') || url.includes('chat.openai.com')) return 'chatgpt';
  return null;
}

function snapshot() {
  return [...tabs.entries()].map(([id, v]) => ({ id, ...v }));
}

async function refreshTabs() {
  const found = await chrome.tabs.query({ url: MATCH_PATTERNS });
  const seen = new Set();
  for (const t of found) {
    seen.add(t.id);
    const site = siteFromUrl(t.url);
    if (!site) continue;
    const prev = tabs.get(t.id);
    tabs.set(t.id, {
      site,
      title: t.title,
      url: t.url,
      status: prev?.status || 'idle',
      lastResponse: prev?.lastResponse ?? null,
      lastPrompt: prev?.lastPrompt ?? null,
      updatedAt: prev?.updatedAt ?? Date.now(),
    });
  }
  for (const id of [...tabs.keys()]) {
    if (!seen.has(id)) tabs.delete(id);
  }
  return snapshot();
}

function update(tabId, patch) {
  const rec = tabs.get(tabId);
  if (!rec) return;
  Object.assign(rec, patch, { updatedAt: Date.now() });
  // Best-effort notify popup; ignore errors when popup is closed.
  chrome.runtime.sendMessage({ type: 'tabUpdate', tabs: snapshot() }).catch(() => {});
}

async function sendToTab(tabId, text) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'send', text });
    update(tabId, { status: 'waiting', lastPrompt: text });
    return { ok: true };
  } catch (e) {
    update(tabId, { status: 'error' });
    return { ok: false, error: String(e?.message || e) };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case 'hello': {
          if (!sender.tab) return sendResponse({ ok: false });
          const site = msg.site || siteFromUrl(sender.tab.url);
          tabs.set(sender.tab.id, {
            site,
            title: msg.title || sender.tab.title,
            url: msg.url || sender.tab.url,
            status: 'idle',
            lastResponse: null,
            lastPrompt: null,
            updatedAt: Date.now(),
          });
          chrome.runtime.sendMessage({ type: 'tabUpdate', tabs: snapshot() }).catch(() => {});
          return sendResponse({ ok: true });
        }
        case 'list': {
          return sendResponse({ ok: true, tabs: await refreshTabs() });
        }
        case 'sendToTab': {
          return sendResponse(await sendToTab(msg.tabId, msg.text));
        }
        case 'broadcast': {
          const list = await refreshTabs();
          const sites = msg.sites && msg.sites.length ? msg.sites : null;
          const targets = sites ? list.filter(t => sites.includes(t.site)) : list;
          const results = [];
          for (const t of targets) {
            // eslint-disable-next-line no-await-in-loop
            results.push({ tabId: t.id, site: t.site, ...(await sendToTab(t.id, msg.text)) });
          }
          return sendResponse({ ok: true, results });
        }
        case 'insertOnly': {
          try {
            await chrome.tabs.sendMessage(msg.tabId, { type: 'insertOnly', text: msg.text });
            return sendResponse({ ok: true });
          } catch (e) {
            return sendResponse({ ok: false, error: String(e?.message || e) });
          }
        }
        case 'readLatest': {
          try {
            const res = await chrome.tabs.sendMessage(msg.tabId, { type: 'readLatest' });
            if (res?.ok && res.text) update(msg.tabId, { lastResponse: res.text, status: 'idle' });
            return sendResponse(res || { ok: false });
          } catch (e) {
            return sendResponse({ ok: false, error: String(e?.message || e) });
          }
        }
        case 'focusTab': {
          try {
            await chrome.tabs.update(msg.tabId, { active: true });
            const tab = await chrome.tabs.get(msg.tabId);
            if (tab?.windowId) await chrome.windows.update(tab.windowId, { focused: true });
            return sendResponse({ ok: true });
          } catch (e) {
            return sendResponse({ ok: false, error: String(e?.message || e) });
          }
        }
        case 'responseReady': {
          if (sender.tab) {
            update(sender.tab.id, { lastResponse: msg.text || null, status: 'idle' });
          }
          return sendResponse({ ok: true });
        }
        case 'statusUpdate': {
          if (sender.tab) update(sender.tab.id, { status: msg.status });
          return sendResponse({ ok: true });
        }
        default:
          return sendResponse({ ok: false, error: 'unknown message type' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true; // keep channel open for async sendResponse
});

chrome.tabs.onRemoved.addListener((id) => {
  if (tabs.delete(id)) {
    chrome.runtime.sendMessage({ type: 'tabUpdate', tabs: snapshot() }).catch(() => {});
  }
});

chrome.tabs.onUpdated.addListener((id, info, tab) => {
  if (info.status !== 'complete') return;
  const site = siteFromUrl(tab.url);
  if (!site) {
    if (tabs.delete(id)) {
      chrome.runtime.sendMessage({ type: 'tabUpdate', tabs: snapshot() }).catch(() => {});
    }
    return;
  }
  const prev = tabs.get(id);
  tabs.set(id, {
    site,
    title: tab.title,
    url: tab.url,
    status: prev?.status || 'idle',
    lastResponse: prev?.lastResponse ?? null,
    lastPrompt: prev?.lastPrompt ?? null,
    updatedAt: Date.now(),
  });
});

// Prime the registry on startup.
chrome.runtime.onInstalled.addListener(() => { refreshTabs(); });
chrome.runtime.onStartup.addListener(() => { refreshTabs(); });
