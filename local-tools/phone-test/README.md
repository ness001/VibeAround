# Local phone-test helpers

These scripts preserve the local Cloudflare Quick Tunnel experiment alongside the source checkout. They are not upstream VibeAround features. The initial end-to-end tests used the v0.7.25 portable application; compatibility with a source build of current main must be verified before reopening remote access.

## Files

| File | Purpose |
|---|---|
| `quick-tunnel.cjs` | Loopback-only HTTP/WebSocket gateway with a temporary Cloudflare hostname, restricted routes, and unchanged upstream authentication |
| `quick-tunnel.test.cjs` | Mock-based authentication, origin, routing, WebSocket, and lifecycle tests |
| `start-app.cjs` | Launch a source-built desktop executable using explicitly selected private state and workspace |
| `verify-local.cjs` | Check authenticated local API access and inspect non-secret launch-plan fields |
| `verify-remote.cjs` | Check public API authentication, blocked routes, login, and WebSocket upgrades |
| `verify-terminal.cjs` | Real Chromium/WebKit mobile-sized terminal handshake, keyboard, and Prompt-bar command tests using disposable shell sessions |
| `verify-chat-controls.cjs` | Isolated real chat UI check for compaction budget, advertised model/effort choices, and acknowledged changes; refuses the primary port |
| `verify-prestart-controls.cjs` | Select a gateway model, effort, and context budget with zero prompts, then verify the first response uses those choices |

## Migration state

- The documentation changes and these custom scripts were carried onto the full `main` checkout.
- No model credentials, owner tokens, histories, installed adapters, binaries, or runtime settings were copied into the repository.
- Existing private application state remains outside Git under `%LOCALAPPDATA%\VibeAround-PhoneTest\data` on the original Windows computer. The test workspace also remains outside this repository.
- Original helper copies and the earlier temporary source checkout were retained as backups.
- The downloaded portable VibeAround release and its ZIP were removed. The modified source desktop application was subsequently built and started on Windows with its QR pairing endpoints; public redemption, replay rejection, WebSocket authentication, and mobile-sized browser login were verified. Physical iPhone/Safari scanning remains a user check.

## Prerequisites

Follow [Build from source](../../docs/guides/build-from-source.md) for Rust, Bun, and platform build prerequisites. Node.js is required for these helpers. Install an approved Cloudflare client separately or set `CLOUDFLARED_PATH` to the verified existing executable; the client is not bundled here.

The gateway targets `127.0.0.1:12358`. Keep VibeAround's internal tunnel provider set to `none` when using this helper, and retain authentication and normal agent approval settings.

## Test and run

From the repository root, run the mock tests without exposing any service:

```powershell
node --test .\local-tools\phone-test\quick-tunnel.test.cjs
```

Before starting a source-built app, provide these environment variables in the same shell:

| Variable | Purpose |
|---|---|
| `VIBEAROUND_DATA_DIR` | Absolute path to private application state outside the repository |
| `VIBEAROUND_WORKSPACE` | Intended workspace; use a disposable folder for initial testing |
| `VIBEAROUND_EXECUTABLE` | Optional explicit source-built desktop executable; otherwise defaults to `src/target/release/vibearound-desktop[.exe]` |
| `CLAUDE_CODE_EXECUTABLE` | Existing approved CLI executable for the ACP adapter, if an override is needed |
| `CLAUDE_CODE_GIT_BASH_PATH` | Git Bash executable on Windows, if needed |
| `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL` | Existing approved process environment; this launcher neither creates nor persists credentials |
| `CLOUDFLARED_PATH` | Optional approved Cloudflare executable; otherwise resolves `cloudflared` from PATH |

Do not paste credentials into scripts, tracked files, public links, or command arguments.

```powershell
node .\local-tools\phone-test\start-app.cjs
```

In another shell with the appropriate private-state environment, verify local behavior before starting the tunnel:

```powershell
node .\local-tools\phone-test\verify-local.cjs
node .\local-tools\phone-test\quick-tunnel.cjs
```

The tunnel prints `PUBLIC_URL=.../va/`. Verify that URL in a separate shell before pairing the phone:

```powershell
node .\local-tools\phone-test\verify-remote.cjs 'https://YOUR-ASSIGNED-HOST.trycloudflare.com/va/'
```

### Interactive terminal smoke test

For an authorized running instance, `verify-terminal.cjs` creates its own disposable generic terminal per engine, connects through the public gateway, verifies cursor-query replies, resizing, touch focus, keyboard command execution without duplicates, and the mobile Prompt bar, then deletes only those test sessions.

It requires an externally installed `playwright-core` and its WebKit/Chromium browsers; no browser-test dependency is added to the application. Set `PLAYWRIGHT_MODULE` to that module's absolute path if it is outside Node's module resolution. `CHROMIUM_EXECUTABLE` optionally selects an already-installed Chromium browser. Set `VIBEAROUND_WORKSPACE` to a disposable workspace and `VIBEAROUND_DATA_DIR` to the intended app's private state.

```powershell
node .\local-tools\phone-test\verify-terminal.cjs 'https://YOUR-ASSIGNED-HOST.trycloudflare.com/va/'
```

Only counters and boolean results are printed, not terminal contents or credentials. This tests browser engines at mobile dimensions, not a physical phone keyboard or Safari device.

### Scan to connect

With a source build containing QR pairing:

1. On the computer, open VibeAround's **Remote** page and its **Connect phone** card.
2. Select an active built-in tunnel, or paste this helper's `PUBLIC_URL` into the card on the computer. The helper's URL is not automatically registered in VibeAround. The validated public origin is remembered for the current desktop session so switching tabs does not clear it; update it after restarting the helper. Pairing tickets are never stored with this preference.
3. Generate the QR code and scan it with the iPhone Camera. Tap the link to open Safari; it signs in without copying an owner token.
4. Scan within **60 seconds**. Each QR can be redeemed only once; generate a new one if it expires or has already been used.

QR images are generated locally. The link carries a random one-use ticket in its fragment, never the owner token. Anyone who can scan a still-valid code can obtain owner access, so do not share screenshots or pairing links. The short QR lifetime does not expire the tunnel or a browser that has already signed in.

The old manual flow remains available: use Desktop's **Settings > General > Auth Token** with the phone page's manual token form. Never publish the token itself. Stop the foreground helper with Ctrl+C.

## Security and lifecycle limits

- There is no local automatic expiry by default (`lifetimeMs: 0`); a positive lifetime can be supplied through the exported `startTunnel` function. Startup timeout and fail-closed error handling remain enabled.
- This is still a Quick Tunnel, not a permanent URL or uptime guarantee. Restarting it changes the hostname. Closing the helper terminates its public connections; running agent tasks require separate shutdown.
- The helper validates the exact allocated Host and browser Origin before translating a valid Origin for the local app. It preserves mandatory app authentication and marks forwarded traffic so it cannot use upstream local-only access.
- QR ticket creation is local-owner-only and is not forwarded through the public gateway. Only the one-use redemption endpoint is forwarded; the application checks ticket expiry, target hostname, and replay.
- Preview, local API bridges, MCP, settings mutation, and other unneeded routes are not exposed. The helper does not populate VibeAround's built-in tunnel-status display.
- An empty workspace is not an OS sandbox. An authenticated owner controls the underlying agent; this helper does not restrict the agent's filesystem permissions.
- VibeAround's owner token is shared across browsers. A full app-process restart rotates it; do not assume logout revokes another browser or an already-open connection.
- Retest after upstream changes, especially authentication, route paths, WebSocket behavior, and agent launch permissions.
