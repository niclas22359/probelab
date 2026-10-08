/**
 * Which containers may the share dialog offer right now?
 *
 * Deliberately a PURE function in a file of its own, without `'use client'`, and
 * not a few lines inside `VisibilityPicker.tsx`: this decision is the one worth
 * testing without rendering anything, and server code may want to ask the same
 * question. The component only draws what comes out of here.
 *
 * The case that needed an answer (access model round 5, "F10"): the
 * organisation has switched "Nur ich" off, and the object ALREADY is private.
 * Showing the blocked row "Nur ich" there would not be information, it would be
 * a reproach — the person chose that container while it was still allowed. So in
 * exactly this case the row disappears, and ONE sentence takes its place that
 * says what to do now.
 *
 * And a sentence that points at two closed doors is no help: if there is no
 * collection yet and this person may not share with the whole organisation
 * either, both offered rows would be blocked. That is what `personalOffNoWayOut`
 * and a second sentence are for — not "choose something", but "ask someone who
 * can change it".
 *
 * All of this is courtesy, not a lock. The bolt sits in the product's save
 * route, which refuses a forbidden visibility even when it is sent without this
 * dialog. And what is switched off is the CONTAINER, not the work: the owner
 * keeps editing the content of their private object as before.
 */

import type { Visibility } from './types';

export interface VisibilityOption {
  visibility: Visibility;
  /** true → shown, but not accepted; `reasonKey` says why. */
  blocked: boolean;
  /** Key below `share.*`, e.g. `picker.privateBlocked`. */
  reasonKey: string;
}

export interface VisibilityOptionsInput {
  /** false → "Nur ich" is switched off for this product. */
  personalAllowed: boolean;
  /** false → "Die ganze Organisation" is reserved for the organisation's admins. */
  membersMayShareOrg: boolean;
  isOrgAdmin: boolean;
  /** false → there is no collection yet that the object could go into. */
  hasCollections: boolean;
  /** The container the object lives in TODAY. */
  current: Visibility;
}

export interface VisibilityOptions {
  options: VisibilityOption[];
  /**
   * true → "Nur ich" is switched off AND the object already lives there. The
   * component then shows `share.picker.personalOffExisting` instead of the row.
   */
  personalOffForExisting: boolean;
  /**
   * true → the sentence above would point at a door that is closed as well:
   * "Nur ich" is switched off, there is no collection AND this person may not
   * share with the whole organisation. Both offered rows are blocked then, and
   * "choose a collection or the whole organisation" would lead nowhere. The
   * component shows `share.picker.personalOffNoWayOut` in that case, the only
   * sentence that is true there: ask someone who can change it.
   */
  personalOffNoWayOut: boolean;
}

export function visibilityOptions(
  input: VisibilityOptionsInput,
): VisibilityOptions {
  const personalOffForExisting =
    !input.personalAllowed && input.current === 'private';

  const options: VisibilityOption[] = [];
  if (!personalOffForExisting) {
    options.push({
      visibility: 'private',
      blocked: !input.personalAllowed,
      reasonKey: 'picker.privateBlocked',
    });
  }
  options.push({
    visibility: 'collection',
    blocked: !input.hasCollections,
    reasonKey: 'picker.collectionBlocked',
  });
  options.push({
    visibility: 'organisation',
    blocked: !input.membersMayShareOrg && !input.isOrgAdmin,
    reasonKey: 'picker.organisationBlocked',
  });

  const personalOffNoWayOut =
    personalOffForExisting &&
    options.every((option) => option.blocked);

  return { options, personalOffForExisting, personalOffNoWayOut };
}
