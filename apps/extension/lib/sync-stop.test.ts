import { expect, test } from "bun:test";
import { syncStopReason } from "./sync-stop.ts";
for (const source of ["x", "tiktok"]) {
	test(`${source} walks past unknown pages and stops on a known item`, () => {
		expect(syncStopReason(["new"], ["known"], 1)).toBeNull();
		expect(syncStopReason(["new2", "known", "older"], ["known"], 2)).toBe(
			"known",
		);
	});
	test(`${source} empty libraries and malicious caps stay bounded`, () => {
		expect(syncStopReason(["new"], [], 9, 100000)).toBeNull();
		expect(syncStopReason(["new"], [], 10, 100000)).toBe("page_limit");
		expect(syncStopReason(["old"], undefined, 100)).toBeNull();
	});
}
