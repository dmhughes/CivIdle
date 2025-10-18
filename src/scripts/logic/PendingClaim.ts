import type { IPendingClaim } from "../../../shared/utilities/Database";
import { TypedEvent } from "../../../shared/utilities/TypedEvent";
import { client } from "../rpc/RPCClient";

export const PendingClaims: IPendingClaim[] = [];
export const RequestPendingClaimUpdate = new TypedEvent<void>();
export const PendingClaimUpdated = new TypedEvent<void>();

RequestPendingClaimUpdate.on(() => {
   client.getPendingClaims().then((pendingClaims: any) => {
      PendingClaims.length = 0;
      pendingClaims.forEach((pendingClaim: any) => {
         PendingClaims.push(pendingClaim);
      });
      PendingClaimUpdated.emit();
   });
});
