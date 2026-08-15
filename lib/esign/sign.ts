/**
 * Capturing a signature (spec section 9).
 *
 * Five things have to be true for a typed-name signature to hold up under the
 * federal ESIGN Act, and each maps to something concrete here:
 *
 *   disclosure of electronic records   the text rendered on screen, prefixed to
 *                                      every document
 *   affirmative consent                `consentToElectronic`, which the schema
 *                                      accepts only as literal `true`
 *   an intent-to-sign act              typing a full legal name
 *   association with the record        subject_type + subject_id + the hash of
 *                                      the exact text shown
 *   a retained reproducible record     the PDF written below, stored FIRM_ONLY
 *
 * The name comparison is a warning and never a block. Someone whose legal name
 * carries an accent their keyboard cannot produce, or who signs "Bob" when the
 * record says "Robert", has still signed. Refusing them would be inventing a
 * requirement the statute does not contain.
 */
import { and, eq } from 'drizzle-orm';
import { schema, withScope } from '../db/scoped';
import type { Session } from '../auth/session';
import { audit } from '../audit';
import { uploadDocument } from '../documents';
import { renderPdf, type PdfBlock } from '../pdf';
import { renderDocument, type DocumentType } from './documents';
import { uuidv7 } from '../uuid';
import type { Locale } from '../../i18n/request';

export interface SignatureInput {
  subjectType: 'WORKER' | 'OWNER' | 'COMPANY';
  subjectId: string;
  companyId: string;
  companyName: string;
  documentType: DocumentType;
  locale: Locale;
  typedName: string;
  consentToElectronic: boolean;
  /** The legal name already on file, for the soft mismatch check. */
  expectedName?: string | undefined;
}

export interface SignatureResult {
  signatureId: string;
  documentId: string;
  /** Set when the typed name does not match the name on file. Never blocking. */
  nameMismatch: boolean;
}

/** Case- and accent-insensitive, whitespace-collapsed. */
function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export async function captureSignature(
  session: Session,
  input: SignatureInput,
): Promise<SignatureResult> {
  if (!input.consentToElectronic) {
    throw new Error('Refusing to record a signature without affirmative consent.');
  }
  if (!input.typedName.trim()) {
    throw new Error('Refusing to record a signature with no typed name.');
  }

  const document = renderDocument(input.documentType, input.locale, {
    companyName: input.companyName,
  });

  const signedAt = new Date();
  const signatureId = uuidv7();

  const nameMismatch = Boolean(
    input.expectedName && normalizeName(input.expectedName) !== normalizeName(input.typedName),
  );

  // The PDF is generated before the row is written, so a failure to produce the
  // retained record fails the whole signature rather than leaving a signature
  // with nothing to reproduce.
  const pdf = renderPdf(buildPdfBlocks(document, input, signedAt, session.ip ?? 'unknown'), {
    title: `${document.title} — ${input.companyName}`,
    footer: `${document.version}  ${document.hash.slice(0, 16)}`,
  });

  const uploaded = await uploadDocument(session, {
    companyId: input.companyId,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    docType: 'SIGNED_AUTHORIZATION',
    label: `${document.title} (${document.locale})`,
    contentType: 'application/pdf',
    bytes: pdf,
  });

  await withScope(session, async (db) => {
    await db.insert(schema.signatures).values({
      id: signatureId,
      companyId: input.companyId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      documentType: input.documentType,
      documentVersion: document.version,
      documentLocale: document.locale,
      documentHash: document.hash,
      typedName: input.typedName.trim(),
      consentToElectronic: true,
      signedAt,
      // Both are required by the schema and by the statute's association
      // requirement. A signature with no origin is materially weaker evidence.
      ip: session.ip ?? '0.0.0.0',
      userAgent: session.userAgent ?? 'unknown',
    });

    await audit(db, session, {
      action: 'SIGNATURE_CAPTURED',
      companyId: input.companyId,
      targetType: 'signatures',
      targetId: signatureId,
      metadata: {
        documentType: input.documentType,
        documentVersion: document.version,
        locale: document.locale,
        documentId: uploaded.id,
        nameMismatch,
      },
    });
  });

  return { signatureId, documentId: uploaded.id, nameMismatch };
}

function buildPdfBlocks(
  document: ReturnType<typeof renderDocument>,
  input: SignatureInput,
  signedAt: Date,
  ip: string,
): PdfBlock[] {
  const labels =
    document.locale === 'es'
      ? {
          signedBy: 'Firmado por',
          signedAt: 'Fecha y hora',
          ip: 'Dirección IP',
          device: 'Dispositivo',
          consent: 'Consentimiento para firmar electrónicamente',
          given: 'Otorgado',
          version: 'Versión del documento',
          hash: 'Huella del documento (SHA-256)',
          record: 'Registro de la firma',
        }
      : {
          signedBy: 'Signed by',
          signedAt: 'Signed at',
          ip: 'IP address',
          device: 'Device',
          consent: 'Consent to sign electronically',
          given: 'Given',
          version: 'Document version',
          hash: 'Document fingerprint (SHA-256)',
          record: 'Signature record',
        };

  return [
    { text: document.title, style: 'heading' },
    { text: input.companyName, style: 'label' },
    ...document.paragraphs.slice(1).map((text): PdfBlock => ({ text, style: 'body' })),

    { text: labels.record, style: 'heading' },
    { text: `${labels.signedBy}: ${input.typedName.trim()}`, style: 'body' },
    { text: `${labels.signedAt}: ${signedAt.toISOString()}`, style: 'body' },
    { text: `${labels.consent}: ${labels.given}`, style: 'body' },
    { text: `${labels.ip}: ${ip}`, style: 'body' },
    { text: `${labels.version}: ${document.version}`, style: 'body' },
    { text: `${labels.hash}: ${document.hash}`, style: 'body' },
  ];
}

/**
 * Which of the required documents a subject still owes.
 *
 * Drives the form's last screens and the status derivation: a worker is not
 * SUBMITTED until both the direct deposit authorization and the data accuracy
 * certification are on file (spec section 11).
 */
export async function missingSignatures(
  session: Session,
  subject: { subjectType: 'WORKER' | 'OWNER' | 'COMPANY'; subjectId: string },
  required: DocumentType[],
): Promise<DocumentType[]> {
  const captured = await withScope(session, async (db) =>
    db
      .select({ documentType: schema.signatures.documentType })
      .from(schema.signatures)
      .where(
        and(
          eq(schema.signatures.subjectType, subject.subjectType),
          eq(schema.signatures.subjectId, subject.subjectId),
        ),
      ),
  );

  const have = new Set(captured.map((row) => row.documentType));
  return required.filter((type) => !have.has(type));
}

/** The documents each kind of subject must sign before they are finished. */
export const REQUIRED_SIGNATURES: Record<'WORKER' | 'OWNER' | 'COMPANY', DocumentType[]> = {
  // Screens 15 and 16 of the worker form.
  WORKER: ['DIRECT_DEPOSIT_AUTH', 'DATA_ACCURACY'],
  // The owner form is screens 0-8, then 13, 14, and 16 — no banking, so no
  // direct deposit authorization.
  OWNER: ['DATA_ACCURACY'],
  COMPANY: ['COMPANY_CERTIFICATION'],
};
