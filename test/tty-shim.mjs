Object.defineProperties(process.stdin, {
	isTTY: { value: true },
	ref: {
		value: () => {
			process.stdin.resume();
			return process.stdin;
		},
	},
	setRawMode: { value: () => process.stdin },
	unref: {
		value: () => {
			process.stdin.pause();
			return process.stdin;
		},
	},
});
Object.defineProperties(process.stdout, {
	isTTY: { value: true },
	columns: { value: 100 },
	rows: { value: 30 },
});

const ready = setInterval(() => {
	if (process.stdin.listenerCount("readable") === 0) return;
	clearInterval(ready);
	process.stderr.write("__OPENAGENTCOUNCIL_TTY_READY__\n");
}, 0);
ready.unref();

if (process.env.OPENAGENTCOUNCIL_TTY_HOLD === "1") {
	const hold = setInterval(() => {}, 2 ** 31 - 1);
	const release = () => clearInterval(hold);
	process.on("SIGINT", release);
	process.on("SIGTERM", release);
}
