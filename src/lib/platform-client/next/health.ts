/**
 * platform-client, Next adapter: what `/api/health` says about the access door.
 *
 * One vocabulary for every product (policy P1): `ok`, `local`, `unconfigured`, `off`. The
 * deploy watchers read this field, so it is never a product's own wording.
 *
 *   return NextResponse.json({ status: "ok", service: "leadlab", ...healthAccessField(door()) });
 */

import type { DoorState, HealthAccessField } from "../core/types";

export function healthAccessField(door: { state: DoorState }): HealthAccessField {
  return { access: door.state };
}
