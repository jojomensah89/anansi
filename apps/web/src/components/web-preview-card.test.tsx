import {test,expect} from "bun:test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {WebPreviewCard} from "./web-preview-card.tsx";
import type {ItemRow} from "../lib/api.ts";
const item = {id:"web-1",source:"web",title:"A useful page",url:"https://example.com/article",excerpt:"A useful description",media:[]} as unknown as ItemRow;
test("web image card is lazy and uses stored media",()=>{const s=renderToStaticMarkup(createElement(WebPreviewCard,{item:{...item,media:[{key:"aa/bb/cover.png",kind:"card",url:"https://example.com/cover.png"}]}}));expect(s).toContain("/api/media/aa/bb/cover.png");expect(s).toContain('loading="lazy"');expect(s).toContain("1.91 / 1");expect(s).toContain("A useful description");});
test("web fallback has domain and title without invented media",()=>{const s=renderToStaticMarkup(createElement(WebPreviewCard,{item}));expect(s).toContain("example.com");expect(s).toContain("A useful page");expect(s).not.toContain("<img");});
test("row renders readable title and domain",()=>{const s=renderToStaticMarkup(createElement(WebPreviewCard,{item,compact:true}));expect(s).toContain("example.com");expect(s).toContain("A useful page");});


test("grid and row web footers retain organization, saved date and globe",()=>{
 for(const compact of [false,true]) {
 const s=renderToStaticMarkup(createElement(WebPreviewCard,{item:{...item,savedAt:1794000000},compact,footer:createElement("span",null,"+ Add tags")}));
 expect(s).toContain("data-web-footer");expect(s).toContain("Add tags");expect(s).toContain("Nov");expect(s).toContain("<svg");
 }
});

import { sameText } from "./web-preview-card.tsx";
test("a description that only repeats the title is not shown twice", () => {
  expect(sameText("Stageshow", "Stageshow")).toBe(true);
  expect(sameText("Membership | Jojo Mensah", "Membership  |  jojo mensah")).toBe(true);
  expect(sameText("", "Anything")).toBe(true);
  expect(sameText("A field guide to the city", "A slower way to see the city")).toBe(false);
});
