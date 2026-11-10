import {test,expect} from "bun:test";
import {renderToStaticMarkup} from "react-dom/server";
import {PhoneActions} from "./phone-actions";
test("phone actions uses the shared sheet trigger",()=>{
 const html=renderToStaticMarkup(<PhoneActions><button>Select items</button></PhoneActions>);
 expect(html).toContain('data-slot="sheet-trigger"');expect(html).toContain('aria-haspopup="dialog"');expect(html).toContain('Actions');expect(html).not.toContain('<details');
});
