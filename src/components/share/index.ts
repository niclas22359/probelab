/**
 * The three building blocks of the access model, plus the dialog that puts them
 * together. This folder is generated from beyondles-ai/beyondles-shared: change
 * it there, then run the sync. What a product has to provide is written down in
 * share-ui/HOST-CONTRACT.md of that repo.
 *
 * The pure helpers (`buildSharePatch`, `visibilityOptions`,
 * `createShareEndpoint`) are exported from modules without `'use client'`, so
 * server code and tests may call them through this barrel.
 */

export type {
  CollectionRef,
  GrantedPerson,
  Person,
  ShareBadgeProps,
  ShareButtonProps,
  ShareCardProps,
  ShareInputProps,
  Visibility,
} from './types';
export { VisibilityPicker, type VisibilityPickerProps } from './VisibilityPicker';
export { VisibilityBadge, type VisibilityBadgeProps } from './VisibilityBadge';
export { PeoplePicker, type PeoplePickerProps } from './PeoplePicker';
export { ShareDialog, type ShareDialogProps } from './ShareDialog';
export {
  buildSharePatch,
  type ShareDraft,
  type SharePatch,
  type ShareState,
} from './share-patch';
export {
  visibilityOptions,
  type VisibilityOption,
  type VisibilityOptions,
  type VisibilityOptionsInput,
} from './visibility-options';
export { createShareEndpoint, type ShareEndpoint } from './share-endpoint';
