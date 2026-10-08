'use client';

/**
 * "Wer sieht das?" — the one picker every product shows at creation time and
 * inside the share dialog. Three containers, always in the same order and always
 * with the same words, so a person who learned it in one product knows it in all
 * of them.
 *
 * A row that the organisation has closed is not hidden, it is shown blocked with
 * the reason. Hiding it would leave the person guessing why a colleague can do
 * something they cannot. A blocked row keeps its place in the tab order and
 * carries `aria-disabled`, so a keyboard or screen-reader user reaches the reason
 * instead of skipping past a row that silently is not there.
 *
 * One exception, decided in `visibility-options.ts`: an object that already is
 * private while the organisation has switched "Nur ich" off gets one sentence
 * instead of a blocked "Nur ich" row.
 *
 * SECURITY: what this component blocks is a courtesy, not a control. The three
 * columns live in the PRODUCT's own database, so the platform never sees and
 * never rejects a forbidden visibility. Anyone can post `visibility:
 * 'organisation'` straight at the product's save route. The product's save route
 * MUST re-read `personalAllowed` and `membersMayShareOrg` from
 * `GET /api/access/me?product=<key>` and refuse server-side: `personalAllowed:
 * false` → no new private object, `membersMayShareOrg: false` → only org admins
 * may set 'organisation'.
 */

// React 19 removed the global `JSX` namespace; the type comes from 'react'
// instead, which the React 18.3 types export as well. A type-only import, so
// the same file compiles in every product.
import type { JSX } from 'react';
import { Fragment, useId } from 'react';
import { Building2, Lock, Users, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cx } from './cx';
import { visibilityOptions } from './visibility-options';
import type { CollectionRef, Visibility } from './types';

export interface VisibilityPickerProps {
  value: { visibility: Visibility; collectionId?: string | null };
  onChange(v: { visibility: Visibility; collectionId?: string | null }): void;
  collections: CollectionRef[];
  /**
   * false → the "Nur ich" row is disabled and says why. If the object already
   * is private, the row is left out and one sentence explains what to do.
   */
  personalAllowed: boolean;
  /** false → the "Die ganze Organisation" row is disabled and says why, unless isOrgAdmin. */
  membersMayShareOrg: boolean;
  isOrgAdmin: boolean;
  /** default true → the one fixed sentence under the picker. */
  showAdminNote?: boolean;
  disabled?: boolean;
}

interface Row {
  visibility: Visibility;
  Icon: LucideIcon;
  blocked: boolean;
  reason: string;
}

const ICONS: Record<Visibility, LucideIcon> = {
  private: Lock,
  collection: Users,
  organisation: Building2,
};

export function VisibilityPicker({
  value,
  onChange,
  collections,
  personalAllowed,
  membersMayShareOrg,
  isOrgAdmin,
  showAdminNote = true,
  disabled = false,
}: VisibilityPickerProps): JSX.Element {
  const t = useTranslations('share');
  const groupName = useId();
  const selectId = useId();
  const reasonId = useId();

  const currentCollectionId = value.collectionId ?? null;
  const noCollections = collections.length === 0;

  const {
    options,
    personalOffForExisting,
    personalOffNoWayOut,
  } = visibilityOptions({
    personalAllowed,
    membersMayShareOrg,
    isOrgAdmin,
    hasCollections: !noCollections,
    current: value.visibility,
  });

  // The reasons are fetched here with fixed keys, so a missing text shows up
  // when the messages are checked and not only once the dialog is open.
  const reasons: Record<Visibility, string> = {
    private: t('picker.privateBlocked'),
    collection: t('picker.collectionBlocked'),
    organisation: t('picker.organisationBlocked'),
  };

  const rows: Row[] = options.map((option) => ({
    visibility: option.visibility,
    Icon: ICONS[option.visibility],
    blocked: option.blocked,
    reason: reasons[option.visibility],
  }));

  // This guard, not the markup, is what actually refuses a closed row: the row
  // stays focusable on purpose (see the header comment), so the change event
  // really does arrive here. It refuses no matter how the event was produced.
  function select(next: Visibility): void {
    if (disabled) return;
    const row = rows.find((candidate) => candidate.visibility === next);
    if (!row || row.blocked) return;

    if (next === 'collection') {
      onChange({
        visibility: 'collection',
        collectionId: currentCollectionId ?? collections[0]?.id ?? null,
      });
      return;
    }
    onChange({ visibility: next, collectionId: null });
  }

  return (
    <div className="space-y-2">
      <fieldset className="m-0 min-w-0 space-y-2 border-0 p-0" disabled={disabled}>
        <legend className="mb-2 text-sm font-medium text-content-secondary">
          {t('picker.legend')}
        </legend>

        {/* The object is private and the organisation has switched "Nur ich"
            off. A blocked row would be a reproach here — the container was
            allowed when it was chosen. One sentence instead, and the two ways
            that are left.

            Unless there are none: no collection AND no right to share with the
            whole organisation. Then "choose a collection or the whole
            organisation" would point at two closed doors, and the only
            sentence that is true takes its place. See visibility-options.ts. */}
        {personalOffForExisting && (
          <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
            {personalOffNoWayOut
              ? t('picker.personalOffNoWayOut')
              : t('picker.personalOffExisting')}
          </p>
        )}

        {rows.map(({ visibility, Icon, blocked, reason }) => {
          const checked = value.visibility === visibility;
          const rowDisabled = disabled || blocked;
          const rowReasonId = `${reasonId}-${visibility}`;

          return (
            <Fragment key={visibility}>
              <label
                className={cx(
                  'flex items-start gap-3 rounded-lg border p-3 transition-colors',
                  'focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/30',
                  checked ? 'border-primary bg-primary/5' : 'border-black/10 bg-white',
                  rowDisabled
                    ? 'cursor-not-allowed opacity-60'
                    : 'cursor-pointer hover:border-primary/40'
                )}
              >
                <input
                  type="radio"
                  name={groupName}
                  value={visibility}
                  checked={checked}
                  // Only the whole-picker `disabled` takes the row out of the tab
                  // order. A blocked row stays reachable and announces its reason,
                  // which is the entire point of showing it instead of hiding it.
                  disabled={disabled}
                  aria-disabled={blocked || disabled ? true : undefined}
                  aria-describedby={blocked ? rowReasonId : undefined}
                  onChange={() => select(visibility)}
                  className="mt-1 h-4 w-4 flex-shrink-0 accent-primary focus:outline-none"
                />
                <Icon
                  className="mt-0.5 h-4 w-4 flex-shrink-0 text-content-secondary"
                  aria-hidden="true"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-content-primary">
                    {t(`picker.${visibility}`)}
                  </span>
                  <span className="block text-xs text-content-tertiary">
                    {t(`picker.${visibility}Hint`)}
                  </span>
                  {blocked && (
                    <span id={rowReasonId} className="mt-1 block text-xs text-amber-700">
                      {reason}
                    </span>
                  )}
                </span>
              </label>

              {visibility === 'collection' && checked && !noCollections && (
                <div className="pl-10">
                  <label
                    htmlFor={selectId}
                    className="mb-1 block text-xs font-medium text-content-secondary"
                  >
                    {t('picker.collectionSelectLabel')}
                  </label>
                  <select
                    id={selectId}
                    value={currentCollectionId ?? ''}
                    disabled={disabled}
                    onChange={(event) => {
                      if (disabled) return;
                      onChange({ visibility: 'collection', collectionId: event.target.value });
                    }}
                    className="w-full rounded-lg border border-black/10 bg-white px-3 py-2 text-sm text-content-primary transition-all duration-200 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {collections.map((collection) => (
                      <option key={collection.id} value={collection.id}>
                        {collection.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </Fragment>
          );
        })}
      </fieldset>

      {showAdminNote && (
        <p className="text-xs text-content-tertiary">{t('adminNote')}</p>
      )}
    </div>
  );
}
