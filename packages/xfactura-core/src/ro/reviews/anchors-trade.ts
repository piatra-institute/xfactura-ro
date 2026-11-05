import type { Anchor } from './types';

/*
 * The excerpts of the clauses of goods across the border (src/ro/sources/trade.ts), as
 * `clauseAnchors` reads them: the Fiscal Code in ANAF's consolidated HTML; OMFP nr. 103/2016,
 * OPANAF nr. 174/2026 and OMFP nr. 1.802/2014 in their PDFs as `pdftotext` gives them (with the
 * cedilla ş and ţ); Regulation (EU) No 282/2011 in the owner's consolidated PDF; VIES's contract
 * in its YAML.
 */
const CODE = 'ANAF/Cod-fiscal-consolidat';

export const tradeAnchors: Readonly<Record<string, readonly Anchor[]>> = {
  [`${CODE}:art.283(1)`]: [
    {
      from: '(1) Prin excepție de la prevederile art. 282, în cazul unei livrări intracomunitare de bunuri, scutite de taxă conform art. 294 alin. (2), exigibilitatea taxei intervine',
      to: 'dacă nu a fost emisă nicio factură/autofactură până la data respectivă.',
    },
  ],
  [`${CODE}:art.285(1)-(2)`]: [
    {
      from: '(1) În cazul în care, la import, bunurile sunt supuse taxelor vamale',
      to: 'dacă bunurile importate ar fi fost supuse unor astfel de taxe.',
    },
  ],
  [`${CODE}:art.289(1)-(2)`]: [
    {
      from: '(1) Baza de impozitare pentru importul de bunuri este valoarea în vamă a bunurilor',
      to: 'primul loc de descărcare a bunurilor în România.',
    },
  ],
  [`${CODE}:art.290(1)`]: [
    {
      from: '(1) Dacă elementele folosite la stabilirea bazei de impozitare a unui import de bunuri se exprimă în valută',
      to: 'prevederilor europene care reglementează calculul valorii în vamă.',
    },
  ],
  [`${CODE}:art.299(1)(c)-(e)`]: [
    {
      from: 'c) pentru taxa achitată pentru importul de bunuri, altele decât cele prevăzute la lit. d)',
      to: 'să dețină o factură sau documentul prevăzut la art. 320 alin. (1);',
    },
  ],
  [`${CODE}:art.326(2)-(5)`]: [
    {
      from: '(2) Prin excepție de la prevederile alin. (1), persoana impozabilă înregistrată conform art. 316 va evidenția în decontul prevăzut la art. 323',
      to: 'în limitele și în condițiile stabilite la art. 297 - 301.',
    },
  ],
  'OMFP103/2016:art.1(4)': [
    {
      from: '(4) Pentru acele operaţiuni care prin natura lor nu permit',
      to: 'obligă persoana impozabilă la colectarea TVA de la data faptului generator de taxă.',
    },
  ],
  'OMFP103/2016:art.2(2)': [
    {
      from: '(2) Scutirea de taxă prevăzută la art. 294 alin. (1) lit. a) din Codul fiscal se justifică de către exportator',
      to: 'certificat pe verso de biroul vamal de ieşire.',
    },
  ],
  'OMFP103/2016:art.10(1),(7)': [
    {
      from: '(1) Scutirea de taxă pentru livrările intracomunitare de bunuri prevăzute la art. 294 alin. (2) lit. a)',
      to: 'contractul/comanda de vânzare/cumpărare, documentele de asigurare.',
    },
    {
      from: '(7) Prin documentele care atestă că bunurile au fost transportate din România în alt stat membru',
      to: 'cu mijloace proprii de transport.',
    },
  ],
  'OMFP103/2016:art.10(6)': [
    {
      from: '(6) Scutirea unei livrări intracomunitare, în sensul articolului 294 alin. (2)',
      to: 'Mecsek Gabona.',
    },
  ],
  'REG282/2011-A:art.45a': [
    {
      from: 'În scopul aplicării scutirilor prevăzute la articolul 138 din Directiva 2006/112/CE, se prezumă',
      to: 'care să ateste depozitarea bunurilor în respectivul stat membru.',
    },
  ],
  'OPANAF174/2026:rd.7': [
    {
      from: 'Rândul 7 - se înscriu informaţiile preluate din jurnalul de cumpărări',
      to: 'cu excepţia celor referitoare la serviciile intracomunitare care se înscriu la rândul 8.',
    },
  ],
  'OPANAF174/2026:rd.24-25': [
    {
      from: 'Rândul 24 - se înscriu informaţiile din jurnalul de cumpărări',
      to: 'pentru care exigibilitatea intervine în perioada de raportare.',
    },
    {
      from: 'Rândul 25 - se înscriu informaţiile din jurnalul de cumpărări',
      to: 'pentru care exigibilitatea intervine în perioada de raportare.',
    },
  ],
  'OMFP1802/2014:conturi.446': [
    {
      from: 'Contul 446 "Alte impozite, taxe şi vărsăminte asimilate" Cu ajutorul acestui cont',
      to: 'Soldul contului reprezintă sumele datorate bugetului statului sau bugetelor locale.',
    },
  ],
  'EC/VIES:checkVatNumber': [
    { from: 'operationId: "checkVatNumber"', to: 'traderCompanyTypeMatch:' },
  ],
};
