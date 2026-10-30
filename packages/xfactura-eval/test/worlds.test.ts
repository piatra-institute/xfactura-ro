import { describe, expect, test } from 'bun:test';
import { Books } from '../src/engine/books';
import { seededIds } from '../src/ids';
import { render } from '../src/world/sources';
import { worlds } from '../src/worlds';

type Detail = {
  checks: { code: string; status: string }[] | null;
  citations: { items: { field: string; status: string }[] } | null;
};

describe('worlds', () => {
  for (const world of worlds)
    test(`${world.id}: every gold decision posts, and every cited field verifies`, async () => {
      expect(world.documents.every((document) => render(document.source).length > 0)).toBe(true);
      const books = await Books.open(world, seededIds(`test/${world.id}`));
      try {
        for (const document of world.documents) await books.upload(document);
        for (const document of [...world.documents].sort((a, b) =>
          a.arrives.localeCompare(b.arrives),
        )) {
          expect(await books.intake(document)).toBe(
            document.gold.intake.op === 'none' ? 'none' : 'person',
          );
          await books.settleQuestions(document);
          const posted = await books.postGold(document);
          expect(posted.map((item) => item.view.status)).toEqual(
            document.gold.decisions.map(() => 'posted'),
          );
          if (document.gold.intake.op !== 'documents.record') continue;
          const [recorded] = await books.documentsOf(document.key);
          const detail = await books.invoke<Detail>('documents.get', { id: recorded!.id });
          const failed = (detail.checks ?? []).filter((check) => check.status === 'failed');
          expect(failed).toEqual([]);
          if (document.source.kind === 'pdf')
            expect(
              detail.citations?.items.filter((citation) => citation.status !== 'verified'),
            ).toEqual([]);
        }
      } finally {
        await books.dispose();
      }
    }, 120_000);
});
