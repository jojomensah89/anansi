import * as webauthn from "@simplewebauthn/server";
import { describe, expect, test, spyOn } from "bun:test";
import { openLocalDb, migrateLocalDb } from "@anansi/db/local";
import {
	insertPasskey,
	putChallenge,
	consumeChallenge,
	type AnansiDb,
} from "@anansi/db";
import { handleApi } from "./api.ts";
import { sessionCookie, SESSION_TTL } from "./library-auth.ts";
const origin = "https://anansi.test";
function setup() {
	const local = openLocalDb(":memory:");
	migrateLocalDb(local);
	const env = { db: local as unknown as AnansiDb, libraryToken: "recovery" };
	return {
		env,
		req: (path: string, method = "POST", body: unknown = {}, cookie = "") =>
			new Request(origin + "/api/auth/" + path, {
				method,
				headers: { origin, cookie },
				...(method === "GET" || method === "DELETE"
					? {}
					: { body: JSON.stringify(body) }),
			}),
	};
}
const key = (id: string) => ({
	id,
	public_key: "AA",
	counter: 0,
	transports: "[]",
	device_type: "singleDevice" as const,
	backed_up: 0,
	name: "Windows",
	created_at: Date.now(),
	last_used_at: null,
});
describe("passkey server contract", () => {
	test("first registration requires secret at options and verify; second requires cookie session", async () => {
		const { env, req } = setup();
		for (const stage of ["options", "verify"])
			expect(
				(await handleApi(env, req("passkey/register/" + stage))).status,
			).toBe(401);
		const options = await handleApi(
			env,
			req("passkey/register/options", "POST", { secret: "recovery" }),
		);
		expect(options.status).toBe(200);
		const data = await options.json() as any;
		expect(data.authenticatorSelection.residentKey).toBe("required");
		expect(data.user.name).toBe("owner");
		await insertPasskey(env.db, key("one"), true);
		expect(
			(
				await handleApi(
					env,
					req("passkey/register/options", "POST", { secret: "recovery" }),
				)
			).status,
		).toBe(401);
		const cookie = sessionCookie(env, req("session")).split(";")[0]!;
		expect(
			(
				await handleApi(
					env,
					req("passkey/register/options", "POST", {}, cookie),
				)
			).status,
		).toBe(200);
		expect(
			(
				await handleApi(
					env,
					req("passkey/register/verify", "POST", { secret: "recovery" }),
				)
			).status,
		).toBe(401);
	});
	test("last deletion refused, bearer rejected, maximum enforced", async () => {
		const { env, req } = setup();
		await insertPasskey(env.db, key("one"), true);
		const cookie = sessionCookie(env, req("session")).split(";")[0]!;
		expect(
			(await handleApi(env, req("passkeys/one", "DELETE", {}, cookie))).status,
		).toBe(409);
		const bearer = req("passkeys", "GET");
		bearer.headers.set("authorization", "Bearer recovery");
		expect((await handleApi(env, bearer)).status).toBe(401);
		for (let i = 2; i <= 10; i++)
			await insertPasskey(env.db, key(String(i)), true);
		expect((await insertPasskey(env.db, key("11"), true)).length).toBe(0);
		expect(
			(
				await handleApi(
					env,
					req("passkey/register/options", "POST", {}, cookie),
				)
			).status,
		).toBe(409);
		expect(
			(await handleApi(env, req("passkeys/one", "DELETE", {}, cookie))).status,
		).toBe(200);
	});
	test("challenge single use, kind binding, expiry and failed verification consume", async () => {
		const { env, req } = setup();
		await putChallenge(env.db, "a", "challenge", "login");
		expect(await consumeChallenge(env.db, "a", "login")).toBe("challenge");
		expect(await consumeChallenge(env.db, "a", "login")).toBeNull();
		await putChallenge(env.db, "b", "challenge", "register");
		expect(await consumeChallenge(env.db, "b", "login")).toBeNull();
		expect(await consumeChallenge(env.db, "b", "register")).toBeNull();
		await putChallenge(env.db, "c", "challenge", "login");
		const now = Date.now();
		const clock = spyOn(Date, "now").mockReturnValue(now + 300001);
		try {
			expect(await consumeChallenge(env.db, "c", "login")).toBeNull();
		} finally {
			clock.mockRestore();
		}
		await insertPasskey(env.db, key("one"), true);
		await putChallenge(env.db, "d", "challenge", "login");
		expect(
			(
				await handleApi(
					env,
					req(
						"passkey/login/verify",
						"POST",
						{ response: {} },
						"anansi_challenge=d",
					),
				)
			).status,
		).toBe(400);
		expect(await consumeChallenge(env.db, "d", "login")).toBeNull();
	});
	test("sliding renewal only beyond half-life, expired rejected, status hasPasskey", async () => {
		const { env, req } = setup();
		const now = Math.floor(Date.now() / 1000) * 1000;
		const clock = spyOn(Date, "now").mockReturnValue(now);
		try {
			const cookie = sessionCookie(env, req("session")).split(";")[0]!;
			for (const seconds of [0, SESSION_TTL / 2, SESSION_TTL / 2 + 1]) {
				clock.mockReturnValue(now + seconds * 1000);
				const res = await handleApi(env, req("session", "GET", {}, cookie));
				expect(!!res.headers.get("set-cookie")).toBe(seconds > SESSION_TTL / 2);
				expect(await res.json() as any).toEqual({
					configured: true,
					authenticated: true,
					hasPasskey: false,
				});
			}
			await insertPasskey(env.db, key("one"), true);
			expect(
				await (await handleApi(env, req("session", "GET"))).json() as any,
			).toEqual({ configured: true, authenticated: false, hasPasskey: true });
			clock.mockReturnValue(now + SESSION_TTL * 1000);
			expect(
				(await (await handleApi(env, req("session", "GET", {}, cookie))).json() as any)
					.authenticated,
			).toBe(false);
		} finally {
			clock.mockRestore();
		}
	});
	test("discovery options and same-origin/no-store contract", async () => {
		const { env, req } = setup();
		expect(
			await (await handleApi(env, req("passkey/login/options"))).json() as any,
		).toEqual({ error: "no passkeys" });
		await insertPasskey(env.db, key("one"), true);
		const res = await handleApi(env, req("passkey/login/options"));
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect((await res.json() as any).allowCredentials).toEqual([]);
		const cross = req("passkey/login/options");
		cross.headers.set("origin", "https://evil.test");
		expect((await handleApi(env, cross)).status).toBe(403);
	});
});

test("verified registration and login persist credential metadata and issue sessions", async () => {
 const {env,req}=setup();
 const registration=spyOn(webauthn,"verifyRegistrationResponse").mockResolvedValue({verified:true,registrationInfo:{credential:{id:"registered",publicKey:new Uint8Array([1,2]),counter:0,transports:["internal"]},credentialDeviceType:"multiDevice",credentialBackedUp:true}} as Awaited<ReturnType<typeof webauthn.verifyRegistrationResponse>>);
 try {
  await putChallenge(env.db,"register","registration-challenge","register");
  const res=await handleApi(env,req("passkey/register/verify","POST",{secret:"recovery",response:{}},"anansi_challenge=register"));
  expect(res.status).toBe(200);expect(res.headers.getSetCookie().some(c=>c.startsWith("anansi_session="))).toBe(true);
  expect((await res.json() as any).passkey).toMatchObject({id:"registered",name:"Passkey",backedUp:true,lastUsedAt:null});
  expect(registration.mock.calls[0]![0]).toMatchObject({expectedOrigin:origin,expectedRPID:"anansi.test",expectedChallenge:"registration-challenge",requireUserVerification:false});
 }finally {registration.mockRestore();}
 const login=spyOn(webauthn,"verifyAuthenticationResponse").mockResolvedValue({verified:true,authenticationInfo:{newCounter:2,credentialBackedUp:true}} as Awaited<ReturnType<typeof webauthn.verifyAuthenticationResponse>>);
 try {
  await putChallenge(env.db,"login","login-challenge","login");
  const res=await handleApi(env,req("passkey/login/verify","POST",{response:{id:"registered"}},"anansi_challenge=login"));
  expect(res.status).toBe(200);expect(await res.json() as any).toEqual({configured:true,authenticated:true,hasPasskey:true});
  const cookie=res.headers.getSetCookie().find(c=>c.startsWith("anansi_session="))!.split(";")[0]!;
  const listed=await (await handleApi(env,req("passkeys","GET",{},cookie))).json() as any;expect(listed.passkeys[0].lastUsedAt).toBeNumber();
 }finally{login.mockRestore();}
});
