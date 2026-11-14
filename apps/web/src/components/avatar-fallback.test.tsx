import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { installDom } from "../lib/test-dom.ts";
import { Avatar, avatarTintFor } from "./avatar.tsx";

const EXPIRED = "https://p16-sign-va.tiktokcdn.com/tos-maliva-avt-0068/expired.jpeg?x-expires=1";

test("an avatar that fails to load falls back to the initial without showing a broken image", async () => {
	const { window, restore } = installDom();
	const root = createRoot(document.getElementById("root")!);
	try {
		await act(async () => root.render(<Avatar src={EXPIRED} seed="@jimmy" size={40} />));
		const shell = document.querySelector("[data-avatar]") as HTMLElement;
		const img = shell.querySelector("img") as HTMLImageElement;
		// While the request is in flight the image exists but is invisible,
		// so a failure can never flash the browser's broken-image glyph.
		expect(shell.dataset.avatar).toBe("loading");
		expect(img.style.opacity).toBe("0");

		await act(async () => img.dispatchEvent(new window.Event("error")));

		expect(shell.dataset.avatar).toBe("initial");
		expect(shell.querySelector("img")).toBeNull();
		expect(shell.textContent).toBe("j");
		expect(shell.style.background).not.toBe("");
		expect(avatarTintFor("jimmy")).toMatch(/^#/);
	} finally {
		await act(async () => root.unmount());
		restore();
	}
});

test("an avatar that loads is shown, and a new URL gets a fresh attempt", async () => {
	const { window, restore } = installDom();
	const root = createRoot(document.getElementById("root")!);
	try {
		await act(async () => root.render(<Avatar src={EXPIRED} seed="jimmy" size={40} />));
		await act(async () => document.querySelector("img")!.dispatchEvent(new window.Event("error")));
		expect(document.querySelector("img")).toBeNull();

		const fresh = "https://pbs.twimg.com/profile_images/1/fresh.jpg";
		await act(async () => root.render(<Avatar src={fresh} seed="jimmy" size={40} />));
		const img = document.querySelector("img") as HTMLImageElement;
		expect(img.getAttribute("src")).toBe(fresh);
		await act(async () => img.dispatchEvent(new window.Event("load")));
		expect((document.querySelector("[data-avatar]") as HTMLElement).dataset.avatar).toBe("loaded");
		expect(img.style.opacity).toBe("1");
	} finally {
		await act(async () => root.unmount());
		restore();
	}
});
