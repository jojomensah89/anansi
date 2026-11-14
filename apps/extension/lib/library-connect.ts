import { isLibraryConnectCommand } from "./messages.ts";
/** Credential redemption stays in the trusted worker. Its only outward result is a boolean. */
export async function connectLibrary(
  message: unknown,
  context: { senderUrl?: string; origin?: string; frameId?: number },
  redeemAndStore: (code: string) => Promise<void>,
): Promise<{ ok: boolean }> {
  if (
    !isLibraryConnectCommand(
      message,
      context.senderUrl,
      context.origin,
      context.frameId,
    )
  )
    return { ok: false };
  try {
    await redeemAndStore(message.code);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

type Connection = {origin:string;token:string};
const readConfig = (c:Connection, transport:typeof fetch) => transport(`${c.origin}/api/extension/config`,{headers:{authorization:`Bearer ${c.token}`},redirect:"error",signal:AbortSignal.timeout(10000)});

/** Retires a stored extension key using that key. The server refuses any other credential, including the shared token. */
export async function retireOwnConnection(connection: Connection, transport: typeof fetch = fetch) {
 try {
  await transport(`${connection.origin}/api/extension/retire-self`,{method:"POST",headers:{authorization:`Bearer ${connection.token}`},redirect:"error",signal:AbortSignal.timeout(10000)});
 } catch { /* Giving up access must still work when the server can't be reached. */ }
}

/** Best effort cleanup only after a real authenticated check of the saved key. */
export async function retirePreviousConnection(
 current: Connection, previous: Connection | undefined,
 transport: typeof fetch = fetch,
) {
 if (!previous || previous.token === current.token) return;
 try {
  if ((await readConfig(current,transport)).status !== 200) return;
 } catch { return; /* Access to the new connection is independent of retirement. */ }
 await retireOwnConnection(previous,transport);
}
