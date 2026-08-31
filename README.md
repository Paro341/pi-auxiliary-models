# pi-auxiliary-models

> Hire two dedicated "helpers" for [Pi](https://github.com/earendil-works/pi-coding-agent) — one to **look at images**, one to **compress long text**. Read-only, explicit, cost-visible.
>
> [简体中文版 README](./README.zh-CN.md)

---

## What is this?

Your Pi main model isn't good at everything: it may be **text-only** (can't see images), or **context-hungry** (long text eats the window). This extension fills those gaps **without touching the main model** — a helper on call whenever you need one.

- ✅ **Read-only** — helpers have no tools; they can't read your files or run commands, only receive the image/text you hand them
- ✅ **Explicit** — every call is requested by you or pre-configured; nothing runs silently
- ✅ **Controllable** — directory policy, call budget, timeout, size caps — all configurable
- ✅ **Cost-visible** — the status bar shows who was used and how much it cost, live

## Quick start

```text
/aux status             # show current config & routing
/aux vision             # look at an image (follows main model; falls back if it can't see)
/aux extract            # compress long text into a summary
```

Pinning a model opens a picker: type `>` plus a keyword to search live (e.g. `> deepseek`), press Tab to switch all/session models.

## Install

From GitHub (requires access to this private repo):

```bash
pi install git:github.com/Paro341/pi-auxiliary-models
```

Or point Pi at local source (e.g. while developing):

```jsonc
// ~/.pi/agent/settings.json  or  <project>/.pi/settings.json
{ "extensions": ["D:/FSCode/AgentEPS/pi/extensions/pi-auxiliary-models/extensions/auxiliary-models.ts"] }
```

## Commands

| Command | Effect |
|---|---|
| `/aux` | open visual config wizard |
| `/aux status` | show config, routing, effective models |
| `/aux vision <provider>/<id>` | pin vision model (e.g. `ollama-cloud/gemma4:31b`) |
| `/aux vision` (no arg) | vision follows main model again |
| `/aux extract <provider>/<id>` | pin extract model |
| `/aux extract` (no arg) | extract follows main model again |
| `/aux allow <dir>` / `/aux disallow <dir>` | manage allowed image directories |
| `/aux policy roots` / `/aux policy unrestricted` | restricted / unrestricted (default) |

## Concepts

### Roles

Two independent "positions":

| Role | Command | What it does | Default routing |
|---|---|---|---|
| **Vision** | `/aux vision` | describe images, recognize content | follows main model; falls back if it can't see |
| **Extract** | `/aux extract` | compress long text into a summary | follows main model |

### Directory policy (pathPolicy)

Before reading an image, the vision role checks its path:

- **`unrestricted` (default)** — any path allowed; aligns with the main model's full-disk access
- **`roots`** — only current working directory + directories in `allowedRoots`; images outside require your confirmation each time

> This is an "accident trip-wire", not a security boundary — the main model can read the whole disk anyway.

## Configuration

File: `~/.pi/agent/auxiliary-models.json` (user directory takes priority; falls back to package directory only when no user config exists).

```jsonc
{
  "enabled": true,                     // master switch
  "defaults": {
    "timeoutMs": 60000,                // per-call timeout
    "maxOutputTokens": 2048,           // max output per call
    "maxInputChars": 50000,            // max input per call
    "maxCallsPerTurn": 2               // max helper calls per turn
  },
  "roles": {
    "vision": {
      "mode": "default",               // "default"=follow / "pinned"=fixed
      "model": null,                   // filled with {provider, id} when pinned
      "assertImageCapable": false,     // when pinned, enforce "can see images"
      "fallbacks": [                   // used if main model can't see images
        { "provider": "ollama-cloud", "id": "gemma4:31b" }
      ],
      "maxImageBytes": 8388608,        // image size cap (after resize)
      "pathPolicy": "unrestricted",    // "unrestricted" | "roots"
      "allowedRoots": []               // allowed dirs in roots mode
    },
    "extract": { "mode": "default", "model": null }
  }
}
```

## Error codes

| Code | Meaning |
|---|---|
| `IMAGE_NOT_FOUND` | path missing/unreadable |
| `IMAGE_OUT_OF_ROOT` | outside allowed dirs (roots mode) |
| `IMAGE_UNSUPPORTED_TYPE` | not a supported image format |
| `IMAGE_TOO_LARGE` | still too large after resize |
| `ROLE_DISABLED` | vision role disabled |
| `PINNED_MODEL_UNAVAILABLE` | pinned model not found / not authenticated |
| `PINNED_MODEL_NOT_VISION` | pinned model can't see images |
| `NO_VISION_FALLBACK` | main model can't see and no fallback |
| `BUDGET_EXCEEDED` | too many helper calls this turn |
| `INPUT_TOO_LARGE` | text exceeds input cap |
| `TIMEOUT` / `ABORTED` | timed out / cancelled |
| `UPSTREAM_ERROR` | provider returned an error |
| `CONFIG_INVALID` | invalid config (previous valid one kept) |

## Known limitations

- Auxiliary calls do **not** trigger Pi audit events like `before_provider_request` (they call `modelRegistry.complete()` directly)
- Some gateways (e.g. `opencode-go`) may **drop images** (2/2 vision models failed through that gateway); prefer first-party gateways
- Some model routes return **empty responses** (e.g. `openrouter/google/gemini-3.6-flash`) — upstream issue
- The extension entry `.ts` has no regression tests; testable logic lives in `lib/*.mjs` (42/42 tests)

## Layout & development

```
extensions/auxiliary-models.ts   entry (UI/footer/wizard/commands)
lib/auxiliary-models-core.mjs    validation/routing/error codes (single source of truth)
lib/auxiliary-models-runner.mjs  call wrapper (timeout/budget/concurrency gate)
lib/auxiliary-models-image.mjs   image validation chain
lib/auxiliary-models-command.mjs command parsing/status text/completions
docs/                            bilingual user guides
sync-to-global.sh                sync source to ~/.pi/agent (parse gate + backup + copy)
```

- All routing decisions go through `resolveValidatedRole` (core.mjs)
- Config read/write goes through `resolveConfigPath`: user directory first, package directory as fallback
- After every `.ts` edit run the parse gate (prevents a half-written extension from breaking all new windows)
- Tests: `node --test tests/*.test.mjs`

## Special Thanks
GPT 5.6 Terra
DeepSeek V4 Flash:0731

## License

MIT