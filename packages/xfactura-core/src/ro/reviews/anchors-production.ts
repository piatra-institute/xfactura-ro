import type { Anchor } from './types';

/*
 * The excerpts of production's clauses (src/ro/sources/production.ts), as `clauseAnchors` reads
 * them from OMFP nr. 1.802/2014 as the legislative portal consolidates it (the owner's copy), as
 * `pdftotext` gives it.
 */
export const productionAnchors: Readonly<Record<string, readonly Anchor[]>> = {
  'OMFP1802/2014-A:pct.8(7)': [
    {
      from: '7. cost de producție înseamnă prețul de achiziție al materiilor prime',
      to: 'În costul de producție nu se includ costurile de distribuție;',
    },
  ],
  'OMFP1802/2014-A:pct.79': [
    {
      from: '79. - (1) Exemple de costuri care nu trebuie incluse în costul stocurilor',
      to: 'pierderea de capacitate rezultată din întreținerea planificată a echipamentului.',
    },
  ],
  'OMFP1802/2014-A:pct.286(1)-(3)': [
    {
      from: '286. - (1) În funcție de specificul activității',
      to: 'fiind recunoscute în costul activului.',
    },
  ],
  'OMFP1802/2014-A:pct.288': [
    {
      from: '288. - Valoarea produselor și serviciilor în curs de execuție',
      to: 'evaluarea acesteia la costurile de producție.',
    },
  ],
  'OMFP1802/2014-A:pct.330(2)': [
    {
      from: '(2) Prevederile alin. (1) se aplică și în cazul returului de produse finite vândute',
      to: 'și 345 "Produse finite".',
    },
  ],
  'OMFP1802/2014-A:pct.435(1)(b)': [
    {
      from: 'b) venituri aferente costului producției, reprezentând variația',
      to: 'neluând în calcul ajustările pentru depreciere reflectate;',
    },
  ],
  'OMFP1802/2014-A:pct.593(4)': [
    {
      from: '(4) Pentru organizarea contabilității de gestiune, nu este obligatorie',
      to: 'clasa 9 "Conturi de gestiune".',
    },
  ],
  'OMFP1802/2014-A:conturi.331-332': [
    {
      from: 'Contul 331 "Produse în curs de execuție" Cu ajutorul',
      to: 'Soldul contului reprezintă valoarea la cost de producție a serviciilor în curs de execuție la sfârșitul perioadei.',
    },
  ],
  'OMFP1802/2014-A:conturi.341-346': [
    {
      from: 'Contul 341 "Semifabricate" Cu ajutorul',
      to: 'Soldul contului reprezintă valoarea la preț de înregistrare a produselor reziduale existente în stoc la sfârșitul perioadei.',
    },
  ],
  'OMFP1802/2014-A:conturi.348': [
    {
      from: 'Contul 348 «Diferențe de preț la produse»*26) Notă',
      to: 'Soldul contului reprezintă diferențele de preț aferente produselor existente în stoc.',
    },
  ],
  'OMFP1802/2014-A:conturi.711-712': [
    {
      from: 'Contul 711 «Venituri aferente costurilor stocurilor de produse» Cu ajutorul',
      to: 'reluarea serviciilor în curs de execuție, la începutul perioadei (332).',
    },
  ],
};
