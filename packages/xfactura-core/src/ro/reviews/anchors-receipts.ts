import type { Anchor } from './types';

/*
 * The excerpts of the receipts' and reverse charge's clauses (src/ro/sources/receipts.ts), as
 * `clauseAnchors` reads them: the Fiscal Code in ANAF's consolidated HTML and in the portal's
 * consolidated form of 2025, with its amendment notes.
 */
const CODE = 'ANAF/Cod-fiscal-consolidat';
const PORTAL = 'LJR/Cod-fiscal-2025';

export const receiptAnchors: Readonly<Record<string, readonly Anchor[]>> = {
  [`${CODE}:art.319(10)(a)`]: [
    {
      from: 'a) livrările de bunuri prin magazinele de comerț cu amănuntul și prestările de servicii către populație, pentru care este obligatorie emiterea de bonuri fiscale',
      to: 'republicată, cu modificările și completările ulterioare;',
    },
  ],
  [`${CODE}:art.319(12)`]: [
    {
      from: '(12) Persoana impozabilă care are obligația de a emite facturi conform prezentului articol, precum și',
      to: 'beneficiază de regimul de scutire prevăzut la art. 310 și 3102.',
    },
  ],
  [`${CODE}:art.319(13)`]: [
    {
      from: '(13) În urma consultării Comitetului TVA',
      to: 'conform procedurii stabilite prin normele metodologice:',
    },
  ],
  [`${CODE}:art.319(21)`]: [
    {
      from: '(21) Facturile emise în sistem simplificat în condițiile prevăzute la alin. (12) și (13)',
      to: 'dacă acesta este o persoană impozabilă ori o persoană juridică neimpozabilă.',
    },
  ],
  [`${CODE}:art.290(2)`]: [
    {
      from: '(2) Dacă elementele folosite pentru stabilirea bazei de impozitare a unei operațiuni, alta decât importul de bunuri',
      to: 'valabil la data la care intervine exigibilitatea taxei pentru operațiunea în cauză',
    },
  ],
  [`${CODE}:art.299(1)(a)`]: [
    {
      from: '(1) Pentru exercitarea dreptului de deducere a taxei, persoana impozabilă trebuie să îndeplinească următoarele condiții:',
      to: 'persoanele impozabile care achiziționează bunuri/servicii de la persoane impozabile în perioada în care aplică sistemul TVA la încasare;',
    },
  ],
  [`${CODE}:norme.art.299.pct.69(3),(6)`]: [
    {
      from: '(3) Facturile emise în condițiile prevăzute la art. 319 alin. (12), (13) și (21) din Codul fiscal constituie',
      to: 'codul de înregistrare în scopuri de TVA al beneficiarului.',
    },
    {
      from: '(6) Pentru achizițiile de bunuri și servicii pe bază de bonuri fiscale',
      to: 'Prevederile acestui alineat se completează cu cele ale pct. 67.',
    },
  ],
  [`${CODE}:art.331(1)-(3)`]: [
    {
      from: '(1) Prin excepție de la prevederile art. 307 alin. (1), în cazul operațiunilor taxabile, persoana obligată la plata taxei este beneficiarul',
      to: 'Beneficiarii au drept de deducere a taxei în limitele și în condițiile stabilite la art. 297 - 301.',
    },
  ],
  [`${CODE}:art.331(4)-(7)`]: [
    {
      from: '(4) De aplicarea prevederilor prezentului articol sunt responsabili atât furnizorii, cât și beneficiarii.',
      to: 'este mai mare sau egală cu 22.500 lei.',
    },
  ],
  [`${CODE}:norme.art.331.pct.109(1)`]: [
    {
      from: '109. (1) Taxarea inversă prevăzută la art. 331 din Codul fiscal reprezintă',
      to: 'Prevederile acestui alineat sunt valabile pentru orice alte situații în care se aplică taxarea inversă.',
    },
  ],
  [`${CODE}:norme.art.331.pct.109(4)`]: [
    {
      from: '(4) În cazul neaplicării taxării inverse prevăzute de lege',
      to: 'nu este posibilă din cauza falimentului furnizorului/prestatorului.',
    },
  ],
  [`${CODE}:norme.art.331.pct.109(7)`]: [
    {
      from: '(7) Codurile NC aferente cerealelor, plantelor tehnice',
      to: '121291 Sfeclă de zahăr',
    },
  ],
  [`${CODE}:norme.art.331.pct.109(19)`]: [
    {
      from: '(19) În sensul art. 331 alin. (7) din Codul fiscal',
      to: 'Pentru imprimantele și camerele video înscrise în factură se aplică regimul normal de taxare.',
    },
  ],
  [`${PORTAL}:art.319(12)`]: [
    {
      from: '(12) Persoana impozabilă care are obligația de a emite facturi conform prezentului articol',
      to: 'publicată în MONITORUL OFICIAL nr. 806 din 29 august 2025',
    },
  ],
  [`${PORTAL}:art.331(6)`]: [
    {
      from: '(6) Prevederile alin. (2) lit. c)',
      to: 'publicată în MONITORUL OFICIAL nr. 594 din 17 iunie 2022',
    },
  ],
};
