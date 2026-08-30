# Auxiliary Models Extension (auxiliary-models) · User Guide

> Two dedicated "helpers" for Pi: one **looks at images**, one **compresses long text**. Read-only, explicit, cost-visible.
> Version v9 · Pi 0.84+ · Node ≥ 22

---

## What it does

Your main model isn't good at everything: it may be **text-only** (can't see images) or **context-hungry** (long text eats context). This extension fills those gaps **without touching the main model** — a helper on call when needed.

- **Read-only**: helpers have no tools; they can't read your files or run commands, only receive the image/text you hand them
- **Explicit**: every call is requested by you (or pre-configured); nothing runs silently
- **Controllable**: directory policy, call budget, timeout, size caps — all configurable
- **Visible**: the status bar shows who was used and how much it cost, live

## Quick start

```text
/aux status            # show current config & routing
/aux vision            # look at an image: follows main model, falls back if it can't see
/aux extract           # compress long text into a summary
```

Pinning a model opens a picker: `> keyword` to search, Tab to switch all/session models.

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

## Directory policy (pathPolicy)

Before reading an image, the vision role checks its path:

- **`unrestricted` (default)**: any path allowed; aligns with the main model's full-disk access
- **`roots`**: only current working directory + directories in `allowedRoots`; images outside require your confirmation each time

> Note: this is an "accident trip-wire", not a security boundary — the main model can read the whole disk anyway. It defaults to open; switch to `/aux policy roots` when you want to be strict.

## Configuration

File: `~/.pi/agent/auxiliary-models.json` (user directory takes priority; a package install falls back to the package directory only when no user config exists).

```jsonc
{
  "enabled": true,                     // master switch
  "defaults": {                        // global limits
    "timeoutMs": 60000,                // per-call timeout
    "maxOutputTokens": 2048,           // max output per call
    "maxInputChars": 50000,            // max input per call
    "maxCallsPerTurn": 2               // max helper calls per turn
  },
  "roles": {
    "vision": {
      "mode": "default",               // "default"=follow main / "pinned"=fixed
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

## Image pipeline

```
realpath → (roots mode) dir check → sniff file header → resize → size cap → send to helper
```

| Error code | Meaning |
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

## FAQ

**Pinned model still fails?** Run `/aux status`, read the "effective route". Common: not authenticated, model can't see images, timeout.

**Can my main model see images?** Depends on type. Text-only models can't — that's why the vision fallback exists.

**Will it cost a lot?** Default max 2 calls per turn, shown live in the status bar.

**Restart after editing config?** No — auto-reloads on next call.

## Known limitations

- Auxiliary calls do **not** trigger Pi audit events like `before_provider_request` (they call `modelRegistry.complete()` directly)
- Some gateways (e.g. `opencode-go`) may **drop images** (2/2 vision models failed); prefer first-party or other gateways
- Some model routes return **empty responses** (e.g. `openrouter/google/gemini-3.6-flash`) — upstream issue
- The extension entry `.ts` has no regression tests; testable logic lives in `lib/*.mjs` (42/42 tests)

## For developers

```
extensions/auxiliary-models.ts   entry (UI/footer/wizard/commands)
lib/auxiliary-models-core.mjs    validation/routing/error codes (single source of truth)
lib/auxiliary-models-runner.mjs  call wrapper (timeout/budget/concurrency gate)
lib/auxiliary-models-image.mjs   image validation chain
lib/auxiliary-models-command.mjs command parsing/status text/completions
```

Conventions: routing always goes through `resolveValidatedRole`; config read/write goes through `resolveConfigPath` (user directory first); after every `.ts` edit run the parse gate (prevents a half-written extension from breaking all new windows); tests: `node --test tests/*.test.mjs`.

---
*Code version v9. When docs and code disagree, trust the code.*