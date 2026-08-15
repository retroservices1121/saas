/**
 * The authorization texts, and what makes a typed-name signature defensible
 * (spec section 9).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THESE ARE PLACEHOLDERS. Spec section 9, final paragraph, and section 16 item
 * 2: the direct deposit authorization and the data accuracy certification "must
 * be supplied or approved by the client's counsel in English, then
 * human-translated to Spanish. Machine translation is not acceptable for these
 * two documents."
 *
 * The English below is a competent draft of what such a document usually says.
 * It has not been reviewed by a lawyer. The Spanish is a careful translation,
 * and it is still machine translation for the purposes of that requirement.
 * Both must be replaced before a real Social Security number enters the system.
 *
 * `assertDocumentsApproved()` at the bottom is the mechanism: set
 * ESIGN_TEXTS_APPROVED=true only once counsel has signed off, and the
 * production build refuses to start without it.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The version string is what makes the whole thing work over time. A signature
 * row stores the version, the locale, and a sha256 of the exact rendered text.
 * When this copy is revised the version changes, and every signature already
 * captured still points at what was actually on the screen when it was signed.
 */
import { createHash } from 'node:crypto';
import type { Locale } from '../../i18n/request';

export type DocumentType = 'DATA_ACCURACY' | 'DIRECT_DEPOSIT_AUTH' | 'COMPANY_CERTIFICATION';

/**
 * Bump this whenever any text below changes, in either language. It is a single
 * version across all documents deliberately: a per-document version invites the
 * question "which one moved", and this string is cheap.
 */
export const DOCUMENT_VERSION = '2026-08-15.draft-1';

export interface RenderedDocument {
  type: DocumentType;
  version: string;
  locale: Locale;
  title: string;
  /** Every paragraph, in order, exactly as rendered on screen. */
  paragraphs: string[];
  /** sha256 of the exact text shown. */
  hash: string;
  consentLabel: string;
  nameLabel: string;
}

interface DocumentCopy {
  title: string;
  paragraphs: string[];
}

type Catalogue = Record<DocumentType, Record<Locale, DocumentCopy>>;

/**
 * The ESIGN Act requires, for a typed-name signature: disclosure that the party
 * consents to conducting the transaction electronically, affirmative consent to
 * that, an intent-to-sign act, association of the signature with the record,
 * and retention of a reproducible record. The electronic-records disclosure
 * below is the first of those, and it prefixes every document.
 */
const ELECTRONIC_DISCLOSURE: Record<Locale, string> = {
  en:
    'ELECTRONIC RECORDS AND SIGNATURES. By checking the box below and typing your ' +
    'full legal name, you agree that your electronic signature has the same legal ' +
    'effect as a handwritten one, and that this record may be provided to you ' +
    'electronically. You may request a paper copy at no charge, and you may withdraw ' +
    'your consent to electronic records, by contacting the company that invited you. ' +
    'To view and keep this record you need a device with a web browser and the ability ' +
    'to view PDF files.',
  es:
    'REGISTROS Y FIRMAS ELECTRÓNICOS. Al marcar la casilla siguiente y escribir su ' +
    'nombre legal completo, usted acepta que su firma electrónica tiene el mismo efecto ' +
    'legal que una firma manuscrita, y que este registro puede entregársele por medios ' +
    'electrónicos. Puede solicitar una copia en papel sin costo, y puede retirar su ' +
    'consentimiento para recibir registros electrónicos, comunicándose con la empresa ' +
    'que lo invitó. Para ver y conservar este registro necesita un dispositivo con un ' +
    'navegador web y la capacidad de ver archivos PDF.',
};

const CATALOGUE: Catalogue = {
  DIRECT_DEPOSIT_AUTH: {
    en: {
      title: 'Direct deposit authorization',
      paragraphs: [
        'I authorize the company named above, and the accounting firm acting on its behalf, to initiate direct deposits of amounts owed to me into the bank account I have provided, and, if necessary, to initiate adjustments for any amounts deposited in error.',
        'This authorization remains in effect until I revoke it in writing, or until the account is closed. I understand that a revocation must be received far enough in advance to allow the company a reasonable opportunity to act on it.',
        'I confirm that the account I have provided is an account I own or am authorized to use, and that the routing and account numbers I entered are correct. I understand that an incorrect number may cause a payment to be delayed or returned.',
        'I understand that my employer does not receive my bank account details through this system. They are held by the accounting firm named above for the sole purpose of paying me.',
      ],
    },
    es: {
      title: 'Autorización de depósito directo',
      paragraphs: [
        'Autorizo a la empresa indicada arriba, y al despacho contable que actúa en su nombre, a iniciar depósitos directos de las cantidades que se me adeuden en la cuenta bancaria que he proporcionado y, si fuera necesario, a iniciar ajustes por cualquier cantidad depositada por error.',
        'Esta autorización permanece vigente hasta que la revoque por escrito, o hasta que se cierre la cuenta. Entiendo que la revocación debe recibirse con suficiente antelación para dar a la empresa una oportunidad razonable de actuar en consecuencia.',
        'Confirmo que la cuenta que he proporcionado es una cuenta de mi propiedad o que estoy autorizado a usar, y que el número de ruta y el número de cuenta que introduje son correctos. Entiendo que un número incorrecto puede provocar que un pago se retrase o sea devuelto.',
        'Entiendo que mi empleador no recibe los datos de mi cuenta bancaria a través de este sistema. Los conserva el despacho contable indicado arriba con el único fin de pagarme.',
      ],
    },
  },

  DATA_ACCURACY: {
    en: {
      title: 'Certification of accuracy',
      paragraphs: [
        'I certify that the information I have provided — my legal name, date of birth, address, and taxpayer identification number — is true, correct, and complete to the best of my knowledge.',
        'I understand that this information will be used to prepare tax and payroll records, and that providing false information may have legal consequences.',
        'I understand that my employer does not see the information I have entered here. It is held by the accounting firm named above.',
        'I will notify the company if any of this information changes.',
      ],
    },
    es: {
      title: 'Certificación de exactitud',
      paragraphs: [
        'Certifico que la información que he proporcionado — mi nombre legal, fecha de nacimiento, dirección y número de identificación del contribuyente — es verdadera, correcta y completa según mi leal saber y entender.',
        'Entiendo que esta información se usará para preparar registros fiscales y de nómina, y que proporcionar información falsa puede tener consecuencias legales.',
        'Entiendo que mi empleador no ve la información que he introducido aquí. La conserva el despacho contable indicado arriba.',
        'Notificaré a la empresa si alguno de estos datos cambia.',
      ],
    },
  },

  COMPANY_CERTIFICATION: {
    en: {
      title: 'Company certification',
      paragraphs: [
        'I certify that I am authorized to act on behalf of the company named above, and that the information provided about the company — its legal name, employer identification number, address, ownership, insurance coverage, and bank account — is true, correct, and complete to the best of my knowledge.',
        'I certify that each individual listed as an owner has been invited to supply their own information directly, and that I have not entered any owner or worker taxpayer identification number or bank account on their behalf.',
        'I understand that the accounting firm named above will rely on this information to prepare filings on the company’s behalf.',
        'I will notify the accounting firm of any material change to this information.',
      ],
    },
    es: {
      title: 'Certificación de la empresa',
      paragraphs: [
        'Certifico que estoy autorizado a actuar en nombre de la empresa indicada arriba, y que la información proporcionada sobre la empresa — su razón social, número de identificación del empleador, dirección, titularidad, cobertura de seguros y cuenta bancaria — es verdadera, correcta y completa según mi leal saber y entender.',
        'Certifico que cada persona incluida como propietaria ha sido invitada a proporcionar su propia información directamente, y que no he introducido en su nombre ningún número de identificación del contribuyente ni ninguna cuenta bancaria de un propietario o trabajador.',
        'Entiendo que el despacho contable indicado arriba se basará en esta información para preparar las presentaciones en nombre de la empresa.',
        'Notificaré al despacho contable cualquier cambio importante en esta información.',
      ],
    },
  },
};

const CONSENT_LABEL: Record<Locale, string> = {
  en: 'I agree to sign this document electronically.',
  es: 'Acepto firmar este documento electrónicamente.',
};

const NAME_LABEL: Record<Locale, string> = {
  en: 'Type your full legal name',
  es: 'Escriba su nombre legal completo',
};

/**
 * Renders one document and hashes exactly what was rendered.
 *
 * The hash covers the version, the type, the locale, and every paragraph joined
 * by a newline — the same string the screen displays. It deliberately does NOT
 * include the company name or the signer's name, which vary per signature and
 * are stored in their own columns; the hash answers "which text did they see",
 * not "who signed it".
 */
export function renderDocument(
  type: DocumentType,
  locale: Locale,
  context: { companyName: string },
): RenderedDocument {
  const copy = CATALOGUE[type][locale];

  const paragraphs = [
    context.companyName,
    ELECTRONIC_DISCLOSURE[locale],
    ...copy.paragraphs,
  ];

  const canonical = [
    DOCUMENT_VERSION,
    type,
    locale,
    ELECTRONIC_DISCLOSURE[locale],
    ...copy.paragraphs,
  ].join('\n');

  return {
    type,
    version: DOCUMENT_VERSION,
    locale,
    title: copy.title,
    paragraphs,
    hash: createHash('sha256').update(canonical, 'utf8').digest('hex'),
    consentLabel: CONSENT_LABEL[locale],
    nameLabel: NAME_LABEL[locale],
  };
}

/** Recomputes a hash for verification, without rendering. */
export function documentHash(type: DocumentType, locale: Locale): string {
  return renderDocument(type, locale, { companyName: '' }).hash;
}

/**
 * Refuses to start in production until counsel has approved the text above.
 *
 * A launch checklist item that lives in a document gets missed. One that stops
 * the process from booting does not. Called from instrumentation.ts.
 */
export function assertDocumentsApproved(): void {
  if (process.env.NODE_ENV !== 'production') return;
  if (process.env.ESIGN_TEXTS_APPROVED === 'true') return;

  throw new Error(
    [
      '',
      'The e-signature documents in lib/esign/documents.ts are placeholders.',
      '',
      'Spec section 9 requires the direct deposit authorization and the data',
      'accuracy certification to be supplied or approved by the client’s counsel',
      'in English, then human-translated to Spanish. Machine translation is not',
      'acceptable for those two documents.',
      '',
      'Once the approved copy is in place, bump DOCUMENT_VERSION and set',
      'ESIGN_TEXTS_APPROVED=true.',
      '',
    ].join('\n'),
  );
}
