# Separate package and command names

Publish the npm package as `openagentcouncil`, expose `agentcouncil` as the primary executable and keep `openagentcouncil` as an alias to the same binary. The package name preserves the OpenAgentCouncil brand and matches OpenAgentPet, while the shorter primary command suits a tool that people invoke directly. Do not expose `oac`, because another active npm package already installs an executable with that name.
