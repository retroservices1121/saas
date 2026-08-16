/**
 * The one-question-per-screen flow (spec section 8).
 *
 * The screen list is data rather than routing, because two things have to agree
 * with it and neither should have to be edited when a screen moves: the
 * progress indicator, and the "where was I" resume. A worker who closes the
 * browser on screen 9 reopens on screen 9, which means the server has to be
 * able to name that screen from a stored string.
 *
 * The owner flow is a subset of the worker flow rather than a separate list —
 * screens 0 through 8, then 13, 14, and 16. Spec section 7.3: the flow does not
 * branch, even for a single-member entity where the admin is the owner.
 */

export type StepId =
  | 'welcome'
  | 'name'
  | 'dob'
  | 'address'
  | 'contact'
  | 'emergency'
  | 'tin-type'
  | 'tin'
  | 'bank'
  | 'routing'
  | 'account'
  | 'check'
  | 'notes'
  | 'review'
  | 'sign-deposit'
  | 'sign-accuracy'
  | 'done';

export interface StepDefinition {
  id: StepId;
  /** i18n key under `form.steps.`. */
  titleKey: string;
  /** Counted in the progress indicator. Welcome and done are not. */
  counted: boolean;
}

const ALL_STEPS: Record<StepId, StepDefinition> = {
  welcome: { id: 'welcome', titleKey: 'welcome', counted: false },
  name: { id: 'name', titleKey: 'name', counted: true },
  dob: { id: 'dob', titleKey: 'dob', counted: true },
  address: { id: 'address', titleKey: 'address', counted: true },
  contact: { id: 'contact', titleKey: 'contact', counted: true },
  emergency: { id: 'emergency', titleKey: 'emergency', counted: true },
  'tin-type': { id: 'tin-type', titleKey: 'tinType', counted: true },
  tin: { id: 'tin', titleKey: 'tin', counted: true },
  bank: { id: 'bank', titleKey: 'bank', counted: true },
  routing: { id: 'routing', titleKey: 'routing', counted: true },
  account: { id: 'account', titleKey: 'account', counted: true },
  check: { id: 'check', titleKey: 'check', counted: true },
  notes: { id: 'notes', titleKey: 'notes', counted: true },
  review: { id: 'review', titleKey: 'review', counted: true },
  'sign-deposit': { id: 'sign-deposit', titleKey: 'signDeposit', counted: true },
  'sign-accuracy': { id: 'sign-accuracy', titleKey: 'signAccuracy', counted: true },
  done: { id: 'done', titleKey: 'done', counted: false },
};

const WORKER_FLOW: StepId[] = [
  'welcome',
  'name',
  'dob',
  'address',
  'contact',
  'emergency',
  'tin-type',
  'tin',
  'bank',
  'routing',
  'account',
  'check',
  'notes',
  'review',
  'sign-deposit',
  'sign-accuracy',
  'done',
];

/**
 * An owner supplies no banking, so there is no direct deposit authorization to
 * sign and no voided check to photograph. Everything else is identical.
 */
const OWNER_FLOW: StepId[] = [
  'welcome',
  'name',
  'dob',
  'address',
  'contact',
  'emergency',
  'tin-type',
  'tin',
  'notes',
  'review',
  'sign-accuracy',
  'done',
];

export type SubjectKind = 'WORKER' | 'OWNER';

export function flowFor(kind: SubjectKind): StepId[] {
  return kind === 'WORKER' ? WORKER_FLOW : OWNER_FLOW;
}

export function stepDefinition(id: StepId): StepDefinition {
  return ALL_STEPS[id];
}

export function isStepId(value: string): value is StepId {
  return value in ALL_STEPS;
}

export function stepInFlow(kind: SubjectKind, id: string): StepId | null {
  if (!isStepId(id)) return null;
  return flowFor(kind).includes(id) ? id : null;
}

export function nextStep(kind: SubjectKind, current: StepId): StepId | null {
  const flow = flowFor(kind);
  const index = flow.indexOf(current);
  return index >= 0 && index < flow.length - 1 ? flow[index + 1]! : null;
}

export function previousStep(kind: SubjectKind, current: StepId): StepId | null {
  const flow = flowFor(kind);
  const index = flow.indexOf(current);
  return index > 0 ? flow[index - 1]! : null;
}

export interface Progress {
  current: number;
  total: number;
  /** 0-100, for the bar. */
  percent: number;
}

/**
 * Counts only the screens that ask a question.
 *
 * A progress bar that includes the welcome and done screens tells someone on
 * screen 1 of 17 that they have made progress by reading a paragraph, and one
 * that jumps to 100% before the signatures is worse — the two screens people
 * most want to know are coming are the ones that ask for a signature.
 */
export function progressFor(kind: SubjectKind, current: StepId): Progress {
  const counted = flowFor(kind).filter((id) => ALL_STEPS[id].counted);
  const index = counted.indexOf(current);

  if (index === -1) {
    return current === 'done'
      ? { current: counted.length, total: counted.length, percent: 100 }
      : { current: 0, total: counted.length, percent: 0 };
  }

  return {
    current: index + 1,
    total: counted.length,
    percent: Math.round(((index + 1) / counted.length) * 100),
  };
}

// ---------------------------------------------------------------------------
// The draft
// ---------------------------------------------------------------------------

/**
 * What is accumulated across screens.
 *
 * The three sensitive answers are stored as `{ enc, last4 }` — sealed at the
 * screen that collected them, so the plaintext exists only inside the request
 * that typed it. Nothing in this shape can be read back into a tax ID without
 * going through `decryptField`, which writes an audit row.
 */
export interface FormDraft {
  legalFirstName?: string;
  legalMiddleName?: string | null;
  legalLastName?: string;
  dateOfBirth?: string;

  addressLine1?: string;
  addressLine2?: string | null;
  city?: string;
  state?: string;
  postalCode?: string;

  email?: string | null;
  phoneE164?: string;

  emergencyContactName?: string | null;
  emergencyContactPhone?: string | null;
  emergencyContactRelationship?: string | null;

  tinType?: 'SSN' | 'ITIN';
  tin?: { enc: string; last4: string };
  /** i18n keys for the soft type-mismatch warning, shown again on review. */
  tinWarnings?: string[];

  bankName?: string;
  bankAccountType?: 'CHECKING' | 'SAVINGS';
  routing?: { enc: string; last4: string };
  account?: { enc: string; last4: string };

  voidedCheckDocumentId?: string;
  note?: string;
}

/** Screens whose answers must be present before the review screen is meaningful. */
export function missingRequired(kind: SubjectKind, draft: FormDraft): StepId[] {
  const missing: StepId[] = [];

  if (!draft.legalFirstName || !draft.legalLastName) missing.push('name');
  if (!draft.dateOfBirth) missing.push('dob');
  if (!draft.addressLine1 || !draft.city || !draft.state || !draft.postalCode) {
    missing.push('address');
  }
  if (!draft.phoneE164) missing.push('contact');
  if (!draft.tinType) missing.push('tin-type');
  if (!draft.tin) missing.push('tin');

  if (kind === 'WORKER') {
    if (!draft.bankName || !draft.bankAccountType) missing.push('bank');
    if (!draft.routing) missing.push('routing');
    if (!draft.account) missing.push('account');
  }

  return missing;
}

/** `•••-••-1234`, built server-side. The client never holds enough to build it. */
export function maskTin(last4: string): string {
  return `•••-••-${last4}`;
}

export function maskAccount(last4: string): string {
  return `••••${last4}`;
}
