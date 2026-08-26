import { render } from "ink-testing-library";
import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { App } from "../src/app.js";

test("renders the production Council screen and caller directory", () => {
	const instance = render(
		createElement(App, { workingDirectory: "/tmp/council-workspace" }),
	);
	assert.match(instance.lastFrame() ?? "", /OpenAgentCouncil/);
	assert.match(instance.lastFrame() ?? "", /COUNCIL ROSTER/);
	assert.match(instance.lastFrame() ?? "", /\/tmp\/council-workspace/);
	instance.unmount();
});
