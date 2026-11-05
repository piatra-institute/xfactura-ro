import type { Anchor } from './types';

/** Where the withholding clauses (sources/withholding.ts) start and end in their snapshots'
 * text, each in its own spelling (the consolidated code writes art. 84^1 as „841”). */
export const withholdingAnchors: Readonly<Record<string, readonly Anchor[]>> = {
  // The dividend clauses the dividend rate's packet now cites.
  'ANAF/Cod-fiscal-consolidat:art.43(2)': [
    {
      from: '(1) O persoană juridică română care plătește dividende către o persoană juridică română',
      to: 'până la data de 25 inclusiv a lunii următoare celei în care se plătește dividendul.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.97(7)': [
    {
      from: '(7) *)Veniturile sub formă de dividende',
      to: 'se aplică veniturilor din dividende distribuite începând cu data de 1 ianuarie 2026.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.84^1(3)-(6)': [
    {
      from: '(1) În cazul veniturilor din cedarea folosinței bunurilor, altele decât cele din arendarea bunurilor agricole și din închirierea pe termen scurt',
      to: 'până la data de 25 inclusiv a lunii următoare celei în care a fost reținut.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.84^1(8)-(9)': [
    {
      from: '(8) Prin excepție de la prevederile alin. (3) - (6)',
      to: 'aferentă anului în care au fost realizate veniturile.',
    },
  ],
  'LJR/Cod-fiscal-2025:art.84^1': [
    {
      from: 'Articolul 84^1Reguli privind stabilirea impozitului',
      to: 'Capitolul IV, Titlul IV a fost completat de Punctul 64., Articolul LIII, Capitolul II din ORDONANȚA DE URGENȚĂ nr. 115 din 14 decembrie 2023, publicată în MONITORUL OFICIAL nr. 1139 din 15 decembrie 2023',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.72(2)-(6)': [
    {
      from: '(1) Contribuabilii care realizează venituri din drepturi de proprietate intelectuală datorează impozit pe venit',
      to: 'pentru care plata impozitului pe venit se face de către fiecare asociat, pentru venitul său propriu.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.73': [
    {
      from: '(1) Contribuabilii care obțin venituri din drepturi de proprietate intelectuală au dreptul să opteze',
      to: 'este obligatorie pentru contribuabil pe o perioadă de 2 ani fiscali consecutivi',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.151(5)-(8)': [
    {
      from: '(5) Plătitorii de venituri din drepturi de proprietate intelectuală prevăzuți la art. 72 alin. (2)',
      to: 'Plata contribuției de asigurări sociale se efectuează în cadrul aceluiași termen.',
    },
    {
      from: '(3) Prin excepție de la prevederile alin. (2), pentru persoanele fizice care realizează venituri din drepturi de proprietate intelectuală, din arendă',
      to: 'sunt cei prevăzuți la art. 72 alin. (2).',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.132(2)-exceptii': [
    {
      from: '(2) Plătitorii de venituri cu regim de reținere la sursă a impozitelor au obligația',
      to: 'evidența nominală a persoanelor asigurate.',
    },
    {
      from: '(3) Prevederile alin. (2) sunt aplicabile și în cazul plătitorilor de venituri prevăzuți la art. 84',
      to: 'alin. (8).',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.97(7)-interimare': [
    {
      from: '2) Conform art. VII alin. (2) din Legea nr. 141/2025',
      to: 'aprobate potrivit legii.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.7.pct.36': [
    { from: '36. redevență :', to: 'a comunicațiilor electronice între operatori;' },
  ],
  'ANAF/Cod-fiscal-consolidat:norme.art.223.pct.2': [
    {
      from: '(3) În cazul unei tranzacții care implică transferul de software',
      to: 'exclusiv în scopul de a permite exploatarea programului pe mai multe computere sau în rețeaua primitorului.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.223(1)': [
    {
      from: '(1) Veniturile impozabile obținute din România, indiferent',
      to: 'de la fiduciar la beneficiarul nerezident în cadrul operațiunii de fiducie.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.223(2)': [
    {
      from: '(2) Următoarele venituri impozabile obținute din România nu sunt impozitate',
      to: 'definite la art. 108 alin. (3).',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.224(4)(b)': [
    { from: 'b) 16% pentru veniturile din dividende prevăzute la art. 223', to: 'lit. a);' },
  ],
  'ANAF/Cod-fiscal-consolidat:art.224(4)(c)': [
    {
      from: 'c) 50% pentru veniturile prevăzute la art. 223',
      to: 'calificate ca fiind artificiale conform art. 11 alin. (3);',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.224(4)(c^1)': [
    {
      from: 'c1) 10% în cazul veniturilor impozabile',
      to: 'convenție de evitare a dublei impuneri;',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.224(4)(d)': [
    { from: 'd) 16% în cazul oricăror altor venituri impozabile', to: 'art. 223 alin. (1).' },
  ],
  'ANAF/Cod-fiscal-consolidat:art.224(5)': [
    {
      from: '(1) Impozitul datorat de nerezidenți pentru veniturile impozabile obținute din România',
      to: 'până la termenul de plată a acestuia la bugetul de stat.',
    },
    {
      from: '(5) Impozitul se calculează, respectiv se reține în momentul plății venitului',
      to: 'pentru ziua în care se efectuează plata venitului către nerezidenți.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.229(1)': [
    {
      from: '(1) Sunt scutite de impozitul pe veniturile obținute din România de nerezidenți următoarele venituri:',
      to: 'g) veniturile din dobânzi și redevențe, care intră sub incidența cap. V din prezentul titlu;',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.230(1)-(2)': [
    {
      from: '(1) În înțelesul art. 224, dacă un contribuabil este rezident',
      to: 'cu excepția situației în care se schimbă condițiile de rezidență.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.231(1)': [
    {
      from: '(1) Plătitorii de venituri cu regim de reținere la sursă a impozitelor, cu excepția plătitorilor de venituri din salarii',
      to: 'atunci când impozitul datorat de nerezident este suportat de către plătitorul de venit.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.25(4)(a)-nerezidenti': [
    {
      from: 'Sunt nedeductibile și cheltuielile cu impozitele nereținute la sursă',
      to: 'pentru veniturile realizate din România,',
    },
  ],
  'L82/1991:art.19(3)-(3^2)': [
    {
      from: '(3) Repartizarea profitului se înregistrează',
      to: 'dispune măsurile ce se impun în acest scop.',
    },
  ],
  'L163/2018:art.II.pct.1-2': [
    {
      from: '1. La articolul 67, alineatul (2)',
      to: 'nu s-a stabilit o dobândă mai mare."',
    },
  ],
  'OMFP3067/2018:pct.423^1-423^2': [
    {
      from: '423^1. - Entitățile care au optat',
      to: 'Soldul contului reprezintă sumele repartizate ca dividende, conform legii, în cursul exercițiului financiar."',
    },
  ],
  'OMFP3067/2018:art.III-V': [
    {
      from: 'ART. V Situațiile financiare interimare',
      to: 'de către adunarea generală a acționarilor/asociaților.',
    },
  ],
  'ANAF/D100:nomenclator.withholding': [
    { from: '13. 631 (poz.13)', to: '15. 633 (poz.15)' },
    { from: '109. 628 (poz.101)', to: 'evidență contabilă (se aplica din 01.2024)' },
    { from: 'Model 1# Pentru cod_oblig in', to: '702,703)' },
  ],
  'ANAF/D205:tip_venit.29': [
    { from: '1.k) venituri din cedarea', to: 'contabila - 10% (col.7,8,9,10)' },
    {
      from: 'Nomenclator - natura veniturilor in (desfiintate)',
      to: 'venituri din drepturi de proprietate intelectuală 01',
    },
  ],
  'ANAF/D207:structura': [
    {
      from: 'Act_N 36. 37. 9.Actul normativ',
      to: '3-Acord internațional la care România este parte',
    },
    { from: 'Validari suplimentare', to: 'L329/2013)' },
  ],
};
