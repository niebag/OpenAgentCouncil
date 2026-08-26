<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://shieldcn.dev/header/graph.svg?title=OpenAgentCouncil&subtitle=Deliberate+with+local+coding+agents&mode=dark" />
    <img alt="OpenAgentCouncil" src="https://shieldcn.dev/header/graph.svg?title=OpenAgentCouncil&subtitle=Deliberate+with+local+coding+agents&mode=light" />
  </picture>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/openagentcouncil"><img alt="npm" src="https://shieldcn.dev/npm/openagentcouncil.svg" /></a>
  <a href="https://github.com/niebag/OpenAgentCouncil/actions/workflows/ci.yml"><img alt="CI" src="https://shieldcn.dev/github/ci/niebag/OpenAgentCouncil.svg?workflow=CI&branch=main" /></a>
  <a href="LICENSE"><img alt="MIT license" src="https://shieldcn.dev/github/license/niebag/OpenAgentCouncil.svg" /></a>
  <img alt="Node 24" src="https://shieldcn.dev/badge/node-24-blue.svg" />
  <img alt="macOS and Linux" src="https://shieldcn.dev/badge/platform-macOS%20%7C%20Linux-blue.svg" />
  <img alt="Codex and Claude Code" src="https://shieldcn.dev/badge/CLIs-Codex%20%2B%20Claude%20Code-blue.svg" />
</p>

OpenAgentCouncil is a local terminal app that asks a Council of coding agents to examine a question independently, then lets a Chair turn the discussion into a reviewed Recommendation.

## Requirements

- Node.js 24.
- macOS or Linux with an interactive terminal.
- At least one supported CLI on `PATH`: [Codex](https://openai.com/codex/) or [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview).

Each CLI must already be installed and authenticated. OpenAgentCouncil does not provide a login flow.

## Install and run

Install globally:

```sh
npm install --global openagentcouncil
agentcouncil
```

Or run it without a global installation:

```sh
npx openagentcouncil
```

`agentcouncil` is the primary command. `openagentcouncil` is an alias for the same program.

## Council concepts

A **Council** has one neutral **Chair** and at least two other **Council Members**. Members first provide independent **Positions** for a bounded **Deliberation**. The Chair produces a draft, members run a **Review Round**, and the result becomes a **Recommendation** when the Council reaches **Quorum**. A stopped or incomplete discussion remains an **Incomplete Deliberation**, not a Recommendation.

## Commands and configuration

On first start, choose an available CLI to create the Engineering Council. The terminal app supports:

- `/new` to start a Session and choose a Council
- `/resume` to reopen a saved Session
- `/stop` to end active work while preserving it
- `/members` to show Council Members
- `/config` and `/config open` to find or open configuration
- `/help` and `/quit`

Configuration and Member Profiles live outside the repository:

- macOS: `~/Library/Application Support/OpenAgentCouncil/`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/openagentcouncil/`

Sessions are local, versioned JSON files in that same app-data directory. They are written with user-only permissions and atomic replacement.

## Privacy, cost, and limitations

OpenAgentCouncil has no telemetry, accounts, cloud service, database, or sync. It does not inspect, copy, or manage CLI credentials. It starts the CLI you have already configured, so provider requests can use your existing subscription or API allowance.

The app is a terminal UI, not a background service. It needs an interactive TTY and currently supports only macOS and Linux. Council output can be wrong or incomplete; review Recommendations and diffs before acting. Provider behavior, authentication, pricing, data handling, and terms remain the provider's responsibility.

Anthropic's current Claude Code documentation describes third-party gateway setups, but says Anthropic does not endorse, maintain, or audit those products. OpenAgentCouncil is a local CLI wrapper, not a gateway, and makes no claim of Anthropic approval. Review the [current Claude Code gateway guidance](https://code.claude.com/docs/en/llm-gateway) and your applicable provider terms before use or distribution.

OpenAgentCouncil is independent from OpenAI and Anthropic. OpenAI, Codex, Anthropic, Claude, and Claude Code are trademarks or product names of their respective owners.

## Remove

```sh
npm uninstall --global openagentcouncil
```

Removing the package does not delete local configuration or Sessions. Remove the app-data directory above if you want to erase them.

## Release validation

```sh
npm run quality
npm test
npm run release:validate
```

`release:validate` builds, packs, installs the tarball into a temporary prefix without network access, and runs both executable names against fixture CLIs. Before publishing, recheck the npm package and executable names, provider terms, and this manual matrix:

- macOS and Linux: first-run setup, Session save/resume, and provider-backed Council
- narrow and wide terminals: resizing, scrollback, light/dark terminal themes, and keyboard-only use
- terminal accessibility: readable focus, status, and error states with the user's configured assistive tooling

Release blocker: the automated artifact validation passes, but the provider-backed and cross-platform manual matrix still requires a recorded sign-off before this release candidate is published.

Release checks recorded on 2026-08-26: the npm registry returned no package for `openagentcouncil` or `agentcouncil`, and an npm search found no published `agentcouncil` executable. Anthropic's current Claude Code guidance permits supported third-party gateways but does not endorse, maintain, or audit them. This wrapper does not inspect authentication or claim provider approval; users remain responsible for complying with the terms that apply to their account.

## Contributors and contributing

Contributors are listed in the [GitHub project](https://github.com/niebag/OpenAgentCouncil). See [CONTRIBUTING.md](CONTRIBUTING.md): keep changes focused, run the validation commands, and use Conventional Commits.

## License

OpenAgentCouncil is available under the [MIT License](LICENSE).
