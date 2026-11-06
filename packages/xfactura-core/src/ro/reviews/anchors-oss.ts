import type { Anchor } from './types';

/*
 * The excerpts of the distance sales' and the One Stop Shop's clauses (src/ro/sources/oss.ts), as
 * `clauseAnchors` reads them: the Fiscal Code in ANAF's consolidated HTML, OPANAF nr. 174/2026
 * and ANAF's D398 structure in their PDFs as `pdftotext` gives them; OUG nr. 120/2021 and
 * Regulation (EU) No 282/2011 in the owner's consolidated PDFs (the Regulation spells ţ with a
 * cedilla).
 */
const CODE = 'ANAF/Cod-fiscal-consolidat';
const EFACTURA = 'OUG120/2021-A';
const REGULATION = 'REG282/2011-A';

export const ossAnchors: Readonly<Record<string, readonly Anchor[]>> = {
  [`${CODE}:art.275(2)`]: [
    {
      from: '(2) Prin excepție de la prevederile alin. (1) lit. a), locul livrării în cazul vânzărilor intracomunitare de bunuri la distanță',
      to: 'în momentul în care se încheie expedierea sau transportul bunurilor către client.',
    },
  ],
  [`${CODE}:art.278(5)(h)`]: [
    {
      from: 'h) locul unde beneficiarul este stabilit, își are domiciliul stabil sau reședința obișnuită, în cazul următoarelor servicii prestate către o persoană neimpozabilă:',
      to: '3. serviciile furnizate pe cale electronică.',
    },
  ],
  [`${CODE}:art.278^1(1)-(2)`]: [
    {
      from: 'nu se aplică dacă sunt îndeplinite cumulativ următoarele condiții:',
      to: 'se aplică de la momentul depășirii pragului.',
    },
  ],
  [`${CODE}:art.278^1(3)`]: [
    {
      from: 'care sunt stabilite sau, dacă nu sunt stabilite, își au domiciliul stabil sau reședința obișnuită în România au dreptul de a opta',
      to: 'Opțiunea se aplică pentru cel puțin doi ani calendaristici.',
    },
  ],
  [`${CODE}:art.278^1(5)`]: [
    {
      from: 'Valoarea echivalentă în moneda națională a statelor membre a sumei prevăzute la alin. (1) lit. c)',
      to: 'Pentru România, valoarea echivalentă în moneda națională este de 46.337 lei.',
    },
  ],
  [`${CODE}:art.315(6)-(6^1)`]: [
    {
      from: 'persoana impozabilă trebuie să depună la organul fiscal competent, prin mijloace electronice, o declarație specială de TVA, potrivit modelului stabilit în anexa III din Regulamentul de punere în aplicare (UE) 2020/194, indiferent dacă au fost sau nu efectuate livrări de bunuri',
      to: 'chiar dacă aceasta este o zi nelucrătoare.',
    },
  ],
  [`${CODE}:art.315(11)`]: [
    {
      from: 'modificările respective se includ într-o declarație ulterioară în termen de cel mult trei ani de la data la care trebuia depusă declarația inițială potrivit alin. (6).',
      to: 'care poate fi și negativă.',
    },
  ],
  [`${CODE}:art.315(12)-(13)`]: [
    {
      from: '(12) Declarația specială de TVA se întocmește în euro. În cazul în care livrările de bunuri și prestările de servicii se plătesc în alte monede',
      to: 'până la data la care are obligația depunerii declarației speciale.',
    },
  ],
  [`${CODE}:art.315(7)-(10)`]: [
    {
      from: '(7) Declarația specială de TVA trebuie să conțină următoarele informații:',
      to: 'defalcat pe fiecare stat membru de consum.',
    },
  ],
  'OPANAF3769/2015:anexa2.sect2': [
    {
      from: 'Listele operaţiunilor taxabile efectuate pe teritoriul naţional cuprind următoarele tipuri de',
      to: 'exceptate de la obligaţia utilizării aparatelor de marcat electronice fiscale.',
    },
  ],
  // The workbook has no text extraction: the anchors name the cells, the packet says so.
  'ANAF/D406:Livrari.310340-310346': [
    {
      from: 'Livrări de bunuri expediate/ transportate din RO sau servicii prestate din RO',
      to: 'În funcție de Cota TVA din statul membru în care sa fac livrările.',
    },
  ],
  'ANAF/D398:structura': [{ from: 'D398 Declaratie speciala de TVA', to: 'Tip REDUS' }],
  // An XML file has no text extraction: the anchors name the elements, the packet says so.
  'ECB/eurofxref:reference-rates': [{ from: '<gesmes:subject>Reference rates', to: '</Cube>' }],
  'OPANAF174/2026:rd.3': [
    {
      from: 'Rândul 3 - se înscriu informaţiile preluate din jurnalul de vânzări',
      to: 'cu excepţia celor referitoare la serviciile intracomunitare care se înscriu la rândul 4.',
    },
  ],
  'OPANAF174/2026:rd.17-18': [
    {
      from: 'Rândul 17 - se înscriu informaţiile preluate din jurnalul de vânzări',
      to: 'nedeclararea din eroare a operaţiunilor respective în perioada în care intervine exigibilitatea etc.',
    },
  ],
  [`${EFACTURA}:art.2(1)(n^1)`]: [
    {
      from: 'n^1) relația B2C - tranzacția având ca obiect execuția de lucrări',
      to: 'pentru care se aplică prevederile lit. m) și ale art. 9^1;',
    },
  ],
  [`${EFACTURA}:art.10(1)-(1^2)`]: [
    {
      from: '(1) În relația comercială B2B, între persoane impozabile stabilite în România',
      to: 'un cod de înregistrare în scopuri de TVA din alt stat membru.',
    },
    {
      from: '(1^1) Persoanele impozabile stabilite în România conform art. 266 alin. (2)',
      to: 'Furnizorii/Prestatorii prevăzuți la alin. (1^1) sunt obligați să transmită facturile emise către destinatari conform prevederilor art. 319 din Legea nr. 227/2015, cu modificările și completările ulterioare.',
    },
  ],
  [`${EFACTURA}:art.10(7)`]: [
    {
      from: '(7) Termenul-limită pentru transmiterea facturilor în sistemul național',
      to: 'expirării termenelor.',
    },
  ],
  [`${EFACTURA}:art.10^1(2)`]: [
    {
      from: '(2) Începând cu data de 1 ianuarie 2025, operatorii economici - persoane impozabile stabilite în România',
      to: '(12), (13) și (21) din Legea nr. 227/2015, cu modificările și completările ulterioare.',
    },
    {
      from: '(2^1) Termenul-limită pentru transmiterea facturilor',
      to: 'expirării termenelor.',
    },
  ],
  [`${EFACTURA}:art.10^1(3)-(4)`]: [
    {
      from: '(3) Livrările de bunuri/Prestările de servicii efectuate către o persoană fizică',
      to: 'conform prevederilor art. 319 din Legea nr. 227/2015, cu modificările și completările ulterioare, cu excepția situației în care beneficiarii sunt înscriși în Registrul RO e-Factura opțional.',
    },
  ],
  [`${EFACTURA}:art.10^3-10^10`]: [
    {
      from: 'care emit facturi pentru operațiuni care nu sunt în sfera de aplicare a TVA',
      to: 'cu excepția situației în care beneficiarii sunt înscriși în Registrul RO e-Factura opțional.',
    },
    {
      from: '(1) Furnizorii/Prestatorii care se identifică fiscal prin codul numeric personal nu au obligația',
      to: 'prevederile art. 5, 9^1, art. 10 alin. (1) și art. 10^1 alin. (2).',
    },
  ],
  [`${REGULATION}:art.24a`]: [
    {
      from: 'În aplicarea articolelor 44, 58 și 59a din Directiva 2006/112/CE,',
      to: 'ţara în care începe operaţiunea de transport de călători.',
    },
  ],
  [`${REGULATION}:art.24b`]: [
    {
      from: '(a) prin linia sa telefonică fixă',
      to: 'la data adoptării Regulamentului de punere în aplicare (UE) 2017/2459',
    },
  ],
  [`${REGULATION}:art.24d`]: [
    {
      from: 'prestatorul poate răsturna o prezumţie',
      to: 'improprie sau de abuz din partea prestatorului.',
    },
  ],
  [`${REGULATION}:art.24f`]: [
    {
      from: 'îndeplinirii cerinţelor prevăzute la articolul 24b primul paragraf litera',
      to: '(f) alte informaţii relevante din punct de vedere comercial.',
    },
  ],
  [`${REGULATION}:art.57d`]: [
    {
      from: 'regimul special respectiv se aplică începând cu prima zi a trimestrului calendaristic următor.',
      to: 'nu mai târziu de cea de a zecea zi a lunii următoare primei livrări sau prestări în cauză.',
    },
  ],
  [`${REGULATION}:art.61`]: [
    {
      from: 'Cifrele înscrise într-o declaraţie de TVA care se referă la perioade până la a doua perioadă',
      to: 'nu se aduce atingere normelor statului membru de consum referitoare la evaluări și modificări.',
    },
  ],
};
