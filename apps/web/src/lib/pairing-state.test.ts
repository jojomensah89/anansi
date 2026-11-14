import {expect,test} from "bun:test";
import {pairingState,dismissPairing} from "./pairing-state.ts";
test("watches only the issued pairing and distinguishes dismissal",()=>{
 expect(pairingState([{id:"other",revokedAt:1,lastUse:1}],"own",30)).toBe("waiting");
 expect(pairingState([{id:"own",revokedAt:1,lastUse:null}],"own",30)).toBe("waiting");
 expect(pairingState([{id:"own",revokedAt:1,lastUse:1}],"own",30)).toBe("redeemed");
 expect(pairingState([],"own",0)).toBe("expired");
});
test("dismiss revokes pairing only and preserves ordinary key reveal",async()=>{
 const ids:string[]=[];const revoke=async(id:string)=>{ids.push(id);};
 await dismissPairing({pairing:true,id:"own"},revoke);
 await dismissPairing({pairing:false,id:"api"},revoke);
 expect(ids).toEqual(["own"]);
});
