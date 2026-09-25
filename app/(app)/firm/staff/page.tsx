import { getTranslations } from 'next-intl/server';
import { requireFirmAdmin } from '../../../../lib/auth/current';
import { listFirmStaff } from '../../../../lib/db/queries/firm';
import { Card, StatusChip } from '../../../_components/form';
import InviteStaffForm from './invite-staff-form';
import ResendSetupButton from './resend-setup-button';
import StaffStatusButton from './staff-status-button';

export const dynamic = 'force-dynamic';

/**
 * Firm staff management (spec section 2).
 *
 * The difference between the two roles is worth showing on the page rather than
 * leaving in a manual: FIRM_STAFF can reveal a single field with a reason, and
 * cannot export. That is the whole distinction, and it is the thing someone
 * choosing a role for a new hire needs to know.
 */
export default async function FirmStaffPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ session, user }, t, params] = await Promise.all([
    requireFirmAdmin(),
    getTranslations(),
    searchParams,
  ]);

  const staff = await listFirmStaff(session);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold tracking-tight">{t('firm.staff.title')}</h1>
        <p className="text-sm leading-relaxed text-neutral-600">{t('firm.staff.intro')}</p>
      </div>

      {params.invited ? (
        <p role="status" className="rounded-lg bg-green-50 px-4 py-3 text-sm text-green-900">
          {t('firm.staff.invited')}
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-4 py-3 font-medium">{t('firm.staff.name')}</th>
              <th className="px-4 py-3 font-medium">{t('firm.staff.role')}</th>
              <th className="px-4 py-3 font-medium">{t('firm.staff.status')}</th>
              <th className="px-4 py-3 font-medium">{t('firm.staff.lastLogin')}</th>
              <th className="px-4 py-3 font-medium" />
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {staff.map((member) => (
              <tr key={member.id}>
                <td className="px-4 py-3">
                  <span className="font-medium">{member.name}</span>
                  <span className="block text-xs text-neutral-500">{member.email}</span>
                </td>
                <td className="px-4 py-3 text-neutral-700">{t(`roles.${member.role}`)}</td>
                <td className="px-4 py-3">
                  <StatusChip
                    status={
                      member.status === 'active'
                        ? 'SUBMITTED'
                        : member.status === 'pending'
                          ? 'INVITED'
                          : 'NEEDS_ATTENTION'
                    }
                    label={t(`firm.staff.statuses.${member.status}`)}
                  />
                </td>
                <td className="tabular px-4 py-3 text-neutral-600">
                  {member.lastLoginAt
                    ? member.lastLoginAt.toISOString().slice(0, 10)
                    : t('firm.staff.never')}
                </td>
                <td className="px-4 py-3">
                  {/* Not for your own row: an admin who suspends the only
                      FIRM_ADMIN account needs the platform admin to undo it. */}
                  {member.id === user.userId ? (
                    <span className="block text-right text-xs text-neutral-400">
                      {t('firm.staff.you')}
                    </span>
                  ) : (
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      {/* Only while the invitation is still the thing standing
                          between them and an account. A suspended invitee has
                          to be reactivated first — which returns them to
                          `pending` — and an active one needs a password reset,
                          not a second setup link. */}
                      {member.status === 'pending' ? (
                        <ResendSetupButton userId={member.id} />
                      ) : null}
                      <StaffStatusButton
                        userId={member.id}
                        status={
                          member.status === 'suspended'
                            ? 'suspended'
                            : member.status === 'pending'
                              ? 'pending'
                              : 'active'
                        }
                      />
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Card>
        <h2 className="text-base font-semibold">{t('firm.staff.addTitle')}</h2>
        <p className="mt-1 text-sm leading-relaxed text-neutral-600">{t('firm.staff.roleHint')}</p>
        <div className="mt-4">
          <InviteStaffForm />
        </div>
      </Card>
    </div>
  );
}
