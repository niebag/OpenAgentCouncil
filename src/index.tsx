#!/usr/bin/env node
import { render } from "ink";
import { App } from "./app.js";
import { abortOnShutdown } from "./shutdown.js";

if (!process.stdin.isTTY || !process.stdout.isTTY) {
	console.error(
		"OpenAgentCouncil requires an interactive terminal (TTY). Run it from a terminal.",
	);
	process.exitCode = 1;
} else {
	const app = render(<App workingDirectory={process.cwd()} />, {
		exitOnCtrlC: false,
	});
	abortOnShutdown(app.unmount);
}
