'use client';

/**
 * The small marker in every list row and every detail header, so a person can see
 * at a glance who else is looking at a thing without opening anything.
 *
 * A collection badge shows the collection's own name when the caller knows it
 * ("Sammlung Marketing"), and the generic word when it does not — never an id.
 */

// React 19 removed the global `JSX` namespace; the type comes from 'react'
// instead, which the React 18.3 types export as well. A type-only import, so
// the same file compiles in every product.
import type { JSX } from 'react';
import { Building2, Lock, Users, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/share-primitives/Badge';
import type { Visibility } from './types';

export interface VisibilityBadgeProps {
  visibility: Visibility;
  collectionName?: string | null;
  size?: 'sm' | 'md';
}

const icons: Record<Visibility, LucideIcon> = {
  private: Lock,
  collection: Users,
  organisation: Building2,
};

export function VisibilityBadge({
  visibility,
  collectionName,
  size = 'sm',
}: VisibilityBadgeProps): JSX.Element {
  const t = useTranslations('share');
  const Icon = icons[visibility];

  const label =
    visibility === 'collection' && collectionName
      ? t('badge.collectionNamed', { name: collectionName })
      : t(`badge.${visibility}`);

  return (
    <Badge variant={visibility === 'organisation' ? 'primary' : 'neutral'} size={size}>
      <Icon className={size === 'md' ? 'h-4 w-4' : 'h-3 w-3'} aria-hidden="true" />
      <span>{label}</span>
    </Badge>
  );
}
