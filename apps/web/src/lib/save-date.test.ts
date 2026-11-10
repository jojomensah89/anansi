import { expect, test } from "bun:test";
import { shortDate } from "./api";

test("save dates use UTC day and month, with year only outside current year", () => {
 const year = new Date().getUTCFullYear();
 expect(shortDate(Date.UTC(year,10,5)/1000)).toBe("5 Nov");
 expect(shortDate(Date.UTC(year-1,9,28)/1000)).toBe(`28 Oct ${year-1}`);
 expect(shortDate(null)).toBe("");
});
