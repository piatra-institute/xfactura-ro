import { requireCondition } from '../errors';
import { dateSchema } from '../values';
import {
  bankAccount,
  bankNumber,
  signedBankAmount,
  type BankEntryDocument,
  type BankStatementDocument,
} from './statement-document';

type Field = { tag: string; value: string };
function swiftBodies(text: string) {
  if (!text.trimStart().startsWith('{')) return [text.trim()];
  const bodies: string[] = [];
  let at = 0,
    messageType = '';
  while (at < text.length) {
    if (/\s/.test(text[at])) {
      at++;
      continue;
    }
    requireCondition(
      text[at] === '{' && /^[1-5]:/.test(text.slice(at + 1, at + 3)),
      'MT940_ENVELOPE',
      'Antet SWIFT neacceptat.',
    );
    const kind = text[at + 1];
    if (kind === '4') {
      const match = /(?:^|\n)-\}/g;
      match.lastIndex = at + 3;
      const end = match.exec(text);
      requireCondition(
        end && /^[IO]940/.test(messageType),
        'MT940_ENVELOPE',
        'Este necesar un mesaj SWIFT MT940 complet.',
      );
      bodies.push(text.slice(at + 3, end.index).trim());
      at = match.lastIndex;
    } else {
      let depth = 0,
        end = at;
      for (; end < text.length; end++) {
        if (text[end] === '{') depth++;
        if (text[end] === '}' && --depth === 0) break;
      }
      requireCondition(
        end < text.length && end - at <= 16000,
        'MT940_ENVELOPE',
        'Antet SWIFT incomplet.',
      );
      if (kind === '1') messageType = '';
      if (kind === '2') messageType = text.slice(at + 3, end);
      at = end + 1;
    }
  }
  return bodies;
}
function shortDate(value: string, anchor: string) {
  const year = Number(anchor.slice(0, 4)),
    base = Math.floor(year / 100) * 100 + Number(value.slice(0, 2)),
    selected = [base - 100, base, base + 100].sort(
      (a, b) => Math.abs(a - year) - Math.abs(b - year),
    )[0];
  return dateSchema.parse(`${selected}-${value.slice(2, 4)}-${value.slice(4, 6)}`);
}
function balance(field: Field, anchor: string) {
  const found = /^([CD])(\d{6})([A-Z]{3})(\d{1,16},\d{0,2})$/.exec(field.value);
  requireCondition(found, 'MT940_BALANCE', 'Sold MT940 invalid.');
  requireCondition(
    found[3] === 'RON',
    'UNSUPPORTED_CURRENCY',
    'Sunt acceptate numai extrase contabile în RON.',
  );
  return {
    date: shortDate(found[2], anchor),
    amount: signedBankAmount(bankNumber(found[4], ','), found[1] === 'D' ? 'DBIT' : 'CRDT'),
  };
}
export function parseMt940(
  text: string,
  year: { from: string; to: string },
): BankStatementDocument[] {
  const groups: Field[][] = [];
  for (const body of swiftBodies(text.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, ''))) {
    let group: Field[] | undefined;
    for (const line of body.split('\n')) {
      const tag = /^:(\d{2}[A-Z]?):(.*)$/.exec(line);
      if (tag) {
        if (tag[1] === '20') {
          group = [];
          groups.push(group);
        }
        requireCondition(
          group && ['20', '21', '25', '28C', '60F', '61', '86', '62F', '64', '65'].includes(tag[1]),
          'MT940_FIELD',
          'Câmp MT940 neacceptat sau extras fragmentat.',
        );
        group.push({ tag: tag[1], value: tag[2] });
      } else if (line !== '' && line !== '-') {
        requireCondition(
          group?.length && line.length <= 16000,
          'MT940_FIELD',
          'Linie MT940 fără un câmp valid.',
        );
        group.at(-1)!.value += `\n${line}`;
      }
    }
  }
  return groups.map((fields, ordinal) => {
    const one = (tag: string, optional = false) => {
      const values = fields.filter((field) => field.tag === tag);
      requireCondition(
        values.length <= 1 && (optional || values.length === 1),
        'MT940_FIELD',
        `Câmp MT940 lipsă sau repetat: ${tag}.`,
      );
      return values[0];
    };
    const trn = one('20')!.value.trim(),
      sequence = one('28C')!.value.trim(),
      opening = balance(one('60F')!, year.from),
      closing = balance(one('62F')!, year.to),
      account = bankAccount(one('25')!.value.trim());
    requireCondition(
      trn.length > 0 && trn.length <= 100 && /^[0-9]{1,5}(?:\/[0-9]{1,5})?$/.test(sequence),
      'MT940_ID',
      'Referință sau număr de extras MT940 invalid.',
    );
    const start = fields.indexOf(one('60F')!),
      finish = fields.indexOf(one('62F')!);
    requireCondition(
      start < finish &&
        fields.slice(0, start).every((field) => ['20', '21', '25', '28C'].includes(field.tag)) &&
        fields.slice(finish + 1).every((field) => ['64', '65', '86'].includes(field.tag)),
      'MT940_ORDER',
      'Ordinea câmpurilor MT940 nu este acceptată.',
    );
    const entries: BankEntryDocument[] = [];
    for (let i = start + 1; i < finish; i++) {
      const field = fields[i];
      requireCondition(
        field.tag === '61',
        'MT940_ORDER',
        'Detaliu MT940 fără o înregistrare bancară.',
      );
      const [first, ...continuations] = field.value.split('\n'),
        found = /^(\d{6})(\d{4})?(RC|RD|C|D)([A-Z])?(\d{1,16},\d{0,2})([A-Z][A-Z0-9]{3})(.*)$/.exec(
          first,
        );
      requireCondition(found, 'MT940_ENTRY', 'Înregistrare MT940 invalidă.');
      requireCondition(
        !found[4] || found[4] === 'N',
        'UNSUPPORTED_CURRENCY',
        'Codul valutei tranzacției nu corespunde contului RON.',
      );
      const valueDate = shortDate(found[1], closing.date),
        mmdd = found[2];
      let date = valueDate;
      if (mmdd) {
        const candidates = [
          Number(closing.date.slice(0, 4)) - 1,
          Number(closing.date.slice(0, 4)),
          Number(closing.date.slice(0, 4)) + 1,
        ]
          .map((y) => `${y}-${mmdd.slice(0, 2)}-${mmdd.slice(2)}`)
          .filter(
            (d) =>
              dateSchema.safeParse(d).success &&
              d >= opening.date &&
              d <= closing.date &&
              d >= year.from &&
              d <= year.to,
          );
        requireCondition(
          candidates.length === 1,
          'BANK_BOOKING_DATE',
          'Anul datei de înregistrare este ambiguu.',
        );
        date = candidates[0];
      } else
        requireCondition(
          opening.date === closing.date && valueDate === closing.date,
          'BANK_BOOKING_DATE_REQUIRED',
          'Lipsește data de înregistrare MT940; data valutei nu o poate înlocui.',
        );
      const rest = found[7],
        separator = rest.indexOf('//'),
        client = (separator < 0 ? rest.slice(0, 16) : rest.slice(0, separator)).trim(),
        bank = separator < 0 ? null : rest.slice(separator + 2, separator + 18).trim() || null;
      requireCondition(
        client.length <= 16,
        'MT940_REFERENCE',
        'Referința MT940 depășește lungimea acceptată.',
      );
      let information = '';
      if (fields[i + 1]?.tag === '86') information = fields[++i].value;
      const marker = found[3],
        amount = signedBankAmount(
          bankNumber(found[5], ','),
          marker === 'D' || marker === 'RC' ? 'DBIT' : 'CRDT',
        );
      entries.push({
        ordinal: entries.length,
        date,
        valueDate,
        bookingDateTime: null,
        valueDateTime: null,
        amount,
        reference:
          [
            information,
            ...continuations,
            separator < 0 ? rest.slice(16) : rest.slice(separator + 18),
          ]
            .filter(Boolean)
            .join('\n') ||
          client ||
          bank ||
          found[6],
        bankReference: bank,
        entryReference: null,
        customerReference: client || null,
        transactionCode: found[6],
        reversal: marker.startsWith('R'),
        raw: `:61:${field.value}${information ? `\n:86:${information}` : ''}`,
        charges: [],
        details: [],
      });
    }
    for (const extra of fields.filter((field) => field.tag === '64' || field.tag === '65'))
      balance(extra, year.to);
    return {
      ordinal,
      format: 'mt940',
      sourceId: `${trn}/${sequence}`,
      messageId: trn,
      sequence,
      bankAccount: account,
      currency: 'RON',
      from: opening.date,
      to: closing.date,
      openingDate: opening.date,
      closingDate: closing.date,
      opening: opening.amount,
      closing: closing.amount,
      reportedFrom: null,
      reportedTo: null,
      entries,
    };
  });
}
