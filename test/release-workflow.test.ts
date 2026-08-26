import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = path.join(root, ".github", "workflows", "release.yml");

test("the release workflow is manually owner-gated and validates its tag", async () => {
	const source = await readFile(workflow, "utf8");

	assert.match(source, /workflow_dispatch:/);
	assert.doesNotMatch(source, /^\s*(push|pull_request):/m);
	assert.match(
		source,
		/tag:\n\s+description:.*\n\s+required: true\n\s+type: string/,
	);
	assert.match(source, /github\.actor != 'niebag'/);
	assert.match(source, /github\.actor == 'niebag'/);
	assert.match(source, /ref: refs\/tags\/\$\{\{ inputs\.tag \}\}/);
	assert.match(source, /TAG: \$\{\{ inputs\.tag \}\}/);
	assert.match(
		source,
		/\[ "\$TAG" != "\$version" \] && \[ "\$TAG" != "v\$version" \]/,
	);
});

test("the release workflow reruns every gate before publishing its packed artifact", async () => {
	const source = await readFile(workflow, "utf8");
	const artifact = "$" + "{{ steps.pack.outputs.tarball }}";

	for (const command of [
		"npm ci",
		"npm run quality",
		"npm test",
		"npm run build",
		"npm run release:validate",
		`OPENAGENTCOUNCIL_TARBALL="${artifact}"`,
		`npm publish "${artifact}" --provenance`,
	]) {
		assert.ok(source.includes(command), `missing ${command}`);
	}
	assert.match(source, /node-version: 24/);
	assert.match(source, /id-token: write/);
	assert.ok(source.indexOf('if [ "$TAG"') < source.indexOf("npm publish"));
});
