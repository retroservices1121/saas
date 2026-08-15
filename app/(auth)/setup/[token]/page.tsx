import { getTranslations } from 'next-intl/server';
import QRCode from 'qrcode';
import SetupForm from './setup-form';
import { beginEnrollment, inspectSetupToken } from '../../../../lib/auth/staff-auth';
import { formatSecretForDisplay, totpUri } from '../../../../lib/auth/totp';

/**
 * Password creation plus mandatory TOTP enrollment, from a 24-hour single-use
 * link (spec section 7.1).
 *
 * Rendered dynamically and never cached: the page embeds a freshly generated
 * authenticator secret, and a cached copy would hand the same secret to the
 * next person to open the link.
 */
export const dynamic = 'force-dynamic';

export default async function SetupPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const [{ token }, t] = await Promise.all([params, getTranslations('auth')]);

  const target = await inspectSetupToken(token);

  // Expired, consumed, and never-existed are one answer. Distinguishing them
  // tells someone holding a stale link whether it was ever real.
  if (!target) {
    return (
      <div className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{t('setupExpiredTitle')}</h1>
        <p className="text-sm text-neutral-600">{t('setupExpiredBody')}</p>
      </div>
    );
  }

  const { secret } = beginEnrollment();
  const issuer = process.env.APP_NAME ?? 'Onboarding';
  const uri = totpUri(secret, target.email, issuer);

  const qrSvg = await QRCode.toString(uri, {
    type: 'svg',
    margin: 0,
    // High correction: this is scanned off a screen, sometimes photographed
    // from another screen, and a failed scan sends people to manual entry.
    errorCorrectionLevel: 'H',
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t('setupTitle')}</h1>
        <p className="text-sm text-neutral-600">
          {t('setupSubtitle', { email: target.email })}
        </p>
      </div>

      <SetupForm
        token={token}
        secret={secret}
        formattedSecret={formatSecretForDisplay(secret)}
        qrSvg={qrSvg}
      />
    </div>
  );
}
