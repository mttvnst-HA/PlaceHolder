# Chatbot Relay

A Chromium browser extension (Chrome / Edge / Brave / Arc) that copy/pastes
text between chatbots accessed in your browser. It coordinates open tabs of
**Claude** (claude.ai), **ChatGPT** (chatgpt.com), and **Gemini**
(gemini.google.com) so you can:

1. Open one tab of each chatbot and log in as you normally would.
2. Type a seed prompt once and **broadcast** it to every bot at the same time.
3. Wait for each bot to finish streaming; the extension captures each response.
4. With one click, **forward any bot's response into the other bots' chat
   boxes** (either auto-sent, or pasted without submitting so you can edit it).

All activity happens locally in your browser against the web UIs you're
already logged into — no API keys, no server.

## Install (unpacked)

1. Clone / download this repository.
2. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the `extension/` directory in this
   repo.
5. Pin the **Chatbot Relay** extension to the toolbar.

> Firefox: the manifest is MV3; it loads in recent Firefox via
> `about:debugging` → *Load Temporary Add-on*, but the selectors are tuned
> for Chromium-rendered versions of each site. YMMV.

## Use

1. Open a tab of each chatbot you want to use (claude.ai, chatgpt.com,
   gemini.google.com) and log in.
2. Click the **Chatbot Relay** toolbar icon. The popup lists every chatbot
   tab it detected.
3. Type a prompt in the **Prompt to broadcast** box, choose which bots
   should get it, click **Send to selected**. The extension will:
   - Focus each bot's composer,
   - Insert your prompt,
   - Click *Send*,
   - Watch the DOM for streaming to stop, then
   - Capture the final assistant message.
4. Captured responses appear under **Latest responses**. For any response you
   can:
   - **Copy** it to the clipboard,
   - Click **Send to other bots** to broadcast that response into the other
     two chats (auto-submitted), or
   - Click **→ Claude / → ChatGPT / → Gemini** to send it to one specific
     bot,
   - Click **Insert (no send) into others** if you want to paste the text
     into each other composer but edit it before sending.

## How it works

```
popup.html/js   <->   background.js (service worker)   <->   content.js (per chatbot tab)
                              |                                       |
                              |— keeps a registry of open tabs        |— uses adapters.js
                              |— routes messages                      |   to find the composer,
                              |— pushes state updates                 |   send button, stop
                                                                       |   button, and last
                                                                       |   assistant message
```

The background worker tracks every tab whose URL matches one of the
chatbot hosts. The popup asks the worker for that list, and for any given
tab, the worker forwards `send` / `insertOnly` / `readLatest` messages to the
tab's content script, which manipulates the DOM.

Completion detection works by polling for the site's **Stop generating**
button: while that button exists, the bot is streaming; once it's been
absent for two consecutive polls, the extension reads the most recent
assistant message and reports it back.

## Fragility note

The selectors used to find the composer, send button, stop button, and
last assistant message are site-specific and **change frequently** as
Claude/ChatGPT/Gemini update their UIs. If a site stops working:

1. Open the chatbot in your browser.
2. DevTools → Elements → inspect the composer / send button / last message.
3. Edit the matching selectors in [`extension/adapters.js`](extension/adapters.js).
4. Reload the extension from `chrome://extensions`.

The three adapters (`claude`, `chatgpt`, `gemini`) each have the same
four methods — `findComposer`, `findSendButton`, `findStopButton`,
`findLastResponse` — so fixing one adapter without touching the others is
straightforward.

If all else fails, use the **Refresh responses** button: it asks each tab
for whatever is currently the latest visible assistant message, without
depending on streaming-completion detection.

## Limitations

- Requires you to be logged into each chatbot in that browser profile.
- Web UIs change often; selectors may need tweaks (see above).
- The popup window closes when you click outside it. The background worker
  keeps state, so responses are preserved; reopen the popup to see updates.
- Only the most recent assistant message per tab is tracked — not the full
  conversation history.
- No rate-limit handling; if a site errors (captcha, quota, etc.) the
  extension will show `error` status and you'll need to resolve it in the
  tab directly.

## Files

| File | Purpose |
| ---- | ------- |
| `extension/manifest.json` | MV3 manifest; declares host permissions and content scripts. |
| `extension/background.js` | Service worker: tab registry + message router. |
| `extension/adapters.js`   | Per-site DOM selectors and text-insertion helpers. |
| `extension/content.js`    | Injected into each chatbot page; receives commands from the worker. |
| `extension/popup.html/.css/.js` | Toolbar popup UI. |
