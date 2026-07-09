#!/usr/bin/env bun
import { access, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createHash } from "node:crypto";
import path from "node:path";

const DEFAULT_CDP = "http://127.0.0.1:9222";
const DEFAULT_SESSION = "https://www.dola.com/chat/38415631468262161";
const DOLA_CHAT_HOME = "https://www.dola.com/chat";
const DOLA_IMAGE_HOME = "https://www.dola.com/chat/create-image";
const DEFAULT_OUT_DIR = "downloads";
const DEFAULT_SESSION_STATE = ".dola-cli-session.json";

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
  bun src/cli.js --new-chat --character-image "E:\\temp\\avatar.png" \\
    --character-prompt "这是主角的形象，请记住" --batch-prompt-file prompts.txt \\
    --character-batch-size 10 --out downloads
  bun src/cli.js --resume --new-chat --character-image "E:\\temp\\avatar.png" \\
    --character-prompt "这是主角的形象，请记住" --batch-prompt-file prompts.txt \\
    --out downloads
  bun src/cli.js --account-pool "G:\\cookies\\dola" --resume --new-chat \\
    --character-image "E:\\temp\\avatar.png" \\
    --character-prompt "这是主角的形象，请记住" --batch-prompt-file prompts.txt \\
    --out downloads

Options:
  --session <url|id>       Existing Dola chat URL/id, or ${DOLA_CHAT_HOME}.
  --new-chat               Start at ${DOLA_CHAT_HOME}.
  --resume                 Resume a batch from saved state/output files.
  --session-state <path>   Session/state file. Default: ${DEFAULT_SESSION_STATE}
  --account-pool <path>    Cookie directory or JSON account/CDP pool to rotate.
  --prompt <text>          Prompt to submit. If omitted, the CLI asks interactively.
  --prompt-file <path>     Read prompt from a UTF-8 text file.
  --batch-prompt-file <path>
                           Generate images for each non-empty line in a UTF-8 text file.
  --character-image <path> Fixed character reference image for batch generation.
  --character-prompt <text>
                           Prompt describing the fixed character reference image.
  --character-batch-size <n>
                           Re-upload the character image every n prompts. Default: 10
  --file <path>            Attach a local file before submitting. Can be repeated.
  --attach <path>          Alias for --file.
  --cdp <url>              Chrome CDP endpoint. Default: ${DEFAULT_CDP}
  --timeout <ms>           Max wait time after submit. Default: 120000
  --stable <ms>            Response text stability window. Default: 3000
  --max-retries <n>        Automatic retries after timeout/submit failure. Default: 2
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
  ACCOUNT_RESTRICTED                The last reply indicates the account is restricted.
  IMAGE_GENERATION_REFUSED          The last reply indicates generation was refused.
  IMAGE_GENERATION_TEXT_RESPONSE    The last reply is text instead of an image.
  IMAGE_GENERATION_TIMEOUT          No image appeared in the last reply before timeout.
  IMAGE_GENERATION_NO_CLEAN_IMAGE   Only non-raw/watermarked image URLs were available.
  IMAGE_GENERATION_DUPLICATE_HASH   A downloaded image duplicated an earlier image.
  ACCOUNT_POOL_EXHAUSTED             Every account is restricted for today.
`);
}

function parseArgs(argv) {
  const args = { cdp: DEFAULT_CDP, out: DEFAULT_OUT_DIR, count: 1, timeout: 120000, stable: 3000, maxRetries: 2, files: [] };
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
    else if (arg === "--resume") args.resume = true;
    else if (arg === "--session-state") args.sessionState = value();
    else if (arg === "--account-pool") args.accountPool = value();
    else if (arg === "--image-gen" || arg === "--image-generation") args.imageGen = true;
    else if (arg === "--prompt") args.prompt = value();
    else if (arg === "--prompt-file") args.promptFile = value();
    else if (arg === "--batch-prompt-file") args.batchPromptFile = value();
    else if (arg === "--character-image") args.characterImage = value();
    else if (arg === "--character-prompt") args.characterPrompt = value();
    else if (arg === "--character-batch-size") args.characterBatchSize = Number(value());
    else if (arg === "--file" || arg === "--attach") args.files.push(value());
    else if (arg === "--cdp") args.cdp = value();
    else if (arg === "--out") args.out = value();
    else if (arg === "--count") args.count = Number(value());
    else if (arg === "--timeout") args.timeout = Number(value());
    else if (arg === "--stable") args.stable = Number(value());
    else if (arg === "--max-retries") args.maxRetries = Number(value());
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
  if (!Number.isInteger(args.maxRetries) || args.maxRetries < 0) throw new Error("--max-retries must be a non-negative integer.");
  if (args.characterBatchSize !== undefined && (!Number.isInteger(args.characterBatchSize) || args.characterBatchSize < 1)) {
    throw new Error("--character-batch-size must be a positive integer.");
  }
  const hasCharacterOption = Boolean(args.characterImage || args.characterPrompt || args.characterBatchSize !== undefined);
  if (hasCharacterOption) {
    if (!args.characterImage || !args.characterPrompt) throw new Error("--character-image and --character-prompt are both required for fixed-character batch generation.");
    if (!args.batchPromptFile) throw new Error("--character-image and --character-prompt require --batch-prompt-file.");
    if (args.count !== 1) throw new Error("Fixed-character batch generation only supports one image per prompt; omit --count or use --count 1.");
    args.characterBatchSize ??= 10;
    args.imageGen = true;
  }
  if (args.batchPromptFile) {
    if (args.prompt || args.promptFile) throw new Error("--batch-prompt-file cannot be combined with --prompt or --prompt-file.");
    if (args.noWait) throw new Error("--batch-prompt-file cannot be combined with --no-wait.");
    args.imageGen = true;
  }
  if (args.resume && !args.batchPromptFile) throw new Error("--resume requires --batch-prompt-file.");
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
    .map((line, index) => ({ text: line.trim(), line: index + 1 }))
    .filter(item => item.text);
  if (!prompts.length) throw new Error(`No non-empty prompts found in batch file: ${file}`);
  return prompts;
}

async function readJsonFile(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Could not read JSON state file ${file}: ${error.message}`);
  }
}

function accountDayKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

async function loadAccountPool(file) {
  const absoluteFile = path.resolve(file);
  try {
    const directoryEntries = await readdir(absoluteFile, { withFileTypes: true });
    const cookieFiles = directoryEntries
      .filter(entry => entry.isFile() && /\.(txt|cookies?|json)$/i.test(entry.name))
      .map(entry => path.join(absoluteFile, entry.name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (!cookieFiles.length) throw new Error(`No cookie files found in account pool directory: ${file}`);
    return cookieFiles.map((cookieFile, index) => ({
      id: path.basename(cookieFile, path.extname(cookieFile)) || `account-${index + 1}`,
      cdp: DEFAULT_CDP,
      session: "",
      cookieFile,
    }));
  } catch (error) {
    if (error?.code !== "ENOTDIR") throw error;
  }
  const value = await readJsonFile(file);
  const entries = Array.isArray(value) ? value : value?.accounts;
  if (!Array.isArray(entries) || !entries.length) {
    throw new Error(`Account pool must contain a non-empty JSON array or {"accounts": [...]}: ${file}`);
  }
  const accounts = entries.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new Error(`Account pool entry ${index + 1} must be an object.`);
    const id = String(entry.id || entry.name || `account-${index + 1}`).trim();
    if (!id) throw new Error(`Account pool entry ${index + 1} has an empty id.`);
    const cdp = String(entry.cdp || DEFAULT_CDP).trim();
    const session = entry.session ? normalizeSession(entry.session) : "";
    const cookieFile = entry.cookieFile || entry.cookies || entry.cookie
      ? path.resolve(String(entry.cookieFile || entry.cookies || entry.cookie))
      : "";
    if (!cdp) throw new Error(`Account pool entry ${id} has an empty cdp endpoint.`);
    return { id, cdp, session, cookieFile };
  });
  const ids = new Set();
  for (const account of accounts) {
    if (ids.has(account.id)) throw new Error(`Duplicate account id in pool: ${account.id}`);
    ids.add(account.id);
  }
  return accounts;
}

async function loadNetscapeCookies(file) {
  const text = await readFile(file, "utf8");
  if (file.toLowerCase().endsWith(".json")) {
    const value = JSON.parse(text);
    const entries = Array.isArray(value) ? value : value.cookies;
    if (!Array.isArray(entries)) throw new Error(`Cookie JSON must be an array or contain cookies: ${file}`);
    return entries.map(cookie => ({ ...cookie }));
  }
  return text.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && (!line.startsWith("#") || line.startsWith("#HttpOnly_")))
    .map(line => ({ httpOnly: line.startsWith("#HttpOnly_"), parts: (line.startsWith("#HttpOnly_") ? line.slice("#HttpOnly_".length) : line).split("\t") }))
    .filter(item => item.parts.length >= 7)
    .map(({ parts, httpOnly }) => {
      const [domain, includeSubdomains, cookiePath, secure, expires, name, value] = parts;
      return {
        domain,
        path: cookiePath || "/",
        secure: String(secure).toUpperCase() === "TRUE",
        ...(Number(expires) > 0 ? { expires: Number(expires) } : {}),
        name,
        value,
        httpOnly,
        sameSite: "Lax",
        includeSubdomains: String(includeSubdomains).toUpperCase() === "TRUE",
      };
    });
}

async function applyAccountCookies(client, account) {
  if (!account?.cookieFile) return;
  const cookies = await loadNetscapeCookies(account.cookieFile);
  if (!cookies.length) throw new Error(`No cookies found in account file: ${account.cookieFile}`);
  await client.send("Network.clearBrowserCookies");
  await client.send("Network.setCookies", { cookies });
  console.log(`[dola-cli] loaded ${cookies.length} cookie(s) for account ${account.id}`);
}

function restrictedAccountSet(savedState, day) {
  const values = savedState?.restrictedAccounts?.[day];
  return new Set(Array.isArray(values) ? values.map(String) : []);
}

function chooseAccount(accounts, restricted, preferredId = "") {
  const preferred = accounts.find(account => account.id === preferredId && !restricted.has(account.id));
  const next = preferred || accounts.find(account => !restricted.has(account.id));
  if (!next) {
    throw new DolaCliError(
      "ACCOUNT_POOL_EXHAUSTED",
      "All accounts in the pool are restricted for today.",
      { day: accountDayKey(), restrictedAccounts: [...restricted] }
    );
  }
  return next;
}

function accountStateFields(accountPoolFile, activeAccount, restricted) {
  if (!accountPoolFile) return {};
  return {
    accountPoolFile: path.resolve(accountPoolFile),
    accountId: activeAccount?.id || "",
    restrictedAccounts: { [accountDayKey()]: [...restricted].sort() },
  };
}

async function writeJsonFile(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const tempFile = `${file}.${process.pid}.tmp`;
  await writeFile(tempFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempFile, file);
}

async function inferCompletedOutput(outDir) {
  const completed = [];
  let names = [];
  try {
    names = await readdir(outDir);
  } catch (error) {
    if (error?.code === "ENOENT") return completed;
    throw error;
  }
  for (const name of names) {
    const match = /^(\d+),([a-f0-9]{12})\.(png|jpe?g|webp|gif)$/i.exec(name);
    if (!match) continue;
    const file = path.resolve(outDir, name);
    const bytes = await readFile(file);
    const hash = createHash("sha256").update(bytes).digest("hex");
    completed.push({ line: Number(match[1]), hash, shortHash: hash.slice(0, 12), file });
  }
  return completed;
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
  }

  const createPath = `/json/new?${encodeURIComponent(sessionUrl)}`;
  const created = await fetch(cdpHttpUrl(cdp, createPath), { method: "PUT" })
    .then(r => r.ok ? r.json() : fetch(cdpHttpUrl(cdp, createPath)).then(rr => rr.json()));
  const otherDolaPages = targets.filter(item =>
    item.type === "page"
    && item.id !== created.id
    && /(^|\.)dola\.com\//i.test(item.url || "")
  );
  await Promise.all(otherDolaPages.map(item =>
    fetch(cdpHttpUrl(cdp, `/json/close/${encodeURIComponent(item.id)}`)).catch(() => null)
  ));
  if (otherDolaPages.length) console.log(`[dola-cli] closed ${otherDolaPages.length} other Dola tab(s)`);
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
  if (/账号受限|账户受限|账号封禁|账户封禁|account.*(?:restricted|suspended|disabled)|too many requests|rate limit/i.test(value)) {
    return "ACCOUNT_RESTRICTED";
  }
  if (/quota|limit|credits?|配额|额度|次数|今日.*用完|已用完|上限|限制|用尽/i.test(value)) return "IMAGE_GENERATION_QUOTA_EXHAUSTED";
  if (/无法生成|不能生成|生成不了|拒绝|不支持|违规|安全|policy|cannot|can't|unable|refus/i.test(value)) return "IMAGE_GENERATION_REFUSED";
  if (value) return "IMAGE_GENERATION_TEXT_RESPONSE";
  return "IMAGE_GENERATION_NO_IMAGE";
}

function isAccountRestrictedError(error) {
  return ["ACCOUNT_RESTRICTED", "IMAGE_GENERATION_QUOTA_EXHAUSTED"].includes(error?.code);
}

function looksLikeImageGenerationProgress(text) {
  return /generate(?:d|ing)?\s+image|will\s+generate|starting\s+to\s+generate|generating|正在生成|生成中|开始生成|即将生成|请稍候|请稍等|稍等/i.test(String(text || ""));
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
    .filter(item => {
      const key = normalizeImageKey(item.key || item.url);
      return !key || !options.beforeImageKeys?.has(key);
    })
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
  const fallbackAny = options.allowWatermark || options.watermarkFallback ? resolved : [];
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

async function imageGenerationUiSnapshot(client) {
  return evaluate(client, `(() => {
    const visible = el => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const attrs = el => Array.from(el.attributes || [])
      .filter(attr => /load|busy|generat|pending|stream|state|status/i.test(attr.name))
      .map(attr => [attr.name, attr.value]);
    const loading = Array.from(document.querySelectorAll("[data-loading='true'], [aria-busy='true'], [data-generating='true'], [data-pending='true']"))
      .filter(visible)
      .map(el => ({ tag: el.tagName, id: el.id || "", className: String(el.className || "").slice(0, 160), attrs: attrs(el) }))
      .slice(0, 20);
    const messageNodes = Array.from(document.querySelectorAll("[data-message-id], [data-messageid], [data-testid*='message' i], [class*='message' i], [class*='answer' i], [class*='assistant' i], article"))
      .filter(visible)
      .map(el => ({
        id: el.getAttribute("data-message-id") || el.getAttribute("data-messageid") || el.id || "",
        className: String(el.className || "").slice(0, 180),
        role: el.getAttribute("data-role") || el.getAttribute("data-message-role") || "",
        children: el.childElementCount,
        images: el.querySelectorAll("img[alt='image'][data-track-key]").length,
      }));
    const assistantNodes = messageNodes.filter(item => /assistant|answer|bot|ai/i.test(item.className + " " + item.role));
    const send = document.querySelector("#flow-end-msg-send");
    const input = Array.from(document.querySelectorAll("textarea, input[type='text'], [contenteditable='true'], [role='textbox']"))
      .filter(visible).at(-1);
    return {
      loading,
      busy: loading.length > 0,
      messageCount: messageNodes.length,
      assistantCount: assistantNodes.length,
      assistantShape: assistantNodes.slice(-3),
      generatedImageCount: document.querySelectorAll("img[alt='image'][data-track-key]").length,
      send: send ? { disabled: Boolean(send.disabled), ariaDisabled: send.getAttribute("aria-disabled") || "", loading: send.getAttribute("data-loading") || "" } : null,
      inputEmpty: !input || !(input.value || input.innerText || input.textContent || "").trim(),
    };
  })()`);
}

async function waitForImageGenerationComplete(client, options) {
  const started = Date.now();
  const before = options.beforeGenerationUi || await imageGenerationUiSnapshot(client);
  let activitySeen = false;
  let lastShape = "";
  let lastShapeChange = Date.now();
  while (Date.now() - started < options.timeout) {
    const state = await imageGenerationUiSnapshot(client).catch(() => null);
    if (!state) {
      await sleep(1000);
      continue;
    }
    const shape = JSON.stringify({
      loading: state.loading,
      messageCount: state.messageCount,
      assistantCount: state.assistantCount,
      assistantShape: state.assistantShape,
      generatedImageCount: state.generatedImageCount,
      send: state.send,
    });
    if (shape !== lastShape) {
      lastShape = shape;
      lastShapeChange = Date.now();
    }
    const responseNodeAdded = state.assistantCount > (before?.assistantCount || 0)
      || state.generatedImageCount > (before?.generatedImageCount || 0);
    const messageAdded = state.messageCount >= (before?.messageCount || 0) + 2;
    if (state.busy || responseNodeAdded || messageAdded) activitySeen = true;
    const stable = Date.now() - lastShapeChange >= options.stable;
    const noLongerBusy = !state.busy;
    if (activitySeen && noLongerBusy && stable) {
      console.log(`[dola-cli] image generation UI complete (busy=${state.busy}, assistants=${state.assistantCount}, images=${state.generatedImageCount})`);
      return state;
    }
    await sleep(1000);
  }
  throw new DolaCliError("IMAGE_GENERATION_TIMEOUT", `Timed out after ${options.timeout}ms waiting for Dola image generation to finish.`);
}

async function waitForDownloadItems(client, beforeUrls, capturedRecords, options) {
  await waitForImageGenerationComplete(client, options);
  const started = Date.now();
  let lastChange = Date.now();
  let lastCount = 0;
  // Anchor the reply once generation is complete. Dola can reorder/virtualize
  // old message nodes while raw URLs arrive, which must not change the scope.
  const anchoredReply = await lastReplySnapshot(client);
  let lastReply = anchoredReply;
  let lastReplyChange = Date.now();
  while (Date.now() - started < options.timeout) {
    if (!lastReply?.imageKeys?.length) {
      const replyWithImages = await lastReplySnapshot(client);
      if (replyWithImages?.imageKeys?.length) {
        lastReply = replyWithImages;
        lastReplyChange = Date.now();
        console.log(`[dola-cli] anchored last reply images=${lastReply.imageKeys.length} messageId=${lastReply.messageId || "unknown"}`);
      }
    }
    capturedRecords.push(...await collectHookImages(client));
    capturedRecords.push(...await collectDomImages(client));
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
      const progressOnly = code === "IMAGE_GENERATION_TEXT_RESPONSE"
        && looksLikeImageGenerationProgress(lastReply.text);
      if (!looksLikePromptEcho(lastReply.text, options.promptText) && !progressOnly) {
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
    const progressOnly = code === "IMAGE_GENERATION_TEXT_RESPONSE"
      && looksLikeImageGenerationProgress(reply.text);
    if (!looksLikePromptEcho(reply.text, options.promptText) && !progressOnly) {
      throw new DolaCliError(code, `Image generation returned text instead of images: ${reply.text.slice(0, 300)}`, { lastReply: reply });
    }
  }
  throw new DolaCliError(
    options.allowWatermark || options.watermarkFallback ? "IMAGE_GENERATION_TIMEOUT" : "IMAGE_GENERATION_NO_CLEAN_IMAGE",
    options.allowWatermark || options.watermarkFallback
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
    if (item.watermarked && !options.allowWatermark && !options.watermarkFallback) {
      throw new Error(`Refusing to download watermarked URL without --allow-watermark: ${item.url}`);
    }
    let response;
    let lastDownloadError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        response = await fetch(item.url, { headers: { "user-agent": "Mozilla/5.0", accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8" } });
        if (response.ok) break;
        lastDownloadError = new Error(`Download failed ${response.status}: ${item.url}`);
      } catch (error) {
        lastDownloadError = error;
      }
      if (attempt < 3) {
        console.log(`[dola-cli] image download retry ${attempt + 1}/3`);
        await sleep(attempt * 1000);
      }
    }
    if (!response?.ok) throw lastDownloadError || new Error(`Download failed: ${item.url}`);
    const ext = extensionFromUrl(item.url, response.headers.get("content-type"));
    const bytes = Buffer.from(await response.arrayBuffer());
    const hash = createHash("sha256").update(bytes).digest("hex");
    const shortHash = hash.slice(0, 12);
    if (options.seenHashes?.has(hash)) {
      const first = options.seenHashes.get(hash);
      throw new DolaCliError(
        "IMAGE_GENERATION_DUPLICATE_HASH",
        `Downloaded image content duplicates an earlier image (hash ${shortHash}).`,
        { hash, shortHash, line: options.lineNumber, firstLine: first?.line, firstFile: first?.file }
      );
    }
    const stem = options.hashNaming
      ? [safeFilePart(options.lineNumber, "line"), shortHash]
      : ["dola", item.conversation_id, item.message_id, item.key, item.raw ? "raw" : "clean", String(i + 1).padStart(2, "0")]
        .filter(Boolean)
        .map(part => safeFilePart(part, "item"))
        .join("-");
    const file = path.resolve(outDir, `${stem}.${ext}`);
    await writeFile(file, bytes);
    options.seenHashes?.set(hash, { line: options.lineNumber, file });
    results.push({ ...item, file, hash, shortHash, line: options.lineNumber });
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

async function sendCharacterContext(client, imagePath, characterPrompt, options) {
  const beforeGenerationUi = await imageGenerationUiSnapshot(client);
  await clearImageHook(client);
  await attachFiles(client, [imagePath]);
  await submitPrompt(client, characterPrompt, options);
  await waitForImageGenerationComplete(client, { ...options, beforeGenerationUi });
  await sleep(500);
}

async function openAccountSession(cdp, sessionUrl, forceNew, resume, account) {
  const target = await findOrCreateTarget(cdp, sessionUrl, forceNew);
  if (!target?.webSocketDebuggerUrl) throw new Error("No page CDP target found.");
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  await client.send("Network.enable");
  await client.send("Page.bringToFront").catch(() => {});
  await applyAccountCookies(client, account);

  let currentUrl = await evaluate(client, "location.href");
  if (currentUrl !== sessionUrl) {
    console.log(`[dola-cli] navigating session ${currentUrl} -> ${sessionUrl}`);
    await client.send("Page.navigate", { url: sessionUrl });
    await waitForPageReady(client);
    await sleep(3000);
    currentUrl = await evaluate(client, "location.href");
    console.log(`[dola-cli] session ready ${currentUrl}`);
  } else if (resume) {
    console.log(`[dola-cli] refreshing resumed session ${sessionUrl}`);
    await client.send("Page.reload", { ignoreCache: false });
    await waitForPageReady(client);
    await sleep(3000);
    currentUrl = await evaluate(client, "location.href");
  }
  await installImageHook(client);
  return { client, currentUrl };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) return usage();

  const sessionStateFile = path.resolve(args.sessionState || DEFAULT_SESSION_STATE);
  const savedState = await readJsonFile(sessionStateFile);
  const accountPoolFile = args.accountPool ? path.resolve(args.accountPool) : "";
  let accountPool = accountPoolFile ? await loadAccountPool(accountPoolFile) : [];
  const accountDay = accountDayKey();
  const restrictedAccounts = restrictedAccountSet(savedState, accountDay);
  let activeAccount = accountPool.length
    ? chooseAccount(accountPool, restrictedAccounts, savedState?.accountId || "")
    : null;
  if (activeAccount) {
    args.cdp = activeAccount.cdp;
    args.session = args.newChat ? DOLA_IMAGE_HOME : (activeAccount.session || args.session || savedState?.lastSessionUrl);
  }
  if (!args.session && !args.newChat && savedState?.lastSessionUrl) {
    args.session = savedState.lastSessionUrl;
    console.log(`[dola-cli] resuming remembered session ${args.session}`);
  }
  if (args.newChat) args.session = args.imageGen ? DOLA_IMAGE_HOME : DOLA_CHAT_HOME;
  if (activeAccount && !args.newChat && !args.session) {
    throw new Error(`Account ${activeAccount.id} needs a session URL, or use --new-chat.`);
  }
  if (!args.session) args.session = await askRequired(`Dola chat session URL or id (required, example ${DEFAULT_SESSION}): `);

  let sessionUrl = normalizeSession(args.session);
  const promptEntries = args.dryRun || args.debugUi || args.debugImages
    ? []
    : args.batchPromptFile
      ? await loadBatchPrompts(args.batchPromptFile)
      : [{ text: await loadPrompt(args), line: null }];
  const files = args.dryRun || args.debugUi || args.debugImages ? [] : await normalizeFiles(args.files);
  const characterImage = args.dryRun || args.debugUi || args.debugImages
    ? []
    : args.characterImage
      ? await normalizeFiles([args.characterImage])
      : [];
  if (!args.dryRun && !args.debugUi && !args.debugImages && !promptEntries.length) throw new Error("prompt is required.");
  const outputDir = path.resolve(args.out);
  const inferredCompleted = args.resume ? await inferCompletedOutput(outputDir) : [];
  const savedCompleted = args.resume && Array.isArray(savedState?.completed) ? savedState.completed : [];
  const completedByLine = new Map();
  for (const item of [...inferredCompleted, ...savedCompleted]) {
    if (item?.line && item?.file) completedByLine.set(Number(item.line), item);
  }
  if (args.resume && savedState?.batchPromptFile && path.resolve(savedState.batchPromptFile) !== path.resolve(args.batchPromptFile)) {
    throw new Error(`--resume state belongs to a different batch prompt file: ${savedState.batchPromptFile}`);
  }
  if (args.resume && savedState?.characterImage && path.resolve(savedState.characterImage) !== path.resolve(args.characterImage)) {
    throw new Error(`--resume state belongs to a different character image: ${savedState.characterImage}`);
  }
  if (args.resume && savedState?.accountPoolFile && path.resolve(savedState.accountPoolFile) !== accountPoolFile) {
    throw new Error(`--resume state belongs to a different account pool: ${savedState.accountPoolFile}`);
  }

  console.log(`[dola-cli] connecting CDP ${args.cdp}`);
  const opened = await openAccountSession(args.cdp, sessionUrl, Boolean(args.newChat || activeAccount), args.resume, activeAccount);
  let client = opened.client;
  let currentUrl = opened.currentUrl;
  const poolState = () => accountStateFields(accountPoolFile, activeAccount, restrictedAccounts);

  const before = await pageSnapshot(client);
  console.log(`[dola-cli] session ${currentUrl}`);
  if (args.debugUi) {
    console.log(JSON.stringify({ ui: await uiSnapshot(client), generation: await imageGenerationUiSnapshot(client) }, null, 2));
    client.close();
    return;
  }
  if (args.debugImages) {
    console.log(JSON.stringify({ images: await imageDebugSnapshot(client), lastReply: await lastReplySnapshot(client) }, null, 2));
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
  const seenHashes = new Map();
  let forceCharacterContext = false;
  const switchRestrictedAccount = async (error, lineNumber) => {
    if (!accountPool.length || !activeAccount || !isAccountRestrictedError(error)) return false;
    restrictedAccounts.add(activeAccount.id);
    await writeJsonFile(sessionStateFile, {
      ...(savedState || {}),
      ...poolState(),
      version: 1,
      lastSessionUrl: currentUrl,
      failedLine: lineNumber,
      updatedAt: new Date().toISOString(),
    });
    if (accountPoolFile) accountPool = await loadAccountPool(accountPoolFile);
    const nextAccount = chooseAccount(accountPool, restrictedAccounts, "");
    console.log(`[dola-cli] account ${activeAccount.id} is restricted for ${accountDay}; switching to ${nextAccount.id}`);
    client.close();
    capturedRecords.length = 0;
    activeAccount = nextAccount;
    args.cdp = activeAccount.cdp;
    sessionUrl = normalizeSession(args.newChat
      ? DOLA_IMAGE_HOME
      : (activeAccount.session || sessionUrl));
    const nextOpened = await openAccountSession(args.cdp, sessionUrl, true, false, activeAccount);
    client = nextOpened.client;
    currentUrl = nextOpened.currentUrl;
    await installImageHook(client);
    installNetworkImageCapture(client, capturedRecords);
    forceCharacterContext = Boolean(args.characterImage);
    return true;
  };
  for (const [index, promptEntry] of promptEntries.entries()) {
    const promptText = typeof promptEntry === "string" ? promptEntry : promptEntry.text;
    const lineNumber = typeof promptEntry === "string" ? index + 1 : promptEntry.line;
    const completed = completedByLine.get(lineNumber);
    if (args.resume && completed?.file && await access(completed.file, fsConstants.R_OK).then(() => true).catch(() => false)) {
      if (completed.hash) seenHashes.set(completed.hash, { line: lineNumber, file: completed.file });
      console.log(`[dola-cli] resume skip line ${lineNumber}: ${completed.file}`);
      results.push({ index: index + 1, line: lineNumber, prompt: promptText, skipped: true, downloaded: [{ ...completed }] });
      continue;
    }
    let attempt = 0;
    while (true) {
      try {
      const firstProcessedPrompt = results.every(item => item.skipped);
      if (args.characterImage && (index % args.characterBatchSize === 0 || (args.newChat && firstProcessedPrompt) || attempt > 0 || forceCharacterContext)) {
        console.log(`[dola-cli] refreshing character context before prompt ${index + 1}/${promptEntries.length}`);
        await sendCharacterContext(client, characterImage[0], args.characterPrompt, args);
        forceCharacterContext = false;
      }

      await clearImageHook(client);
      const beforeResponse = await pageSnapshot(client);
      const beforeImageRecords = [
        ...capturedRecords,
        ...(await collectHookImages(client)),
        ...(await collectDomImages(client)),
      ];
      const beforeImageUrls = new Set(beforeImageRecords.map(item => item.url));
      const beforeImageKeys = new Set(
        beforeImageRecords
          .map(item => normalizeImageKey(item.key || item.url))
          .filter(Boolean)
      );
      const beforeGenerationUi = args.imageGen ? await imageGenerationUiSnapshot(client) : null;
      capturedRecords.length = 0;

      if (args.batchPromptFile) console.log(`[dola-cli] batch prompt ${lineNumber ?? index + 1}/${promptEntries.length}`);
      const submit = await submitPrompt(client, promptText, args);
      console.log(`[dola-cli] submitted via ${submit.method} (${submit.selector})`);
      const finalUrl = args.newChat || isChatHomeUrl(sessionUrl)
        ? await waitForConcreteChatUrl(client, currentUrl)
        : await evaluate(client, "location.href").catch(() => currentUrl);
      await writeJsonFile(sessionStateFile, {
        ...(savedState || {}),
        ...poolState(),
        version: 1,
        lastSessionUrl: finalUrl,
        completed: [...completedByLine.values()].filter(item => item.line && item.file),
        updatedAt: new Date().toISOString(),
      });

      const finalSnapshot = args.noWait || (args.imageGen && !args.noDownload)
        ? await pageSnapshot(client)
        : await waitForResponseText(client, beforeResponse.textTail || "", args);
      const downloaded = args.imageGen && !args.noWait && !args.noDownload
        ? await downloadImages(
          await waitForDownloadItems(client, beforeImageUrls, capturedRecords, {
            ...args,
            beforeImageKeys,
            beforeGenerationUi,
            watermarkFallback: Boolean(args.characterImage),
            promptText,
          }),
          path.resolve(args.out),
          { ...args, lineNumber, hashNaming: Boolean(args.characterImage), watermarkFallback: Boolean(args.characterImage), seenHashes }
        )
        : [];

      results.push({
        index: index + 1,
        line: lineNumber,
        finalUrl,
        prompt: promptText,
        submit,
        downloaded,
        page: finalSnapshot,
      });
      for (const item of downloaded || []) {
        if (lineNumber && item.file) {
          completedByLine.set(Number(lineNumber), {
            line: lineNumber,
            hash: item.hash,
            shortHash: item.shortHash,
            file: item.file,
            prompt: promptText,
          });
        }
      }
      if (args.batchPromptFile) {
        const completedForState = new Map(completedByLine);
        for (const item of results) {
          for (const downloaded of item.downloaded || []) {
            if (item.line && downloaded.file) {
              completedForState.set(Number(item.line), {
                line: item.line,
                hash: downloaded.hash,
                shortHash: downloaded.shortHash,
                file: downloaded.file,
                prompt: item.prompt,
              });
            }
          }
        }
        const state = {
          ...poolState(),
          version: 1,
          lastSessionUrl: finalUrl,
          batchPromptFile: path.resolve(args.batchPromptFile),
          characterImage: args.characterImage ? path.resolve(args.characterImage) : "",
          characterPrompt: args.characterPrompt || "",
          characterBatchSize: args.characterBatchSize || null,
          completed: [...completedForState.values()]
            .filter(item => item.line && item.file),
          updatedAt: new Date().toISOString(),
        };
        await writeJsonFile(sessionStateFile, state);
      } else {
        await writeJsonFile(sessionStateFile, { ...poolState(), version: 1, lastSessionUrl: finalUrl, updatedAt: new Date().toISOString() });
      }
      currentUrl = finalUrl;
      break;
      } catch (error) {
        if (await switchRestrictedAccount(error, lineNumber)) {
          attempt = 0;
          continue;
        }
        const retryable = args.batchPromptFile && [
          "IMAGE_GENERATION_TIMEOUT",
          "IMAGE_GENERATION_NO_CLEAN_IMAGE",
          "DOLA_CLI_ERROR",
          "ECONNRESET",
        ].includes(error.code || "DOLA_CLI_ERROR");
        if (retryable && attempt < args.maxRetries) {
          attempt += 1;
          console.log(`[dola-cli] retrying line ${lineNumber} (${attempt}/${args.maxRetries}) in a new Dola tab`);
          client.close();
          capturedRecords.length = 0;
          const retryTarget = await findOrCreateTarget(args.cdp, DOLA_IMAGE_HOME, true);
          client = new CdpClient(retryTarget.webSocketDebuggerUrl);
          await client.connect();
          await client.send("Runtime.enable");
          await client.send("Page.enable");
          await client.send("Network.enable");
          await client.send("Page.bringToFront").catch(() => {});
          currentUrl = await evaluate(client, "location.href").catch(() => DOLA_IMAGE_HOME);
          await waitForPageReady(client);
          await sleep(3000);
          await installImageHook(client);
          installNetworkImageCapture(client, capturedRecords);
          continue;
        }
        if (args.characterImage) {
          const details = { ...(error.details || {}), failedLine: lineNumber, failedPrompt: promptText };
          if (error instanceof DolaCliError) {
            error.details = details;
          } else {
            throw new DolaCliError(error.code || "DOLA_CLI_ERROR", error.message || String(error), details);
          }
        }
        throw error;
      }
    }
  }

  const output = args.batchPromptFile
    ? {
      sessionUrl,
      attached,
      imageGeneration: true,
      batchPromptFile: path.resolve(args.batchPromptFile),
      ...(args.characterImage ? {
        characterImage: path.resolve(args.characterImage),
        characterBatchSize: args.characterBatchSize,
      } : {}),
      ...(accountPoolFile ? {
        accountPoolFile,
        accountId: activeAccount?.id || "",
        restrictedAccounts: { [accountDay]: [...restrictedAccounts].sort() },
      } : {}),
      submitted: results.filter(item => !item.skipped).length,
      skipped: results.filter(item => item.skipped).length,
      results,
    }
    : {
      sessionUrl,
      attached,
      ...(accountPoolFile ? {
        accountPoolFile,
        accountId: activeAccount?.id || "",
        restrictedAccounts: { [accountDay]: [...restrictedAccounts].sort() },
      } : {}),
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
