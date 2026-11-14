import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Card } from "./card";
import type { ItemRow } from "../lib/api";

for (const source of ["x", "github", "reddit", "tiktok", "web"] as const) {
 test(`capture card preserves ${source} identity and separates selection from avatar`, () => {
 const item = {id:"fixture", source, author:"ama",authorName:"Ama Mensah",title:"A saved reference",excerpt:"Useful saved text",tags:[],media:[],postedAt:1793836800,url:"https://example.invalid/reference"} as unknown as ItemRow;
 const html = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><Card item={item} selectable selected /></QueryClientProvider>);
 expect(html).toContain('aria-pressed="true"');
 expect(html).toContain(source === 'github' ? 'Ama Mensah/' : 'capture-card-identity');
 // GitHub draws its mark in its header; a web save leads with its favicon in the identity slot.
 if(source !== 'github' && source !== 'web') expect(html).toContain('capture-card-source');
 if(source === 'web') { expect(html).toContain('capture-card-site'); expect(html).not.toContain('capture-card-source'); }
 expect(html).toContain('<svg');
 expect(html).toContain('right:12px');
 expect(html).not.toContain('left:9px');
 expect(html).not.toContain('card-footer-source');
 expect(html).toContain('data-slot="checkbox"');
 expect(html).toContain('Ama Mensah');
 });
}

test("github capture card keeps the bold owner/repo title line and the panel URL line", () => {
 const item = {id:"repo",source:"github",author:"ama",authorName:"Ama Mensah",title:"ama/reference",excerpt:"Useful saved text",tags:[],media:[],postedAt:1793836800,url:"https://github.com/ama/reference"} as unknown as ItemRow;
 const html = renderToStaticMarkup(<Card item={item} />);
 const title = html.indexOf('>ama/reference<');
 expect(title).toBeGreaterThan(-1);
 expect(title).toBeLessThan(html.indexOf('Useful saved text'));
 expect(html.slice(0, title)).toMatch(/font-weight:700[^>]*$/);
 expect(html).toContain('github.com/ama/reference');
 expect(html.indexOf('github.com/ama/reference')).toBeGreaterThan(html.indexOf('Useful saved text'));
});

for (const source of ["x", "github", "reddit", "tiktok", "web"] as const) {
 test(`${source} has exactly one footer with date and inline private note`, () => {
 const item={id:"footer",source,title:"Reference",excerpt:"Saved text",url:"https://example.invalid/page",savedAt:1793836800,postedAt:1793836800,tags:[{label:"Design",color:"#ffcc00"}],hasNote:true} as ItemRow;
 const html=renderToStaticMarkup(<Card item={item}/>);
 expect(html.split('class="capture-card-footer"')).toHaveLength(2);
 const footer=html.slice(html.indexOf('<footer'),html.indexOf('</footer>'));
 expect(footer).toContain("Design");expect(footer).toContain("<time>");expect(footer).toContain('aria-label="Open private note"');expect(html).not.toContain("#ffcc0022");
 });
}

test("TikTok video poster exposes a video badge",()=>{
 const item={id:"video",source:"tiktok",excerpt:"Saved clip",media:[{kind:"video_poster",key:"clip.webp"}],tags:[]} as unknown as ItemRow;
 expect(renderToStaticMarkup(<Card item={item}/>)).toContain('aria-label="Video"');
});

test("a card shows its source mark once, with the name only for assistive tech", () => {
 for (const [source, label] of [["tiktok","TikTok"],["reddit","Reddit"],["x","X"]] as const) {
  const item = {id:"once",source,author:"ama",authorName:"Ama Mensah",excerpt:"Saved clip",media:[],tags:[],postedAt:1793836800,url:"https://example.invalid/a"} as unknown as ItemRow;
  const html = renderToStaticMarkup(<Card item={item}/>);
  expect(html.match(new RegExp(`aria-label="${label}"`, "g"))).toHaveLength(1);
  expect(html).not.toContain(`>${label}<`);
  expect(html).not.toContain("favorites");
  expect(html).toContain('aria-label="Add tags"');
  expect(html).not.toContain("+ Add tags");
 }
});
