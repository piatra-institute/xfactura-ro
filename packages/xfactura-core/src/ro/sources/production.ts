import type { Clause, LegalSource } from './index';

/*
 * The sources of production (G4): OMFP nr. 1.802/2014 as the legislative portal consolidates it
 * (OMFP1802/2014-A, the owner's copy, to 1 February 2022), which carries the 2015 amendment of the
 * functions of 345, 347, 348 and 711 (OMFP nr. 773/2015 art. 9: every price difference of a
 * product is booked against 711, none against 345). The definition of the production cost, the
 * costs it leaves out, the standard cost and its coefficient, the work in progress established by
 * inventory, the variation of stocks, the functions of groups 33, 34 and 71, and the optional
 * class 9. The 2014 text (ANAF's copy) words the same points with cedillas and, for 345, 348 and
 * 711, without the amendment, so it is not cited for them.
 */

export const productionSources: readonly LegalSource[] = [];

const clause = (id: string, locator: string, summary: string): Clause => ({
  id: `OMFP1802/2014-A:${id}`,
  source: 'OMFP1802/2014-A',
  locator,
  status: 'located',
  summary,
});

export const productionClauses: readonly Clause[] = [
  clause(
    'pct.8(7)',
    'pct. 8 pct. 7',
    'Costul de producție cuprinde cheltuielile directe (materiale, energie tehnologică, manoperă directă) și cota de regie de producție alocată rațional; regia fixă se alocă pe baza capacității normale, cea nealocată este cheltuială a perioadei, regia variabilă după folosirea reală; produsele secundare la valoarea realizabilă netă se scad din costul produsului principal; costurile de distribuție nu se includ.',
  ),
  clause(
    'pct.79',
    'pct. 79',
    'Nu se includ în costul stocurilor: pierderile de materiale, manoperă sau alte costuri peste limitele normal admise, depozitarea (cu excepții), regiile generale de administrație și regia fixă nealocată; capacitatea normală este producția medie estimată în condiții normale.',
  ),
  clause(
    'pct.286(1)-(3)',
    'pct. 286 alin. (1)–(3)',
    'În producție se poate folosi costul standard, care ia în considerare nivelurile normale ale consumurilor, manoperei, eficienței și capacității, revizuite periodic; diferențele de preț față de costul de producție se evidențiază distinct și se recunosc în costul activului.',
  ),
  clause(
    'pct.288',
    'pct. 288',
    'Valoarea producției în curs de execuție se determină prin inventarierea producției neterminate la sfârșitul perioadei, prin metode tehnice de constatare a gradului de finalizare, și se evaluează la costurile de producție.',
  ),
  clause(
    'pct.330(2)',
    'pct. 330 alin. (2)',
    'La returul produselor finite vândute în același exercițiu se corectează conturile 7015, 711 și 345.',
  ),
  clause(
    'pct.435(1)(b)',
    'pct. 435 alin. (1) lit. b)',
    'Veniturile aferente costului producției sunt variația dintre valoarea la cost de producție a stocurilor de produse și servicii în curs de execuție de la sfârșitul perioadei și cea a stocurilor inițiale.',
  ),
  clause(
    'pct.593(4)',
    'pct. 593 alin. (4)',
    'Pentru contabilitatea de gestiune, folosirea conturilor din clasa 9 nu este obligatorie.',
  ),
  clause(
    'conturi.331-332',
    'funcțiunile conturilor 331 și 332',
    'Contul 331 (332) se debitează la sfârșitul perioadei cu valoarea la cost de producție a producției în curs stabilită pe bază de inventar (711, 712) și se creditează cu scăderea ei din gestiune la începutul perioadei următoare.',
  ),
  clause(
    'conturi.341-346',
    'funcțiunile conturilor 341, 345 și 346 (345 modificat prin OMFP nr. 773/2015)',
    'Semifabricatele, produsele finite și produsele reziduale intră în gestiune din producția proprie la preț de înregistrare (711) și ies, vândute sau lipsă la inventar, pe seama contului 711; semifabricatele consumate în unitate trec în 301, 302; produsele reținute în unitate, în 301, 302, 303, 381.',
  ),
  clause(
    'conturi.348',
    'funcțiunea contului 348 (modificată prin OMFP nr. 773/2015)',
    'Contul 348 ține diferențele dintre prețul standard și costul de producție: se debitează cu diferențele nefavorabile ale produselor intrate și cu cele favorabile repartizate asupra ieșirilor, se creditează cu cele favorabile ale intrărilor și cu cele nefavorabile repartizate asupra ieșirilor, toate pe seama contului 711.',
  ),
  clause(
    'conturi.711-712',
    'funcțiunile conturilor 711 (modificată prin OMFP nr. 773/2015) și 712',
    'Contul 711 se creditează cu costul producției în curs la sfârșitul perioadei, cu prețul de înregistrare al produselor obținute sau constatate plus și cu diferențele nefavorabile ale intrărilor; se debitează cu reluarea producției în curs la începutul perioadei, cu prețul de înregistrare al produselor vândute sau lipsă și cu diferențele repartizate asupra ieșirilor.',
  ),
];
