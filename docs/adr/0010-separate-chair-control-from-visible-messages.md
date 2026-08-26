# Separate Chair control from visible messages

The Chair returns a small validated JSON envelope for participant selection, Round actions and Deliberation state, while user-visible contributions and Recommendations remain Markdown. OpenAgentCouncil gives malformed control output one repair attempt before failing the Chair call. This keeps orchestration deterministic without forcing implementation metadata into the Council timeline.
