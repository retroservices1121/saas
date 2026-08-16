import { getLocale, getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import StepShell from '../_components/shell';
import {
  AccountStep,
  AcknowledgeStep,
  AddressStep,
  BankStep,
  ContactStep,
  DobConfirmStep,
  EmergencyStep,
  NameStep,
  NotesStep,
  RoutingStep,
  SignStep,
  TinStep,
  TinTypeStep,
} from '../_components/step-forms';
import {
  confirmReviewAction,
  finishAction,
  readDraft,
  saveAccountAction,
  saveAddressAction,
  saveBankAction,
  saveContactAction,
  saveDobAction,
  saveEmergencyAction,
  saveNameAction,
  saveNoteAction,
  saveRoutingAction,
  saveTinAction,
  saveTinTypeAction,
  signAction,
  skipCheckAction,
} from '../../_actions/form';
import { requireSubject } from '../../../lib/auth/invite-session';
import { maskAccount, maskTin, stepInFlow, type FormDraft } from '../../../lib/forms/wizard';
import { renderDocument } from '../../../lib/esign/documents';
import type { Locale } from '../../../i18n/request';

export const dynamic = 'force-dynamic';

export default async function FormStepPage({
  params,
}: {
  params: Promise<{ step: string }>;
}) {
  const [{ step: raw }, current] = await Promise.all([params, requireSubject()]);

  // A step that is not in this subject's flow — an owner reaching /form/routing,
  // say — is a wrong turn rather than an error. Send them to the start.
  const step = stepInFlow(current.invite.subjectType, raw);
  if (!step) redirect('/form/welcome');

  const [t, locale, draft] = await Promise.all([
    getTranslations(),
    getLocale(),
    readDraft() as Promise<FormDraft>,
  ]);

  const kind = current.invite.subjectType;
  const company = current.invite.companyName;
  const shell = (title: string, hint: string | undefined, children: React.ReactNode) => (
    <StepShell kind={kind} step={step} title={title} hint={hint}>
      {children}
    </StepShell>
  );

  const stringDefaults: Record<string, string> = Object.fromEntries(
    Object.entries(draft).flatMap(([key, value]) =>
      typeof value === 'string' ? [[key, value]] : [],
    ),
  );

  switch (step) {
    case 'welcome':
      return shell(
        t('form.welcome.title', { company }),
        undefined,
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-4 text-base leading-relaxed text-neutral-700">
            <p>{t('form.welcome.what')}</p>
            {/*
              The sentence the whole system exists for, said to the person it
              protects, on the screen before they are asked for anything.
            */}
            <p className="rounded-lg bg-green-50 px-4 py-3 font-medium text-green-900">
              {t('form.welcome.privacy', { company })}
            </p>
            <p>{t('form.welcome.time')}</p>
          </div>
          <AcknowledgeStep action={saveDobAction} label={t('form.welcome.start')} />
        </div>,
      );

    case 'name':
      return shell(t('form.name.title'), t('form.name.hint'), (
        <NameStep action={saveNameAction} defaults={stringDefaults} />
      ));

    case 'dob': {
      const value = draft.dateOfBirth ?? '';
      const formatted = value
        ? new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(
            new Date(`${value}T00:00:00Z`),
          )
        : '';
      return shell(t('form.dob.title'), t('form.dob.hint'), (
        <DobConfirmStep action={saveDobAction} dateOfBirth={value} formatted={formatted} />
      ));
    }

    case 'address':
      return shell(t('form.address.title'), undefined, (
        <AddressStep action={saveAddressAction} defaults={stringDefaults} />
      ));

    case 'contact':
      return shell(t('form.contact.title'), undefined, (
        <ContactStep action={saveContactAction} defaults={stringDefaults} />
      ));

    case 'emergency':
      return shell(t('form.emergency.title'), t('form.emergency.hint'), (
        <EmergencyStep action={saveEmergencyAction} defaults={stringDefaults} />
      ));

    case 'tin-type':
      return shell(t('form.tinType.title'), t('form.tinType.hint'), (
        <TinTypeStep action={saveTinTypeAction} current={draft.tinType} />
      ));

    case 'tin':
      if (!draft.tinType) redirect('/form/tin-type');
      return shell(t('form.tin.title'), undefined, (
        <TinStep action={saveTinAction} tinType={draft.tinType} />
      ));

    case 'bank':
      return shell(t('form.bank.title'), t('form.bank.hint'), (
        <BankStep action={saveBankAction} defaults={stringDefaults} />
      ));

    case 'routing':
      return shell(t('form.routing.title'), undefined, (
        <RoutingStep action={saveRoutingAction} />
      ));

    case 'account':
      return shell(t('form.account.title'), undefined, <AccountStep action={saveAccountAction} />);

    case 'check':
      // Optional by design (spec section 8, screen 12). The upload itself is a
      // presigned PUT from the device; skipping is a first-class outcome, not a
      // hidden link.
      return shell(t('form.check.title'), t('form.check.hint'), (
        <div className="flex flex-col gap-4">
          <p className="rounded-lg bg-neutral-50 px-4 py-3 text-sm leading-relaxed text-neutral-600">
            {t('form.check.optional')}
          </p>
          <AcknowledgeStep action={skipCheckAction} label={t('form.check.skip')} />
        </div>
      ));

    case 'notes':
      return shell(t('form.notes.title'), t('form.notes.hint'), (
        <NotesStep action={saveNoteAction} defaultValue={draft.note} />
      ));

    case 'review':
      return shell(t('form.review.title'), t('form.review.hint'), (
        <div className="flex flex-col gap-6">
          <ReviewList draft={draft} kind={kind} />
          {draft.tinWarnings?.length ? (
            <p className="rounded-lg bg-amber-50 px-4 py-3 text-sm leading-relaxed text-amber-900">
              {t(draft.tinWarnings[0]!)}
            </p>
          ) : null}
          <AcknowledgeStep action={confirmReviewAction} label={t('form.review.confirm')} />
        </div>
      ));

    case 'sign-deposit':
    case 'sign-accuracy': {
      const documentType =
        step === 'sign-deposit' ? 'DIRECT_DEPOSIT_AUTH' : ('DATA_ACCURACY' as const);
      const document = renderDocument(documentType, locale as Locale, { companyName: company });
      const expectedName = [draft.legalFirstName, draft.legalMiddleName, draft.legalLastName]
        .filter(Boolean)
        .join(' ');

      return shell(document.title, undefined, (
        <SignStep
          action={signAction}
          documentType={documentType}
          documentVersion={document.version}
          documentLocale={document.locale}
          paragraphs={document.paragraphs.slice(1)}
          consentLabel={document.consentLabel}
          nameLabel={document.nameLabel}
          expectedName={expectedName}
        />
      ));
    }

    case 'done':
      return shell(t('form.done.title'), undefined, (
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-4 text-base leading-relaxed text-neutral-700">
            <p>{t('form.done.body', { company })}</p>
            {/* No sensitive values on this screen (spec section 8, screen 17). */}
            <p>{t('form.done.corrections')}</p>
          </div>
          <AcknowledgeStep action={finishAction} label={t('form.done.close')} />
        </div>
      ));
  }
}

/**
 * The review list. Sensitive answers are masked here exactly as they are
 * everywhere else — the person who typed it does not need to see it again to
 * confirm the last four digits are right, and the screen may be over a
 * shoulder.
 */
async function ReviewList({ draft, kind }: { draft: FormDraft; kind: 'WORKER' | 'OWNER' }) {
  const t = await getTranslations();

  const rows: Array<{ label: string; value: string; href: string }> = [
    {
      label: t('form.review.name'),
      value: [draft.legalFirstName, draft.legalMiddleName, draft.legalLastName]
        .filter(Boolean)
        .join(' '),
      href: '/form/name',
    },
    { label: t('form.review.dob'), value: draft.dateOfBirth ?? '', href: '/form/dob' },
    {
      label: t('form.review.address'),
      value: [draft.addressLine1, draft.addressLine2, draft.city, draft.state, draft.postalCode]
        .filter(Boolean)
        .join(', '),
      href: '/form/address',
    },
    {
      label: t('form.review.contact'),
      value: [draft.phoneE164, draft.email].filter(Boolean).join(' · '),
      href: '/form/contact',
    },
    {
      label: t(`form.review.tin.${draft.tinType ?? 'SSN'}`),
      value: draft.tin ? maskTin(draft.tin.last4) : '',
      href: '/form/tin',
    },
  ];

  if (kind === 'WORKER') {
    rows.push(
      {
        label: t('form.review.bank'),
        value: [draft.bankName, draft.bankAccountType].filter(Boolean).join(' · '),
        href: '/form/bank',
      },
      {
        label: t('form.review.routing'),
        value: draft.routing ? maskAccount(draft.routing.last4) : '',
        href: '/form/routing',
      },
      {
        label: t('form.review.account'),
        value: draft.account ? maskAccount(draft.account.last4) : '',
        href: '/form/account',
      },
    );
  }

  return (
    <dl className="flex flex-col divide-y divide-neutral-200 rounded-lg border border-neutral-200">
      {rows.map((row) => (
        <div key={row.href} className="flex items-start justify-between gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <dt className="text-sm text-neutral-600">{row.label}</dt>
            <dd className="tabular mt-0.5 break-words text-base font-medium">
              {row.value || t('app.notProvided')}
            </dd>
          </div>
          <a
            href={row.href}
            className="shrink-0 rounded-md px-2 py-1.5 text-sm font-medium text-blue-700 underline"
          >
            {t('form.review.edit')}
          </a>
        </div>
      ))}
    </dl>
  );
}
