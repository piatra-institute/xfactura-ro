// Renders a review packet for the reviewer, in Romanian: a PDF with the canonical packet attached
// (packet.json, whose SHA-256 is the packet hash) and its unhashed context (context.json: the
// clause excerpts and the deadlines on the day it was generated), with form fields for the
// answers and an empty signature field; and the same content as Markdown.
import fontkit from '@pdf-lib/fontkit';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { AFRelationship, PDFDocument, PDFString, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type {
  NextDeadline,
  PacketItem,
  ReviewPacket,
} from '../../packages/xfactura-core/src/ro/reviews';
import { repositoryRoot, type Excerpt } from './snapshots';

/** Noto Sans (SIL Open Font License 1.1), already shipped by the web invoicer. */
export const FONT = path.join(
  repositoryRoot,
  'packages/xfactura-web/public/assets/NotoSans-Regular.ttf',
);

export const CONTEXT_FORMAT = 'xfactura.review-context@1';

/** What a packet's PDF carries besides the packet: not hashed, since it depends on the day and on
 * the local snapshots. */
export interface PacketContext {
  format: typeof CONTEXT_FORMAT;
  packetId: string;
  packetSha256: string;
  generatedOn: string;
  excerpts: Excerpt[];
  deadlines: { key: string; deadline: NextDeadline | null }[];
  minutes: number;
}

/** The form field of each question, by the item's position. */
export const answerField = (index: number) => `q${index + 1}`;
export const textField = (index: number) => `q${index + 1}_text`;
export const reviewerFields = {
  name: 'reviewer_name',
  ceccar: 'reviewer_ceccar',
  role: 'reviewer_role',
} as const;
export const SIGNATURE_FIELD = 'semnatura';

const day = (date: string) => `${date.slice(8, 10)}.${date.slice(5, 7)}.${date.slice(0, 4)}`;
const value = (json: unknown) => (typeof json === 'string' ? json : JSON.stringify(json));
const deadlineText = (deadline: NextDeadline | null) =>
  deadline
    ? `${deadline.obligation} pentru perioada ${day(deadline.period.start)}–${day(deadline.period.end)}: ${day(deadline.due)} (${deadline.days === 0 ? 'astăzi' : deadline.days === 1 ? 'mâine' : `peste ${deadline.days} zile`})`
    : 'niciun termen calculat (declarațiile nu sunt adnotate)';
const versionText = (version: PacketItem['versions'][number]) =>
  `${version.id}: valoarea ${value(version.value)}${Object.keys(version.scope).length ? `, domeniu ${JSON.stringify(version.scope)}` : ''}; de la ${day(version.from)} ${version.to ? `până la ${day(version.to)}` : 'fără dată de sfârșit'}${version.reviewedThrough ? `, verificată până la ${day(version.reviewedThrough)}` : ''}; clauze: ${version.clauses.join(', ')}.`;
const excerptReason = (text: string) =>
  text
    .replace('excerpt unavailable: ', 'Extras indisponibil: ')
    .replace('snapshot missing (no .sources/ directory)', 'snapshot lipsă (nu există .sources/)')
    .replace('snapshot missing', 'snapshot lipsă')
    .replace(
      'snapshot differs from its registered hash (drift to review)',
      'snapshotul local diferă de amprenta înregistrată',
    )
    .replace(
      'the clause is pending: its source has no registered snapshot',
      'clauza nu a fost citită: sursa ei nu are snapshot înregistrat',
    )
    .replace(
      /^Extras indisponibil: no anchor recorded.*$/,
      'Extras indisponibil: nicio ancoră înregistrată pentru clauză',
    )
    .replace(
      'no PDF text extractor (install poppler for pdftotext)',
      'lipsește extractorul de text PDF (pdftotext)',
    )
    .replace(/anchor not (found|unique)/, 'ancora nu a fost găsită sau nu e unică')
    .replace('end anchor not found', 'ancora de sfârșit nu a fost găsită');

const questions = (count: number) => (count === 1 ? '1 întrebare' : `${count} întrebări`);

const title = (packet: ReviewPacket) =>
  packet.items.length === 1
    ? `Pachet de revizuire ${packet.id}: ${packet.items[0]!.key}`
    : `Pachet de revizuire ${packet.id}: ${packet.items.length} parametri`;

const instructions = [
  'Citiți fiecare întrebare împreună cu sursele, extrasele și cazurile ei.',
  'Bifați A (lectura motorului), B (lectura alternativă) sau C (altă lectură, pe care o scrieți în câmpul de text de sub întrebare).',
  'Completați la final numele, numărul de membru CECCAR și calitatea.',
  'Semnați documentul în câmpul de semnătură, cu semnătura electronică calificată. Semnătura acoperă răspunsurile: nu modificați documentul după semnare.',
  'Fișierul atașat packet.json este pachetul exact; amprenta lui SHA-256 este amprenta pachetului. Fișierul context.json conține extrasele și termenele din ziua generării și nu intră în amprentă.',
  'Un răspuns A leagă valoarea doar cât timp pachetul regenerat pentru parametru are aceeași amprentă: orice schimbare a valorii, a datelor, a clauzelor, a ancorelor extraselor, a lecturilor sau a cazurilor îl anulează.',
];

export function renderMarkdown(packet: ReviewPacket, packetSha256: string, context: PacketContext) {
  const excerpt = (clause: string) => context.excerpts.find((item) => item.clause === clause);
  const lines = [
    `# ${title(packet)}`,
    '',
    `- Amprenta pachetului (SHA-256 a packet.json): \`${packetSha256}\``,
    `- Generat la ${day(context.generatedOn)}; ${questions(packet.items.length)}; aproximativ ${context.minutes} minute.`,
    '',
    '## Cum se răspunde',
    '',
    ...instructions.map((text, index) => `${index + 1}. ${text}`),
    '',
  ];
  packet.items.forEach((item, index) => {
    const deadline = context.deadlines.find((entry) => entry.key === item.key)?.deadline ?? null;
    lines.push(
      `## Întrebarea ${index + 1}: \`${item.key}\``,
      '',
      item.description,
      '',
      '### Versiuni',
      '',
      ...item.versions.map((version) => `- ${versionText(version)}`),
      '',
      '### Surse',
      '',
    );
    for (const source of item.sources) {
      const shown = excerpt(source.clause);
      lines.push(
        `#### ${source.role === 'cited' ? 'Citată' : 'Context'}: ${source.clause}`,
        '',
        `${source.locator}, ${source.title}. ${source.status === 'located' ? 'Localizată' : 'Necitită (în așteptare)'}: ${source.summary}`,
        '',
        ...source.snapshots.map((snapshot) => `- Snapshot SHA-256 \`${snapshot.sha256}\``),
        ...(shown?.shown
          ? [
              '',
              ...shown.text.split('\n').map((line) => `> ${line}`),
              '',
              `Extras SHA-256 \`${shown.sha256}\``,
            ]
          : ['', `_${excerptReason(shown?.text ?? 'excerpt unavailable: snapshot missing')}_`]),
        '',
      );
    }
    lines.push(
      '### Lecturi',
      '',
      `- **A. Lectura motorului:** ${item.readings.engine}`,
      `- **B. Lectura alternativă:** ${item.readings.alternative}`,
      '',
      '### Cazuri calculate cu codul motorului',
      '',
    );
    item.cases.forEach((entry, number) => {
      const differs = JSON.stringify(entry.engine) !== JSON.stringify(entry.alternative);
      lines.push(
        `${number + 1}. **${entry.title}**${differs ? ' (lecturile diferă)' : ''}`,
        `   ${entry.facts}`,
        `   - Motorul (A): ${entry.engine.summary}`,
        ...entry.engine.lines.map((line) => `     - ${line}`),
        `   - Alternativa (B): ${entry.alternative.summary}`,
        ...entry.alternative.lines.map((line) => `     - ${line}`),
      );
    });
    lines.push(
      '',
      '### Domeniu',
      '',
      `- Profiluri afectate: ${item.scope.profiles.map((profile) => `${profile.id} (${profile.title})`).join('; ') || 'neadnotate'}`,
      `- Declarații: ${item.scope.obligations.join(', ') || 'neadnotate'}`,
      `- Următorul termen: ${deadlineText(deadline)}`,
      '',
      '### Lacune de sursă',
      '',
      ...(item.gaps.length ? item.gaps.map((gap) => `- ${gap}`) : ['- Niciuna declarată.']),
      '',
      '### Întrebarea',
      '',
      item.question.text,
      '',
      `- [ ] A. ${item.question.options.A}`,
      `- [ ] B. ${item.question.options.B}`,
      `- [ ] C. ${item.question.options.C}`,
      '',
    );
  });
  lines.push(
    '## Recenzent',
    '',
    'Nume, număr de membru CECCAR, calitate și semnătura electronică calificată: în PDF.',
    '',
  );
  return lines.join('\n');
}

/** A flowing layout over A4 pages with one Unicode font. */
class Layout {
  readonly pages: PDFPage[] = [];
  page!: PDFPage;
  y = 0;
  static readonly width = 595.28;
  static readonly height = 841.89;
  static readonly margin = 50;
  missing = new Set<string>();

  constructor(
    private readonly document: PDFDocument,
    private readonly font: PDFFont,
    private readonly has: (codePoint: number) => boolean,
  ) {
    this.newPage();
  }

  newPage() {
    this.page = this.document.addPage([Layout.width, Layout.height]);
    this.pages.push(this.page);
    this.y = Layout.height - Layout.margin;
  }

  ensure(height: number) {
    if (this.y - height < Layout.margin) this.newPage();
  }

  /** Characters the font lacks become '?', and are reported. */
  clean(text: string) {
    return [...text]
      .map((char) => {
        if (char === '\n' || this.has(char.codePointAt(0)!)) return char;
        this.missing.add(char);
        return '?';
      })
      .join('');
  }

  wrap(text: string, size: number, width: number) {
    const lines: string[] = [];
    for (const paragraph of this.clean(text).split('\n')) {
      let line = '';
      for (const word of paragraph.split(' ')) {
        const candidate = line ? `${line} ${word}` : word;
        if (this.font.widthOfTextAtSize(candidate, size) <= width) {
          line = candidate;
          continue;
        }
        if (line) lines.push(line);
        line = word;
        // A word wider than the line (a hash): split it by characters.
        while (this.font.widthOfTextAtSize(line, size) > width) {
          let cut = line.length - 1;
          while (cut > 1 && this.font.widthOfTextAtSize(line.slice(0, cut), size) > width) cut -= 1;
          lines.push(line.slice(0, cut));
          line = line.slice(cut);
        }
      }
      lines.push(line);
    }
    return lines;
  }

  text(
    text: string,
    options: {
      size?: number;
      indent?: number;
      gap?: number;
      color?: [number, number, number];
    } = {},
  ) {
    const size = options.size ?? 9.5;
    const indent = options.indent ?? 0;
    const leading = size * 1.35;
    const [r, g, b] = options.color ?? [0, 0, 0];
    for (const line of this.wrap(text, size, Layout.width - 2 * Layout.margin - indent)) {
      this.ensure(leading);
      this.y -= leading;
      this.page.drawText(line, {
        x: Layout.margin + indent,
        y: this.y,
        size,
        font: this.font,
        color: rgb(r, g, b),
      });
    }
    this.y -= options.gap ?? 3;
  }

  heading(text: string, size = 12) {
    this.ensure(size * 3);
    this.y -= size * 0.6;
    this.text(text, { size, gap: 4, color: [0.1, 0.2, 0.45] });
  }

  /** A box of `height` at the current position, for a form field. */
  box(height: number, indent = 0) {
    this.ensure(height + 6);
    this.y -= height + 3;
    const rect = {
      x: Layout.margin + indent,
      y: this.y,
      width: Layout.width - 2 * Layout.margin - indent,
      height,
    };
    this.y -= 6;
    return rect;
  }
}

export async function renderPdf(
  packet: ReviewPacket,
  packetSha256: string,
  context: PacketContext,
  packetBytes: string,
) {
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  const fontBytes = readFileSync(FONT);
  const font = await document.embedFont(fontBytes, { subset: false });
  const glyphs = fontkit.create(fontBytes) as { hasGlyphForCodePoint(code: number): boolean };
  const created = new Date(`${context.generatedOn}T00:00:00Z`);
  document.setTitle(title(packet));
  document.setSubject(`Amprenta pachetului: ${packetSha256}`);
  document.setAuthor('xFactura');
  document.setCreator('xFactura scripts/review/packet.ts');
  document.setProducer('xFactura (pdf-lib)');
  document.setLanguage('ro-RO');
  document.setCreationDate(created);
  document.setModificationDate(created);
  const form = document.getForm();
  const layout = new Layout(document, font, (code) => glyphs.hasGlyphForCodePoint(code));
  const excerpt = (clause: string) => context.excerpts.find((item) => item.clause === clause);

  layout.text('Pachet de revizuire a regulilor fiscale', {
    size: 17,
    gap: 6,
    color: [0.1, 0.2, 0.45],
  });
  layout.text(title(packet), { size: 11.5, gap: 6 });
  layout.text(`Amprenta pachetului (SHA-256 a fișierului atașat packet.json): ${packetSha256}`, {
    size: 9,
  });
  layout.text(
    `Generat la ${day(context.generatedOn)} de xFactura; ${questions(packet.items.length)}; aproximativ ${context.minutes} minute.`,
    { size: 9, gap: 8 },
  );
  layout.heading('Cum se răspunde');
  instructions.forEach((text, index) => layout.text(`${index + 1}. ${text}`, { indent: 8 }));
  layout.heading('Întrebări');
  packet.items.forEach((item, index) => {
    const deadline = context.deadlines.find((entry) => entry.key === item.key)?.deadline ?? null;
    layout.text(`${index + 1}. ${item.key}: ${item.question.text}`, { indent: 8 });
    layout.text(`Următorul termen: ${deadlineText(deadline)}`, {
      indent: 20,
      size: 8.5,
      color: [0.35, 0.35, 0.35],
    });
  });

  packet.items.forEach((item, index) => {
    layout.newPage();
    const deadline = context.deadlines.find((entry) => entry.key === item.key)?.deadline ?? null;
    layout.text(`Întrebarea ${index + 1}: ${item.key}`, {
      size: 15,
      gap: 4,
      color: [0.1, 0.2, 0.45],
    });
    layout.text(item.description, { gap: 6 });
    layout.heading('Versiuni');
    for (const version of item.versions) layout.text(`• ${versionText(version)}`, { indent: 8 });
    layout.heading('Surse');
    for (const source of item.sources) {
      const shown = excerpt(source.clause);
      layout.text(
        `${source.role === 'cited' ? 'Citată' : 'Context'}: ${source.clause}: ${source.locator}, ${source.title}.`,
        { indent: 8 },
      );
      layout.text(
        `${source.status === 'located' ? 'Localizată' : 'Necitită (în așteptare)'}: ${source.summary}`,
        { indent: 16, size: 9 },
      );
      for (const snapshot of source.snapshots)
        layout.text(`Snapshot SHA-256 ${snapshot.sha256}`, {
          indent: 16,
          size: 8,
          color: [0.35, 0.35, 0.35],
        });
      if (shown?.shown) {
        layout.text(shown.text, { indent: 24, size: 8.5, color: [0.15, 0.15, 0.15] });
        layout.text(`Extras SHA-256 ${shown.sha256}`, {
          indent: 24,
          size: 8,
          color: [0.35, 0.35, 0.35],
        });
      } else
        layout.text(excerptReason(shown?.text ?? 'excerpt unavailable: snapshot missing'), {
          indent: 24,
          size: 8.5,
          color: [0.6, 0.2, 0.1],
        });
      layout.y -= 4;
    }
    layout.heading('Lecturi');
    layout.text(`A. Lectura motorului: ${item.readings.engine}`, { indent: 8 });
    layout.text(`B. Lectura alternativă: ${item.readings.alternative}`, { indent: 8 });
    layout.heading('Cazuri calculate cu codul motorului');
    item.cases.forEach((entry, number) => {
      const differs = JSON.stringify(entry.engine) !== JSON.stringify(entry.alternative);
      layout.text(`${number + 1}. ${entry.title}${differs ? ' (lecturile diferă)' : ''}`, {
        indent: 8,
      });
      layout.text(entry.facts, { indent: 20, size: 9 });
      layout.text(`Motorul (A): ${entry.engine.summary}`, { indent: 20, size: 9 });
      for (const line of entry.engine.lines)
        layout.text(line, { indent: 32, size: 8, color: [0.35, 0.35, 0.35] });
      layout.text(`Alternativa (B): ${entry.alternative.summary}`, { indent: 20, size: 9 });
      for (const line of entry.alternative.lines)
        layout.text(line, { indent: 32, size: 8, color: [0.35, 0.35, 0.35] });
    });
    layout.heading('Domeniu');
    layout.text(
      `Profiluri afectate: ${item.scope.profiles.map((profile) => `${profile.id} (${profile.title})`).join('; ') || 'neadnotate'}.`,
      { indent: 8 },
    );
    layout.text(`Declarații: ${item.scope.obligations.join(', ') || 'neadnotate'}.`, { indent: 8 });
    layout.text(`Următorul termen: ${deadlineText(deadline)}.`, { indent: 8 });
    layout.heading('Lacune de sursă');
    for (const gap of item.gaps.length ? item.gaps : ['Niciuna declarată.'])
      layout.text(`• ${gap}`, { indent: 8 });

    layout.heading(`Întrebarea ${index + 1}`);
    layout.text(item.question.text, { gap: 6 });
    const group = form.createRadioGroup(answerField(index));
    for (const option of ['A', 'B', 'C'] as const) {
      const label = `${option}. ${item.question.options[option]}`;
      const lines = layout.wrap(label, 9.5, Layout.width - 2 * Layout.margin - 22);
      layout.ensure(lines.length * 12.8 + 6);
      group.addOptionToPage(option, layout.page, {
        x: Layout.margin + 2,
        y: layout.y - 12,
        width: 11,
        height: 11,
      });
      layout.text(label, { indent: 22 });
    }
    layout.text('Pentru C, lectura dumneavoastră:', { size: 9, color: [0.35, 0.35, 0.35] });
    const free = form.createTextField(textField(index));
    free.enableMultiline();
    free.addToPage(layout.page, layout.box(60));
  });

  layout.newPage();
  layout.text('Recenzent', { size: 15, gap: 8, color: [0.1, 0.2, 0.45] });
  for (const [field, label] of [
    [reviewerFields.name, 'Numele'],
    [reviewerFields.ceccar, 'Numărul de membru CECCAR'],
    [reviewerFields.role, 'Calitatea (de exemplu: expert contabil)'],
  ] as const) {
    layout.text(label, { size: 9 });
    form.createTextField(field).addToPage(layout.page, layout.box(20));
  }
  layout.y -= 10;
  layout.text(
    `Semnătura electronică calificată (câmpul „${SIGNATURE_FIELD}”). Prin semnare confirmați răspunsurile din acest pachet, cu amprenta ${packetSha256}.`,
    { size: 9 },
  );
  const rect = layout.box(70);
  layout.page.drawRectangle({ ...rect, borderColor: rgb(0.1, 0.2, 0.45), borderWidth: 1 });
  const signature = document.context.obj({
    Type: 'Annot',
    Subtype: 'Widget',
    FT: 'Sig',
    T: PDFString.of(SIGNATURE_FIELD),
    F: 4,
    Rect: [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height],
    P: layout.page.ref,
  });
  const signatureRef = document.context.register(signature);
  layout.page.node.addAnnot(signatureRef);
  form.acroForm.addField(signatureRef);

  layout.pages.forEach((page, index) =>
    page.drawText(`${packet.id} · pagina ${index + 1} din ${layout.pages.length}`, {
      x: Layout.margin,
      y: 25,
      size: 7.5,
      font,
      color: rgb(0.45, 0.45, 0.45),
    }),
  );
  // Empty fields drawn with the standard font: what the reviewer types is read from the field's
  // value, whatever font their reader draws it with.
  form.updateFieldAppearances();

  await document.attach(new TextEncoder().encode(packetBytes), 'packet.json', {
    mimeType: 'application/json',
    description: `Pachetul de revizuire ${packet.id} (JSON canonic; SHA-256 ${packetSha256})`,
    creationDate: created,
    modificationDate: created,
    afRelationship: AFRelationship.Source,
  });
  await document.attach(
    new TextEncoder().encode(`${JSON.stringify(context, null, 2)}\n`),
    'context.json',
    {
      mimeType: 'application/json',
      description: 'Extrasele și termenele din ziua generării (nu intră în amprentă)',
      creationDate: created,
      modificationDate: created,
      afRelationship: AFRelationship.Supplement,
    },
  );
  // Plain objects, not object streams: the importer reads attachments as declarations do.
  const bytes = await document.save({ useObjectStreams: false });
  return { bytes, missingGlyphs: [...layout.missing] };
}
