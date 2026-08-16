import { getTranslations } from 'next-intl/server';
import { requireFirm } from '../../../../../../lib/auth/current';
import { listNotesForFirm } from '../../../../../../lib/db/queries/firm';
import { Card } from '../../../../../_components/form';

export const dynamic = 'force-dynamic';

/**
 * The observations tab.
 *
 * A note written by a worker is FIRM_ONLY and appears here and nowhere else.
 * "My ITIN application is still pending" is the case the client document names
 * by hand, and it is exactly the case where surfacing it to the employer would
 * matter.
 */
export default async function FirmNotesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [{ id }, { session }, t] = await Promise.all([
    params,
    requireFirm(),
    getTranslations(),
  ]);

  const notes = await listNotesForFirm(session, id);

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-base font-semibold">
        {t('firm.notes.title', { count: notes.length })}
      </h2>

      {notes.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-300 bg-white px-6 py-10 text-center text-sm text-neutral-600">
          {t('firm.notes.empty')}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {notes.map((note) => (
            <Card key={note.id}>
              <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
                <span className="font-medium text-neutral-700">{t(`roles.${note.authorRole}`)}</span>
                <span className="tabular">{note.createdAt.toISOString().slice(0, 10)}</span>
                {note.visibility === 'FIRM_ONLY' ? (
                  <span className="rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-900">
                    {t('firm.notes.firmOnly')}
                  </span>
                ) : null}
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-neutral-900">
                {note.body}
              </p>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
