/**
 * The data shapes of the share dialog and the one real calculation in this
 * folder.
 *
 * Deliberately a module WITHOUT `'use client'`: a server route that validates an
 * incoming patch, and a test that runs without a DOM, must be able to import
 * `buildSharePatch` and get the function itself rather than a client reference.
 */

import type { CollectionRef, GrantedPerson, Person, Visibility } from './types';

export interface ShareState {
  visibility: Visibility;
  collectionId: string | null;
  owner: Person;
  collections: CollectionRef[];
  people: GrantedPerson[];
  members: Person[];
  personalAllowed: boolean;
  membersMayShareOrg: boolean;
  isOrgAdmin: boolean;
  /** labels of personal connections the object uses → shown as the honest sentence */
  usesPersonalConnections?: string[];
}

export interface SharePatch {
  visibility?: Visibility;
  collectionId?: string | null;
  add?: { userId: string; level: 'view' | 'edit' }[];
  remove?: string[];
  levels?: { userId: string; level: 'view' | 'edit' }[];
}

/** What the dialog lets the person change — everything else in ShareState is read-only context. */
export interface ShareDraft {
  visibility: Visibility;
  collectionId: string | null;
  people: GrantedPerson[];
}

/**
 * The difference between the loaded state and the edited one, and nothing more.
 * A field that did not move is not in the patch at all, so a product can treat
 * every key it receives as an instruction rather than as a possible no-op.
 *
 * `collectionId` is diffed on its EFFECTIVE value: leaving a collection for
 * "Nur ich" sends `collectionId: null` even though the draft still remembers
 * which collection it was, because that is what actually changed for the object.
 */
export function buildSharePatch(initial: ShareDraft, draft: ShareDraft): SharePatch {
  const patch: SharePatch = {};

  if (draft.visibility !== initial.visibility) {
    patch.visibility = draft.visibility;
  }

  const before = initial.visibility === 'collection' ? initial.collectionId : null;
  const after = draft.visibility === 'collection' ? draft.collectionId : null;
  if (before !== after) {
    patch.collectionId = after;
  }

  const initialById = new Map(initial.people.map((person) => [person.userId, person]));
  const draftById = new Map(draft.people.map((person) => [person.userId, person]));

  const add = draft.people
    .filter((person) => !initialById.has(person.userId))
    .map((person) => ({ userId: person.userId, level: person.level }));
  if (add.length > 0) patch.add = add;

  const remove = initial.people
    .filter((person) => !draftById.has(person.userId))
    .map((person) => person.userId);
  if (remove.length > 0) patch.remove = remove;

  const levels = draft.people
    .filter((person) => {
      const was = initialById.get(person.userId);
      return was !== undefined && was.level !== person.level;
    })
    .map((person) => ({ userId: person.userId, level: person.level }));
  if (levels.length > 0) patch.levels = levels;

  return patch;
}
