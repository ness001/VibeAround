# UI and backend stack comparison

This document compares alternatives to each layer of VibeAround's stack separately. It is a technology evaluation, not a migration proposal or a claim that one stack is universally preferred.

**Recommendation:** retain the current stack unless a measured problem or team constraint justifies a change. For a remote coding application, authentication, process lifecycle, reconnect behavior, and mobile usability are more consequential than framework popularity.

## Current stack

The requirements below come from the v0.7.25 manifests. They are declared dependency ranges, not necessarily the exact versions resolved in lockfiles.

| Layer | Current choice | Declared requirement or implementation |
|---|---|---|
| UI framework | React + TypeScript | React/React DOM `^19.2.6`; TypeScript `~5.8.3` |
| Styling | Tailwind CSS | `^4.3.0` |
| UI components | shadcn/ui + Radix UI | shadcn tooling `^4.7.0`; Radix `^1.4.3` |
| Frontend build tooling | Vite | `^6.4.3` |
| Desktop shell | Tauri | Rust crate `2.10`; desktop UI API `^2.11.0` |
| Backend | Rust + Axum + Tokio | Axum `0.8`; shared Tokio `1.49` |
| Browser terminal | xterm.js | `@xterm/xterm` `^6.0.0`, with fit and rendering addons |

The desktop UI and browser dashboard are separate React applications. The iPhone interface is the web dashboard in Safari, not a native iOS application. Replacing the desktop shell would not, by itself, change that phone interface.

## 1. UI framework: React + TypeScript

TypeScript is not exclusive to React: Vue, Svelte, and Angular also support it. These choices replace the component framework rather than the application's transport or backend.

| Choice | Main strengths | Main trade-offs | Migration from current implementation | Best fit |
|---|---|---|---|---|
| **React + TypeScript — current** | Broad ecosystem; reusable components and hooks; established tooling and hiring pool | Many state-management and architectural choices; component behavior still requires careful design | None | Feature-rich products and teams with React experience |
| **Vue + TypeScript** | Approachable templates; cohesive routing and state-management ecosystem; single-file components | React-specific components and hooks cannot be reused directly | High: rewrite components, hooks, and UI integration tests | Teams preferring template-based development |
| **Svelte + TypeScript** | Concise components; compiler-oriented reactivity; less component boilerplate | Smaller ecosystem and hiring pool; framework-specific reactivity conventions | High: rewrite UI and replace React component dependencies | Small teams prioritizing concise UI code |
| **Angular + TypeScript** | Integrated forms, dependency injection, routing, and strong conventions | More concepts and structure; existing React libraries need replacements | High: substantial UI and application-structure rewrite | Large teams that value standardized architecture |

**Assessment:** React is a strong fit here. Team familiarity or concrete maintenance problems would be better reasons to switch than generalized performance claims. Framework changes do not eliminate iPhone keyboard, viewport, accessibility, or background-connection testing.

## 2. Styling: Tailwind CSS

| Choice | Main strengths | Main trade-offs | Migration from current implementation | Best fit |
|---|---|---|---|---|
| **Tailwind CSS — current** | Shared design tokens; fast responsive styling; utilities work well with the current component approach | Long class lists; utility conventions need consistency | None | Custom product interfaces and design systems |
| **CSS Modules** | Local class scoping; standard CSS; minimal styling-library coupling | Separate stylesheets; design tokens and conventions need deliberate organization | Medium–high: move utility styling into scoped rules | Teams preferring conventional CSS ownership |
| **Sass + scoped styles** | Mixins and stylesheet organization; compatible with CSS Modules | Sass alone does not scope classes; abstractions can grow unnecessarily | Medium–high: restyle components and establish conventions | Existing Sass expertise or substantial stylesheet reuse |
| **Runtime CSS-in-JS, such as Emotion** | Styles can respond directly to component props and themes | Runtime implementations add styling work and framework coupling; SSR may need extra setup | Medium–high: replace styling and retest themes | Highly dynamic component styles |
| **Build-time typed CSS, such as vanilla-extract** | Typed theme contracts; generated CSS without a runtime styling engine | Additional build integration; different authoring conventions | Medium–high: rewrite styles and token definitions | Teams wanting typed styling without runtime generation |

**Assessment:** Tailwind and CSS Modules are both reasonable long-term choices. Keeping Tailwind avoids rewriting existing shadcn-style components. Accessibility and visual consistency depend on implementation, not the styling syntax alone.

## 3. UI components: shadcn/ui + Radix UI

shadcn/ui supplies component code that the application owns and can edit. Radix supplies interaction primitives. Material UI, Ant Design, and Mantine primarily provide packaged component libraries; they are alternatives at a similar product layer, but have different ownership and update models.

| Choice | Main strengths | Main trade-offs | Migration from current implementation | Best fit |
|---|---|---|---|---|
| **shadcn/ui + Radix UI — current** | High customization; editable component code; accessible primitives | Local copies require maintenance; upstream fixes may require manual integration | None | A distinctive chat and terminal interface |
| **Material UI** | Extensive components, documentation, theming, and ecosystem | Material defaults are opinionated; some advanced MUI X features require commercial licenses | Medium–high: replace components, styles, and behavior tests | Rapid delivery of business applications |
| **Ant Design** | Extensive forms, tables, and administrative workflows | Strong visual conventions; phone layouts need deliberate adaptation | Medium–high: replace components and interaction patterns | Desktop-oriented administrative dashboards |
| **Mantine** | Broad component set and utility hooks; productive defaults | Smaller ecosystem than React's largest libraries; library conventions shape customization | Medium–high: replace local components and styling | General-purpose React applications |
| **React Aria Components + custom styling** | Accessible behavior and flexible composition without a prescribed appearance | More visual design work; not a complete ready-styled product UI | Medium–high: replace primitives and retain or rebuild styles | Teams owning a custom design system |

**Assessment:** shadcn/Radix fits the current customized UI. Mantine or Material UI could reduce initial component-building work for a new project, but switching an existing app has a significant cost. No library guarantees accessibility without testing focus, labels, keyboard operation, and touch behavior.

## 4. Frontend build tooling: Vite

| Choice | Main strengths | Main trade-offs | Migration from current implementation | Best fit |
|---|---|---|---|---|
| **Vite — current** | Fast development startup; straightforward modern defaults; established framework plugins | Some legacy tooling assumes webpack; output and plugin behavior need version-aware configuration | None | Modern client-side apps and Tauri frontends |
| **webpack** | Mature loader/plugin ecosystem; extensive customization | More configuration; large projects may need performance tuning | Medium: replace configuration and validate assets, workers, and development behavior | Existing webpack infrastructure or specialized requirements |
| **Rspack** | Rust-based bundling; substantial webpack API compatibility | Compatibility is not universal; webpack compatibility does not imply Vite compatibility | Medium: choose/configure a development setup and replace Vite plugins | Large webpack-oriented projects seeking faster builds |
| **Parcel** | Low-configuration setup; automatic handling of common assets | Specialized customization may be less straightforward | Medium: validate entry points, asset URLs, and packaging integration | Straightforward applications with conventional requirements |

**Assessment:** Vite is the clearest choice for the current project. Build speed should be measured on this repository; no benchmark or migration experiment is included here. Next.js and similar full-stack frameworks are not direct substitutes for a bundler: adopting them changes application architecture as well.

## 5. Desktop shell: Tauri

These options can host web UI technologies. Footprint descriptions are qualitative tendencies, not measurements of VibeAround or equivalent builds.

| Choice | Rendering/runtime model | Main strengths | Main trade-offs | Migration impact | Best fit |
|---|---|---|---|---|---|
| **Tauri — current** | Platform WebView with a Rust native layer | Usually smaller distribution than bundling Chromium; strong native integration | WebView behavior varies by OS; Rust and native packaging increase build complexity | None | Lightweight cross-platform desktop apps |
| **Electron** | Bundled Chromium and Node.js | Predictable browser-engine version; mature desktop tooling and integrations | Typically larger downloads and memory footprint; Chromium updates must ship with the app | High for shell/IPC; React UI and a separate Rust service may be retained | Desktop consistency and JavaScript-heavy teams |
| **Neutralinojs** | System WebView with native APIs and extensions | Lightweight distribution; JavaScript-oriented shell development | Smaller ecosystem; complex native capabilities may need custom extensions | Medium–high: replace desktop APIs, IPC, and packaging | Smaller desktop utilities |
| **Wails** | Platform WebView with a Go backend | Go-native integration; relatively lightweight web-based shell | Smaller ecosystem; WebView differences remain; not a direct home for Rust commands | High if replacing Rust integration; lower if retaining Rust as a separate service | Teams already using Go |

**Assessment:** Tauri favors footprint and the existing Rust integration. Electron is the most compelling alternative when consistent rendering and desktop tooling outweigh package size. Neither is automatically more secure: IPC boundaries, permissions, updates, and exposed capabilities matter.

A browser/PWA-only deployment removes this shell rather than replacing it. Native SwiftUI or Windows UI and Flutter are broader UI/platform changes, so they are not equivalent shell swaps.

## 6. Backend: Rust + Axum + Tokio

These rows compare service implementations. Replacing the service language does not necessarily require replacing React, but Tauri's existing Rust integration makes a non-Rust backend more involved.

| Choice | Main strengths | Main trade-offs | Migration impact | Best fit |
|---|---|---|---|---|
| **Rust + Axum + Tokio — current** | Memory safety in safe Rust; predictable resource management; strong asynchronous networking | Steeper learning curve; native dependencies and compilation add complexity | None | Long-running local services and native process integration |
| **Node.js + TypeScript + Fastify/Express** | Shared language with frontend; broad networking ecosystem; rapid iteration | CPU-heavy tasks need workers or offloading; PTY support may involve native addons | High: reimplement process, session, API, and persistence behavior | I/O-heavy services and TypeScript-focused teams |
| **Go + net/http or Chi** | Good concurrency support; straightforward service deployment and tooling | Less frontend code sharing; PTY and platform behavior still require OS-specific handling | High: backend rewrite and integration changes | Small operationally simple services |
| **Python + FastAPI** | Rapid prototyping; extensive AI/data ecosystem | Packaging Python into desktop deployments can be awkward; CPU-heavy work needs separate execution strategies | High: service rewrite and new distribution approach | Prototypes or services with substantial Python dependencies |
| **C# + ASP.NET Core** | Strong async networking, diagnostics, performance, and Windows tooling | Different runtime/build pipeline; native Tauri integration would need a boundary | High: service rewrite and host integration | .NET teams and Windows-oriented products |

**Assessment:** Rust is a natural fit for the current shell and process-management code. Node.js simplifies language sharing; Go is a good standalone-service option; ASP.NET Core suits a .NET team. Actual workloads should guide performance decisions, not language reputation alone.

If only the HTTP framework is problematic, a narrower Rust-to-Rust change, such as Axum to Actix Web, is another option. It still requires adapting handlers, middleware, and WebSockets, but avoids rewriting the entire service language.

## 7. Browser terminal: xterm.js

Terminal emulation is a specialized layer with fewer close substitutes. It is not the same as a shell, PTY backend, or remote-access server.

| Choice | Main strengths | Main trade-offs | Migration impact | Best fit |
|---|---|---|---|---|
| **xterm.js — current** | Established terminal emulator; addon ecosystem; existing fit/rendering integrations | Requires a separate PTY, transport, authentication, and lifecycle implementation | None | Interactive coding terminals in web apps |
| **hterm** | Established browser terminal emulation; configurable integration | Different APIs and a smaller integration ecosystem; existing xterm addons do not transfer | Medium–high: replace rendering, resize, input, and transport adapters | Applications whose requirements fit hterm's API |
| **DomTerm** | Terminal features combined with rich document-style output | More specialized architecture; not a drop-in widget replacement | High: reconsider terminal/backend integration and output assumptions | Rich-output terminal workflows |

**Assessment:** xterm.js remains the clearest choice. Test terminal compatibility, Unicode, copy/paste, resizing, touch input, and iPhone keyboards before considering a replacement. Tools such as ttyd and Wetty package more of the web-terminal service; they are not direct emulator-library substitutes.

## Decision summary

| If the primary problem is... | First option to evaluate |
|---|---|
| No measured problem; existing code is maintainable | Keep the current stack |
| Platform WebView rendering inconsistencies | Electron, while measuring memory and distribution costs |
| Too much work building ordinary UI components | Mantine or Material UI for new surfaces before a wholesale migration |
| Team struggles with utility-class styling | CSS Modules, adopted incrementally where practical |
| Team wants fewer implementation languages | Node.js/TypeScript backend, with an explicit native-integration plan |
| Existing team expertise is Go or .NET | Wails/Go or an ASP.NET Core service, respectively |
| Desktop shell provides little value | Browser-first deployment; retain a local agent service |
| Phone keyboard, scrolling, or reconnection is unreliable | Fix and test those behaviors before changing frameworks |

Migration-cost labels are relative estimates based on the current architecture, not delivery schedules. Alternatives' performance, accessibility, security, and suitability depend on the implementation and target devices. React-to-Vue, Tauri-to-Wails, and Rust-to-Go changes are not independent cost-free choices.

## Source anchors

- [`src/web/package.json`](../../src/web/package.json) — dashboard framework, styling, build tooling, and terminal dependencies.
- [`src/desktop-ui/package.json`](../../src/desktop-ui/package.json) — desktop React UI and Tauri API dependencies.
- [`src/desktop/Cargo.toml`](../../src/desktop/Cargo.toml) — native desktop shell and Rust dependencies.
- [`src/server/Cargo.toml`](../../src/server/Cargo.toml) — HTTP/WebSocket server dependencies.
- [`src/Cargo.toml`](../../src/Cargo.toml) — shared Rust workspace dependencies.
- [Architecture overview](overview.md) — application boundaries and communication paths.
- [Security model](security-model.md) — access boundaries independent of framework selection.

Source anchors verify the current stack; alternative assessments are engineering judgments, not upstream project endorsements or measured benchmark results.

*Last verified against: v0.7.25 manifests, 2026-09-18.*

---

[← Overview](overview.md) · [Documentation index](../README.md) · [Security model →](security-model.md)
