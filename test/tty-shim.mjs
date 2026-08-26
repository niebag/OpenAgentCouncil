Object.defineProperties(process.stdin, {
	isTTY: { value: true },
	setRawMode: { value: () => process.stdin },
});
Object.defineProperties(process.stdout, {
	isTTY: { value: true },
	columns: { value: 100 },
	rows: { value: 30 },
});
