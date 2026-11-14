import { expect, test } from "bun:test";
import { shelfRule } from "../../../../packages/db/src/shelves.ts";
import { describeRule, hasRule } from "./shelves.ts";
for (const rule of [null, {}, {removed:"include"}, {removed:"exclude"}, {archived:true}, {nsfw:true}, {since:0}, {until:200}, {type:["article"]}, {contentType:["repo"]}, {source:"web"}, {query:" foo "}, {media:"invalid"}, {tag:["Design"]}]) {
 test(`server and browser agree: ${JSON.stringify(rule)}`, () => {
  expect(hasRule(rule as never)).toBe(shelfRule(rule) !== null);
  expect(describeRule(rule as never).length > 0).toBe(shelfRule(rule) !== null);
 });
}
