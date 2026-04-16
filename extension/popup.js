// popup.js — the extension's popup UI. Talks to the background worker only;
// the background worker is the single source of truth for tab state.

const send = (msg) =>
  new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => resolve(res || { ok: false }));
    } catch (e) {
      resolve({ ok: false, error: String(e) });
    }
  });

let currentTabs = [];

const SITE_LABEL = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' };

function render() {
  renderTabs(currentTabs);
  renderResponses(currentTabs);
}

function renderTabs(tabs) {
  const list = document.getElementById('tab-list');
  list.innerHTML = '';
  if (!tabs.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No chatbot tabs open. Open claude.ai, chatgpt.com, or gemini.google.com.';
    list.appendChild(li);
    return;
  }
  for (const t of tabs) {
    const li = document.createElement('li');
    const site = document.createElement('span');
    site.className = 'site';
    site.textContent = SITE_LABEL[t.site] || t.site;
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = t.title || t.url || '';
    title.title = t.url || '';
    const status = document.createElement('span');
    status.className = `status ${t.status || 'idle'}`;
    status.textContent = t.status || 'idle';
    const focus = document.createElement('button');
    focus.textContent = 'Show';
    focus.title = 'Switch to this tab';
    focus.addEventListener('click', () => send({ type: 'focusTab', tabId: t.id }));
    li.append(site, title, status, focus);
    list.appendChild(li);
  }
}

function renderResponses(tabs) {
  const container = document.getElementById('responses');
  container.innerHTML = '';
  const withResp = tabs.filter((t) => t.lastResponse);
  if (!withResp.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = 'No responses captured yet. Broadcast a prompt and wait for the bots to reply.';
    container.appendChild(d);
    return;
  }
  for (const t of withResp) {
    container.appendChild(responseCard(t));
  }
}

function responseCard(t) {
  const wrap = document.createElement('div');
  wrap.className = 'response';
  const head = document.createElement('div');
  head.className = 'resp-header';
  const who = document.createElement('strong');
  who.textContent = SITE_LABEL[t.site] || t.site;
  head.appendChild(who);
  wrap.appendChild(head);

  const pre = document.createElement('pre');
  pre.textContent = t.lastResponse;
  wrap.appendChild(pre);

  const actions = document.createElement('div');
  actions.className = 'actions';

  const copyBtn = document.createElement('button');
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(t.lastResponse);
      copyBtn.textContent = 'Copied!';
      setTimeout(() => (copyBtn.textContent = 'Copy'), 1200);
    } catch (_) {
      copyBtn.textContent = 'Copy failed';
    }
  });
  actions.appendChild(copyBtn);

  const otherSites = Object.keys(SITE_LABEL).filter((s) => s !== t.site);
  const forwardAll = document.createElement('button');
  forwardAll.textContent = 'Send to other bots';
  forwardAll.className = 'primary';
  forwardAll.addEventListener('click', async () => {
    await send({ type: 'broadcast', sites: otherSites, text: t.lastResponse });
  });
  actions.appendChild(forwardAll);

  for (const s of otherSites) {
    const btn = document.createElement('button');
    btn.textContent = `→ ${SITE_LABEL[s]}`;
    btn.title = `Send this response to ${SITE_LABEL[s]} only`;
    btn.addEventListener('click', async () => {
      await send({ type: 'broadcast', sites: [s], text: t.lastResponse });
    });
    actions.appendChild(btn);
  }

  const insertBtn = document.createElement('button');
  insertBtn.textContent = 'Insert (no send) into others';
  insertBtn.title = 'Paste into each other bot\'s composer without submitting';
  insertBtn.addEventListener('click', async () => {
    for (const other of currentTabs) {
      if (other.site === t.site) continue;
      await send({ type: 'insertOnly', tabId: other.id, text: t.lastResponse });
    }
  });
  actions.appendChild(insertBtn);

  wrap.appendChild(actions);
  return wrap;
}

async function refresh() {
  const res = await send({ type: 'list' });
  currentTabs = res?.tabs || [];
  render();
}

document.getElementById('broadcast').addEventListener('click', async () => {
  const text = document.getElementById('prompt').value.trim();
  if (!text) return;
  const sites = [...document.querySelectorAll('.site-picker input[type="checkbox"]:checked')]
    .map((i) => i.dataset.site);
  if (!sites.length) return;
  const btn = document.getElementById('broadcast');
  btn.disabled = true;
  btn.textContent = 'Sending...';
  try {
    await send({ type: 'broadcast', text, sites });
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send to selected';
  }
});

document.getElementById('refresh').addEventListener('click', refresh);

document.getElementById('refresh-responses').addEventListener('click', async () => {
  // Ask each registered tab for its current visible last response.
  const list = (await send({ type: 'list' }))?.tabs || [];
  await Promise.all(list.map((t) => send({ type: 'readLatest', tabId: t.id })));
  await refresh();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'tabUpdate' && Array.isArray(msg.tabs)) {
    currentTabs = msg.tabs;
    render();
  }
});

refresh();
