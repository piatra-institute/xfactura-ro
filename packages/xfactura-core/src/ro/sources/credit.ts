import type { Clause } from './index';

/*
 * The sources of credit notes in a currency (`invoices.credit`, `invoices.euConsumer`): the rate
 * of an adjustment's VAT base and VAT (Codul fiscal art. 282 alin. (9) and the norms' pct. 25
 * alin. (2), registered in the main list; art. 290 alin. (2) and the norms' pct. 35 alin. (6) for
 * the base operation's own rate), and the books' rate (OMFP nr. 1.802/2014 pct. 314, 319, 322
 * and 330). Read on 5 November 2026 in ANAF's consolidated Code with its norms (snapshot
 * ANAF/Cod-fiscal-consolidat) and in the order as ANAF publishes it (snapshot OMFP1802/2014); the
 * portal's consolidated Code of 25.10.2026 (LJR/Cod-fiscal-2025) gives art. 282 alin. (9) in the
 * same words. Kept apart from the main list, which spreads them in.
 */

const CODE = 'ANAF/Cod-fiscal-consolidat';
const OMFP = 'OMFP1802/2014';

export const creditClauses: readonly Clause[] = [
  {
    id: `${CODE}:norme.art.290.pct.35(6)`,
    source: CODE,
    locator: 'normele metodologice, titlul VII, pct. 35 alin. (6) (aplicarea art. 290)',
    status: 'located',
    summary:
      'Pentru operațiunile în interiorul țării cu baza de impozitare în valută, transformarea în lei se face la cursul de la data exigibilității taxei (art. 280–282 alin. (1)–(2)); sub TVA la încasare, la data la care exigibilitatea ar fi intervenit fără sistem.',
  },
  {
    id: `${OMFP}:pct.314(2)-(3)`,
    source: OMFP,
    locator: 'pct. 314 alin. (2)–(3)',
    status: 'located',
    summary:
      'Orice operațiune economico-financiară se consemnează în momentul efectuării ei într-un document justificativ, care probează efectuarea ei.',
  },
  {
    id: `${OMFP}:pct.319`,
    source: OMFP,
    locator: 'pct. 319',
    status: 'located',
    summary:
      'O tranzacție în valută se înregistrează inițial la cursul BNR de la data efectuării operațiunii.',
  },
  {
    id: `${OMFP}:pct.330(1)`,
    source: OMFP,
    locator: 'pct. 330 alin. (1)',
    status: 'located',
    summary:
      'La mărfurile returnate de clienți în exercițiul vânzării se corectează conturile 411, 707, 607 și 371; tratamentul TVA este cel al legislației fiscale.',
  },
  {
    id: `${OMFP}:pct.322`,
    source: OMFP,
    locator: 'pct. 322 alin. (1)–(2)',
    status: 'located',
    summary:
      'Diferențele de curs care apar la decontarea creanțelor și datoriilor în valută la alte cursuri decât cele la care au fost înregistrate inițial în cursul lunii, sau la care sunt înregistrate în contabilitate, se recunosc în luna în care apar, ca venituri sau cheltuieli din diferențe de curs.',
  },
];
