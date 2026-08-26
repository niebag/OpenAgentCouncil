# TUI stack research

Research date: 2026-08-25. Sources are npm registry records, official documentation, and source repositories.

## Decision

Use **TypeScript with ESM, Node.js 24, Ink 7, React 19, `@inkjs/ui`, `react-ink-textarea`, and `ink-testing-library`** for the fake-agent prototype. Node 24 is the current Active LTS line; setting that fixed major as the project baseline avoids a moving runtime requirement. This does not settle the production renderer; the prototype exists to test whether Ink's simpler distribution model can support the agreed interaction design. [Node.js release schedule](https://github.com/nodejs/Release#release-schedule)

That set is the shortest path to an npm-installed macOS/Linux CLI. Ink is a maintained, MIT-licensed JavaScript renderer; version 7.1.1 requires Node 22 and React 19.2 or newer. It already handles terminal layout, keyboard and paste events, focus, CI rendering, and basic screen-reader output. [`ink` package metadata](https://registry.npmjs.org/ink/latest), [Ink README](https://github.com/vadimdemedes/ink#readme)

Use terminal scrollback for completed messages through Ink's `<Static>` component, with active member statuses and the composer kept live below it. Do not add an in-app scroll view or Markdown renderer to the first prototype. Ink documents `<Static>` specifically for unbounded completed output. [Ink `<Static>` documentation](https://github.com/vadimdemedes/ink#static)

Choose OpenTUI if the prototype shows that Ink cannot provide the agreed transcript navigation and rich message rendering without assembling several weaker packages. OpenTUI supplies scrolling, Markdown, code and diff rendering, but its native Zig core, pre-1.0 release pace, platform packages, and newer runtime requirements make it a larger distribution commitment. [OpenTUI README](https://github.com/anomalyco/opentui#readme), [runtime support](https://opentui.com/docs/getting-started/runtime-support/)

## Package and command names

Direct npm registry lookups returned `404 Not Found` for all three proposed package names:

- [`open-agent-council`](https://registry.npmjs.org/open-agent-council)
- [`openagentcouncil`](https://registry.npmjs.org/openagentcouncil)
- [`open-agent-council-cli`](https://registry.npmjs.org/open-agent-council-cli)

They therefore appear unregistered today. The settled package name is **`openagentcouncil`**, matching the existing OpenAgentPet convention. A registry `404` is not a reservation or a guarantee that npm will accept a future publish, so claim the name early. npm's own guidance requires an unscoped name to be unique and not confusingly similar to another package. [npm package-name guidelines](https://docs.npmjs.com/package-name-guidelines/)

Direct lookups for the proposed executable names [`agentcouncil`](https://registry.npmjs.org/agentcouncil) and [`openagentcouncil`](https://registry.npmjs.org/openagentcouncil) also returned `404 Not Found`. Package-name availability does not prove that no other installed package exposes the same executable, but neither name has the known conflict found for `oac`.

The executable name **`oac` has a material collision**. The unscoped [`oac`](https://www.npmjs.com/package/oac) package exists, although its published metadata declares no `bin`. More importantly, [`@open330/oac`](https://www.npmjs.com/package/%40open330%2Foac) actively publishes an `oac` executable for a different agent CLI. npm links each package's `bin` name into the shared global binary directory, so installing two packages with the same name creates an overwrite/shadowing risk. [npm `bin` documentation](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#bin) Search results will also be ambiguous. Expose `agentcouncil` as the primary executable and `openagentcouncil` as its predictable long alias; do not publish `oac`.

## Ink and OpenTUI

| Concern | Ink 7.1.1 | OpenTUI 0.5.8 |
|---|---|---|
| Runtime and distribution | Ink supports Node `>=22`, ESM and React `>=19.2`; OpenAgentCouncil sets Node 24 as its baseline. It is a conventional npm package with no separate native package matrix. [manifest](https://github.com/vadimdemedes/ink/blob/master/package.json) | Bun is the documented low-risk runtime. Current source declares Bun `>=1.3`; the Node path is tested at Node `>=26.4` and requires experimental FFI. Core ships optional native packages for macOS/Linux architectures and libc variants. [core manifest](https://github.com/anomalyco/opentui/blob/main/packages/core/package.json), [runtime support](https://opentui.com/docs/getting-started/runtime-support/), [Node version gate](https://github.com/anomalyco/opentui/blob/main/scripts/node26.mjs) |
| License and maintenance | MIT. 7.1.1 was published 2026-07-16. [npm](https://www.npmjs.com/package/ink), [license](https://github.com/vadimdemedes/ink/blob/master/license) | MIT and very active, but still pre-1.0. Version 0.5.8 was released on 2026-08-24, one day after 0.5.7. Pin matching Core/React versions and test upgrades. [npm versions](https://www.npmjs.com/package/%40opentui%2Fcore?activeTab=versions), [releases](https://github.com/anomalyco/opentui/releases), [license](https://github.com/anomalyco/opentui/blob/main/LICENSE) |
| Keyboard and paste | `useInput` exposes characters, arrows, page keys, modifiers and other control keys; `usePaste` handles bracketed paste separately. [input docs](https://github.com/vadimdemedes/ink#useinputinputhandler-options), [paste docs](https://github.com/vadimdemedes/ink#usepastehandler-options) | Core has keyboard and mouse routing plus configurable input/textarea key bindings. [input](https://opentui.com/docs/components/input/), [textarea](https://opentui.com/docs/components/textarea/) |
| Input and autocomplete | Ink core leaves widgets to components. `@inkjs/ui` provides text, password, confirm, select, multiselect and a prefix-based, case-sensitive autocomplete on `TextInput`. [Ink UI](https://github.com/vadimdemedes/ink-ui#readme), [autocomplete](https://github.com/vadimdemedes/ink-ui/blob/main/docs/text-input.md#autocomplete) | Built-in input, multiline textarea and select. There is no exported autocomplete component; compose one by filtering `Select` options from the input event. [exports](https://github.com/anomalyco/opentui/blob/main/packages/core/src/renderables/index.ts), [Select source](https://github.com/anomalyco/opentui/blob/main/packages/core/src/renderables/Select.ts) |
| Scroll and virtualization | Core only clips overflow; it does not scroll. `<Static>` plus terminal scrollback is enough for the prototype. `ink-scroll-view` is maintained and scrollable but explicitly renders every child, so it is not virtualization. [`overflow` docs](https://github.com/vadimdemedes/ink#overflow), [`ink-scroll-view`](https://github.com/ByteLandTechnology/ink-scroll-view#readme) | `ScrollBox` supports sticky edges, keyboard/mouse/programmatic scrolling and viewport culling. Culling avoids drawing offscreen children but still retains and lays them out; there is no exported virtual-list recycler. [ScrollBox docs](https://opentui.com/docs/components/scrollbox/), [source](https://github.com/anomalyco/opentui/blob/main/packages/core/src/renderables/ScrollBox.ts) |
| Markdown, code and diff | None in core. `@kud/ink-markdown` is a credible Ink 7 option for virtualized Markdown and unified diffs, but it is alpha; syntax highlighting and its streaming hook are still planned. Add it only after formatted output becomes an acceptance condition. [project README](https://github.com/kud/ink-markdown#readme), [npm](https://www.npmjs.com/package/%40kud%2Fink-markdown) | Core and React expose Markdown, tree-sitter-backed Code and Diff renderables. Diff supports unified/split views; Markdown supports fenced code and streaming updates. [Markdown](https://opentui.com/docs/components/markdown/), [Code](https://opentui.com/docs/components/code/), [Diff](https://opentui.com/docs/components/diff/) |
| Testing | The official `ink-testing-library` renders frames and supplies mock stdin. It is MIT, version 4.0.0, and was last published 2024-05-22. [README](https://github.com/vadimdemedes/ink-testing-library#readme), [npm](https://www.npmjs.com/package/ink-testing-library) | `@opentui/core/testing` includes an in-memory renderer, frame capture, resize, keyboard/mouse mocks, terminal capabilities and a frame recorder; React adds `testRender`. [testing guide](https://github.com/anomalyco/opentui/blob/main/packages/core/src/testing/README.md), [React utility](https://github.com/anomalyco/opentui/blob/main/packages/react/src/test-utils.ts) |

## Supporting packages

### CLI surface and configuration

Do not add an argument parser while both executable names open the same TUI and all commands live inside it. Use Node's process arguments only if a small flag such as `--help` becomes necessary.

Do not add a configuration framework. Store the small local v1 configuration as JSON with `node:fs/promises`, validate it at the load boundary, and use `node:os.homedir()` plus the agreed app-data path. A package becomes useful only when the product needs layered config files, environment-variable mapping, or migrations.

### Setup and prompts

Build first-run setup with the same Ink surface and **`@inkjs/ui`** components. This avoids switching terminal renderers and already covers the expected text, secret, confirm and selection fields. Version 2.0.0 accepts Ink 5 or newer. [`@inkjs/ui` npm metadata](https://registry.npmjs.org/@inkjs%2fui/latest)

If setup must ship before the full TUI, **`@clack/prompts` 1.7** is the smallest credible standalone alternative. It is MIT, requires Node 20.12 or newer, and includes text, password, confirm, select, autocomplete, multiline, path and spinner prompts. Do not install it alongside `@inkjs/ui` for the prototype. [Clack README](https://github.com/bombshell-dev/clack/blob/main/packages/prompts/README.md), [npm](https://www.npmjs.com/package/%40clack%2Fprompts)

Inquirer remains maintained and offers a broader prompt family, including search and external-editor flows, but those features add no prototype value. [Inquirer README](https://github.com/SBoudrias/Inquirer.js#readme), [npm](https://www.npmjs.com/package/%40inquirer%2Fprompts)

### Composer

Use `react-ink-textarea` 0.4.0 for the multiline composer and pin that exact version while it remains pre-1.0. It targets Ink 7 and provides multiline editing, paste handling, a viewport, labels and insertion support for mention autocomplete. `Enter` sends a message and `Ctrl+J` inserts a newline. `Shift+Enter`, `Ctrl+Enter` and `Alt+Enter` are progressive-enhancement aliases because terminals do not distinguish them consistently. Ink's automatic Kitty keyboard support handles those richer key events where the terminal supports them. [react-ink-textarea](https://github.com/omranjamal/react-ink-textarea), [npm](https://www.npmjs.com/package/react-ink-textarea), [Ink keyboard support](https://github.com/vadimdemedes/ink/blob/v7.1.1/readme.md#kittykeyboard)

## Prototype package set

Runtime:

```text
ink
react
@inkjs/ui
react-ink-textarea@0.4.0
```

Development:

```text
ink-testing-library
tsx
typescript
```

Use Node's built-in test runner through `tsx --test` so TypeScript and TSX tests run without a separate test framework. Keep `tsc --noEmit` in the quality job because Node's type stripping does not typecheck and does not support TSX by itself. `ink-testing-library` supplies terminal frames and input without requiring Jest or Vitest. [Node test runner](https://nodejs.org/download/release/v24.15.0/docs/api/test.html), [Node TypeScript support](https://nodejs.org/api/typescript.html), [tsx Node integration](https://tsx.is/node-enhancement)

CI must use fixtures and fake `codex` and `claude` executables. Tests may exercise the real subprocess boundary, protocol parsing, timeouts and signals, but must not require installed CLIs, credentials, network access or paid model calls.

Keep fake-agent behavior behind the same process interface that real adapters will use, but do not add an assistant/chat framework. [`@assistant-ui/react-ink`](https://github.com/assistant-ui/assistant-ui/blob/main/packages/react-ink/README.md) is maintained and capable, yet its message runtime, stores, adapters and protocol dependencies duplicate OpenAgentCouncil's own Session, Deliberation and Council model.

## Do not build these from scratch

- Terminal layout, repainting, resize handling, raw keyboard parsing, paste handling or focus management: Ink owns them.
- Text, password, confirm, select and simple autocomplete widgets: `@inkjs/ui` owns them.
- Multiline editing and portable newline behavior: `react-ink-textarea` owns them.
- Test terminal streams and frame capture: `ink-testing-library` owns them.
- A scroll engine, Markdown parser, syntax highlighter or diff renderer: defer them for the prototype; adopt a maintained package or switch to OpenTUI when the requirement becomes real.

## Unknowns to prove in the prototype

1. Verify `@inkjs/ui` 2.0 interactions under Ink 7 and React 19; its peer range allows Ink 7, but its last release predates Ink 7.
2. Test long completed messages, rapid status updates, resize, paste, Ctrl+C and screen-reader mode on one current macOS terminal and one Linux terminal.
3. Confirm whether users require scrolling inside the app rather than ordinary terminal scrollback. That single requirement is the clearest reason to choose OpenTUI instead.
4. Recheck npm name and executable collisions immediately before the first publish.
