'use client';

/**
 * "Wer noch?" — search a name, click it, it is added. Used twice: inside the
 * share dialog (with a view/edit level per person) and in Verwaltung › Sammlungen
 * (without levels, because a collection member is simply a member).
 *
 * The component holds no data of its own beyond the search text. Everything else
 * comes in through props and goes out through callbacks, so the same file works
 * against a Suite API route, a Lab's own store or a test double.
 */

// React 19 removed the global `JSX` namespace; the type comes from 'react'
// instead, which the React 18.3 types export as well. A type-only import, so
// the same file compiles in every product.
import type { JSX } from 'react';
import { useState } from 'react';
import { Search, UserPlus, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/share-primitives/Input';
import { cx } from './cx';
import type { GrantedPerson, Person } from './types';

/** How many candidates are offered before the person is asked to narrow the search. */
const MAX_CANDIDATES = 8;

/** `selected` may or may not carry levels; a person without one is a viewer. */
function levelOf(person: Person | GrantedPerson): 'view' | 'edit' {
  return 'level' in person ? person.level : 'view';
}

export interface PeoplePickerProps {
  /** everyone who may be picked (org members) */
  members: Person[];
  selected: Person[] | GrantedPerson[];
  onAdd(p: Person, level?: 'view' | 'edit'): void;
  onRemove(userId: string): void;
  /** present → show the view/edit select */
  onLevelChange?(userId: string, level: 'view' | 'edit'): void;
  /** e.g. the owner */
  excludeUserIds?: string[];
  disabled?: boolean;
}

export function PeoplePicker({
  members,
  selected,
  onAdd,
  onRemove,
  onLevelChange,
  excludeUserIds = [],
  disabled = false,
}: PeoplePickerProps): JSX.Element {
  const t = useTranslations('share');
  const [query, setQuery] = useState('');

  const chosen: Array<Person | GrantedPerson> = selected;
  const chosenIds = new Set(chosen.map((person) => person.userId));
  const excluded = new Set(excludeUserIds);

  const needle = query.trim().toLowerCase();
  const candidates = members.filter((member) => {
    if (chosenIds.has(member.userId) || excluded.has(member.userId)) return false;
    if (needle === '') return true;
    return (
      member.name.toLowerCase().includes(needle) || member.email.toLowerCase().includes(needle)
    );
  });
  const offered = candidates.slice(0, MAX_CANDIDATES);
  const hidden = candidates.length - offered.length;

  return (
    <div className="space-y-3">
      <Input
        label={t('people.searchLabel')}
        placeholder={t('people.searchPlaceholder')}
        value={query}
        disabled={disabled}
        autoComplete="off"
        icon={<Search className="h-4 w-4" aria-hidden="true" />}
        onChange={(event) => setQuery(event.target.value)}
      />

      {offered.length === 0 ? (
        <p className="text-xs text-content-tertiary">{t('people.noMatches')}</p>
      ) : (
        <ul className="max-h-44 divide-y divide-black/5 overflow-y-auto rounded-lg border border-black/10 bg-white">
          {offered.map((member) => (
            <li key={member.userId}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  if (disabled) return;
                  if (onLevelChange) onAdd(member, 'view');
                  else onAdd(member);
                }}
                className={cx(
                  'flex w-full items-center gap-2 px-3 py-2 text-left transition-colors',
                  'hover:bg-surface-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40',
                  'disabled:cursor-not-allowed disabled:opacity-50'
                )}
              >
                <UserPlus className="h-4 w-4 flex-shrink-0 text-content-tertiary" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block truncate text-sm text-content-primary">{member.name}</span>
                  <span className="block truncate text-xs text-content-tertiary">{member.email}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {hidden > 0 && (
        <p className="text-xs text-content-tertiary">{t('people.moreHint', { count: hidden })}</p>
      )}

      <div>
        <p className="mb-2 text-sm font-medium text-content-secondary">
          {t('people.selectedHeading')}
        </p>
        {chosen.length === 0 ? (
          <p className="text-xs text-content-tertiary">{t('people.empty')}</p>
        ) : (
          <ul className="space-y-2">
            {chosen.map((person) => {
              const level = levelOf(person);
              return (
                <li
                  key={person.userId}
                  className="flex items-center gap-2 rounded-lg border border-black/5 bg-surface-secondary px-3 py-2"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-content-primary">
                      {person.name}
                    </span>
                    <span className="block truncate text-xs text-content-tertiary">
                      {person.email}
                    </span>
                  </span>

                  {onLevelChange && (
                    <select
                      aria-label={t('people.levelLabel', { name: person.name })}
                      value={level}
                      disabled={disabled}
                      onChange={(event) => {
                        if (disabled) return;
                        onLevelChange(
                          person.userId,
                          event.target.value === 'edit' ? 'edit' : 'view'
                        );
                      }}
                      className="rounded-lg border border-black/10 bg-white px-2 py-1 text-xs text-content-primary focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <option value="view">{t('people.levelView')}</option>
                      <option value="edit">{t('people.levelEdit')}</option>
                    </select>
                  )}

                  <button
                    type="button"
                    aria-label={t('people.remove', { name: person.name })}
                    disabled={disabled}
                    onClick={() => {
                      if (disabled) return;
                      onRemove(person.userId);
                    }}
                    className={cx(
                      'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-content-tertiary transition-colors',
                      'hover:bg-white hover:text-red-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                      'disabled:cursor-not-allowed disabled:opacity-50'
                    )}
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
