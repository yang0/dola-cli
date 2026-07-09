#!/usr/bin/env bun
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";

const DEFAULT_CDP = "http://127.0.0.1:9222";
const DEFAULT_SESSION = "https://www.dola.com/chat/38415631468262161";
const DOLA_CHAT_HOME = "https://www.dola.com/chat";
const DOLA_IMAGE_HOME = "https://www.dola.com/chat/create-image";
const DEFAULT_OUT_DIR = "downloads";

class DolaCliError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DolaCliError";
    this.code = code;
    this.details = details;
  }
}

function usage() {
  console.log(`dola-cli

Submit a message, optionally with local image/file attachments, to Dola chat
through an existing Chrome session exposed on CDP port 9222.

Usage:
  bun src/cli.js --session <dola-chat-url|id> --prompt <text> [options]
  bun src/cli.js --new-chat --prompt <text> [options]
  bun src/cli.js --new-chat --batch-prompt-file <path> [options]

Prerequisites:
  1. Start Chrome with --remote-debugging-port=9222.
  2. Log in to https://www.dola.com manually.
  3. Use --session for an existing chat, or --new-chat for Dola chat home.

Demos:
  bun src/cli.js --session "${DEFAULT_SESSION}" --dry-run
  bun src/cli.js --session "${DEFAULT_SESSION}" --file "E:\\temp\\aa.png" --prompt "请描述这张图片" --no-wait
  bun src/cli.js --new-chat --file "E:\\temp\\aa.png" --prompt "What is in this image?"

Options:
  --session <url|id>       Existing Dola chat URL/id, or ${DOLA_CHAT_HOME}.
  --new-chat               Start at ${DOLA_CHAT_HOME}.
  --prompt <text>          Prompt to submit. If omitted, the CLI asks interactively.
  --prompt-file <path>     Read prompt from a UTF-8 text file.
  --batch-prompt-file <path>
                           Generate images for each non-empty line in a UTF-8 text file.
  --file <path>            Attach a local file before submitting. Can be repeated.
  --attach <path>          Alias for --file.
  --cdp <url>              Chrome CDP endpoint. Default: ${DEFAULT_CDP}
  --timeout <ms>           Max wait time after submit. Default: 120000
  --stable <ms>            Response text stability window. Default: 3000
  --image-gen              Enable Dola image generation and download images from the last reply only.
  --out <path>             Image download directory. Default: ${DEFAULT_OUT_DIR}
  --count <n>              Number of images to download. Default: 1
  --no-download            Generate images without downloading them.
  --allow-watermark        Permit watermarked image URLs when no raw URL is available.
  --no-wait                Submit only; do not wait for response text.
  --debug-ui               Print visible input/button candidates and exit.
  --debug-images           Print captured image URLs and exit.
  --dry-run                Validate CDP/session only; do not submit a prompt.
  -h, --help               Show this help.

Image generation errors (non-zero exit):
  IMAGE_GENERATION_QUOTA_EXHAUSTED  The last reply indicates quota or usage exhaustion.
  IMAGE_GENERATION_REFUSED          The last reply indicates generation was refused.
  IMAGE_GENERATION_TEXT_RESPONSE    The last reply is text instead of an image.
  IMAGE_GENERATION_TIMEOUT          No image appeared in the last reply before timeout.
  IMAGE_GENERATION_NO_CLEAN_IMAGE   Only non-raw/watermarked image URLs were available.
`);
}

function parseArgs(argv) {
  const args = { cdp: DEFAULT_CDP, out: DEFAULT_OUT_DIR, count: 1, timeout: 120000, stable: 3000, files: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (!next) throw new Error(`Missing value for ${arg}`);
      return next;
    };
    if (arg === "-h" || arg === "--help") args.help = true;
    else if (arg === "--session") args.session = value();
    else if (arg === "--new-chat") args.newChat = true;
    else if (arg === "--image-gen" || arg === "--image-generation") args.imageGen = true;
    else if (arg === "--prompt") args.prompt = value();
    else if (arg === "--prompt-file") args.promptFile = value();
    else if (arg === "--batch-prompt-file") args.batchPromptFile = value();
    else if (arg === "--file" || arg === "--attach") args.files.push(value());
    else if (arg === "--cdp") args.cdp = value();
    else if (arg === "--out") args.out = value();
    else if (arg === "--count") args.count = Number(value());
    else if (arg === "--timeout") args.timeout = Number(value());
    else if (arg === "--stable") args.stable = Number(value());
    else if (arg === "--no-wait") args.noWait = true;
    else if (arg === "--no-download") args.noDownload = true;
    else if (arg === "--allow-watermark") args.allowWatermark = true;
    else if (arg === "--debug-ui") args.debugUi = true;
    else if (arg === "--debug-images") args.debugImages = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(args.count) || args.count < 1) throw new Error("--count must be a positive number.");
  if (!Number.isFinite(args.timeout) || args.timeout < 1000) throw new Error("--timeout must be at least 1000.");
  if (!Number.isFinite(args.stable) || args.stable < 500) throw new Error("--stable must be at least 500.");
  if (args.batchPromptFile) {
    if (args.prompt || args.promptFile) throw new Error("--batch-prompt-file cannot be combined with --prompt or --prompt-file.");
    if (args.noWait) throw new Error("--batch-prompt-file cannot be combined with --no-wait.");
    args.imageGen = true;
  }
  return args;
}

async function askRequired(question) {
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(question)).trim();
    if (!answer) throw new Error("Required input was empty.");
    return answer;
  } finally {
    rl.close();
  }
}

function normalizeSession(session) {
  const value = String(session || "").trim();
  if (!value) throw new Error("chat session is required.");
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    if (!/(^|\.)dola\.com$/i.test(url.hostname)) throw new Error("session URL must be a dola.com URL.");
    if (url.pathname.replace(/\/+$/, "") === "/chat") return DOLA_CHAT_HOME;
    return url.toString();
  }
  if (/^\d{8,}$/.test(value)) return `https://www.dola.com/chat/${value}`;
  throw new Error("chat session must be a Dola chat URL or numeric session id.");
}

function isChatHomeUrl(url) {
  try {
    const parsed = new URL(url);
    return /(^|\.)dola\.com$/i.test(parsed.hostname) && parsed.pathname.replace(/\/+$/, "") === "/chat";
  } catch {
    return false;
  }
}

function isConcreteChatUrl(url) {
  try {
    const parsed = new URL(url);
    return /(^|\.)dola\.com$/i.test(parsed.hostname) && /^\/chat\/\d+\/?$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

async function loadPrompt(args) {
  if (args.promptFile) return (await readFile(args.promptFile, "utf8")).trim();
  if (args.prompt) return String(args.prompt).trim();
  return askRequired("Prompt to submit: ");
}

async function loadBatchPrompts(file) {
  const text = await readFile(file, "utf8");
  const prompts = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  if (!prompts.length) throw new Error(`No non-empty prompts found in batch file: ${file}`);
  return prompts;
}

async function normalizeFiles(files) {
  const resolved = [];
  for (const file of files || []) {
    const fullPath = path.resolve(file);
    await access(fullPath, fsConstants.R_OK).catch(() => {
      throw new Error(`Attachment is not readable: ${fullPath}`);
    });
    resolved.push(fullPath);
  }
  return resolved;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cdpHttpUrl(cdp, pathname) {
  const base = new URL(cdp);
  return `${base.origin}${pathname}`;
}

function isLikelyImageUrl(url) {
  if (!url || typeof url !== "string") return false;
  if (!/^https?:\/\//i.test(url)) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (/\/(api|web|passport)\//i.test(parsed.pathname)) return false;
  if (/\.(png|jpe?g|webp|gif)(\?|$)/i.test(url)) return true;
  const hostLooksImage = /dola|byteimg|bytedance|volc|tos|cdn|image|img/i.test(parsed.hostname);
  const pathLooksImage = /image|img|tplv|tos-|obj\/|origin|raw|large|webp|jpeg|jpg|png/i.test(parsed.pathname);
  const queryLooksSigned = /x-expires|expires|sign|signature|format|image|img|tplv|raw|origin|width|height/i.test(parsed.search);
  return hostLooksImage && pathLooksImage && queryLooksSigned;
}

function isWatermarkedUrl(url) {
  return /watermark|downsize_watermark|image_dld_watermark|image_pre_watermark|hcg_watermark|img_pre_mark|wm_|with[_-]?water|marked|logo/i.test(url || "");
}

function isPreferredRawUrl(url) {
  if (isWatermarkedUrl(url)) return false;
  if (/(image_raw|raw|origin|original|ori|source|large|no[_-]?watermark|without[_-]?watermark)/i.test(url || "")) return true;
  if (/rc_gen_image\/[a-f0-9]{16,64}\.(jpeg|jpg|png|webp)(\?|$)/i.test(url || "")) return true;
  return false;
}

function imageKeyFromUrl(url) {
  const text = String(url || "");
  const match = /rc_gen_image\/([a-f0-9]{16,64})(?:preview)?\.(?:jpeg|jpg|png|webp)/i.exec(text)
    || /rc_gen_image\/([^~?/#]+)(?:~|\?|$)/i.exec(text);
  if (!match) return "";
  const filename = match[1].includes(".") ? match[1] : `${match[1]}.jpeg`;
  return `rc_gen_image/${filename.replace(/preview\.(jpeg|jpg|png|webp)$/i, ".$1")}`;
}

function normalizeImageKey(value) {
  return imageKeyFromUrl(value) || String(value || "").replace(/^\d+_\d+_/, "");
}

function collectImageUrls(value, found = new Set()) {
  if (!value) return found;
  if (typeof value === "string") {
    if (isLikelyImageUrl(value)) found.add(value);
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectImageUrls(item, found);
    return found;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (/url|uri|src|image|origin|original|raw|large|watermark/i.test(key)) collectImageUrls(item, found);
      else if (typeof item === "object") collectImageUrls(item, found);
    }
  }
  return found;
}

function extractImageRecordsFromJson(value, records = []) {
  const visit = (node, context = {}) => {
    if (!node || typeof node !== "object") return;
    const next = {
      conversation_id: node.conversation_id || node.conversationId || context.conversation_id || "",
      message_id: node.message_id || node.messageId || node.id || context.message_id || "",
      key: node.key || context.key || "",
      prompt: node.prompt || node.query || node.input || context.prompt || "",
    };

    const urls = [];
    for (const [key, item] of Object.entries(node)) {
      if (/url|uri|src|image|origin|original|raw|large|watermark/i.test(key)) {
        for (const url of collectImageUrls(item)) urls.push(url);
      }
    }
    for (const url of urls) {
      records.push({ ...next, url, key: next.key || imageKeyFromUrl(url), raw: isPreferredRawUrl(url), watermarked: isWatermarkedUrl(url) });
    }

    for (const child of (Array.isArray(node) ? node : Object.values(node))) visit(child, next);
  };
  visit(value);
  return records;
}

function uniqueImageRecords(records) {
  const byUrl = new Map();
  for (const item of records) {
    if (!item?.url || !isLikelyImageUrl(item.url)) continue;
    if (!byUrl.has(item.url)) byUrl.set(item.url, item);
  }
  return [...byUrl.values()];
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 1;
    this.pending = new Map();
    this.events = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.onmessage = event => this.handleMessage(String(event.data));
    this.ws.onerror = () => {};
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP WebSocket timeout: ${this.wsUrl}`)), 15000);
      this.ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      this.ws.onclose = () => {
        clearTimeout(timer);
        reject(new Error(`CDP WebSocket closed before opening: ${this.wsUrl}`));
      };
    });
  }

  handleMessage(raw) {
    const msg = JSON.parse(raw);
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result || {});
      return;
    }
    if (msg.method && this.events.has(msg.method)) {
      for (const fn of this.events.get(msg.method)) fn(msg.params || {});
    }
  }

  on(method, fn) {
    if (!this.events.has(method)) this.events.set(method, new Set());
    this.events.get(method).add(fn);
  }

  send(method, params = {}) {
    const id = this.id++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  close() {
    this.ws?.close();
  }
}

async function findOrCreateTarget(cdp, sessionUrl, forceNew = false) {
  const targets = await fetch(cdpHttpUrl(cdp, "/json/list")).then(r => r.json());
  if (!forceNew) {
    const exact = targets.find(item => item.type === "page" && item.url === sessionUrl);
    if (exact) return exact;
    const dolaChat = targets.find(item => item.type === "page" && /dola\.com\/chat/i.test(item.url));
    if (dolaChat) return dolaChat;
  }

  const createPath = `/json/new?${encodeURIComponent(sessionUrl)}`;
  const created = await fetch(cdpHttpUrl(cdp, createPath), { method: "PUT" })
    .then(r => r.ok ? r.json() : fetch(cdpHttpUrl(cdp, createPath)).then(rr => rr.json()));
  return created;
}

async function evaluate(client, expression, awaitPromise = true) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed.");
  }
  return result.result?.value;
}

async function waitForPageReady(client, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ready = await evaluate(client, `document.readyState`).catch(() => "");
    if (ready === "interactive" || ready === "complete") return;
    await sleep(500);
  }
}

async function waitForConcreteChatUrl(client, initialUrl, timeoutMs = 60000) {
  const started = Date.now();
  let lastUrl = initialUrl;
  while (Date.now() - started < timeoutMs) {
    lastUrl = await evaluate(client, "location.href").catch(() => lastUrl);
    if (isConcreteChatUrl(lastUrl)) return lastUrl;
    await sleep(1000);
  }
  return lastUrl;
}

async function ensureImageGenerationMode(client) {
  const state = await evaluate(client, `(() => {
    const imageTexts = ["\\u56fe\\u50cf\\u751f\\u6210", "Create Image", "Image Generation"];
    const imageRegex = /image.?gen|create.?image|image/i;
    if (/\\/chat\\/create-image/i.test(location.pathname)) return { ok: true, already: true };
    const visible = el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const isActive = el => {
      const text = [el.innerText, el.textContent, el.getAttribute("aria-label"), el.title, el.className, el.id].join(" ");
      const selected = el.getAttribute("aria-selected") === "true" || el.getAttribute("data-state") === "active";
      return selected || /active|selected|checked|primary|highlight/i.test(text);
    };
    const matchesImage = el => {
      const text = (el.innerText || el.textContent || "");
      const allText = [text, el.getAttribute("aria-label"), el.title, el.className, el.id].join(" ");
      return imageTexts.some(t => text.includes(t)) || imageRegex.test(allText);
    };
    const activeButton = Array.from(document.querySelectorAll("button, [role='button']"))
      .filter(visible)
      .find(el => matchesImage(el) && isActive(el));
    if (activeButton) return { ok: true, already: true };

    const candidates = [
      ...document.querySelectorAll('[data-skill-id="skill_bar_button_3"], [data-testid*="image"], [id*="image"]'),
      ...document.querySelectorAll("button, [role='button']")
    ].filter(visible)
      .map(el => {
        const rect = el.getBoundingClientRect();
        const text = [el.innerText, el.textContent, el.getAttribute("aria-label"), el.title, el.className, el.id].join(" ");
        const plain = (el.innerText || el.textContent || "");
        let score = 0;
        if (imageTexts.some(t => plain.includes(t))) score += 200;
        if (imageRegex.test(text)) score += 120;
        if (rect.y > window.innerHeight * 0.55) score += 20;
        return { el, score, rect, text: text.trim().slice(0, 120) };
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score);
    const item = candidates[0];
    if (!item) return { ok: false, error: "No image generation button found." };
    return { ok: true, already: false, text: item.text, x: item.rect.x + item.rect.width / 2, y: item.rect.y + item.rect.height / 2 };
  })()`);

  if (!state?.ok) throw new Error(state?.error || "No image generation button found.");
  if (!state.already) {
    await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: state.x, y: state.y, button: "left", clickCount: 1 });
    await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: state.x, y: state.y, button: "left", clickCount: 1 });
  }

  const switched = await evaluate(client, `(() => new Promise(resolve => {
    const imageTexts = ["\\u56fe\\u50cf\\u751f\\u6210", "Create Image", "Image Generation"];
    const visible = el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const check = () => {
      if (/\\/chat\\/create-image/i.test(location.pathname)) return true;
      const buttons = Array.from(document.querySelectorAll("button, [role='button']")).filter(visible);
      const matching = buttons.filter(el => imageTexts.some(t => (el.innerText || el.textContent || "").includes(t)));
      const active = matching.some(el => {
        const text = [el.innerText, el.textContent, el.className, el.getAttribute("aria-selected"), el.getAttribute("data-state")].join(" ");
        return /active|selected|checked|primary|highlight|true/i.test(text);
      });
      return active;
    };
    if (check()) return resolve(true);
    const deadline = Date.now() + 6000;
    const timer = setInterval(() => {
      if (check() || Date.now() > deadline) {
        clearInterval(timer);
        resolve(check());
      }
    }, 250);
  }))()`);
  if (!switched) throw new Error("Clicked image generation but Dola did not appear to switch modes.");
  console.log("[dola-cli] image generation mode ready");
}

async function attachFiles(client, files) {
  if (!files.length) return [];
  await client.send("DOM.enable");

  const names = files.map(file => path.basename(file));
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const documentResult = await client.send("DOM.getDocument", { depth: -1, pierce: true });
    const rootNodeId = documentResult.root?.nodeId;
    if (!rootNodeId) throw new Error("Could not inspect Dola DOM for file input.");

    let inputResult = await client.send("DOM.querySelector", {
      nodeId: rootNodeId,
      selector: "input[type=file]",
    });

    if (!inputResult.nodeId && attempt === 1) {
      await clickAttachmentButton(client).catch(() => {});
      await sleep(1000);
      continue;
    }

    if (!inputResult.nodeId) {
      await clickAttachmentButton(client).catch(() => {});
      await sleep(1000);
      inputResult = await client.send("DOM.querySelector", { nodeId: rootNodeId, selector: "input[type=file]" });
    }

    if (inputResult.nodeId) {
      await client.send("DOM.setFileInputFiles", { nodeId: inputResult.nodeId, files });
      await waitForAttachments(client, names);
      console.log(`[dola-cli] attached ${names.join(", ")}`);
      return names;
    }
  }

  throw new Error("No Dola file input found.");
}

async function clickAttachmentButton(client) {
  const button = await evaluate(client, `(() => {
    const visible = el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const words = /attach|upload|image|file|photo|添加|上传|图片|文件|附件|照片/i;
    const candidates = Array.from(document.querySelectorAll("button, [role='button'], label, [aria-label], [title]"))
      .filter(visible)
      .map(el => ({ el, text: [el.innerText, el.textContent, el.getAttribute("aria-label"), el.title, el.className, el.id].join(" "), rect: el.getBoundingClientRect() }))
      .filter(item => words.test(item.text))
      .sort((a, b) => (b.rect.y - a.rect.y) || (a.rect.x - b.rect.x));
    const item = candidates[0];
    if (!item) return null;
    return { x: item.rect.x + item.rect.width / 2, y: item.rect.y + item.rect.height / 2 };
  })()`);
  if (!button) throw new Error("No visible attachment button found.");
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: button.x, y: button.y, button: "left", clickCount: 1 });
  await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: button.x, y: button.y, button: "left", clickCount: 1 });
}

async function waitForAttachments(client, names) {
  const started = Date.now();
  while (Date.now() - started < 20000) {
    const state = await evaluate(client, `(() => {
      const names = ${JSON.stringify(names)};
      const body = document.body.innerText || "";
      const selected = Array.from(document.querySelector("input[type=file]")?.files || []).map(file => file.name);
      return {
        selected,
        seen: names.filter(name => body.includes(name)),
        uploading: /uploading|processing|上传中|处理中/i.test(body),
      };
    })()`).catch(() => null);
    if (state?.seen?.length === names.length && !state.uploading) return;
    if (state?.selected?.length === names.length && names.every(name => state.selected.includes(name))) {
      await sleep(2500);
      return;
    }
    await sleep(1000);
  }
}

async function submitPrompt(client, promptText, options = {}) {
  const inputInfo = await evaluate(client, `(() => {
    const visible = el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const pickLastVisible = selectors => {
      for (const selector of selectors) {
        const items = Array.from(document.querySelectorAll(selector)).filter(visible);
        if (items.length) return { el: items[items.length - 1], selector };
      }
      return null;
    };
    const input = pickLastVisible([
      "textarea:not([aria-hidden='true']):not([tabindex='-1'])",
      "[contenteditable='true']",
      "[role='textbox']",
      "div[contenteditable='true']",
      "textarea",
      "input[type='text']"
    ]);
    if (!input) return { ok: false, error: "No visible Dola input box found." };
    input.el.focus();
    // Clear any leftover text by selecting all and deleting through real keyboard events.
    input.el.setSelectionRange && input.el.setSelectionRange(0, input.el.value ? input.el.value.length : 0);
    const rect = input.el.getBoundingClientRect();
    return { ok: true, selector: input.selector, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tagName: input.el.tagName };
  })()`);

  if (!inputInfo?.ok) throw new Error(inputInfo?.error || "No visible Dola input box found.");
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: inputInfo.x, y: inputInfo.y, button: "left", clickCount: 1 });
  await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: inputInfo.x, y: inputInfo.y, button: "left", clickCount: 1 });
  // Select all then delete to clear leftover content.
  await client.send("Input.dispatchKeyEvent", { type: "keyDown", windowsVirtualKeyCode: 65, code: "KeyA", key: "a", modifiers: 2 });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 65, code: "KeyA", key: "a", modifiers: 2 });
  await sleep(100);
  await client.send("Input.dispatchKeyEvent", { type: "keyDown", windowsVirtualKeyCode: 46, code: "Delete", key: "Delete" });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 46, code: "Delete", key: "Delete" });
  await sleep(100);
  await client.send("Input.insertText", { text: promptText });
  await syncInputText(client, promptText);
  if (options.imageGen) {
    await ensureImageGenerationMode(client);
    await syncInputText(client, promptText);
  }
  await sleep(500);

  const buttonInfo = await findSendButton(client);
  if (buttonInfo?.ok) {
    await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: buttonInfo.x, y: buttonInfo.y, button: "left", clickCount: 1 });
    await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: buttonInfo.x, y: buttonInfo.y, button: "left", clickCount: 1 });
    await sleep(1000);
  } else {
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", windowsVirtualKeyCode: 13, code: "Enter", key: "Enter" });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 13, code: "Enter", key: "Enter" });
    await sleep(1000);
  }

  const stillThere = await evaluate(client, `(() => {
    const el = Array.from(document.querySelectorAll("textarea, input[type='text'], [contenteditable='true'], [role='textbox']")).filter(el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    }).at(-1);
    return el ? (el.value || el.innerText || el.textContent || "") : "";
  })()`).catch(() => "");
  if (stillThere.includes(promptText)) {
    throw new Error("Prompt text is still in the input after submit; Dola did not accept the message.");
  }
  return { selector: inputInfo.selector, method: buttonInfo?.ok ? "cdp-mouse" : "enter-key", buttonText: buttonInfo?.text || "" };
}

async function findSendButton(client) {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const button = await evaluate(client, `(() => {
      const visible = el => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };
      const isDisabled = el => Boolean(el.disabled || el.getAttribute("aria-disabled") === "true" || el.dataset.disabled === "true");
      const send = document.querySelector("#flow-end-msg-send");
      if (visible(send)) {
        const rect = send.getBoundingClientRect();
        return {
          ok: !isDisabled(send),
          disabled: isDisabled(send),
          text: (send.innerText || send.textContent || send.getAttribute("aria-label") || send.title || "").trim().slice(0, 120),
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2
        };
      }
      const words = /send|submit|generate|发送|提交|生成/i;
      const candidates = Array.from(document.querySelectorAll("button, [role='button'], [aria-label], [title]"))
        .filter(visible)
        .map(el => ({ el, text: [el.innerText, el.textContent, el.getAttribute("aria-label"), el.title, el.className, el.id].join(" ").trim(), rect: el.getBoundingClientRect(), disabled: el.disabled || el.getAttribute("aria-disabled") }))
        .filter(item => !item.disabled && (words.test(item.text) || item.rect.y > window.innerHeight * 0.55))
        .sort((a, b) => (b.rect.y - a.rect.y) || (b.rect.x - a.rect.x));
      const item = candidates[0];
      if (!item) return { ok: false };
      return { ok: true, text: item.text.slice(0, 120), x: item.rect.x + item.rect.width / 2, y: item.rect.y + item.rect.height / 2 };
    })()`).catch(() => ({ ok: false }));
    if (button?.ok) return button;
    await sleep(750);
  }
  return { ok: false };
}

async function syncInputText(client, promptText) {
  return evaluate(client, `(() => {
    const text = ${JSON.stringify(promptText)};
    const visible = el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const el = Array.from(document.querySelectorAll("textarea, input[type='text'], [contenteditable='true'], [role='textbox']"))
      .filter(visible)
      .at(-1);
    if (!el) return false;
    el.focus();
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      el._valueTracker?.setValue("");
      setter?.call(el, text);
    } else {
      el.textContent = text;
    }
    el.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: text }));
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
}

async function installImageHook(client) {
  await evaluate(client, `(() => {
    if (window.__dolaCliImageHookInstalled) return true;
    window.__dolaCliImageHookInstalled = true;
    window.__dolaCliImageRecords = [];
    const originalParse = JSON.parse;
    const okUrl = url => {
      try {
        const parsed = new URL(url || "");
        if (!/^https?:$/i.test(parsed.protocol)) return false;
        if (/\\/(api|web|passport)\\//i.test(parsed.pathname)) return false;
        if (/\\.(png|jpe?g|webp|gif)(\\?|$)/i.test(url)) return true;
        return /dola|byteimg|bytedance|volc|tos|cdn|image|img/i.test(parsed.hostname)
          && /image|img|tplv|tos-|obj\\/|origin|raw|large|webp|jpeg|jpg|png/i.test(parsed.pathname)
          && /x-expires|expires|sign|signature|format|image|img|tplv|raw|origin|width|height/i.test(parsed.search);
      } catch { return false; }
    };
    const isWatermarked = url => /watermark|downsize_watermark|image_dld_watermark|image_pre_watermark|hcg_watermark|img_pre_mark|wm_|with[_-]?water|marked|logo/i.test(url || "");
    const isRaw = url => /(image_raw|raw|origin|original|ori|source|large|no[_-]?watermark|without[_-]?watermark)/i.test(url || "") && !isWatermarked(url);
    const imageKey = url => {
      const match = /rc_gen_image\\/([a-f0-9]{16,64})(?:preview)?\\.(?:jpeg|jpg|png|webp)/i.exec(String(url || ""))
        || /rc_gen_image\\/([^~?/#]+)(?:~|\\?|$)/i.exec(String(url || ""));
      if (!match) return "";
      const filename = match[1].includes(".") ? match[1] : match[1] + ".jpeg";
      return "rc_gen_image/" + filename.replace(/preview\\.(jpeg|jpg|png|webp)$/i, ".$1");
    };
    const push = (url, context = {}) => {
      if (!okUrl(url)) return;
      if (!window.__dolaCliImageRecords.some(item => item.url === url)) {
        window.__dolaCliImageRecords.push({ ...context, url, key: context.key || imageKey(url), raw: isRaw(url), watermarked: isWatermarked(url) });
      }
    };
    const visit = (node, context = {}) => {
      if (!node || typeof node !== "object") return;
      const next = {
        conversation_id: node.conversation_id || node.conversationId || context.conversation_id || "",
        message_id: node.message_id || node.messageId || node.id || context.message_id || "",
        key: node.key || context.key || "",
        prompt: node.prompt || node.query || node.input || context.prompt || "",
      };
      for (const [key, item] of Object.entries(node)) {
        if (/url|uri|src|image|origin|original|raw|large|watermark/i.test(key)) {
          if (typeof item === "string") push(item, next);
          else visit(item, next);
        } else if (typeof item === "object") {
          visit(item, next);
        }
      }
    };
    JSON.parse = function dolaCliParse(text, reviver) {
      const data = originalParse.call(this, text, reviver);
      try {
        if (typeof text === "string" && /image|img|url|raw|origin|watermark/i.test(text)) visit(data);
      } catch {}
      return data;
    };
    return true;
  })()`);
}

async function clearImageHook(client) {
  await evaluate(client, `(() => { window.__dolaCliImageRecords = []; return true; })()`);
}

async function collectHookImages(client) {
  const records = await evaluate(client, `window.__dolaCliImageRecords || []`).catch(() => []);
  return Array.isArray(records) ? uniqueImageRecords(records) : [];
}

function rawUrlFromTrackKey(trackKey, origin) {
  if (!trackKey || !origin) return "";
  const path = String(trackKey).replace(/^\d+_\d+_/, "");
  if (!path) return "";
  try {
    return new URL(path, origin).href;
  } catch {
    return "";
  }
}

async function collectDomImages(client) {
  const urls = await evaluate(client, `(() => {
    const out = Array.from(document.querySelectorAll('img[alt="image"][data-track-key]'))
      .filter(img => img.naturalWidth >= 256 && img.naturalHeight >= 256)
      .map(img => {
        const src = img.currentSrc || img.src || "";
        const key = img.getAttribute("data-track-key") || "";
        const rawUrl = (() => {
          if (!key || !src) return "";
          const path = key.replace(/^\d+_\d+_/, "");
          if (!path) return "";
          try { return new URL(path, new URL(src).origin).href; } catch { return ""; }
        })();
        return {
          url: rawUrl || src,
          key: key,
          width: img.naturalWidth,
          height: img.naturalHeight,
        };
      });
    return out;
  })()`).catch(() => []);
  return uniqueImageRecords((urls || []).filter(item => isLikelyImageUrl(item.url)).map(item => ({
    url: item.url,
    key: imageKeyFromUrl(item.key || item.url),
    raw: isPreferredRawUrl(item.url),
    watermarked: isWatermarkedUrl(item.url),
    width: item.width,
    height: item.height,
  })));
}

async function lastReplySnapshot(client) {
  const snapshot = await evaluate(client, `(() => {
    const visible = el => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const rectOf = el => {
      const rect = el.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: rect.height, width: rect.width, area: rect.width * rect.height };
    };
    const textOf = el => (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
    const inputBoxes = Array.from(document.querySelectorAll("textarea, input[type='text'], [contenteditable='true'], [role='textbox']")).filter(visible);
    const composerTop = inputBoxes.length ? Math.min(...inputBoxes.map(el => el.getBoundingClientRect().top)) : Number.POSITIVE_INFINITY;
    const generatedImageSelector = 'img[alt="image"][data-track-key]';
    const messageSelector = [
      "[data-message-id]",
      "[data-testid*='message' i]",
      "[class*='message' i]",
      "[class*='chat-item' i]",
      "[class*='bubble' i]",
      "[class*='answer' i]",
      "[class*='assistant' i]",
      "article"
    ].join(",");
    const isUiChrome = el => {
      const tag = el.tagName;
      if (["BUTTON", "NAV", "HEADER", "FOOTER", "ASIDE", "TEXTAREA", "INPUT", "SELECT", "OPTION"].includes(tag)) return true;
      if (el.closest("button, nav, header, footer, aside")) return true;
      return false;
    };
    const nearestMessage = el => el.closest(messageSelector)
      || el.closest("[class*='container-' i], [class*='wrapper' i], [class*='content' i]")
      || el.parentElement;
    const raw = [];
    for (const img of Array.from(document.querySelectorAll(generatedImageSelector)).filter(visible)) {
      const node = nearestMessage(img);
      if (node) raw.push(node);
    }
    for (const node of Array.from(document.querySelectorAll(messageSelector)).filter(visible)) raw.push(node);
    for (const node of Array.from(document.querySelectorAll("div, section, article, li")).filter(visible)) {
      if (isUiChrome(node)) continue;
      const rect = node.getBoundingClientRect();
      if (rect.bottom > composerTop - 4) continue;
      const text = textOf(node);
      const hasGeneratedImage = Boolean(node.querySelector(generatedImageSelector));
      if (hasGeneratedImage || (text.length >= 4 && text.length <= 1200 && rect.height <= window.innerHeight * 0.75)) raw.push(node);
    }
    const candidates = Array.from(new Set(raw))
      .filter(node => visible(node) && !isUiChrome(node))
      .map(node => {
        const rect = rectOf(node);
        const text = textOf(node);
        const imgs = Array.from(node.querySelectorAll(generatedImageSelector))
          .filter(visible)
          .filter(img => img.naturalWidth >= 128 && img.naturalHeight >= 128)
          .map(img => ({
            url: img.currentSrc || img.src || "",
            key: img.getAttribute("data-track-key") || "",
            width: img.naturalWidth,
            height: img.naturalHeight
          }));
        const idSource = [
          node.getAttribute("data-message-id"),
          node.getAttribute("data-messageid"),
          node.id,
          node.getAttribute("data-track-key"),
          ...imgs.map(img => img.key)
        ].filter(Boolean).join(" ");
        const messageMatch = /(?:^|\\D)(\\d{8,})(?:\\D|$)/.exec(idSource);
        return { text, imgs, rect, messageId: messageMatch ? messageMatch[1] : "", html: node.outerHTML.slice(0, 300) };
      })
      .filter(item => item.rect.bottom <= composerTop - 4 && (item.text || item.imgs.length))
      .filter(item => item.rect.area <= window.innerWidth * window.innerHeight * 1.5)
      .sort((a, b) => (b.rect.bottom - a.rect.bottom) || (b.rect.top - a.rect.top) || (a.rect.area - b.rect.area));
    const last = candidates[0] || null;
    if (!last) return { text: "", images: [], imageKeys: [], imageUrls: [], messageId: "", signature: "" };
    const imageKeys = Array.from(new Set(last.imgs.map(img => img.key).filter(Boolean)));
    const imageUrls = Array.from(new Set(last.imgs.map(img => img.url).filter(Boolean)));
    const signature = [last.messageId, last.text, imageKeys.join("|"), imageUrls.join("|")].join("\\n").slice(0, 2000);
    return {
      text: last.text.slice(0, 1200),
      images: last.imgs,
      imageKeys,
      imageUrls,
      messageId: last.messageId,
      signature,
      rect: last.rect
    };
  })()`).catch(() => null);
  const normalizedKeys = new Set();
  for (const key of snapshot?.imageKeys || []) {
    const normalized = normalizeImageKey(key);
    if (normalized) normalizedKeys.add(normalized);
  }
  for (const url of snapshot?.imageUrls || []) {
    const normalized = normalizeImageKey(url);
    if (normalized) normalizedKeys.add(normalized);
  }
  return {
    text: snapshot?.text || "",
    images: Array.isArray(snapshot?.images) ? snapshot.images : [],
    imageKeys: [...normalizedKeys],
    imageUrls: Array.isArray(snapshot?.imageUrls) ? snapshot.imageUrls : [],
    messageId: snapshot?.messageId || "",
    signature: snapshot?.signature || "",
    rect: snapshot?.rect || null,
  };
}

function messageIdFromRecord(item) {
  if (!item) return 0;
  if (item.message_id && /^\d+$/.test(String(item.message_id))) return Number(item.message_id);
  const key = item.key || imageKeyFromUrl(item.url);
  const match = /^\d+_(\d+)_/.exec(String(key || ""));
  return match ? Number(match[1]) : 0;
}

function classifyImageGenerationTextError(text) {
  const value = String(text || "").trim();
  if (/quota|limit|credits?|配额|额度|次数|今日.*用完|已用完|上限|限制|用尽/i.test(value)) return "IMAGE_GENERATION_QUOTA_EXHAUSTED";
  if (/无法生成|不能生成|生成不了|拒绝|不支持|违规|安全|policy|cannot|can't|unable|refus/i.test(value)) return "IMAGE_GENERATION_REFUSED";
  if (value) return "IMAGE_GENERATION_TEXT_RESPONSE";
  return "IMAGE_GENERATION_NO_IMAGE";
}

function looksLikePromptEcho(text, promptText) {
  const compact = value => String(value || "").replace(/\s+/g, " ").trim();
  const reply = compact(text);
  const prompt = compact(promptText);
  if (!reply || !prompt) return false;
  return reply === prompt || reply.includes(prompt.slice(0, 300)) || prompt.includes(reply.slice(0, 300));
}

function recordMatchesLastReply(item, lastReply) {
  if (!lastReply) return true;
  const replyKeys = new Set(lastReply.imageKeys || []);
  const replyUrls = new Set(lastReply.imageUrls || []);
  const itemKey = normalizeImageKey(item.key || item.url);
  if (itemKey && replyKeys.has(itemKey)) return true;
  if (item.url && replyUrls.has(item.url)) return true;
  const itemMessageId = messageIdFromRecord(item);
  if (lastReply.messageId && itemMessageId && String(itemMessageId) === String(lastReply.messageId)) return true;
  return false;
}

function chooseDownloadItems(records, beforeUrls, options) {
  const fresh = uniqueImageRecords(records)
    .filter(item => !beforeUrls.has(item.url))
    .filter(item => recordMatchesLastReply(item, options.lastReply));
  const rawByKey = new Map();
  for (const item of fresh) {
    const key = normalizeImageKey(item.key || item.url);
    if (key && item.raw && !item.watermarked) rawByKey.set(key, item);
  }
  const resolved = fresh.map(item => {
    const key = normalizeImageKey(item.key || item.url);
    if (item.watermarked && key && rawByKey.has(key)) return rawByKey.get(key);
    return item;
  });
  const clean = resolved.filter(item => !item.watermarked);
  const generated = clean.filter(item => item.key || /rc_gen_image/i.test(item.url));
  const preferred = clean.filter(item => item.raw);
  const fallbackAny = options.allowWatermark ? resolved : [];
  // Sort generated candidates by message id descending so the most recent image wins
  const sortByRecent = items => [...items].sort((a, b) => messageIdFromRecord(b) - messageIdFromRecord(a));
  const ordered = [
    ...sortByRecent(generated.filter(item => item.raw)),
    ...sortByRecent(generated.filter(item => !item.raw)),
    ...sortByRecent(preferred.filter(item => !generated.includes(item))),
    ...sortByRecent(clean.filter(item => !item.raw && !generated.includes(item))),
    ...fallbackAny
  ];
  return uniqueImageRecords(ordered).slice(0, options.count);
}

async function waitForDownloadItems(client, beforeUrls, capturedRecords, options) {
  const started = Date.now();
  let lastChange = Date.now();
  let lastCount = 0;
  let lastReply = options.beforeLastReply || null;
  let lastReplyChange = Date.now();
  while (Date.now() - started < options.timeout) {
    capturedRecords.push(...await collectHookImages(client));
    capturedRecords.push(...await collectDomImages(client));
    const reply = await lastReplySnapshot(client);
    const replyChanged = reply.signature && reply.signature !== lastReply?.signature;
    if (replyChanged) {
      lastReply = reply;
      lastReplyChange = Date.now();
      console.log(`[dola-cli] last reply changed (text=${reply.text.length}, images=${reply.imageKeys.length}, messageId=${reply.messageId || "unknown"})`);
    }
    const scopedOptions = { ...options, lastReply };
    const selected = chooseDownloadItems(capturedRecords, beforeUrls, scopedOptions);
    const freshRecords = uniqueImageRecords(capturedRecords).filter(item => !beforeUrls.has(item.url));
    const freshCount = freshRecords.length;
    if (freshCount !== lastCount) {
      lastCount = freshCount;
      lastChange = Date.now();
      const generated = freshRecords.filter(item => item.key || /rc_gen_image/i.test(item.url)).length;
      const raw = freshRecords.filter(item => item.raw && !item.watermarked).length;
      const watermarked = freshRecords.filter(item => item.watermarked).length;
      console.log(`[dola-cli] captured ${freshCount} image URL(s), generated=${generated}, raw=${raw}, watermarked=${watermarked}, selected=${selected.length}`);
    }
    const hasGenerated = selected.some(item => item.key || /rc_gen_image/i.test(item.url));
    if (selected.length >= options.count && hasGenerated && Date.now() - lastChange >= options.stable) return selected;
    const replyIsFinalText = lastReply?.signature
      && lastReply.signature !== options.beforeLastReply?.signature
      && !lastReply.imageKeys?.length
      && lastReply.text
      && Date.now() - lastReplyChange >= options.stable;
    if (replyIsFinalText) {
      const code = classifyImageGenerationTextError(lastReply.text);
      if (!looksLikePromptEcho(lastReply.text, options.promptText)) {
        throw new DolaCliError(code, `Image generation returned text instead of images: ${lastReply.text.slice(0, 300)}`, { lastReply });
      }
    }
    await sleep(1000);
  }
  const finalReply = await lastReplySnapshot(client);
  const scopedOptions = { ...options, lastReply: finalReply.signature ? finalReply : lastReply };
  const selected = chooseDownloadItems(capturedRecords, beforeUrls, scopedOptions);
  const hasGenerated = selected.some(item => item.key || /rc_gen_image/i.test(item.url));
  if (selected.length && hasGenerated) return selected;
  const reply = scopedOptions.lastReply;
  if (reply?.signature && reply.signature !== options.beforeLastReply?.signature && !reply.imageKeys?.length && reply.text) {
    const code = classifyImageGenerationTextError(reply.text);
    if (!looksLikePromptEcho(reply.text, options.promptText)) {
      throw new DolaCliError(code, `Image generation returned text instead of images: ${reply.text.slice(0, 300)}`, { lastReply: reply });
    }
  }
  throw new DolaCliError(
    options.allowWatermark ? "IMAGE_GENERATION_TIMEOUT" : "IMAGE_GENERATION_NO_CLEAN_IMAGE",
    options.allowWatermark
      ? `Timed out after ${options.timeout}ms without generated image URLs in the last reply.`
      : `Timed out after ${options.timeout}ms without clean/raw image URLs in the last reply. Use --allow-watermark to permit fallback URLs.`,
    { lastReply: reply || null }
  );
}

function extensionFromUrl(url, contentType) {
  const ext = path.extname(new URL(url).pathname).replace(".", "").toLowerCase();
  if (["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) return ext;
  if (/png/i.test(contentType || "")) return "png";
  if (/webp/i.test(contentType || "")) return "webp";
  if (/gif/i.test(contentType || "")) return "gif";
  return "jpg";
}

function safeFilePart(value, fallback) {
  return String(value || fallback).replace(/[\\/:*?"<>|\r\n]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 90) || fallback;
}

async function downloadImages(items, outDir, options = {}) {
  await mkdir(outDir, { recursive: true });
  const results = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item.watermarked && !options.allowWatermark) throw new Error(`Refusing to download watermarked URL without --allow-watermark: ${item.url}`);
    const response = await fetch(item.url, { headers: { "user-agent": "Mozilla/5.0" } });
    if (!response.ok) throw new Error(`Download failed ${response.status}: ${item.url}`);
    const ext = extensionFromUrl(item.url, response.headers.get("content-type"));
    const stem = ["dola", item.conversation_id, item.message_id, item.key, item.raw ? "raw" : "clean", String(i + 1).padStart(2, "0")]
      .filter(Boolean)
      .map(part => safeFilePart(part, "item"))
      .join("-");
    const file = path.resolve(outDir, `${stem}.${ext}`);
    await writeFile(file, Buffer.from(await response.arrayBuffer()));
    results.push({ ...item, file });
    console.log(`[dola-cli] saved ${file}`);
  }
  return results;
}

function installNetworkImageCapture(client, capturedRecords) {
  const requestBodies = new Map();
  client.on("Network.responseReceived", params => {
    const url = params.response?.url;
    const mime = params.response?.mimeType || "";
    if (/^image\//i.test(mime) && isLikelyImageUrl(url)) {
      capturedRecords.push({ url, key: imageKeyFromUrl(url), raw: isPreferredRawUrl(url), watermarked: isWatermarkedUrl(url) });
    }
    if (/json|text|event-stream/i.test(mime)) requestBodies.set(params.requestId, true);
  });
  client.on("Network.loadingFinished", async params => {
    if (!requestBodies.has(params.requestId)) return;
    requestBodies.delete(params.requestId);
    try {
      const body = await client.send("Network.getResponseBody", { requestId: params.requestId });
      const text = body.base64Encoded
        ? Buffer.from(body.body || "", "base64").toString("utf8")
        : body.body || "";
      if (!/image|img|url|raw|origin|watermark/i.test(text)) return;
      for (const block of text.split(/\r?\n\r?\n/)) {
        const dataLines = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim());
        const candidates = dataLines.length ? dataLines : [block.trim()];
        for (const raw of candidates) {
          if (!raw || raw === "[DONE]" || !raw.startsWith("{")) continue;
          try {
            capturedRecords.push(...extractImageRecordsFromJson(JSON.parse(raw)));
          } catch {}
        }
      }
      if (text.trim().startsWith("{")) {
        try {
          capturedRecords.push(...extractImageRecordsFromJson(JSON.parse(text)));
        } catch {}
      }
    } catch {}
  });
}

async function pageSnapshot(client) {
  return evaluate(client, `(() => ({
    title: document.title,
    url: location.href,
    textTail: (document.body.innerText || "").slice(-2500),
    inputCount: document.querySelectorAll("textarea, input[type='text'], [contenteditable='true'], [role='textbox']").length,
    fileInputCount: document.querySelectorAll("input[type=file]").length,
  }))()`);
}

async function uiSnapshot(client) {
  return evaluate(client, `(() => {
    const visible = el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const rectOf = el => {
      const rect = el.getBoundingClientRect();
      return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
    };
    return {
      url: location.href,
      active: document.activeElement?.outerHTML?.slice(0, 300) || "",
      inputs: Array.from(document.querySelectorAll("textarea, input, [contenteditable='true'], [role='textbox']"))
        .filter(visible)
        .map(el => ({
          tag: el.tagName,
          id: el.id || "",
          className: String(el.className).slice(0, 180),
          type: el.getAttribute("type") || "",
          role: el.getAttribute("role") || "",
          aria: el.getAttribute("aria-label") || "",
          placeholder: el.getAttribute("placeholder") || "",
          value: (el.value || el.innerText || el.textContent || "").slice(0, 160),
          rect: rectOf(el),
        })),
      buttons: Array.from(document.querySelectorAll("button, [role='button'], [aria-label], [title]"))
        .filter(visible)
        .map(el => ({
          tag: el.tagName,
          id: el.id || "",
          className: String(el.className).slice(0, 180),
          text: (el.innerText || el.textContent || el.getAttribute("aria-label") || el.title || "").trim().slice(0, 160),
          aria: el.getAttribute("aria-label") || "",
          title: el.title || "",
          disabled: Boolean(el.disabled || el.getAttribute("aria-disabled")),
          rect: rectOf(el),
        }))
        .slice(-120),
    };
  })()`);
}

async function imageDebugSnapshot(client) {
  return evaluate(client, `(() => {
    const visible = el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const rectOf = el => {
      const rect = el.getBoundingClientRect();
      return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
    };
    const nearbyText = el => {
      let cur = el;
      for (let i = 0; cur && i < 8; i += 1, cur = cur.parentElement) {
        const text = (cur.innerText || cur.textContent || "").trim();
        if (text) return text.slice(0, 300);
      }
      return "";
    };
    const ancestry = el => {
      const out = [];
      let cur = el;
      for (let i = 0; cur && i < 8; i += 1, cur = cur.parentElement) {
        out.push({
          tag: cur.tagName,
          id: cur.id || "",
          className: String(cur.className || "").slice(0, 160),
          attrs: Array.from(cur.attributes || []).filter(attr => /^data-|^aria-/.test(attr.name)).slice(0, 8).map(attr => [attr.name, attr.value]).slice(0, 8),
        });
      }
      return out;
    };
    return {
      url: location.href,
      textTail: (document.body.innerText || "").slice(-1000),
      generatedActions: Array.from(document.querySelectorAll('img[alt="image"][data-track-key]'))
        .flatMap(img => {
          const box = img.closest('[class*="image-box-grid-item"], [class*="container-"], [class*="image-wrapper"]')?.parentElement?.parentElement?.parentElement || img.parentElement;
          const buttons = Array.from((box || document).querySelectorAll("button, [role='button']"));
          return buttons.map(button => ({
            text: (button.innerText || button.textContent || button.getAttribute("aria-label") || button.title || "").trim(),
            aria: button.getAttribute("aria-label") || "",
            title: button.title || "",
            className: String(button.className || "").slice(0, 200),
            html: button.outerHTML.slice(0, 500),
            rect: rectOf(button),
          }));
        })
        .slice(0, 40),
      images: Array.from(document.querySelectorAll("img"))
        .map(img => ({
          visible: visible(img),
          src: img.currentSrc || img.src || "",
          alt: img.alt || "",
          natural: { w: img.naturalWidth, h: img.naturalHeight },
          rect: rectOf(img),
          nearbyText: nearbyText(img),
          ancestry: ancestry(img),
        }))
        .filter(item => item.src && !item.src.startsWith("data:image/svg+xml"))
    };
  })()`);
}

async function waitForResponseText(client, beforeTail, options) {
  const started = Date.now();
  let lastText = "";
  let lastChange = Date.now();
  while (Date.now() - started < options.timeout) {
    const snapshot = await pageSnapshot(client);
    const text = snapshot.textTail || "";
    if (text !== lastText) {
      lastText = text;
      lastChange = Date.now();
      console.log(`[dola-cli] page text changed (${text.length} chars in tail)`);
    }
    if (text && text !== beforeTail && Date.now() - lastChange >= options.stable) return snapshot;
    await sleep(1000);
  }
  return pageSnapshot(client);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) return usage();

  if (args.newChat) args.session = args.imageGen ? DOLA_IMAGE_HOME : DOLA_CHAT_HOME;
  if (!args.session) args.session = await askRequired(`Dola chat session URL or id (required, example ${DEFAULT_SESSION}): `);

  const sessionUrl = normalizeSession(args.session);
  const promptTexts = args.dryRun || args.debugUi || args.debugImages
    ? []
    : args.batchPromptFile
      ? await loadBatchPrompts(args.batchPromptFile)
      : [await loadPrompt(args)];
  const files = args.dryRun || args.debugUi || args.debugImages ? [] : await normalizeFiles(args.files);
  if (!args.dryRun && !args.debugUi && !args.debugImages && !promptTexts.length) throw new Error("prompt is required.");

  console.log(`[dola-cli] connecting CDP ${args.cdp}`);
  const target = await findOrCreateTarget(args.cdp, sessionUrl, args.newChat);
  if (!target?.webSocketDebuggerUrl) throw new Error("No page CDP target found.");

  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  await client.send("Network.enable");
  await client.send("Page.bringToFront").catch(() => {});

  let currentUrl = await evaluate(client, "location.href");
  if (currentUrl !== sessionUrl) {
    await client.send("Page.navigate", { url: sessionUrl });
    await waitForPageReady(client);
    await sleep(3000);
    currentUrl = await evaluate(client, "location.href");
  }
  await installImageHook(client);

  const before = await pageSnapshot(client);
  console.log(`[dola-cli] session ${currentUrl}`);
  if (args.debugUi) {
    console.log(JSON.stringify(await uiSnapshot(client), null, 2));
    client.close();
    return;
  }
  if (args.debugImages) {
    console.log(JSON.stringify(await imageDebugSnapshot(client), null, 2));
    client.close();
    return;
  }
  if (args.dryRun) {
    console.log(JSON.stringify({ sessionUrl, currentUrl, page: before }, null, 2));
    client.close();
    return;
  }

  const attached = await attachFiles(client, files);
  if (attached.length) {
    await sleep(2000);
  }
  const capturedRecords = [];
  installNetworkImageCapture(client, capturedRecords);

  const results = [];
  for (const [index, promptText] of promptTexts.entries()) {
    await clearImageHook(client);
    const beforeResponse = await pageSnapshot(client);
    const beforeImageUrls = new Set([
      ...(await collectHookImages(client)).map(item => item.url),
      ...(await collectDomImages(client)).map(item => item.url),
    ]);
    const beforeLastReply = args.imageGen ? await lastReplySnapshot(client) : null;

    if (args.batchPromptFile) console.log(`[dola-cli] batch prompt ${index + 1}/${promptTexts.length}`);
    const submit = await submitPrompt(client, promptText, args);
    console.log(`[dola-cli] submitted via ${submit.method} (${submit.selector})`);
    const finalUrl = args.newChat || isChatHomeUrl(sessionUrl)
      ? await waitForConcreteChatUrl(client, currentUrl)
      : await evaluate(client, "location.href").catch(() => currentUrl);

    const finalSnapshot = args.noWait || (args.imageGen && !args.noDownload)
      ? await pageSnapshot(client)
      : await waitForResponseText(client, beforeResponse.textTail || "", args);
    const downloaded = args.imageGen && !args.noWait && !args.noDownload
      ? await downloadImages(await waitForDownloadItems(client, beforeImageUrls, capturedRecords, { ...args, beforeLastReply, promptText }), path.resolve(args.out), args)
      : [];

    results.push({
      index: index + 1,
      finalUrl,
      prompt: promptText,
      submit,
      downloaded,
      page: finalSnapshot,
    });
    currentUrl = finalUrl;
  }

  const output = args.batchPromptFile
    ? {
      sessionUrl,
      attached,
      imageGeneration: true,
      batchPromptFile: path.resolve(args.batchPromptFile),
      submitted: results.length,
      results,
    }
    : {
      sessionUrl,
      attached,
      submitted: true,
      imageGeneration: Boolean(args.imageGen),
      ...results[0],
    };
  console.log(JSON.stringify(output, null, 2));
  client.close();
}

main().catch(error => {
  const code = error.code || "DOLA_CLI_ERROR";
  const details = error.details ? `\n${JSON.stringify(error.details, null, 2)}` : "";
  console.error(`[dola-cli] failed (${code}): ${error.stack || error.message}${details}`);
  process.exit(1);
});
