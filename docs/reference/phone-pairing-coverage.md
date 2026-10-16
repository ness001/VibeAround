# Phone pairing coverage

Coverage and implementation lessons from the Windows QR-pairing investigation on 2026-09-18. This records observed results, not a claim of complete device support. See [security model](../architecture/security-model.md#qr-scan-pairing) for the contract and [timers and limits](timers-and-limits.md) for ticket lifetime and capacity.

**Status:** the WebKit failure is reproduced and fixed in browser-engine tests. **Post-fix physical iPhone/Safari confirmation is still pending.** Android success was user-reported, not an independently repeated device test.

## Failure and targeted fix

A real Playwright WebKit browser on Windows, using an iPhone 13-sized context, reproduced the phone failure. `POST /va/api/pair/redeem` with `mode: "same-origin"` and `referrerPolicy: "no-referrer"` sent `Origin: null`. The public gateway rejected it with **403**, and the page displayed:

> Connection failed. Scan a new QR code or use another pairing method.

The equivalent Chromium request sent the actual page origin and returned **200**. An earlier Chromium smoke test with an iPhone-sized viewport therefore missed the problem: viewport emulation does not select the WebKit engine or prove physical Safari compatibility.

The controlled request matrix used `POST /va/api/pair/start`, retaining `no-referrer`, to compare fetch modes without consuming QR tickets. Pair-start and redemption pass through the same gateway Origin gate; these four probe results are distinct from the actual redemption evidence above and below.

| Browser engine on Windows | Fetch mode | Observed Origin | Pair-start probe status |
|---|---|---|---|
| WebKit | `same-origin` | `null` | 403 |
| WebKit | `cors` | Actual page origin | 200 |
| Chromium | `same-origin` | Actual page origin | 200 |
| Chromium | `cors` | Actual page origin | 200 |

The client now uses `mode: "cors"`. The destination remains the fixed relative `/va/api/pair/redeem` URL; `redirect: "error"`, `credentials: "same-origin"`, `cache: "no-store"`, and `referrerPolicy: "no-referrer"` remain in place. This changes browser request behavior, not authorization policy: it does **not** allow foreign origins, redirects, or unauthenticated protected API access.

The rebuilt dashboard was served from `web/dist` by the already-running daemon; neither the app nor the tunnel was restarted for this client fix. Real WebKit and Chromium runs then returned **200**, reported **paired: true**, and cleared the ticket fragment. The full post-fix WebKit phone check also verified exactly one redemption, a stored session token, authenticated `/api/sessions` returning **200**, and the actual application body rendering. Reusing that ticket in a second fresh tab displayed the expired/already-used state. This deployment behavior was verified for that source-run configuration, not every packaged distribution.

## External URL navigation fix

The external tunnel URL originally lived only in component `useState("")`. The actual desktop reproduced the loss: enter the URL, navigate to **Launch**, then return to **Remote**; the field was empty and QR generation disabled. The fix keeps only the validated, non-secret origin in `sessionStorage`, with guarded reads and writes. QR tickets are never persisted.

A live post-fix desktop check, without an app restart, confirmed navigation preserved the URL and **Generate** remained enabled. The two added regression tests passed with the complete desktop suite: **48/48 tests, 166 assertions across 11 files**; the desktop production build also passed. An external helper still requires manual URL entry initially; the sidebar lists built-in tunnels only.

## Mobile terminal input fix

`TerminalView.tsx` set xterm's `disableStdin: isMobile`. This disables more than keyboard entry: `CoreService.triggerDataEvent` suppresses all PTY-bound data, including cursor-position / DSR replies. Fresh generic shells worked in desktop Chromium and WebKit, but both iPhone 13-sized contexts stalled with only four binary output bytes and two frames; input failed even with focus confirmed.

The fix sets `disableStdin: false`; mobile touch scrolling, font sizing and the special input bar remain unchanged. After **44/44 web tests** and the production build passed, the rebuilt client was served without restarting the app.

The checked-in `local-tools/phone-test/verify-terminal.cjs` passed in mobile Chromium and WebKit: cursor reply, resize, focus and command execution all succeeded. A split-string output marker proves execution rather than merely matching echoed input. Exact keyboard data showed no duplication; the **Prompt** bar command executed once in one frame. The harness created and deleted only its own disposable PTYs.

A separate disposable WebKit session launched the real Claude CLI: cursor reply succeeded, 1,626 output bytes arrived, and the Claude UI was detected without nested-session or launch errors. No user prompt was entered, and the session was cleaned up. **Physical-phone terminal keyboard behavior still awaits user confirmation.**

## Verified coverage and its limits

| Layer / check | Recorded result | Boundary |
|---|---|---|
| Web unit suite | 44/44 passed | Includes QR request contract, fragment cleanup, single redemption, response validation, failure/replay handling, destination validation and mobile terminal input configuration; mocks cannot prove engine-generated headers |
| Desktop UI unit suite | 48/48 passed; 166 assertions, 11 files | Includes URL validation/persistence, fragment-only QR tickets, countdown, cancellation and stale-response handling; not a camera scan |
| Local gateway Node suite | 19/19 passed | Authentication, origins, routes, WebSockets and lifecycle; this helper is not an upstream tunnel feature |
| Native QR ticket store | 5/5 passed | Single use, owner/audience binding, expiry, capacity recovery, malformed input and concurrent redemption |
| Native server pairing tests | 9/9 passed | Issuance/redemption constraints, local-only issuance, request validation and existing pairing behavior |
| Public redemption / replay | Fresh ticket 200; reuse 410 | Real backend checks; both Chromium and WebKit displayed the expired/already-used state on ticket reuse |
| Public origin rejection | Null and foreign origins still 403 | Post-fix probes; no gateway origin relaxation |
| Source-built Windows app | Tauri desktop and CLI built; app running on loopback port 12358 | Actual desktop QR rendered and screenshot inspected privately; local model replied `QR_READY` |
| Physical phones | Android worked according to the user; iPhone failed before the fix | Post-fix physical iPhone confirmation remains pending |

Expiry, capacity, owner binding and concurrency are covered by native tests. These are **not** physical-phone expiry or simultaneous-camera tests. A successful compile, HTTP probe, Chromium viewport test, and WebKit engine test each prove different things; none substitutes for the remaining device check.

**Durable regression coverage:** repository unit tests assert the QR request mode/options and mobile terminal input configuration. The earlier cross-browser **QR** smoke harness and screenshots remain temporary investigation files outside the repository; a checked-in QR browser regression is still a gap. The **terminal** Chromium/WebKit smoke harness is now checked in as an opt-in helper, not CI. **No automated cross-browser CI was added.**

## Repeatable checks

From `src/`, using the project's Bun, Node.js and Cargo tooling:

```bash
bun run web:test
bun run desktop-ui:test
node --test ../local-tools/phone-test/quick-tunnel.test.cjs
cargo test -p common auth::qr::tests
cargo test -p server web_server::pair::tests
bun run web:build
bun run desktop-ui:build
```

These commands rerun unit suites and frontend builds; they do not reproduce the public browser-engine experiment or launch a native app. For native launch prerequisites and commands, follow [Build from source](../guides/build-from-source.md) and the [local phone-test helper instructions](../../local-tools/phone-test/README.md). Public exposure requires explicit approval; existing exposure during this investigation is not authorization for a new tunnel.

### Opt-in terminal browser smoke

With the app and an already-authorized helper tunnel running, set `VIBEAROUND_DATA_DIR` to the intended private app data directory and `VIBEAROUND_WORKSPACE` to a disposable workspace. Provide Playwright's browser engines separately: optional `PLAYWRIGHT_MODULE` selects an externally installed module (default `playwright-core`); optional `CHROMIUM_EXECUTABLE` selects an existing Chromium/Edge executable. WebKit must also be available to Playwright. No repository dependency or CI installation is implied.

From the repository root, with `PUBLIC_URL` set privately to the current helper origin:

```powershell
node .\local-tools\phone-test\verify-terminal.cjs "$env:PUBLIC_URL"
```

The helper reads local auth internally; never put credentials in the URL or arguments. It creates disposable generic shell sessions, executes marker commands, and deletes its own sessions afterward. It tests terminal transport, not QR pairing or the separate Claude CLI launch observation.

For an authorized end-to-end pairing retest:

1. Verify the intended source-built desktop app is actually running, its local API responds, and its **Remote → Connect phone** card renders a QR code. Compilation alone is not completion.
2. Use a new ticket and clean browser context for each case. Run real Chromium and WebKit engines separately, not Chromium with two viewport profiles. Verify redemption status, paired state, and fragment removal.
3. Test replay separately with a consumed ticket, then recheck null/foreign-origin rejection. Do not interpret a stale ticket's 410 as the original 403 regression.
4. Have the user generate a fresh QR, scan with the physical iPhone Camera, open Safari, and confirm the authenticated dashboard. Record the actual device/browser outcome before closing the pending device check.
5. If physical expiry behavior is required, test it separately against the [configured lifetime](timers-and-limits.md#lifecycles-and-ttls); passing native expiry tests is not that observation.

## Diagnostic and delivery lessons

- **Capture evidence at the failing boundary.** Existing production logs had no pairing request/status telemetry. Sanitized browser observations of path, method, Origin classification (`null`, expected, foreign), and status identified the gateway rejection. Do not infer a backend ticket failure from the generic UI message.
- **Keep secrets out of diagnostics.** Do not record query strings, request/response bodies, authorization tokens, cookies, ticket fragments, full pairing links, or scannable QR screenshots in documentation or shared logs. Use a generic origin such as `https://phone.example` when an example is needed. The native QR screenshot was inspected, not included here.
- **Preflight Windows tooling early.** Check Rust/Cargo, the MSVC C++ toolchain and Windows SDK, and WebView2 before scheduling a native build. Native tests were completed after user-approved installation; missing tooling must be reported as a blocker, not a passed check.
- **Parallelize independent work, serialize shared builds.** Backend, web and desktop work can proceed in parallel with clear file ownership. Coordinate Cargo work sharing one target directory so agents do not contend for the same build lock.
- **Preserve environment boundaries.** The company npm feed was used only for local dependency downloads; repository registry configuration and lockfiles were unchanged. Do not turn an environment-specific workaround into an unrelated repository change.
- **Deliver a running path, not just binaries.** Confirm the intended app is live, inspect the real desktop UI, explain how to generate and scan a fresh QR, and state remaining physical-device checks. Retest the client served by the running daemon, not just an edited source file.

---

*Source anchors: `src/web/src/lib/qrPairing.ts` (`initPairingAuth`), `src/web/src/PairingGate.tsx`, `src/web/qa/qrPairing.test.ts`, `src/web/src/components/TerminalView.tsx`, `local-tools/phone-test/verify-terminal.cjs`; `src/desktop-ui/src/remote-dashboard/PhonePairing.tsx`, `src/desktop-ui/src/remote-dashboard/phonePairingModel.ts`, `src/desktop-ui/qa/phonePairing.test.ts`; `src/core/src/auth/qr.rs`, `src/server/src/web_server/pair.rs`; `local-tools/phone-test/quick-tunnel.cjs`, `local-tools/phone-test/quick-tunnel.test.cjs`; `src/package.json` (test/build scripts). Browser/device observations above are investigation evidence, not inferred from source.*

*Last verified: v0.7.25 with local QR-pairing and mobile terminal changes, 2026-09-18. Physical iPhone pairing and phone keyboard post-fix results pending.*

<sub>[◀ Timers and limits](timers-and-limits.md) · [Documentation index](../README.md) · [Provider endpoints ▶](provider-endpoints.md)</sub>
