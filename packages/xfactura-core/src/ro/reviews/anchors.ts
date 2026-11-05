import { nonpayerAnchors } from './anchors-nonpayers';
import { saftAnchors } from './anchors-saft';
import { taxAccountAnchors } from './anchors-taxaccount';
import type { Anchor } from './types';

/**
 * Where each clause's text starts and ends in its source's snapshot, as plain text with
 * whitespace collapsed (HTML without tags; PDF as `pdftotext` gives it). `from` must occur once;
 * the excerpt runs to the end of the first `to` after it. Several anchors make one excerpt.
 * A located clause without anchors shows no excerpt; the packet says so.
 */
export const clauseAnchors: Readonly<Record<string, readonly Anchor[]>> = {
  'ANAF/Cod-fiscal-consolidat:art.298': [
    {
      from: '(1) Prin excepție de la prevederile art. 297 se limitează la 50% dreptul de deducere',
      to: 'se vor aplica regulile generale de deducere stabilite la art. 297 și art. 299 - 301.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:norme.art.298.pct.68': [
    {
      from: '68. (1) În aplicarea art. 298 alin. (1) din Codul fiscal',
      to: 'inclusiv pentru activitățile prevăzute la art. 298 alin. (3) lit. b) - f) din Codul fiscal.',
    },
    {
      from: '(7) Utilizarea vehiculului pentru activitățile exceptate prevăzute la art. 298 alin. (3) din Codul fiscal',
      to: 'sau orice alte dovezi care pot fi furnizate.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.291(1)': [
    {
      from: '(1) Cota standard se aplică asupra bazei de impozitare',
      to: 'iar nivelul acesteia este 21%',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.291(2)': [
    {
      from: '(2) Cota redusă de 11% se aplică asupra bazei de impozitare',
      to: 'n) serviciile de restaurant și de catering, cu excepția băuturilor alcoolice, precum și a băuturilor nealcoolice care se încadrează la codul NC 2202.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.291(4)-(6)': [
    {
      from: '(4) Cota aplicabilă este cea în vigoare la data la care intervine faptul generator',
      to: 'precum și în situația prevăzută la alin. (5).',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.281(1)': [
    {
      from: '(1) Faptul generator intervine la data livrării bunurilor',
      to: 'în conformitate cu regulile stabilite de prezentul articol.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.281(8)': [
    {
      from: '(8) În cazul livrărilor de bunuri și al prestărilor de servicii care se efectuează continuu',
      to: 'dar perioada de decontare nu poate depăși un an.',
    },
    {
      from: '(6) În aplicarea prevederilor art. 281 alin. (8) din Codul fiscal',
      to: 'acesta nu este considerat fapt generator de taxă.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.281(12)': [
    {
      from: '(12) Prestările de servicii care nu se regăsesc la alin. (7) - (10)',
      to: 'se consideră efectuate la data finalizării prestării serviciului respectiv.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.282(1)': [
    {
      from: '(1) Exigibilitatea taxei intervine la data la care are loc faptul generator.',
      to: '(1) Exigibilitatea taxei intervine la data la care are loc faptul generator.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.282(9)': [
    {
      from: '(9) În cazul evenimentelor menționate la art. 287',
      to: 'care a generat aceste evenimente.',
    },
    {
      from: '(2) În aplicarea art. 282 alin. (9) din Codul fiscal',
      to: 'pentru operațiunea de bază.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.282(2)': [
    {
      from: '(2) Prin excepție de la prevederile alin. (1), exigibilitatea taxei intervine:',
      to: 'de jocuri sau alte mașini similare.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:L141/2025.art.III': [
    {
      from: 'Legea nr. 141/2025 Art. III',
      to: 'plata în avans pentru achiziționarea acestora.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.47(1)(c)': [
    {
      from: 'c) a realizat venituri care nu au depășit echivalentul în lei a 100.000 euro',
      to: 'în care s-au înregistrat veniturile;',
    },
    {
      from: '(3) Pentru anul fiscal 2025/2026, limita veniturilor realizate',
      to: 'nu se aplică pentru calculul limitei de 250.000 euro.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.51(1)': [
    {
      from: '(1) Cota de impozit pe veniturile microîntreprinderilor este de 1%.',
      to: '(1) Cota de impozit pe veniturile microîntreprinderilor este de 1%.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.52(1),(5)': [
    {
      from: '(1) Dacă în cursul unui an fiscal o microîntreprindere realizează venituri mai mari de 100.000 euro',
      to: 'începând cu trimestrul în care s-a depășit această limită.',
    },
    {
      from: '(5) Limitele fiscale prevăzute la alin. (1) se verifică pe baza veniturilor',
      to: 'cel valabil la închiderea exercițiului financiar precedent.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.53': [
    {
      from: '(1) Baza impozabilă a impozitului pe veniturile microîntreprinderilor o constituie veniturile din orice sursă',
      to: 'h) veniturile din diferențe de curs valutar;',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.54(1)': [
    {
      from: '(1) Pentru încadrarea în condițiile privind nivelul veniturilor',
      to: 'respectiv mai mult de un teren.',
    },
  ],
  'ANAF/D300-12.0.0:rd.9': [
    {
      from: 'Rd.9 col.1 Livrări de bunuri şi prestări de servicii taxabile cu cota 21%',
      to: 'Rd.9 col.1 Livrări de bunuri şi prestări de servicii taxabile cu cota 21%',
    },
  ],
  'ANAF/D300-12.0.0:rd.10': [
    {
      from: 'Rd.10 col.1 Livrări de bunuri şi prestări de servicii taxabile cu cota 11%',
      to: 'Rd.10 col.1 Livrări de bunuri şi prestări de servicii taxabile cu cota 11%',
    },
  ],
  'ANAF/D300-12.0.0:rd.11': [
    {
      from: 'Rd.11 col.1 Livrări de bunuri taxabile cu cota 9% conform art. III din Legea nr. 141/2025',
      to: 'Rd.11 col.1 Livrări de bunuri taxabile cu cota 9% conform art. III din Legea nr. 141/2025',
    },
  ],
  'ANAF/Ploiesti-modificari-tva:cote': [
    {
      from: '22 OCTOMBRIE 2025 Cotele de TVA (începând cu 01.08.2025):',
      to: 'Cota redusă de TVA 5% se elimină.',
    },
  ],
  'OUG59/2005:art.1(1)': [
    {
      from: '(1) Începând cu data de 1 iulie 2005, impozitele',
      to: 'care se întregesc la 1 leu (RON).',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.47(1^1)': [
    {
      from: '(11) În aplicarea prevederilor alin. (1) lit. c) limita privind veniturile realizate',
      to: 'se cumulează cu cele realizate de persoana juridică română/alte întreprinderi legate.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.52(5^1)-(5^2)': [
    {
      from: '(51) În cazul microîntreprinderii care, în cursul anului fiscal, se găsește în situația prevăzută la art. 47',
      to: 'care datorează impozit pe baza normei anuale de venit, potrivit prevederilor titlului IV.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.80(2)-(3)': [
    {
      from: '(2) Prin excepție de la prevederile alin. (1), impozitul aferent veniturilor fiecărei luni',
      to: '(3) Numărul mediu de salariați și veniturile totale se stabilesc potrivit prevederilor art. 147 alin. (6) și (7).',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.147(4)-(10)': [
    {
      from: '(4) Prin excepție de la prevederile alin. (1), plătitorii de venituri din salarii și asimilate salariilor prevăzuți la art. 80 alin. (2)',
      to: 'urmează să realizeze un venit total de până la 100.000 euro.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.310(1)-(2),(6)': [
    {
      from: 'a cărei cifră de afaceri anuală, declarată sau realizată, nu depășește plafonul de 395.000 lei',
      to: 'și cesiunea/transferul de active necorporale, efectuate de persoana impozabilă.',
    },
    {
      from: '(6) Persoana impozabilă care aplică regimul special de scutire și a cărei cifră de afaceri',
      to: 'realizate în data în care plafonul de scutire este depășit.',
    },
  ],
  'OMF2036/2025:anexa1.pct.2.1-2.3': [
    {
      from: '2.1. Entităţile care la data bilanţului nu depăşesc limitele a cel puţin două dintre următoarele trei criterii',
      to: 'precum şi entităţile de interes public întocmesc situaţii financiare anuale care cuprind:',
    },
  ],
  'OMF2036/2025:anexa1.pct.2.6': [
    {
      from: '(2) Pentru întocmirea situaţiilor financiare anuale la 31 decembrie 2025',
      to: 'sunt depăşite în două exerciţii financiare consecutive.',
    },
  ],
  'OMFP1802/2014:pct.12-13': [
    {
      from: '12. ‐ (1) Atunci când, la data bilanțului, o entitate depăşeşte',
      to: 'O analiză similară se efectuează şi de către microentități.',
    },
  ],
  'OMFP1802/2014:pct.15': [
    {
      from: '15. ‐ Totalul activelor menționat la pct. 9 şi 10',
      to: 'din formatul bilanțului prescurtat prevăzut la pct. 451.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.147(11)': [
    {
      from: '(11) Ori de câte ori în cursul trimestrului persoanele fizice',
      to: 'urmând ca după încheierea trimestrului să se depună numai declarația pentru luna a treia.',
    },
  ],
  'OPANAF605/2026:anexa6.cap.I': [
    {
      from: 'trimestrial, până la data de 25 inclusiv a lunii următoare trimestrului, de plătitorii',
      to: 'pentru fiecare lună din trimestru, potrivit art. 147 alin. (5) din Codul fiscal.',
    },
    {
      from: 'Ori de câte ori în cursul trimestrului persoanele fizice care realizează venituri din salarii sau asimilate salariilor beneficiază de concedii şi',
      to: 'urmând ca după încheierea trimestrului să se depună numai declaraţia pentru luna a treia.',
    },
  ],
  'OMFP3254/2017:art.3-5': [
    {
      from: '(3) Registrul de evidență fiscală se ține, după caz, pe fiecare sursă de venit',
      to: 'pe fiecare sursă din fiecare categorie de venit, astfel încât',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.69(3),(9)': [
    {
      from: '(3) Norma de venit pentru fiecare activitate desfășurată de contribuabil',
      to: 'norma de venit fiind stabilită pentru fiecare membru asociat.',
    },
    {
      from: '(9) Contribuabilii, pentru care venitul net se determină pe bază de norme de venit',
      to: 'până la termenul legal de depunere prevăzut la art. 122 alin. (3).',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:norme.art.69.pct.8(5)': [
    {
      from: '(5) În aplicarea art. 69 din Codul fiscal, în cazul în care activitatea',
      to: 'aplică criteriile specifice de corecție asupra normei de venit proprii.',
    },
  ],
  'L239/2025:art.XII.pct.6': [
    {
      from: '6. La articolul 69, alineatul (3) se modifică',
      to: 'norma de venit fiind stabilită pentru fiecare membru asociat.',
    },
  ],
  'L239/2025:art.XIII': [
    {
      from: 'b) prevederile art. XII pct. 3 - 11, 16 şi 18 - 20 se aplică',
      to: 'se aplică începând cu veniturile aferente anului 2026;',
    },
  ],
  'LJR/Cod-fiscal-2025:art.69(3)': [
    {
      from: '(3) Norma de venit pentru fiecare activitate desfășurată de contribuabil nu poate fi mai mică decât salariul',
      to: 'norma de venit fiind stabilită pentru fiecare membru asociat.',
    },
  ],
  'OUG128/2024:art.I.pct.1': [
    {
      from: '(9) Contribuabilii, pentru care venitul net se determină pe bază de norme de venit şi',
      to: 'prevăzut la art. 122 alin. (3).',
    },
    {
      from: '(2)Prevederile art. I pct. 1-4, 6-10',
      to: 'se aplică începând cu veniturile aferente anului 2025.',
    },
  ],
  'ANAF/ghid-coduri-facturi-2.9:O': [
    {
      from: 'Categoria de TVA "O": pentru operațiuni efectuate de neplătitorii de TVA',
      to: 'conform Codului Fiscal.',
    },
  ],
  'L82/1991:art.36(1)(a)': [
    {
      from: '(1) Persoanele prevăzute la art. 1 alin. (1) - (3) depun un exemplar al situaţiilor financiare anuale',
      to: 'în termen de 150 de zile de la încheierea exerciţiului financiar;',
    },
  ],
  'OMF2036/2025:anexa1.pct.3.1(1)(a)': [
    {
      from: '3.1. (1) Termenele pentru depunerea situaţiilor financiare anuale',
      to: 'până la data de 31 mai inclusiv a exerciţiului financiar următor celui de raportare;',
    },
  ],
  'OMF1194/2025:art.2,anexa.pct.16-17': [
    {
      from: 'ART. 2 (1) Sistemul de raportare contabilă la 30 iunie 2025',
      to: 'echivalentul în lei a 1.000.000 euro.',
    },
    {
      from: '(4) Pentru întocmirea raportărilor contabile la 30 iunie 2025, încadrarea',
      to: 'valabil la data încheierii exerciţiului financiar precedent.',
    },
    {
      from: '16. Entităţile care nu au desfăşurat activitate de la data înfiinţării',
      to: 'până cel mai târziu la data de 18 august 2025.',
    },
  ],
  'ANAF/raportari-semestriale:2026': [{ from: 'S1012 S1013 S1029', to: 'S1074 S1081' }],
  // The profit tax (src/ro/reviews/specs/profit.ts).
  'ANAF/Cod-fiscal-consolidat:art.26(1)(a)': [
    {
      from: 'a) rezerva legală este deductibilă în limita unei cote de 5%',
      to: 'subscris și vărsat sau din patrimoniu, după caz;',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:norme.art.26.pct.19(1)': [
    {
      from: '19. (1) În aplicarea prevederilor art. 26 alin. (1) lit. a)',
      to: 'în funcție de nivelul profitului contabil din perioada de calcul.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.25(3)(b)': [
    {
      from: 'b) cheltuielile sociale, în limita unei cote de până la 5%',
      to: 'potrivit Codului muncii.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.25(4)(i)': [
    {
      from: 'i) cheltuielile de sponsorizare și/sau mecenat, acordate potrivit legii',
      to: 'valoarea reprezentând 20% din impozitul pe profit datorat.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.31(1)': [
    {
      from: '(1) Pierderile fiscale anuale stabilite prin declarația de impozit pe profit, începând cu anul 2024',
      to: 'la fiecare termen de plată a impozitului pe profit.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.31(5)': [
    {
      from: '(5) Contribuabilii care au fost plătitori de impozit pe veniturile microîntreprinderilor și care anterior au realizat pierdere fiscală',
      to: 'Această pierdere se recuperează potrivit alin. (1) și (7), după caz.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.31(7)-(8)': [
    {
      from: '(7) Pierderile fiscale anuale stabilite prin declarația de impozit pe profit, aferente anilor precedenți',
      to: 'aceste pierderi se cumulează.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.41(1)': [
    {
      from: '(1) Calculul, declararea și plata impozitului pe profit, cu excepțiile',
      to: 'prevăzut la art. 42.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.19(1)': [
    {
      from: '(1) Rezultatul fiscal se calculează ca diferență între veniturile și cheltuielile înregistrate',
      to: 'iar rezultatul fiscal negativ este pierdere fiscală.',
    },
  ],
  'ANAF/Cod-fiscal-consolidat:art.25(2)': [
    {
      from: '(2) Cheltuielile cu salariile și cele asimilate salariilor astfel cum sunt definite potrivit titlului IV',
      to: 'cu excepția celor reglementate la alin. (3) și (4).',
    },
  ],
  ...nonpayerAnchors,
  ...taxAccountAnchors,
  ...saftAnchors,
};
