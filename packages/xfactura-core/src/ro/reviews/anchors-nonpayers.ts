import type { Anchor } from './types';

/*
 * The excerpts of the non-payers' clauses (src/ro/sources/nonpayers.ts), as `clauseAnchors`
 * reads them: the Fiscal Code in ANAF's consolidated HTML, the orders and the chart in their PDFs
 * as `pdftotext` gives them.
 */
const CODE = 'ANAF/Cod-fiscal-consolidat';

export const nonpayerAnchors: Readonly<Record<string, readonly Anchor[]>> = {
  [`${CODE}:art.310(4)-(5)`]: [
    {
      from: '(4) O persoană impozabilă nou-înființată poate beneficia de aplicarea regimului special de scutire',
      to: 'plafonul de scutire este plafonul prevăzut la alin. (1).',
    },
  ],
  [`${CODE}:art.310(6^1)-(6^3)`]: [
    {
      from: '(61) Dacă organele fiscale competente constată că persoana impozabilă nu a respectat prevederile alin. (6)',
      to: 'ori într-un decont ulterior.',
    },
  ],
  [`${CODE}:art.310(7)`]: [
    {
      from: '(7) Persoana impozabilă înregistrată în scopuri de TVA conform art. 316 care în cursul anului calendaristic precedent',
      to: 'efectuării tuturor ajustărilor de taxă, conform prezentului titlu.',
    },
  ],
  [`${CODE}:art.316(1)(b),(1^1)`]: [
    {
      from: 'b) dacă în cursul unui an calendaristic depășește plafonul de scutire prevăzut la art. 310 alin. (1), cel târziu la data depășirii plafonului;',
      to: 'cel târziu la data depășirii plafonului;',
    },
    {
      from: '(11) În cazul în care o persoană este obligată să solicite înregistrarea în condițiile alin. (1), (2), (4) sau (6)',
      to: 'dacă persoana impozabilă nu aplică regimul special de scutire prevăzut la art. 3102.',
    },
  ],
  [`${CODE}:art.316(11)(g),(13)`]: [
    {
      from: 'g) în situația persoanelor impozabile care solicită scoaterea din evidența persoanelor înregistrate în scopuri de TVA în vederea aplicării regimului special de scutire',
      to: 'art. 3151;',
    },
    {
      from: '(13) Persoanele impozabile aflate în situațiile prevăzute la alin. (11) au obligația să depună ultimul decont de taxă',
      to: 'comunicată decizia de anulare a înregistrării în scopuri de TVA.',
    },
  ],
  [`${CODE}:art.317(1)`]: [
    {
      from: '(1) Are obligația să solicite înregistrarea în scopuri de TVA, conform prezentului articol:',
      to: 'conform art. 307 alin. (2), înaintea primirii serviciilor respective;',
    },
  ],
  [`${CODE}:art.307(2)`]: [
    {
      from: '(2) Taxa este datorată de orice persoană impozabilă, inclusiv de către persoana juridică neimpozabilă înregistrată în scopuri de TVA conform art. 316 sau 317, care este beneficiar al serviciilor',
      to: 'chiar dacă este înregistrată în România conform art. 316 alin. (4) sau (6).',
    },
  ],
  [`${CODE}:art.324(1)-(2)`]: [
    {
      from: '(1) Decontul special de taxă se depune la organele fiscale competente de către persoanele care nu sunt înregistrate',
      to: 'Decontul special de taxă trebuie depus numai pentru perioadele în care ia naștere exigibilitatea taxei.',
    },
  ],
  [`${CODE}:art.325(1)`]: [
    {
      from: '(1) Orice persoană impozabilă înregistrată în scopuri de TVA conform art. 316 sau 317 trebuie să întocmească',
      to: 'de la persoane impozabile nestabilite în România, dar stabilite în Uniunea Europeană.',
    },
  ],
  [`${CODE}:art.305(2)-(5)`]: [
    {
      from: '(2) Taxa deductibilă aferentă bunurilor de capital, în condițiile în care nu se aplică regulile privind livrarea către sine',
      to: 'dacă acestea au fost achiziționate sau fabricate după data aderării;',
    },
    {
      from: '(5) Ajustarea taxei deductibile se efectuează astfel:',
      to: 'incluzând anul în care apare modificarea destinației de utilizare;',
    },
    {
      from: 'c) pentru cazurile prevăzute la alin. (4) lit. c) ajustarea se efectuează în cadrul perioadei de ajustare',
      to: 'incluzând anul în care apare modificarea destinației de utilizare;',
    },
  ],
  [`${CODE}:art.322(4)-(5)`]: [
    {
      from: '(4) Întreprinderile mici care se înregistrează în scopuri de TVA, conform art. 316, în cursul anului',
      to: 'achiziții intracomunitare de bunuri înainte de înregistrarea în scopuri de TVA conform art. 316.',
    },
    {
      from: '(5) Dacă cifra de afaceri efectiv obținută în anul înregistrării',
      to: 'una sau mai multe achiziții intracomunitare de bunuri.',
    },
  ],
  [`${CODE}:norme.art.291.pct.36(b)`]: [
    {
      from: 'b) contrapartida unei livrări de bunuri/prestări de servicii trebuie considerată ca incluzând deja taxa pe valoarea adăugată',
      to: 'o declarație pe propria răspundere a furnizorului.',
    },
  ],
  [`${CODE}:norme.art.310.pct.83(7)-(8),(11)-(12)`]: [
    {
      from: '(7) Persoana impozabilă care solicită scoaterea din evidența persoanelor înregistrate în scopuri de TVA conform art. 316 din Codul fiscal în vederea aplicării regimului special de scutire are obligația',
      to: 'vor solicita plata ori vor dispune restituirea taxei rezultate ca urmare a ajustării.',
    },
    {
      from: '(11) În sensul art. 310 alin. (11) din Codul fiscal, persoanele impozabile care solicită înregistrarea în scopuri de taxă prin opțiune',
      to: 'a persoanei impozabile sau, după caz, într-un decont ulterior.',
    },
  ],
  [`${CODE}:norme.art.310.pct.84(2)-(3)`]: [
    {
      from: '(2) În cazul în care persoana impozabilă a atins sau a depășit plafonul de scutire și nu a solicitat înregistrarea în scopuri de TVA conform legii',
      to: 'în scopuri de taxă dacă ar fi solicitat înregistrarea în termenul prevăzut de lege și data la care a fost înregistrată.',
    },
  ],
  [`${CODE}:norme.art.317.pct.90(4)`]: [
    {
      from: '(4) Înregistrarea în scopuri de TVA conform art. 317 alin. (1) lit. b) și c) din Codul fiscal se solicită numai de persoanele',
      to: 'în beneficiul unei persoane impozabile stabilite în România.',
    },
  ],
  'L82/1991:art.27(8)': [
    {
      from: '(8) Exerciţiul financiar al unităţilor nou-înfiinţate începe la data înfiinţării',
      to: 'potrivit legii.',
    },
  ],
  'OMFP1802/2014:cont.4423': [
    {
      from: 'Contul 4423 "Taxa pe valoarea adăugată de plată" Cu ajutorul acestui cont',
      to: 'Soldul contului reprezintă taxa pe valoarea adăugată de plată.',
    },
  ],
  'OPANAF592/2016:anexa2.pct.I': [
    {
      from: 'Secţiunea 4 "Operaţiuni prevăzute la art. 307 alin. (2), (3), (5) şi (6) din Codul fiscal" se',
      to: 'art. 316 alin. (4) sau (6) din Codul fiscal.',
    },
  ],
  'OPANAF592/2016:anexa2.pct.II': [
    {
      from: 'a) până la data de 25 inclusiv a lunii următoare celei în care ia naştere exigibilitatea operaţiunilor',
      to: 'pentru care se datorează taxă pe valoarea adăugată în România;',
    },
  ],
  'OPANAF174/2026:rd.16': [
    {
      from: 'Rândul 16 - se evidenţiază sumele rezultate din corectarea informaţiilor de la rândurile 9, 10, 11, şi 12',
      to: 'cum ar fi nedeclararea din eroare a operaţiunii în perioada în care intervine exigibilitatea.',
    },
  ],
  'OPANAF174/2026:rd.33-34': [
    {
      from: 'Rândul 33 - se evidenţiază sumele rezultate din corectarea taxei deduse',
      to: 'cum ar fi nedeclararea din eroare a operaţiunii în perioada în care intervine exigibilitatea.',
    },
    {
      from: 'Rândul 34 - se înscriu diferenţele de taxă pe valoarea adăugată rezultate ca urmare a ajustării anuale',
      to: 'cu semnul plus sau minus, după caz.',
    },
  ],
};
