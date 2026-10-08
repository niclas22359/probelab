/**
 * platform-client, Next adapter: the barrel. Three functions, nothing else.
 *
 * `core` has no barrel on purpose (products import its files one by one); the adapter is
 * small enough for one.
 */

export { createNextAccess } from "./access";
export { healthAccessField } from "./health";
export { readPlatformToken } from "./token";
