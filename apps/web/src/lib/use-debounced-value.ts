import { useEffect, useState } from "react";

/**
 * The value as it was once it stopped changing for `delay` milliseconds.
 *
 * The input keeps its own state and stays instant; only what is derived from
 * it (a request, a query key) waits for the typing to settle.
 */
export function useDebouncedValue<T>(value: T, delay: number): T {
	const [settled, setSettled] = useState(value);
	useEffect(() => {
		if (Object.is(value, settled)) return;
		const timer = setTimeout(() => setSettled(value), delay);
		return () => clearTimeout(timer);
	}, [value, settled, delay]);
	return settled;
}
