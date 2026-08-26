type ShutdownTarget = {
	exitCode?: string | number | null;
	on(signal: NodeJS.Signals, listener: () => void): unknown;
	off(signal: NodeJS.Signals, listener: () => void): unknown;
};

export function abortOnShutdown(
	unmount: () => void,
	target: ShutdownTarget = process,
) {
	let stopped = false;
	const interrupt = () => {
		if (stopped) return;
		stopped = true;
		target.exitCode = 130;
		unmount();
	};
	const terminate = () => {
		if (stopped) return;
		stopped = true;
		target.exitCode = 143;
		unmount();
	};
	target.on("SIGINT", interrupt);
	target.on("SIGTERM", terminate);
	return () => {
		target.off("SIGINT", interrupt);
		target.off("SIGTERM", terminate);
	};
}
