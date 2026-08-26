# Own session state above CLI adapters

OpenAgentCouncil supports explicit Codex and Claude Code adapters in v1 and owns the normalized Session state instead of treating either CLI's history as canonical. Each Council Member gets an isolated CLI-session per Deliberation, which is resumed within that Deliberation's Rounds; native session IDs remain recoverable execution references. This prevents earlier discussions from biasing new Positions and keeps `/resume` consistent across CLIs without introducing a speculative adapter plugin system.
