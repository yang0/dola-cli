# dola-cli

Small Bun CLI for driving Dola through an existing Chrome CDP session.

It follows the same browser-control approach as `E:\projectHome\doubao-img`:
connect to Chrome on port `9222`, open or reuse a Dola chat session, attach local
files, submit prompts, create new sessions, switch to image generation, and
download generated images.

## Prerequisites

Start Chrome with remote debugging enabled and log in to Dola manually:

```powershell
chrome.exe --remote-debugging-port=9222
```

## Chat

```powershell
bun src\cli.js --session "https://www.dola.com/chat/38415631468262161" --file "E:\temp\aa.png" --prompt "Describe this image"
```

## New Session

```powershell
bun src\cli.js --new-chat --prompt "Hello" --no-wait
```

The JSON output includes `finalUrl`, for example `https://www.dola.com/chat/<id>`.

## Image Generation

```powershell
bun src\cli.js --new-chat --image-gen --prompt "A simple green circle icon on a white background" --count 1 --out downloads
```

Image downloads prefer raw/original/no-watermark URLs. URLs containing watermark
markers are skipped by default. Use `--allow-watermark` only when you explicitly
want to permit watermarked fallback URLs.

Useful diagnostics:

```powershell
bun src\cli.js --session "https://www.dola.com/chat/38415631468262161" --dry-run
bun src\cli.js --session "https://www.dola.com/chat/38415631468262161" --debug-ui
npm run check
```
