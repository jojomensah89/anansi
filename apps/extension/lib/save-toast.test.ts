import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import {
	createSaveToast,
	deliverWithConfirmation,
	rejectedSaveAction,
	saveToastMessage,
	toastPosition,
	type SaveOutcome,
} from "./save-toast.ts";

describe("saveToastMessage", () => {
	test("says what happened in plain words", () => {
		expect(saveToastMessage("save", "stored")).toEqual({ text: "Saved to Anansi", tone: "ok" });
		expect(saveToastMessage("unsave", "stored")).toEqual({ text: "Removed from Anansi", tone: "ok" });
		expect(saveToastMessage("save", "failed")).toEqual({ text: "Not saved to Anansi", tone: "error" });
		expect(saveToastMessage("unsave", "failed")).toEqual({ text: "Not removed from Anansi", tone: "error" });
		expect(saveToastMessage("save", "disconnected")).toEqual({ text: "Connect Anansi to save this", tone: "error" });
	});
});

describe("toastPosition", () => {
	const viewport = { width: 1000, height: 800 };
	test("sits just above the click", () => {
		expect(toastPosition({ x: 500, y: 400 }, viewport, { width: 160, height: 32 })).toEqual({ left: 420, top: 356 });
	});
	test("stays on screen near every edge", () => {
		expect(toastPosition({ x: 2, y: 2 }, viewport, { width: 160, height: 32 })).toEqual({ left: 8, top: 14 });
		expect(toastPosition({ x: 999, y: 799 }, viewport, { width: 160, height: 32 })).toEqual({ left: 832, top: 755 });
	});
	test("falls back to the bottom right without a recent click", () => {
		expect(toastPosition(null, viewport, { width: 160, height: 32 })).toEqual({ left: 816, top: 744 });
	});
});

describe("createSaveToast", () => {
	const setup = () => {
		const { document } = parseHTML("<!doctype html><html><body></body></html>");
		const timers: Array<() => void> = [];
		const toast = createSaveToast({
			document: document as unknown as Document,
			viewport: () => ({ width: 1000, height: 800 }),
			schedule: (run) => {
				timers.push(run);
				return timers.length;
			},
			cancel: (id) => {
				timers[id - 1] = () => {};
			},
		});
		return { document, toast, timers };
	};
	const label = (document: ReturnType<typeof setup>["document"]) => {
		const host = document.querySelector("[data-anansi-toast]") as unknown as HTMLElement;
		return host.shadowRoot?.querySelector("[role=status]")?.textContent;
	};

	test("shows one status message with the outcome as text", () => {
		const { document, toast } = setup();
		toast.show("save", "stored");
		expect(label(document)).toBe("Saved to Anansi");
	});

	test("a newer outcome replaces the previous one", () => {
		const { document, toast } = setup();
		toast.show("save", "stored");
		toast.show("unsave", "stored");
		expect(document.querySelectorAll("[data-anansi-toast]").length).toBe(1);
		expect(label(document)).toBe("Removed from Anansi");
	});

	test("removes itself afterward, and an old timer cannot remove a newer toast", () => {
		const { document, toast, timers } = setup();
		toast.show("save", "stored");
		toast.show("unsave", "stored");
		timers[0]?.();
		expect(document.querySelector("[data-anansi-toast]")).not.toBeNull();
		timers[1]?.();
		expect(document.querySelector("[data-anansi-toast]")).toBeNull();
	});
});

describe("rejectedSaveAction", () => {
	const nonce = "nonce-value";
	test("recognizes a rejected save from this page", () => {
		expect(rejectedSaveAction({ anansi: "page-event", action: "bookmark", bookmarkAction: "save", nonce }, nonce)).toBe("save");
		expect(rejectedSaveAction({ anansi: "page-event", action: "bookmark", bookmarkAction: "unsave", nonce }, nonce)).toBe("unsave");
	});
	test("ignores anything else, including messages the page could forge", () => {
		expect(rejectedSaveAction({ anansi: "page-event", action: "bookmark", bookmarkAction: "save", nonce: "other" }, nonce)).toBeNull();
		expect(rejectedSaveAction({ anansi: "page-event", action: "ready", nonce }, nonce)).toBeNull();
		expect(rejectedSaveAction({ anansi: "page-event", action: "bookmark", bookmarkAction: "steal", nonce }, nonce)).toBeNull();
		expect(rejectedSaveAction("text", nonce)).toBeNull();
		expect(rejectedSaveAction(null, nonce)).toBeNull();
	});
});

describe("deliverWithConfirmation", () => {
	const run = (results: Array<{ ok: boolean; error?: string } | Error>) => {
		const notified: SaveOutcome[] = [];
		const retries: Array<() => void> = [];
		let index = 0;
		const started = deliverWithConfirmation({
			send: async () => {
				const next = results[index++];
				if (next instanceof Error) throw next;
				return next;
			},
			notify: (outcome) => notified.push(outcome),
			retryLater: (again) => retries.push(again),
		});
		return { notified, retries, started };
	};

	test("confirms once when the worker stores the save", async () => {
		const h = run([{ ok: true }]);
		await h.started;
		expect(h.notified).toEqual(["stored"]);
		expect(h.retries.length).toBe(0);
	});

	test("a worker restart stays silent if the retry succeeds", async () => {
		const h = run([new Error("worker restarting"), { ok: true }]);
		await h.started;
		expect(h.notified).toEqual([]);
		h.retries[0]?.();
		await Bun.sleep(0);
		expect(h.notified).toEqual(["stored"]);
	});

	test("reports failure on the second miss, keeps retrying, and corrects itself", async () => {
		const h = run([new Error("down"), new Error("down"), new Error("down"), { ok: true }]);
		await h.started;
		for (let i = 0; i < 3; i++) {
			h.retries[i]?.();
			await Bun.sleep(0);
		}
		expect(h.notified).toEqual(["failed", "stored"]);
	});

	test("says the extension is disconnected straight away", async () => {
		const h = run([{ ok: false, error: "connect to Anansi before capturing" }, { ok: true }]);
		await h.started;
		expect(h.notified).toEqual(["disconnected"]);
		h.retries[0]?.();
		await Bun.sleep(0);
		expect(h.notified).toEqual(["disconnected", "stored"]);
	});
});
