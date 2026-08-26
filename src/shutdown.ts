type ShutdownTarget = {
	exitCode?: string | number | null;
	once(signal: NodeJS.Signals, listener: () => void): unknown;
	off(signal: NodeJS.Signals, listener: () => void): unknown;
};

export function abortOnShutdown(
	unmount: () => void,
	target: ShutdownTarget = process,
) {
	const interrupt = () => {
		target.exitCode = 130;
		unmount();
	};
	const terminate = () => {
		target.exitCode = 143;
		unmount();
	};
	target.once("SIGINT", interrupt);
	target.once("SIGTERM", terminate);
	return () => {
		target.off("SIGINT", interrupt);
		target.off("SIGTERM", terminate);
	};
}
