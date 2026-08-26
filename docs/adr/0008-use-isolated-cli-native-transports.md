# Use isolated CLI-native transports

OpenAgentCouncil integrates with Codex through App Server and with Claude Code through structured print-mode calls resumed by session ID. Both adapters reuse the CLI's existing authentication and model defaults, load repository instructions such as `AGENTS.md` and `CLAUDE.md`, and disable personal hooks, MCP servers, plugins and skills. This keeps the product on supported local CLI surfaces without letting unrelated customizations change a Council Member's role or introduce side effects.
