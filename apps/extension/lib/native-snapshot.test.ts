import { expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { completeNativeItem, createNativeSnapshotCache, nativeItemFromDocument, nativeItemsFromPayload } from "./native-snapshot.ts";

test("X provider object produces a full snapshot and rejects truncated content", () => {
	const tweet = { rest_id: "123", legacy: { full_text: "Complete post text" }, core: { user_results: { result: { legacy: { screen_name: "alice", name: "Alice" } } } } };
	expect(nativeItemsFromPayload("x", { data: { tweet } }, 100)[0]).toMatchObject({ externalId: "123", body: "Complete post text", authorHandle: "alice" });
	expect(nativeItemsFromPayload("x", { ...tweet, legacy: { ...tweet.legacy, truncated: true } }, 100)).toEqual([]);
	expect(nativeItemsFromPayload("x", { ...tweet, legacy: { ...tweet.legacy, truncated: true }, note_tweet: { note_tweet_results: { result: {} } } }, 100)).toEqual([]);
	expect(nativeItemsFromPayload("x", {
		...tweet,
		legacy: { ...tweet.legacy, truncated: true },
		note_tweet: { note_tweet_results: { result: { text: "Complete long post text" } } },
	}, 100)[0]).toMatchObject({ externalId: "123", body: "Complete long post text" });
});

test("X snapshots discard provider payload metadata after normalizing the text", () => {
	const tweet = {
		rest_id: "123",
		legacy: { full_text: "Full text with an emoji 😄", authorization: "provider-secret", entities: { urls: [] } },
		privateProviderMetadata: { cookie: "provider-cookie" },
	};
	const [snapshot] = nativeItemsFromPayload("x", { data: { tweet } }, 100);
	expect(snapshot?.body).toBe("Full text with an emoji 😄");
	expect(snapshot?.raw).not.toHaveProperty("tweet");
	expect(JSON.stringify(snapshot?.raw)).not.toContain("provider-secret");
	expect(JSON.stringify(snapshot?.raw)).not.toContain("provider-cookie");
});

test("X retweet snapshots keep the outer identity only when provider data proves the subject URL", () => {
	const tweet = {
		rest_id: "124",
		legacy: {
			full_text: "Retweeted post",
			retweeted_status_result: { result: { rest_id: "123", legacy: { full_text: "Original post" } } },
		},
		core: { user_results: { result: { legacy: { screen_name: "alice", name: "Alice" } } } },
	};
	const [snapshot] = nativeItemsFromPayload("x", tweet, 100);
	expect(snapshot).toMatchObject({ externalId: "124", url: "https://x.com/i/status/123", body: "Original post", raw: { nativeIdentity: { outerId: "124", subjectId: "123" } } });
	expect(snapshot?.raw).not.toHaveProperty("tweet");
	expect(completeNativeItem({ ...snapshot!, url: "https://x.com/alice/status/456" })).toBe(false);

	const noProviderProof = { ...snapshot!, raw: { ...snapshot!.raw as object, nativeIdentity: { outerId: "124", subjectId: "456" } } };
	expect(completeNativeItem(noProviderProof)).toBe(false);
});

test("native snapshots reject an external ID that disagrees with the canonical URL", () => {
	const [item] = nativeItemsFromPayload("x", {
		rest_id: "123",
		legacy: { full_text: "Complete post text" },
		core: { user_results: { result: { legacy: { screen_name: "alice", name: "Alice" } } } },
	}, 100);
	expect(item).toBeDefined();
	expect(completeNativeItem({ ...item!, url: "https://x.com/alice/status/456" })).toBe(false);
});

test("visible X snapshots require matching identity and reject show-more posts", () => {
	const { document } = parseHTML('<article><a href="https://x.com/alice/status/123"><time></time></a><div data-testid="tweetText">Complete text</div></article>');
	expect(nativeItemFromDocument("x", "123", document, 100)?.body).toBe("Complete text");
	expect(nativeItemFromDocument("x", "456", document, 100)).toBeUndefined();
	const more = document.createElement("button"); more.setAttribute("data-testid", "tweet-text-show-more-link"); document.querySelector("article")!.appendChild(more);
	expect(nativeItemFromDocument("x", "123", document, 100)).toBeUndefined();
});

test("visible X text keeps emoji image alt text and line breaks", () => {
	const { document } = parseHTML('<article><a href="https://x.com/alice/status/123"><time></time></a><div data-testid="tweetText">Hello <img alt="😄" src="emoji.png"><br>world</div></article>');
	expect(nativeItemFromDocument("x", "123", document, 100)?.body).toBe("Hello 😄\nworld");
});

test("TikTok and Reddit observed objects normalize without another network request", () => {
	expect(nativeItemsFromPayload("tiktok", { itemInfo: { itemStruct: { id: "123", desc: "Video caption", author: { uniqueId: "alice" }, video: { cover: "https://example.com/image.jpg" } } } }, 100)[0]?.body).toBe("Video caption");
	const [reddit] = nativeItemsFromPayload("reddit", { kind: "t3", data: { name: "t3_abc", title: "Post title", selftext: "Full body", permalink: "/r/test/comments/abc/post/", author: "alice" } }, 100);
	expect(reddit?.externalId).toBe("t3_abc");
	expect(reddit?.raw).toEqual({});
	expect(nativeItemsFromPayload("tiktok", { itemInfo: { itemStruct: { id: "123", desc: "Video caption", author: { uniqueId: "alice" }, video: { cover: "https://example.com/image.jpg" } } } }, 100)[0]?.raw).toEqual({});
});

test("Reddit post and comment snapshots match the fullname encoded by their permalink", () => {
	const [post] = nativeItemsFromPayload("reddit", { kind: "t3", data: {
		name: "t3_abc", title: "Post title", selftext: "Full body", permalink: "/r/test/comments/abc/post/", author: "alice",
	} }, 100);
	expect(post && completeNativeItem(post)).toBe(true);
	expect(post && completeNativeItem({ ...post, url: "https://www.reddit.com/r/test/comments/other/post/" })).toBe(false);

	const [comment] = nativeItemsFromPayload("reddit", { kind: "t1", data: {
		name: "t1_def", link_title: "Thread title", body: "Comment body", permalink: "/r/test/comments/abc/post/def/", author: "alice",
	} }, 100);
	expect(comment).toMatchObject({ externalId: "t1_def", url: "https://www.reddit.com/r/test/comments/abc/post/def/" });
	expect(comment && completeNativeItem(comment)).toBe(true);
	expect(comment && completeNativeItem({ ...comment, url: "https://www.reddit.com/r/test/comments/abc/post/other/" })).toBe(false);
});

test("visible Reddit cards accept fullname and legacy DOM IDs, with canonical Reddit permalinks", () => {
	const { document } = parseHTML('<shreddit-post id="abc" post-id="t3_abc" post-title="Post title" permalink="/r/test/comments/abc/post/" author="alice"><div slot="text-body">Visible body</div></shreddit-post>');
	expect(nativeItemFromDocument("reddit", "t3_abc", document, 100)).toMatchObject({
		externalId: "t3_abc", url: "https://www.reddit.com/r/test/comments/abc/post/", title: "Post title", body: "Visible body",
	});
	expect(nativeItemFromDocument("reddit", "t3_other", document, 100)).toBeUndefined();

	const { document: legacy } = parseHTML('<div class="thing" id="thing_t1_def" data-fullname="t1_def"><a class="title">Thread title</a><div class="usertext-body">Comment body</div><a class="comments" href="/r/test/comments/abc/post/def/"></a></div>');
	expect(nativeItemFromDocument("reddit", "t1_def", legacy, 100)).toMatchObject({ externalId: "t1_def", url: "https://www.reddit.com/r/test/comments/abc/post/def/" });
});

test("Reddit click snapshots use a validated full-name id and preserve structured post text", () => {
	const fullname = "t3_1uozn97";
	const permalink = "/r/google_antigravity/comments/1uozn97/what_does_your_antigravity_setup_look_like/";
	const { document, window } = parseHTML(`<shreddit-post id="${fullname}" permalink="${permalink}" content-href="https://www.reddit.com${permalink}" post-title="What does your Antigravity setup look like?" post-type="text" author="Arnoooodles" show-full-content><div slot="text-body"><p>My setup is centered around a clean desk and a reliable workstation.</p><p>These are the parts I use every day:</p><ul><li>A compact mechanical keyboard</li><li>Two monitors on an adjustable arm</li></ul></div><button class="save-control">Save</button></shreddit-post>`);
	const root = document.querySelector("shreddit-post")!;
	const saveControl = root.querySelector(".save-control")!;
	const priorDocument = globalThis.document;
	const priorWindow = globalThis.window;
	const priorElement = globalThis.Element;
	Object.defineProperty(globalThis, "document", { configurable: true, value: document });
	Object.defineProperty(globalThis, "window", { configurable: true, value: window });
	Object.defineProperty(globalThis, "Element", { configurable: true, value: window.Element });
	try {
		const snapshots = createNativeSnapshotCache("reddit");
		saveControl.dispatchEvent(new window.Event("click", { bubbles: true }));
		root.remove();
		expect(snapshots.get(fullname)).toMatchObject({
			externalId: fullname,
			url: `https://www.reddit.com${permalink}`,
			title: "What does your Antigravity setup look like?",
			authorHandle: "Arnoooodles",
			body: "My setup is centered around a clean desk and a reliable workstation.\n\nThese are the parts I use every day:\n\n• A compact mechanical keyboard\n• Two monitors on an adjustable arm",
		});
	} finally {
		if (priorDocument) Object.defineProperty(globalThis, "document", { configurable: true, value: priorDocument });
		else Reflect.deleteProperty(globalThis, "document");
		if (priorWindow) Object.defineProperty(globalThis, "window", { configurable: true, value: priorWindow });
		else Reflect.deleteProperty(globalThis, "window");
		if (priorElement) Object.defineProperty(globalThis, "Element", { configurable: true, value: priorElement });
		else Reflect.deleteProperty(globalThis, "Element");
	}

	const { document: unrelated } = parseHTML(`<shreddit-post id="t3_unrelated" permalink="${permalink}" post-title="Unrelated card" post-type="text" author="alice"><div slot="text-body"><p>Unrelated body</p></div></shreddit-post>`);
	expect(nativeItemFromDocument("reddit", fullname, unrelated, 100)).toBeUndefined();
	const { document: mismatchedPermalink } = parseHTML(`<shreddit-post id="${fullname}" permalink="/r/google_antigravity/comments/other/post/" post-title="Mismatched card" post-type="text" author="alice"><div slot="text-body"><p>Wrong permalink</p></div></shreddit-post>`);
	expect(nativeItemFromDocument("reddit", fullname, mismatchedPermalink, 100)).toBeUndefined();
});

test("TikTok hydration scripts provide a bounded snapshot without a visible video anchor", () => {
	const itemStruct = { id: "7684204107338485013", desc: "What are your thoughts? #metaads #businessowners #paidads", author: { uniqueId: "bynr" }, video: { cover: "https://example.com/cover.jpg" } };
	for (const [scriptId, payload] of [
		["__UNIVERSAL_DATA_FOR_REHYDRATION__", { __DEFAULT_SCOPE__: { "webapp.video-detail": { itemInfo: { itemStruct } } } }],
		["SIGI_STATE", { ItemModule: { [itemStruct.id]: itemStruct } }],
	] as const) {
		const { document } = parseHTML(`<main>Feed without an item anchor</main><script id="${scriptId}" type="application/json">${JSON.stringify(payload)}</script>`);
		expect(nativeItemFromDocument("tiktok", itemStruct.id, document, 100)).toMatchObject({
			externalId: itemStruct.id,
			url: "https://www.tiktok.com/@bynr/video/7684204107338485013",
			body: "What are your thoughts? #metaads #businessowners #paidads",
			raw: {},
		});
	}
});

test("TikTok hydration scripts over the payload bound are ignored", () => {
	const { document } = parseHTML(`<script id="SIGI_STATE" type="application/json">${" ".repeat(2_000_001)}</script>`);
	expect(nativeItemFromDocument("tiktok", "123", document, 100)).toBeUndefined();
});

test("GitHub visible card snapshots preserve repository identity and description", () => {
	const { document } = parseHTML('<article><a href="https://github.com/alice/repo">alice/repo</a><p class="f4">A complete repository description that must survive the DOM fallback.</p></article>');
	expect(nativeItemFromDocument("github", "alice/repo", document, 100)).toMatchObject({ title: "alice/repo", body: "A complete repository description that must survive the DOM fallback.", kind: "repo" });
	const { document: relative } = parseHTML('<article><a href="/alice/repo">alice/repo</a><p class="f4">Relative repository card</p></article>');
	expect(nativeItemFromDocument("github", "alice/repo", relative, 100)).toMatchObject({ url: "https://github.com/alice/repo", body: "Relative repository card" });
});

test("GitHub DOM snapshots require a matching repository link from github.com", () => {
	const { document } = parseHTML('<article><a href="https://example.com/alice/repo">alice/repo</a><p class="f4">Useful project</p></article>');
	expect(nativeItemFromDocument("github", "alice/repo", document, 100)).toBeUndefined();
});

test("GitHub visible snapshots require a recognized description field, including when empty", () => {
	const { document: unrecognized } = parseHTML('<article><a href="https://github.com/alice/repo">alice/repo</a><p>Useful project</p></article>');
	expect(nativeItemFromDocument("github", "alice/repo", unrecognized, 100)).toBeUndefined();

	const { document: empty } = parseHTML('<article><a href="https://github.com/alice/repo">alice/repo</a><p itemprop="description"></p></article>');
	expect(nativeItemFromDocument("github", "alice/repo", empty, 100)).toMatchObject({ title: "alice/repo", body: "", kind: "repo" });
});
