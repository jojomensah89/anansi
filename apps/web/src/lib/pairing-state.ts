export type PairingClient = {id:string;revokedAt:number|null;lastUse:number|null};
export function pairingState(clients:PairingClient[], id:string|undefined, seconds:number) {
 const row=clients.find(c=>c.id===id);
 if (row?.revokedAt != null && row.lastUse != null) return "redeemed";
 if (seconds <= 0) return "expired";
 return "waiting";
}
export async function dismissPairing(reveal:{pairing:boolean;id?:string}, revoke:(id:string)=>Promise<unknown>) {
 if (reveal.pairing && reveal.id) await revoke(reveal.id);
}
