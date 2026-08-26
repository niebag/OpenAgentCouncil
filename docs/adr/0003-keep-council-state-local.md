# Keep council state local

OpenAgentCouncil stores Council configuration and Sessions in local appdata outside the working repository, using user-only file permissions without application-level encryption. Each Session is a versioned JSON file written atomically through a temporary file and rename. V1 has no database, event log, accounts, cloud sync or telemetry, and Sessions can be removed from the resume picker. This keeps potentially sensitive transcripts out of Git and avoids adding remote trust or persistence infrastructure before it is needed.
