import { expect, test } from "bun:test";
import { authorSharePercent, formatAuthorShare } from "../routes/creators.tsx";

test("author share uses the whole library as its denominator", () => {
	expect(authorSharePercent(12, 100)).toBe(12);
	expect(formatAuthorShare(12, 100)).toBe("12.0%");
	expect(formatAuthorShare(1, 5000)).toBe("<0.1%");
	expect(formatAuthorShare(1, 0)).toBe("0.0%");
});
