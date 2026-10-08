"use client";

import { useState } from "react";

import { VisibilityPicker, type Visibility } from "@/components/share";

/**
 * The "who sees this" part of the note form: the shared picker plus the one
 * hidden field the server action reads (`visibility`, lower case, the same
 * value the old `<select>` posted).
 *
 * What the picker blocks is a courtesy. The server action calls `createNote`,
 * which checks `allowedVisibilities` again, so a forged post is refused there.
 *
 * `collections` is empty on purpose: the example note cannot be stored in a
 * collection yet (its input schema knows `private` and `organisation` only), so
 * the collection row is shown as not available. A Lab that shares by collection
 * passes `access.collections` here and extends the input schema (docs/OFFEN.md).
 */
export function NoteVisibilityField({
  personalAllowed,
  organisationAllowed,
}: {
  /** `allowedVisibilities(access)` includes PRIVATE. */
  personalAllowed: boolean;
  /** `allowedVisibilities(access)` includes ORGANISATION. */
  organisationAllowed: boolean;
}) {
  const [value, setValue] = useState<{
    visibility: Visibility;
    collectionId?: string | null;
  }>({
    visibility:
      personalAllowed || !organisationAllowed ? "private" : "organisation",
    collectionId: null,
  });

  return (
    <div>
      <VisibilityPicker
        value={value}
        onChange={setValue}
        collections={[]}
        personalAllowed={personalAllowed}
        // `allowedVisibilities` already folds in the organisation admins, so
        // the picker does not get a second opinion through `isOrgAdmin`.
        membersMayShareOrg={organisationAllowed}
        isOrgAdmin={false}
      />
      <input type="hidden" name="visibility" value={value.visibility} />
    </div>
  );
}
