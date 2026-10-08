/**
 * The access-model vocabulary, shared by the three building blocks.
 *
 * This folder is generated from beyondles-ai/beyondles-shared and copied into
 * every product by the sync (see share-ui/HOST-CONTRACT.md there), so nothing in
 * here may reach into a product. These four types are the whole contract between
 * a product's own data and the share user interface:
 *
 *   - `Visibility` is the container an object lives in. Every top-level object in
 *     every product carries `owner_user_id`, `visibility` and `collection_id` in
 *     the product's own database — the platform stores who may see what, never
 *     the object itself.
 *   - `CollectionRef` is a group of people (de "Sammlung"), held once on the
 *     platform so every product shares into the same "Marketing".
 *   - `Person` is an organisation member as the product knows them.
 *   - `GrantedPerson` is a person who was added to one single object.
 *
 * The wording is fixed and identical in every product:
 * private = "Nur ich" / "Only me", collection = "Eine Sammlung" / "A collection",
 * organisation = "Die ganze Organisation" / "Whole organisation".
 */

import type { ChangeEvent, MouseEvent, ReactNode } from 'react';

export type Visibility = 'private' | 'collection' | 'organisation';

export interface CollectionRef {
  id: string;
  name: string;
}

export interface Person {
  userId: string;
  name: string;
  email: string;
}

export interface GrantedPerson extends Person {
  level: 'view' | 'edit';
}

/**
 * The four primitives every host provides at
 * `@/components/ui/share-primitives/{Badge,Button,Card,Input}`.
 *
 * Each interface lists exactly the props the building blocks pass, no more. A
 * host component may accept more (its own variants, every HTML attribute); it
 * must accept at least these. Typing an adapter as
 * `function Button(props: ShareButtonProps)` makes the compiler say so when a
 * later version of the blocks starts passing something new.
 */
export interface ShareBadgeProps {
  /** `primary` for the whole organisation, `neutral` for the other two containers. */
  variant?: 'primary' | 'neutral';
  size?: 'sm' | 'md';
  children?: ReactNode;
}

export interface ShareButtonProps {
  /** Always passed as `"button"`. The dialog also lives inside creation forms. */
  type?: 'button' | 'submit' | 'reset';
  variant?: 'primary' | 'secondary' | 'danger';
  /** Absent means the host's regular size. */
  size?: 'sm';
  /** true → the button shows that it is working and cannot be clicked. */
  isLoading?: boolean;
  disabled?: boolean;
  className?: string;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  children?: ReactNode;
}

export interface ShareCardProps {
  variant?: 'elevated';
  /** `none` → the blocks bring their own padding through `className`. */
  padding?: 'none';
  className?: string;
  children?: ReactNode;
}

export interface ShareInputProps {
  /** Visible label, programmatically tied to the field. */
  label?: string;
  /** Decoration inside the field, before the text. */
  icon?: ReactNode;
  value?: string;
  placeholder?: string;
  disabled?: boolean;
  autoComplete?: string;
  onChange?: (event: ChangeEvent<HTMLInputElement>) => void;
}
