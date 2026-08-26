import type { ChildProcessWithoutNullStreams } from "node:child_process";

const ownsProcessGroup = process.platform !== "win32";
const wait = (milliseconds: number) =>
	new Promise((resolve) => setTimeout(resolve, milliseconds));

function running(child: ChildProcessWithoutNullStreams) {
	if (child.pid === undefined) return false;
	if (!ownsProcessGroup)
		return child.exitCode === null && child.signalCode === null;
	try {
		process.kill(-child.pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}

function signal(child: ChildProcessWithoutNullStreams, value: NodeJS.Signals) {
	if (ownsProcessGroup && child.pid !== undefined) {
		try {
			process.kill(-child.pid, value);
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
		}
	}
	child.kill(value);
}

async function waitForExit(
	child: ChildProcessWithoutNullStreams,
	exited: Promise<void>,
	grace: number,
) {
	const deadline = Date.now() + grace;
	while (running(child)) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) return false;
		await wait(Math.min(10, remaining));
	}
	await exited;
	return true;
}

export const detachedProcess = ownsProcessGroup;

export async function terminateProcess(
	child: ChildProcessWithoutNullStreams,
	exited: Promise<void>,
	grace: number,
	closeInputFirst = false,
) {
	if (!running(child)) return;
	if (closeInputFirst) {
		child.stdin.end();
		if (await waitForExit(child, exited, grace)) return;
	}
	signal(child, "SIGTERM");
	if (await waitForExit(child, exited, grace)) return;
	signal(child, "SIGKILL");
	if (!(await waitForExit(child, exited, grace)))
		throw new Error("Provider process group did not exit after SIGKILL");
}
