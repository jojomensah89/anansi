/**
 * Every count in the interface, written one way: whole numbers with thousands
 * separators, so the rail's "2,907" and Sources' "1,402" read alike.
 */
const COUNT = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });

export function formatCount(n: number): string {
	return COUNT.format(n);
}
