import { test, expect } from "bun:test";
import { connectLibrary } from "./library-connect.ts";
const message = {
  anansi: "library-connect",
  messageVersion: 1,
  code: "anansi_" + "a".repeat(43),
};
const context = {
  senderUrl: "https://library.test/settings",
  origin: "https://library.test",
  frameId: 0,
};
for (const [name, ctx, msg] of [
  ["wrong origin", { ...context, senderUrl: "https://other.test" }, message],
  ["sub-frame", { ...context, frameId: 1 }, message],
  ["malformed", context, { ...message, code: "bad" }],
  ["extra key", context, { ...message, key: "secret" }],
] as const)
  test(name, async () => {
    let called = false;
    expect(
      await connectLibrary(msg, ctx, async () => {
        called = true;
      }),
    ).toEqual({ ok: false });
    expect(called).toBe(false);
  });
test("key never returned even when adapter returns it", async () => {
  const result = await connectLibrary(message, context, async () => {
    return { key: "never-expose" } as never;
  });
  expect(result).toEqual({ ok: true });
  expect(JSON.stringify(result)).not.toContain("never-expose");
});
test("redemption failure is boolean only", async () => {
  expect(
    await connectLibrary(message, context, async () => {
      throw new Error("secret");
    }),
  ).toEqual({ ok: false });
});

test("disconnecting asks the server to retire the key it presents, and a refusal changes nothing",async()=>{
 const {retireOwnConnection}=await import("./library-connect.ts");
 const calls:{url:string;auth:string|null}[]=[];
 await retireOwnConnection({origin:"https://library.test",token:"key"},(async(input:unknown,init?:RequestInit)=>{calls.push({url:String(input),auth:new Headers(init?.headers).get("authorization")});return new Response(null,{status:401});}) as typeof fetch);
 expect(calls).toEqual([{url:"https://library.test/api/extension/retire-self",auth:"Bearer key"}]);
});

test("disconnecting still works when the server can't be reached",async()=>{
 const {retireOwnConnection}=await import("./library-connect.ts");
 await retireOwnConnection({origin:"https://library.test",token:"key"},(async()=>{throw new Error("offline");}) as unknown as typeof fetch);
});

test("failed new-key verification never retires the previous key",async()=>{
 const {retirePreviousConnection}=await import("./library-connect.ts");
 const paths:string[]=[];
 await retirePreviousConnection({origin:"https://new.test",token:"new"},{origin:"https://old.test",token:"old"},(async(input:unknown)=>{paths.push(String(input));return new Response(null,{status:401});}) as typeof fetch);
 expect(paths).toEqual(["https://new.test/api/extension/config"]);
});
