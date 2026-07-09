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

For batch generation, create a UTF-8 text file with one prompt per non-empty
line, then run:

```powershell
bun src\cli.js --new-chat --batch-prompt-file prompts.txt --count 1 --out downloads
```

`--batch-prompt-file` automatically enables image generation. Prompts are
submitted sequentially, and `--count` applies to each line. It cannot be used
with `--prompt`, `--prompt-file`, or `--no-wait`.

Image downloads prefer raw/original/no-watermark URLs. URLs containing watermark
markers are skipped by default. Use `--allow-watermark` only when you explicitly
want to permit watermarked fallback URLs.

Only images contained in the final Dola reply are downloaded. If that reply is
text-only, the command exits with a non-zero status and reports one of these
error codes: `IMAGE_GENERATION_QUOTA_EXHAUSTED`, `IMAGE_GENERATION_REFUSED`, or
`IMAGE_GENERATION_TEXT_RESPONSE`. Timeouts and unavailable clean image URLs use
`IMAGE_GENERATION_TIMEOUT` and `IMAGE_GENERATION_NO_CLEAN_IMAGE`, respectively.

Useful diagnostics:

```powershell
bun src\cli.js --session "https://www.dola.com/chat/38415631468262161" --dry-run
bun src\cli.js --session "https://www.dola.com/chat/38415631468262161" --debug-ui
npm run check
```
