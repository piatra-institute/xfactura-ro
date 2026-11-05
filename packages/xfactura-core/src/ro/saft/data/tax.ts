// ANAF tax types and VAT tax codes for TaxInformationStructure and TaxTable.
// Extracted from ANAF RO_SAFT_SchemaDefCod_05.02.2026.xlsx (sha256 d0981202182438e4597ff3bc27d2c41dec06c60bc32b86620c1de29a9cb8436d),
// sheets TAX-IMP - Impozite, Livrari, Achizitii ded 100%, Achizitii ded 50%, Achizitii neded and TVA_NoteContabile (active codes only).
// The pinned RO_SAFT_SchemaDefCod_16.02.2026.xlsx (sha256 050508bf6eadbd6bb4684a0016296253c629d4e9b54a1118dd9b9bfd0c1d0f2d) has the same sheets; it adds only the WHT code 604040.

/** TaxType: the tax and duty codes of the state budget nomenclature (TAX-IMP). */
export const taxTypes: Readonly<Record<string, string>> = {
  '000':
    'Cod utilizat pentru înregistrările care nu sunt relevante pentru raportarea de taxe și impozite',
  '100': 'Impozit pe profit',
  '101': 'Varsaminte din veniturile nete ale Bancii Nationale a Romaniei',
  '102':
    'Plati anticipate in contul impozitului pe profit anual datorat de bancile comerciale,persosne juridice romane si sucursalele din Romania ale bancilor, persoane juridice straine',
  '103':
    'Impozit pe profit /plăţi anticipate în contul impozitului pe profit anual datorat /datorate de persoane juridice române, altele decât cele de la pct.1, precum şi de persoanele juridice cu sediul social în România, înfiinţate potrivit legislaţiei europene',
  '104': 'Impozit pe profit anual',
  '105':
    'Impozit pe profit datorat de persoane juridice străine, altele decât cele de la pct.1 sau plăţi anticipate în contul impozitului pe profit anual, datorate de către persoanele juridice străine care desfăşoară activitate prin intermediul unui sediu permanent în România',
  '106': 'Impozit pe profit din asociere datorat de persoane fizice',
  '107': 'Impozit pe profit scutit',
  '108': 'Impozit pe profit datorat in conformitate cu art. 40~3 din Codul fiscal',
  '110': 'Fondul Romania',
  '111': 'Impozit pe profit scutit conform art.38 alin(1) din Codul fiscal',
  '112': 'Impozit pe profit scutit conform art.38 alin(3) din Codul fiscal',
  '113': 'Impozit pe profit scutit conform art.38 alin(8), (9) sau (11) din Codul fiscal',
  '114':
    'Cota suplimentara de 20% din valoarea investitiilor prevazute la art.38 alin(13) din Codul fiscal',
  '116':
    'Impozit specific pe cifra de afaceri datorat de persoanele juridice care desfăşoară activităţi în sectoarele petrol şi gaze naturale',
  '117':
    'Impozit pe cifra de afaceri datorat de institu?iile de credit - persoane juridice române si sucursalele din România ale institu?iilor de credit - persoane juridice străine',
  '120': 'Impozit pe veniturile microintreprinderilor',
  '121': 'Impozit pe veniturile microintreprinderi',
  '122':
    'Impozit pe veniturile persoanelor fizice dintr-o asociere cu o persoană juridică microîntreprindere, care nu generează o persoană juridică',
  '127': 'Impozit pe veniturile microintreprinderilor scutit',
  '128': 'Impozit asupra veniturilor suplimentare offshore',
  '130': 'Impozit specific',
  '140':
    'Impozit pe veniturile obtinute din Romania de nerezidenti - persoane juridice, incasate pana la 31.01.2014',
  '150': 'Impozit pe veniturile din dividende distribuite persoanelor juridice',
  '155': 'Impozitul pe onorariul avocatilor si notarilor publici',
  '160':
    'Impozitul pe venitul reprezentantelor din Romania ale societatilor comerciale si organizatiilor economice straine',
  '161': 'Impozit pe venitul suplimentar realizat de producătorii de energie electrică',
  '162':
    'Impozit pe veniturile din instrainarea prin vanzare a terenurilor agricole situate in extravilan',
  '163': 'Impozit special pe bunurile imobile de valoare mare',
  '164': 'Impozit special pe bunurile mobile de valoare mare',
  '179': 'Compensatia la carburanti',
  '200': 'Accize',
  '210':
    'Accize incasate din vanzarea de alcool, distilate si bauturi alcoolice, datorate pana la 31.12.2006',
  '211': 'Accize pentru bere',
  '212': 'Accize pentru vinuri spumoase',
  '213': 'Accize pentru bauturi fermentate, spumoase, altele decat bere si vinuri',
  '214': 'Accize pentru produse intermediare',
  '215': 'Accize pentru alcool etilic',
  '216': 'Accize pentru vinuri liniştite',
  '217': 'Accize pentru băuturi fermentate liniştite, altele decât bere şi vinuri',
  '218':
    'Accize din vanzarea de bauturi fermentate linistite, altele decât bere si vinuri, datorate pana la data de 31.01.2011',
  '220': 'Accize din vanzarea produselor din tutun',
  '221': 'Accize pentru tigarete',
  '222': 'Accize pentru tigari si tigati foi',
  '223': 'Accize pentru tutun de fumat',
  '224': 'Accize pentru tutun de fumat fin tăiat, destinat rulării în ţigarete',
  '225': 'Accize pentru alte tutunuri de fumat',
  '226': 'Accize pentru produse din tutun încălzit',
  '227':
    'Accize pentru lichidele cu conținut de nicotină destinate inhalării cu ajutorul unui dispozitiv electronic tip țigaretă electronică',
  '228':
    'Accize pentru produse destinate inhalării fără ardere, care conţin înlocuitori de tutun, cu sau fără nicotină, inclusiv cele conţinute în rezerve livrate împreună cu ţigări electronice şi alte dispozitive de vaporizare electrice personale similare',
  '230': 'Accize incasate din vanzarea produselor energetice',
  '231': 'Accize pentru benzina cu plumb',
  '232':
    'Accize pentru benzină fără plumb şi bioetanol denaturat şi utilizat drept combustibil pentru motor',
  '233': 'Accize pentru motorină şi biodiesel',
  '234': 'Accize pentru pacura',
  '235': 'Accize pentru gaz petrolier lichefiat',
  '236': 'Accize pentru gaz natural',
  '237': 'Accize pentru carbune si cocs',
  '238': 'Accize pentru petrol lampant (kerosen)',
  '239': 'Accize din vanzarea uleiurilor minerale datorate pana la 31.12.2006',
  '240': 'Accize pentru cafea',
  '241': 'Accize de restituit/de compensat din vanzarea de motorina',
  '242': 'Accize pentru cafea prajită, inclusiv cafea cu înlocuitori',
  '243': 'Accize pentru cafea solubilă, inclusiv amestecuri cu cafea solubilă',
  '244': 'Accize pentru cafea verde',
  '245':
    'Accize pentru băuturi nealcoolice cu zahăr adăugat pentru care nivelul total de zahăr este cuprins între 5 g - 8 g/100 ml',
  '246':
    'Accize pentru băuturi nealcoolice cu zahăr adăugat pentru care nivelul total de zahăr este peste 8 g/100 ml',
  '250': 'Accize incasate din vanzarea altor produse datorate pana la data de 30 septembrie 2013',
  '251':
    'Accize pentru berea/baza de bere din amestecul cu băuturi nealcoolice, la care ponderea gradelor Plato provenite din malţ, cereale malţificabile şi/sau nemalţificabile este mai mică de 30% din numărul total de grade Plato',
  '252':
    'Accize pentru băuturile fermentate, altele decât bere şi vinuri, la care ponderea de alcool absolut (100%) provenită din fermentarea exclusivă a fructelor, sucurilor de fructe şi sucurilor concentrate de fructe este mai mică de 50%',
  '253': 'Accize pentru bijuterii din aur şi/sau din platină, cu excepţia verighetelor',
  '254': 'Accize pentru confecţii din blănuri naturale',
  '255':
    'Accize pentru iahturi şi alte nave şi ambarcaţiuni cu sau fără motor pentru agrement, cu excepţia celor destinate utilizării în sportul de performanţă',
  '256':
    'Accize pentru autoturisme şi autoturisme de teren a căror capacitate cilindrică este mai mare sau egală cu 3.000 cm3',
  '257':
    'Accize pentru arme de vânătoare şi arme de uz personal, altele decât cele de uz militar sau de uz sportiv',
  '258':
    'Accize pentru cartuşe cu glonţ şi alte tipuri de muniţie pentru armele de vânătoare şi arme de uz personal, altele decât cele de uz militar sau de uz sportiv',
  '259':
    'Accize pentru motoare cu capacitate de peste 100 CP, destinate iahturilor şi altor nave şi ambarcaţiuni pentru agrement',
  '260': 'Accize incasate din vanzarea autoturismelor din productia interna',
  '261':
    'Accize pentru autoturismele care au făcut obiectul unor contracte de leasing iniţiate înainte de 1 ianuarie 2007',
  '270': 'Accize pentru energie electrica',
  '275': 'Accize pentru alte produse accizabile (energetice)',
  '280': 'Accize incasate din vanzarea aparatelor de aer conditionat',
  '283': 'Accize incasate la eliberarea banderolelor fiscale pentru bauturi alcoolice',
  '290': 'Accize de rambursat',
  '300': 'Taxa pe valoarea adaugata',
  '301': 'Taxa pe valoarea adaugata- lunar',
  '302': 'Taxa pe valoarea adaugata- trimestrial',
  '303': 'Taxa pe valoarea adaugata- semestrial',
  '304': 'Taxa pe valoarea adaugata- anuala',
  '305': 'Dobanzi si penalitati de intarziere aferente T.V.A.',
  '307': 'TVA de plata la bugetul de stat, rezultata ca urmare a ajustarilor',
  '344':
    'Sume defalcate din tva pentru institutiile de invatamant preuniversitar de stat, crese, centre judetene si locale de consultante agricola precum si pentru sustinerea sistemului de protectie a copilului',
  '390': 'Taxa pe valoarea adaugata rambursare',
  '410': 'Contributia de asigurari sociale',
  '411': 'Contributia de asigurari sociale datorata de angajator',
  '412': 'Contributia individuala de asigurari sociale retinuta de la asigurati',
  '413':
    'Contributia de asigurari sociale datorata pentru persoane pentru care plata drepturilor se suporta din bugetul asigurarilor pentru somaj',
  '414':
    'Contributia pentru pensia suplimentara retinuta de la persoanele cuprinse in sistemul de asigurari sociale',
  '415': 'Contributia la fondul de pensii si asigurari sociale ale agricultorilor',
  '416':
    'Contributia de asigurare pentru accidente de munca si boli profesionale datorata de angajator',
  '417': 'Contributia pentru asigurari sociale',
  '418': 'Contributia de asigurare pt.accidente de munca si boli profesionale pt. someri',
  '419':
    'Contribuţia individuală de asigurări sociale datorată de persoanele care realizează venituri de natură profesională, altele decât cele de natură salarială',
  '420': 'Contributia de asigurari pentru somaj',
  '421': 'Contributia de asigurari pentru somaj datorata de angajator',
  '422': 'Contributia individuala de asigurari pentru somaj retinuta de la asigurati',
  '423': 'Contributia angajatorilor la Fondul de garantare pentru plata creantelor salariale',
  '424':
    'Contribuţia individuală de asigurări pentru şomaj datorată de persoanele care realizează venituri de natură profesională, altele decât cele de natură salarială',
  '430': 'Contributia pentru asigurari de sanatate',
  '431': 'Contributia pentru asigurari de sanatate datorata de angajator',
  '432': 'Contributia pentru asigurari de sanatate retinuta de la asigurati',
  '433':
    'Contributia pentru asigurari de sanatate datorata pentru persoane pentru care plata drepturilor se suporta din bugetul asigurarilor pentru somaj',
  '434':
    'Contributia pentru asigurari de sanatate datorata pentru persoanele care satisfac stagiul militar in termen',
  '435':
    'Contributia pentru asigurari de sanatate datorata pentru persoanele care executa pedepse privative de libertate sau aflate in arest preventiv',
  '436':
    'Contributia pentru asigurari de sanatate calculata pentru concediile medicale care se deduce din contributia de asigurari sociale datorata de angajator',
  '437':
    'Contributia de asigurari de sanatate pentru persoanele aflate in concediu pentru cresterea copilului pana la implinirea varstei de 2 ani si in cazul copilului cu handicap pana la implinirea varstei de 3 ani',
  '438':
    'Contributia de asigurari sociale de sanatate, datorata pentru persoanele care se afla in concediu medical, conform Legii nr.95/2006 privind reforma in domeniul sanatatii, cu modificarile si completarile ulterioare si alte deduceri conform legislatiei specifice privind contributiile sociale',
  '439': 'Contributii pentru concedii si indemnizatii de la persoane juridice sau fizice',
  '440': 'Contributii pt. concedii si indemnizatii datorate de persoanele aflate in somaj',
  '441':
    'Contributia pentru asigurari sociale de sanatate datorate de pensionari pentru partea de venit care depaseste plafonul prevazut de lege',
  '442':
    'Contributia pentru concedii si indemnizatii datorate de persoanele aflate in incapacitate de munca din cauza de accident de munca sau boala profesionala',
  '443':
    'Contributia pentru concedii si indemnizatii datorate de persoanele aflate in incapacitate de munca din cauza de accident de munca sau boala profesionala suportata din fondul de asigurare pentru accidente de munca si boli profesionale',
  '444':
    'Contributia de asigurari sociale de sanatate datorata pentru persoanele care fac parte dintr-o familie care are dreptul la ajutor social, potrivit Legii nr. 416/2001 privind venitul minim garantat, cu modificarile si completarile ulterioare',
  '445':
    'Contribuţia individuală de sănătate datorată pentru persoanele, cetăţeni străini, aflate în centrele de cazare în vederea returnării ori expulzării, precum şi pentru persoanele, cetăţeni străini, victime ale traficului de persoane, care se află în timpul procedurilor necesare stabilirii identităţii şi sunt cazaţi în centrele special amenajate, potrivit legii',
  '446':
    'Contribuţia individuală de sănătate datorată pentru persoanele care se află în executarea măsurilor prevăzute la art.105, 113, 114 din Codul penal, precum şi pentru persoanele care se află în perioada de amânare sau întrerupere a executării pedepsei privative de libertate',
  '447':
    'Contribuţia individuală de sănătate datorată pentru personalul monahal al cultelor recunoscute',
  '448':
    'Contribuţia de asigurări sociale de sănătate datorată de angajator pentru persoanele care se află în concediu medical pentru incapacitate de muncă, urmare unui accident de muncă sau boală profesională suportată din FAAMBP, conform Legii nr.95/2006, cu modificările şi completările ulterioare',
  '449':
    'Contribuţia individuală de sănătate datorată pentru persoanele, cetăţeni români, care sunt victime ale traficului de persoane, pentru o perioadă de cel mult 12 luni',
  '450':
    'Contribuţie trimestriala datorata pentru medicamentele suportate din Fondul naţional unic de asigurări sociale de sănătate şi din bugetul Ministerului Sănătăţii',
  '451':
    'Contribuţia individuală de asigurări sociale datorată de persoanele care realizează venituri din drepturi de proprietate intelectuală',
  '452':
    'Contribuţia individuală de asigurări sociale datorată de persoanele care realizează venituri din activităţi desfăşurate în baza contractelor/convenţiilor civile încheiate potrivit Codului civil, precum şi a contractelor de agent',
  '453':
    'Contribuţia individuală de asigurări sociale datorată de persoanele care realizează venituri din activitatea de expertiză contabilă şi tehnică, judiciară şi extrajudiciară',
  '454':
    'Contributii de asigurari sociale de stat datorate de persoane care realizeaza venituri din activitati independente, activitati agricole si asocieri fara personalitate juridica',
  '455': 'Contribuţie trimestrială datorată pentru contractele cost-volum/cost-volum-rezultat',
  '456':
    'Contribuţie datorată pentru volume de medicamente consumate care depăşesc volumele stabilite prin contracte',
  '457': 'CASS datorată de pensionari care depășesc plafonul de 4000 lei',
  '458': 'CAS suportat de angajator/plătitorul de venit (art.146 alin. 5^6 din CF)',
  '459': 'CASS suportat de angajator/plătitorul de venit (art.168 alin. 6^1 din CF)',
  '460': 'Contributia de asigurari sociale de sanatate datorata de persoane fizice - Regularizari',
  '461':
    'Contribuţia individuală de asigurări sociale de sănătate datorată de persoanele care realizează venituri din drepturi de proprietate intelectuală',
  '462':
    'Contribuţia individuală de asigurări sociale de sănătate datorată de persoanele care realizează venituri din activităţi desfăşurate în baza contractelor/convenţiilor civile încheiate potrivit Codului civil, precum şi a contractelor de agent',
  '463':
    'Contribuţia individuală de asigurări sociale de sănătate care realizează venituri din activitatea de expertiză contabilă şi tehnică, judiciară şi extrajudiciară',
  '464':
    'Contribuţia individuală de asigurări sociale de sănătate datorată de persoanele care realizează venitul obţinut dintr-o asociere cu o microintreprindere, potrivit titlului IV^1 din Codul Fiscal, care nu generează o persoană juridică',
  '465':
    'Contribuţia individuală de asigurări sociale de sănătate datorată de persoanele care realizează venituri, în regim de reţinere la sursă a impozitului pe venit, din asocierile fără personalitate juridică prevăzute la art. 13 lit. e) din Codul Fiscal',
  '466':
    'Contribuţia individuală de asigurări sociale de sănătate datorată de persoanele care realizează venituri, în regim de reţinere la sursă a impozitului pe venit, din activităţile agricole prevăzute la art. 71 lit. d) din Codul Fiscal',
  '467': 'Contributii individuale asigurari sociale (OMEF1646/2007)',
  '468':
    'Contributia de asigurari sociale de sanatate datorate de persoanele care realizeaza venituri din activati independente si persoanele care nu realizeaza venituri',
  '469':
    'Contribuţia individuală de asigurări sociale de sănătate datorată de persoanele care realizează venituri din arendarea bunurilor agricole, în regim de reţinere la sursă a impozitului pe venit',
  '470':
    'Contribuţia individuală de asigurări sociale de sănătate datorată de persoanele care realizează venituri din cedarea folosintei bunurilor',
  '471':
    'Contribuția individuală de asigurări sociale de sănătate datorată de persoanele care realizează venituri obținute dintr-o asociere cu o persoană juridică contribuabil, potrivit titlului II din Codul fiscal',
  '472':
    'Contribuția de asigurări sociale de sănătate datorată de persoanele care realizează venituri obținute din asocierea cu o persoană juridică, contribuabil, potrivit Legii nr. 170/2016 privind impozitul specific, cu modificările și completările ulterioare',
  '473':
    'Contribuția de asigurări sociale datorată de persoanele fizice care realizează venituri în baza contractelor de activitate sportivă',
  '474':
    'Contribuția de asigurări sociale de sănătate datorată de persoanele fizice care realizează venituri în baza contractelor de activitate sportivă',
  '475': 'Contribuții de asigurări sociale aferente declarației unice',
  '476': 'Contribuții de asigurări sociale de sănătate aferente declarației unice',
  '477':
    'Contribuţia de asigurări sociale datorată de persoanele fizice care realizează venituri din desfăsurarea activitatilor casnice',
  '480': 'Contribuție asiguratorie pentru muncă',
  '481': 'Contribuția de asigurări sociale datorată în cazul condițiilor deosebite de muncă',
  '482': 'Contribuția de asigurări sociale datorată în cazul condițiilor speciale de muncă',
  '483':
    'Contribuția de asigurări sociale, datorată de către persoanele fizice care au calitatea de angajați sau pentru care există obligația plății contribuției de asigurări sociale, potrivit legii și care își desfăsoară activitatea în domeniul construcțiilor conform art. 60 pct. 5 din Legea nr. 227/2015 privind Codul fiscal, cu modificările și completările ulterioare',
  '484':
    'Contribuția asiguratorie pentru muncă, datorată de către persoanele fizice și juridice care au calitatea de angajatori și care desfăsoară activitatea în domeniul construcțiilor conform art. 60 pct. 5 din Legea nr.227/2015 privind Codul fiscal, cu modificările și completările ulterioare',
  '485':
    'Contribuții de asigurări sociale datorate de persoane asigurate pe baza de contract de asigurare',
  '486': 'CAS agricultură (art.60 pct. 7 din CF)',
  '487':
    'Contribuţia asiguratorie pentru munca, datorata de catre persoanele fizice sau juridice care au calitatea de angajatori şi care se încadreaza în condiţiile prevazute la art. 60 pct. 7 din Codul fiscal',
  '488':
    'Contributia de asigurări sociale datorată de către persoanele fizice care se încadrează în conditiile prevăzute la art.60 pct.2 din Codul fiscal',
  '489': 'Contributie asiguratorie',
  '500': 'Taxa jocuri de noroc',
  '501':
    'Taxa pe jocuri de noroc datorata anticipat sau lunar pe perioada de valabilitate a licentei de exploatare a jocurilor de noroc',
  '502':
    'Taxa pe jocuri de noroc regularizata periodic in functie de realizari, datorata pentru perioada de raportare',
  '503': 'Taxa de timbru social asupra jocurilor de noroc',
  '504':
    'Taxa anuală de autorizare a jocurilor de noroc, regularizată periodic, în funcţie de realizări',
  '510': 'Taxe pentru organizarea şi exploatarea jocurilor de noroc, datorate pana la 01.01.2014',
  '511': 'Taxe aferente licenţei de organizare a jocurilor de noroc pentru jocurile loto',
  '512': 'Taxe aferente licenţei de organizare a jocurilor de noroc pentru pariuri mutuale',
  '513': 'Taxe aferente licenţei de organizare a jocurilor de noroc pentru pariuri în cotă fixă',
  '514':
    'Taxe aferente licenţei de organizare a jocurilor de noroc pentru jocuri de noroc caracteristice activităţii cazinourilor',
  '515': 'Taxe aferente licenţei de organizare a jocurilor de noroc pentru jocuri tip slot-machine',
  '516':
    'Taxe aferente licenţei de organizare a jocurilor de noroc pentru jocurile bingo desfăşurate în săli de joc',
  '517':
    'Taxe aferente licenţei de organizare a jocurilor de noroc pentru jocurile bingo organizate prin intermediul sistemelor reţelelor TV',
  '518': 'Taxe aferente autorizaţiei de exploatare a jocurilor de noroc pentru jocurile loto',
  '519': 'Taxe aferente autorizaţiei de exploatare a jocurilor de noroc pentru pariuri mutuale',
  '520':
    'Taxe aferente autorizaţiei de exploatare a jocurilor de noroc pentru pariuri în cotă fixă',
  '521':
    'Taxe aferente autorizaţiei de exploatare a jocurilor de noroc pentru jocuri de noroc caracteristice activităţii cazinourilor',
  '522':
    'Taxe aferente autorizaţiei de exploatare a jocurilor de noroc pentru jocuri tip slot-machine',
  '523':
    'Taxe aferente autorizaţiei de exploatare a jocurilor de noroc pentru jocurile bingo desfăşurate în săli de joc',
  '524':
    'Taxe aferente autorizaţiei de exploatare a jocurilor de noroc pentru jocurile bingo organizate prin intermediul sistemelor reţelelor TV',
  '534':
    'Taxa aferentă autorizatiei de exploatare a jocurilor de noroc pentru care obligatia declarării si plătii este lunară',
  '535': 'Taxa de acces pentru jocurile de noroc',
  '536': 'Taxa pentru obţinerea licenţei de organizare a jocurilor de noroc',
  '537': 'Taxa anuală pentru obţinerea autorizaţiei de exploatare a jocurilor de noroc',
  '538': 'Taxa specială pentru videoloterie',
  '539': 'Taxa de viciu pentru jocurile de noroc caracteristice slotmachine',
  '540': 'Taxe administrative pentru solicitarea licenței pentru jocurile de noroc la distanță',
  '541':
    'Taxa lunară calculată la totalul taxelor de participare încasate lunar, datorată de organizatorii de jocuri de noroc online, prevazută în OUG 77/2009 privind organizarea și exploatarea jocurilor de noroc',
  '551': 'Taxa datorata Comitetului Olimpic si Sportiv Roman',
  '552': 'Taxa datorata Comitetului Paralimpic Roman',
  '553': 'Taxa de promovare a activitatilor de jocuri de noroc',
  '600': 'Impozit pe venit',
  '601': 'Impozit pe veniturile din activitati independente',
  '602': 'Impozit pe veniturile din salarii si asimilate salariilor',
  '603': 'Impozit pe veniturile din cedarea folosintei bunurilor',
  '604': 'Impozit pe veniturile din dividende distribuite persoanelor fizice',
  '605': 'Impozit pe veniturile din dobanzi',
  '606': 'Impozite pe veniturile din lichidare/dizolvare fara lichidare a unei persoane juridice',
  '607': 'Impozit pe veniturile din pensii',
  '608': 'Impozit pe veniturile din premii',
  '609': 'Impozit pe castigul din transferul dreptului de proprietate asupra titlurilor de valoare',
  '610': 'Regularizari',
  '611': 'Impozit pe veniturile din drepturi de proprietate intelectuala',
  '612':
    'Impozit pe veniturile obtinute din Romania de nerezidenti - persoane fizice, incasate pana la 31.01.2014',
  '613': 'Impozit aferent veniturilor din activitati agricole',
  '614':
    'Impozit pe veniturile obtinute din valorificarea de bunuri in regim de consignatie si din activitatile desfasurate pe baza unui contract de agent, comision sau mandat comercial',
  '615':
    'Impozit pe veniturile din activitatea de expertiza contabila si tehnica judiciara si extrajudiciara',
  '616':
    'Impozit pe veniturile din activităţi desfăşurate în baza contractelor/ convenţiilor civile încheiate potrivit Codului civil, precum şi a contractelor de agent',
  '617':
    'Impozit pe castingul din operatiuni de vanzare - cumparare de valute la termen, pe baza de contract, precum si din alte operatiuni de acest gen, altele decat cele cu instrumente financiare tranzactionate pe piete autorizate si supravegheate de Comisia Nationala a Valorilor Mobiliare',
  '618':
    'Impozit pe veniturile din activitati comerciale - impozit pe veniturile realizate in baza unor conventii/ contracte civile incheiate in conditiile codului civil',
  '619': 'Impozit pe veniturile din arendarea bunurilor agricole',
  '620': 'Impozit pe veniturile din transferal proprietarilor imobiliare din patrimonial personal',
  '621': 'Impozit pe veniturile din jocuri de noroc',
  '622':
    'Impozit pe veniturile realizate de persoanele fizice dintr-o asociere cu o persoană juridică contribuabil, potrivit titlului II din Codul fiscal',
  '623':
    'Impozit pe veniturile realizate de persoanele fizice dintr-o asociere cu o persoană juridică contribuabil, potrivit titlului III din Codul fiscal',
  '624':
    'Impozit pe veniturile obținute de persoanele fizice dintr-o asociere cu o persoană juridică contribuabil, potrivit Legii nr.170/2016',
  '625':
    'Impozit pe veniturile realizate de persoanele fizice din activități independente realizate în baza contractelor de activitate sportivă',
  '626':
    'Plăți anticipate ale impozitului pentru unele venituri din activități independente, precum și pentru venituri din alte surse prevăzute la art. 114 alin.(2) lit. k ^ 1) din Legea 227/2015, cu modificările și completările ulterioare',
  '627':
    'Impozit pe veniturile realizate de persoanele fizice din desfaşurarea activitatilor casnice',
  '628':
    'Impozit pe veniturile din cedarea folosintei bunurilor, altele decât cele din arendarea bunurilor agricole si din închirierea în scop turistic a camerelor situate în locuinte proprietate personală, retinut la sursă de către persoanele juridice sau alte entităti care au obligatia de a conduce evidentă contabilă',
  '631': 'Impozit pe veniturile din dividende obţinute din România de persoane nerezidente',
  '632': 'Impozit pe veniturile din dobânzi obţinute din România de persoane nerezidente',
  '633': 'Impozit pe veniturile din redevenţe obţinute din România de persoane nerezidente',
  '634': 'Impozit pe veniturile din comisioane obţinute din România de persoane nerezidente',
  '635':
    'Impozit pe veniturile obţinute din România de persoane nerezidente din activităţi sportive şi de divertisment',
  '636':
    'Impozit pe veniturile din servicii prestate în România şi în afara României de persoane nerezident',
  '637':
    'Impozit pe veniturile obţinute de persoane fizice nerezidente din premii acordate la concursuri organizate în România',
  '638':
    'Impozit pe veniturile obţinute la jocuri de noroc practicate în România de persoane fizice nerezidente',
  '639':
    'Impozit pe venituri din lichidarea unei persoane juridice române realizate de persoane nerezidente',
  '640':
    'Impozit pe veniturile reprezentând remuneraţii primite de persoane juridice nerezidente care au calitatea de administrator, fondator sau membru al consiliului de administraţie al unei persoane juridice române',
  '641':
    'Impozit pe veniturile realizate din transferul masei patrimoniale fiduciare de la fiduciar la beneficiarul nerezident',
  '642':
    'Impozit pe veniturile din transferul titlurilor de valoare si din operatiuni cu instrumente financiare derivate',
  '650': 'Sume virate pentru sponsorizarea entitatilor nonprofit',
  '675': 'Impozit pe venit aferent declarației unice',
  '690': 'Impozit pe veniturile din alte surse',
  '699': 'Impozit pe salarii (restante)',
  '701': 'Impozit pe construcţii',
  '706':
    'Taxa speciala anuala regularizata în conformitate cu prevederile art.XLIV din Legea nr.296/2023',
  '707':
    'Plati anticipate in contul taxei speciale anuale, datorata în conformitate cu prevederile art.XLIV din Legea nr.296/2023',
  '708': 'Contributie la Fondul de Tranzitie Energetica',
  '709': 'Contributia de solidaritate',
  '710': 'Impozit la titeiul si la gazele naturale din productia interna',
  '711':
    'Impozit asupra veniturilor suplimentare obtinute ca urmare a dereglementarii preturilor din sectorul gazelor naturale',
  '712':
    'Impozit pe veniturile din activitatile de exploatare a resurselor naturale, altele decat gazele naturale',
  '713': 'Impozit pe monopolul natural din sectorul energiei electrice si al gazului natural',
  '720': 'Taxa asupra activitatilor daunatoare sanatatii',
  '721': 'Penalitati neachitare la termen',
  '725': 'Taxe si tarife pentru eliberarea de licente si autorizatii de functionare',
  '730':
    'Cota din veniturile realizate de persoanele juridice romane care presteaza activitatile prevazute la art.2 lit.a) din OG nr.47/1998 privind constituirea si utilizarea Fondului special al aviatiei civile',
  '735':
    'Cota aplicata fondului de salarii realizat lunar, inclusiv asupra castigurilor realizate lunar de colaboratori persoane fizice (art.53/OUG nr.102/1999)',
  '740':
    'Taxa de timbru social asupra valorii autovehiculelor noi din import, cu capacitate cilindrica de minimum 2000cm3',
  '750': 'Taxa pe activitatea de prospectiune, explorare, exploatare a resurselor minerale',
  '751':
    'Venituri cu destinatie speciala din cota unica asupra carburantilor auto livrati la intern de producatori precum si pentru carburantii auto consumati de acestia si asupra carburantilor auto importati',
  '752': 'Venituri din recuperarea cheltuielilor judiciare avansate de stat',
  '753':
    'Venituri din recuperarea cheltuielilor judiciare avansate de stat de la persoanele nerezidente',
  '754':
    'Compensații aferente dreptului de trecere în schimbul limitărilor aduse dreptului de folosință',
  '755': 'Redevente miniere',
  '756': 'Redevente petroliere',
  '757': 'Alte venituri din concesiuni si inchirieri de catre Institutii publice',
  '758':
    'Redevenţe rezultate din contractele de concesiune, arendă şi alte contracte de exploatare eficientă a terenurilor cu destinaţie agricolă',
  '759': 'Despăgubiri acordate pentru toate pagubele cauzate prin exercitarea dreptului de trecere',
  '760': 'Taxa de dezvoltare cuprinsa in tariful energiei electrice si termice',
  '761': 'Taxe judiciare de timbru',
  '762': 'Venituri din timbru judiciar',
  '763': 'Taxa pe activele financiare',
  '765': 'Venituri din aplicarea prescriptiei extinctive',
  '766':
    'Redevenţa obţinută prin concesionare din activităţi de exploatare a resurselor la suprafaţa ale statului şi a apelor minerale naturale carbogazoase sau necarbogazoase',
  '767':
    'Redevenţa obţinută prin concesionare din activităţi de exploatare a resurselor la suprafaţa ale statului, reprezentând terenuri cu destinaţie agricola',
  '770': 'Taxa din veniturile institutiilor de invatamant superior',
  '771': 'Venituri din taxe pentru prestatii vamale',
  '772': 'Taxe consulare',
  '773': 'Venituri din expertiza tehnica, judiciara si extrajudiciara',
  '774': 'Venituri din prestari servicii',
  '776': 'Taxa de poluare pentru autovehicule, de compensat/restituit',
  '777': 'Taxe si alte venituri din protectia mediului',
  '778': 'Varsaminte din disponibilitatile institutiilor publice si activitatilor autofinantat',
  '779': 'Taxe speciale pentru autoturisme si autovehicule la prima inmatriculare in Romania',
  '780': 'Varsaminte din profitul net al regiilor autonome',
  '781': 'Dividende de virat la bugetul de stat de către autorităţile publice centrale',
  '790':
    'Taxe de autorizare pentru comercializarea alcoolului, bauturilor alcoolice, produselor din tutun si a cafelei',
  '791': 'Timbru de mediu',
  '810': 'Varsaminte de la persoanele juridice, pentru persoanele cu handicap neincadrate',
  '811':
    'Sume datorate privind protectia speciala si incadrarea in munca a persoanelor cu handicap',
  '814': 'Cote defalcate din impozitul pe venit',
  '820': 'Contributia pentru invatamantul de stat',
  '825': 'Contribuție individuală la bugetul de stat (pensie militari)',
  '830': 'Contributia agentilor economici din turism',
  '840':
    'Incasari din rambursarea imprumuturilor acordate pentru acoperirea arieratelor catre CONEL si ROMGAZ',
  '850': 'Taxe vamale de la persoane juridic',
  '910': 'Venituri din amenzi si alte sanctiuni aplicate de catre alte institutii de specialitate',
  '911':
    'Venituri la bugetul asigurarilor sociale de stat, din amenzi si alte sanctiuni aplicate potrivit dispozitiile legale',
  '912': 'Venituri din amenzi si alte sanctiuni aplicate de Directia Generala Antifrauda Fiscala',
  '913': 'Venituri din amenzi aplicate persoanelor nerezidente',
  '915': 'Incasari din cota retinuta, conform Codului penal',
  '916': 'Restituiri de fonduri din finantarea bugetara a anilor precedenti',
  '920':
    'Penalitati pentru nedepunerea sau depunerea cu intarziere a declaratiei de impozite si taxe',
  '921': 'Penalitati datorate in cazul esalonarilor la plata',
  '922': 'Venituri din despagubiri',
  '923':
    'Incasari din valorificarea bunurilor confiscate, abandonate si alte sume constatate odata cu confiscarea potrivit legii',
  '924': 'Amenzi judiciare',
  '925': 'Majorari de intarziere pentru venituri nevarsate la termen',
  '926': 'Alte amenzi, penalitati si confiscari',
  '927': 'Penalități de nedeclarare',
  '930':
    'Impozit pe profitul obtinut din activitati comerciale ilicite sau din nerespectarea legii privind protectia consumatorilor',
  '931': 'Alte incasari din impozite directe',
  '932':
    'Încasări din valorificarea bunurilor confiscate, abandonate și alte sume constatate odată cu confiscarea potrivit legii',
  '933':
    'Încasări din valorificarea bunurilor confiscate, abandonate și alte sume constatate odata cu confiscarea potrivit legii de către Direcția Generală Antifraudă Fiscală',
  '940': 'Contribuţia trimestriala pentru finanţarea unor cheltuieli în domeniul sănătăţii',
  '941':
    'Contributia pentru finantarea unor cheltuieli de sanatate pentru produsele din tutun din productia interna',
  '942':
    'Contributia pentru finantarea unor cheltuieli de sanatate pentru produsele din tutun din achizitii intracomunitare/import',
  '943':
    'Contributia pentru finantarea unor cheltuieli de sanatate pentru bauturile alcoolice din productia interna',
  '944':
    'Contributia pentru finantarea unor cheltuieli de sanatate pentru bauturile alcoolice din achizitii intracomunitare/ import',
  '945':
    'Contributia pentru finantarea unor cheltuieli de sanatate din activitati publicitare la produsele din tutun si bauturi alcoolice',
  '946':
    'Contribuţie trimestriala datorata pentru medicamentele suportate din Fondul naţional unic de asigurări sociale de sănătate şi din bugetul Ministerului Sănătăţii, aflate în sold, la data de 1 octombrie 2011 şi neachitate',
  '947': 'Disponibil din taxe pentru emisiile poluante provenite de la autovehicule',
  '950': 'Venituri din valorificarea unor bunuri ale institutiilor publice',
  '951': 'Sume din recuperarea debitelor provenite din drepturi necuvenite',
  '952': 'Venituri din recuperarea cheltuielilor de judecata, imputatii si despagubiri',
  '953': 'Alte venituri din valorificarea unor bunuri',
  '954':
    'Sume din recuperarea debitelor provenite din drepturile necuvenite aferente bugetului de stat',
  '955': 'Fond de risc',
  '956': 'Venituri din ajutoare de stat recuperate',
  '957':
    'Venituri din recuperarea cheltuielilor efectuate in cursul procesului de executare silita',
  '958':
    'Sume din recuperarea debitelor provenite din drepturile necuvenite aferente sistemului public de pensii',
  '959':
    'Sume din recuperarea debitelor provenite din drepturile necuvenite aferente sistemului de asigurare pentru accidente de munca și boli profesionale',
  '960': 'Vărsăminte din reducerea drepturilor salariale',
  '961':
    'Venituri din comisionul perceput de catre inspectoratele teritoriale de munca, datorat pana la data de 31 decembrie 2010',
  '970': 'Alte venituri',
  '971':
    'Venituri rezultate din garantiile acordate si platite institutiilor de credit in cadrul programului <PRIMA CASA>',
  '972': 'Creante recuperate in urma atragerii raspunderii solidare',
  '981': 'Restituiri fonduri din finantarea bugetara a anilor precedenti - BS',
  '982': 'Restituiri fonduri din finantarea bugetara a anilor precedenti - BCAS',
  '983': 'Restituiri fonduri din finantarea bugetara a anilor precedenti - BSAN',
  '984': 'Restituiri fonduri din finantarea bugetara a anilor precedenti - BSOM',
  '985': 'Venituri din compensarea creantelor din despagubiri BS',
  '986': 'Venituri din compensarea creantelor din despagubiri CAS',
  '987': 'Venituri din compensarea creantelor din despagubiri CASS',
  '988': 'Venituri din compensarea creantelor din despagubiri SOMAJ',
  '990':
    'Sume reprezentând impozit pe venit și contribuții sociale datorate de persoanele fizice în curs de distribuire',
  '991': 'Cont unic nerezidenti',
  '992': 'Venituri ale bugetului de stat incasate in contul unic, in curs de distribuire',
  '993':
    'Venituri ale bugetelor asigurarilor sociale de stat incasate in contul unic, in curs de distribuire',
  '994':
    'Disponibil al bugetelor asigurarilor sociale si fondurilor speciale, in curs de distribuire',
  '995':
    'Disponibil din sume încasate din înfiinţarea popririi (bancă/terţ) asupra sumelor ce se cuvin debitorilor',
  '997':
    'Disponibil din sume incasate reprezentand prejudiciul cauzat si recuperat in conditiile art.10 din Legea nr. 241/2005',
  '998':
    'Sume încasate pentru bugetul de stat, bugetul asigurarilor de stat și bugetul Fondului național unic de asigurări sociale de sănătate, în curs de distribuire',
  '999': 'Alte impozite, taxe, contribuții',
};

/** Which sheet a VAT tax code comes from: supplies, purchases with VAT deductible 100% or 50%,
 * purchases with nondeductible VAT, or ledger entries without a source document. */
export type VatCodeKind = 'sales' | 'purchases' | 'purchases50' | 'nondeductible' | 'ledger';

/** TaxCode of TaxType 300 (VAT): its sheet, description and VAT rate; a null rate is a code
 * whose amounts aggregate several rates or follow another Member State. */
export const vatTaxCodes: Readonly<
  Record<string, { kind: VatCodeKind; description: string; percentage: string | null }>
> = {
  '300101': {
    kind: 'purchases',
    description:
      'Achiziţii intracomunitare de bunuri pentru care cumpărătorul este obligat la plata TVA (taxare inversă) 19% altele decat achiziţiile intracomunitare pentru care cumpărătorul este obligat la plata TVA (taxare inversă), iar furnizorul este înregistrat în scopuri de TVA în statul membru din care a avut loc livrarea intracomunitară',
    percentage: '19',
  },
  '300102': {
    kind: 'purchases',
    description:
      'Achiziţii intracomunitare de bunuri pentru care cumpărătorul este obligat la plata TVA (taxare inversă) 9% altele decat achiziţiile intracomunitare pentru care cumpărătorul este obligat la plata TVA (taxare inversă), iar furnizorul este înregistrat în scopuri de TVA în statul membru din care a avut loc livrarea intracomunitară',
    percentage: '9',
  },
  '300103': {
    kind: 'purchases',
    description:
      'Achiziţii intracomunitare de bunuri pentru care cumpărătorul este obligat la plata TVA (taxare inversă) 5% altele decat achiziţiile intracomunitare pentru care cumpărătorul este obligat la plata TVA (taxare inversă), iar furnizorul este înregistrat în scopuri de TVA în statul membru din care a avut loc livrarea intracomunitară',
    percentage: '5',
  },
  '300104': {
    kind: 'purchases',
    description:
      'Achiziţii intracomunitare de bunuri pentru care cumpărătorul este obligat la plata TVA (taxare inversă) 21% altele decat achiziţiile intracomunitare pentru care cumpărătorul este obligat la plata TVA (taxare inversă), iar furnizorul este înregistrat în scopuri de TVA în statul membru din care a avut loc livrarea intracomunitară',
    percentage: '21',
  },
  '300105': {
    kind: 'purchases',
    description:
      'Achiziţii intracomunitare de bunuri pentru care cumpărătorul este obligat la plata TVA (taxare inversă) 11% altele decat achiziţiile intracomunitare pentru care cumpărătorul este obligat la plata TVA (taxare inversă), iar furnizorul este înregistrat în scopuri de TVA în statul membru din care a avut loc livrarea intracomunitară',
    percentage: '11',
  },
  '300201': {
    kind: 'purchases',
    description:
      'Achiziţii intracomunitara de bunuri de la un furnizor înregistrat în scopuri de TVA în statul membru din care a avut loc livrarea intracomunitară 19%',
    percentage: '19',
  },
  '300202': {
    kind: 'purchases',
    description:
      'Achiziţii intracomunitara de bunuri de la un furnizor înregistrat în scopuri de TVA în statul membru din care a avut loc livrarea intracomunitară 9%',
    percentage: '9',
  },
  '300203': {
    kind: 'purchases',
    description:
      'Achiziţii intracomunitara de bunuri de la un furnizor înregistrat în scopuri de TVA în statul membru din care a avut loc livrarea intracomunitară 5%',
    percentage: '5',
  },
  '300204': {
    kind: 'purchases',
    description:
      'Achiziţii intracomunitara de bunuri de la un furnizor înregistrat în scopuri de TVA în statul membru din care a avut loc livrarea intracomunitară 21%',
    percentage: '21',
  },
  '300205': {
    kind: 'purchases',
    description:
      'Achiziţii intracomunitara de bunuri de la un furnizor înregistrat în scopuri de TVA în statul membru din care a avut loc livrarea intracomunitară 11%',
    percentage: '11',
  },
  '300401': {
    kind: 'purchases',
    description: 'Regularizări privind achiziţiile intracomunitare de bunuri 19%',
    percentage: '19',
  },
  '300402': {
    kind: 'purchases',
    description: 'Regularizări privind achiziţiile intracomunitare de bunuri 9%',
    percentage: '9',
  },
  '300403': {
    kind: 'purchases',
    description: 'Regularizări privind achiziţiile intracomunitare de bunuri 5%',
    percentage: '5',
  },
  '300404': {
    kind: 'purchases',
    description: 'Regularizări privind achiziţiile intracomunitare de bunuri 21%',
    percentage: '21',
  },
  '300405': {
    kind: 'purchases',
    description: 'Regularizări privind achiziţiile intracomunitare de bunuri 11%',
    percentage: '11',
  },
  '300501': {
    kind: 'purchases',
    description:
      'Achizitii de bunuri (altele decat AIC de bunuri si importuri cu masuri de simplificare ) si achizitii de servicii (altele decat AIC de servicii cf reg B2B), pentru care care beneficiarul din Romania este obligat la plata TVA 19%',
    percentage: '19',
  },
  '300502': {
    kind: 'purchases',
    description:
      'Achizitii de bunuri (altele decat AIC de bunuri si importuri cu masuri de simplificare ) si achizitii de servicii (altele decat AIC de servicii cf reg B2B), pentru care care beneficiarul din Romania este obligat la plata TVA 9%',
    percentage: '9',
  },
  '300503': {
    kind: 'purchases',
    description:
      'Achizitii de bunuri (altele decat AIC de bunuri si importuri cu masuri de simplificare) si achizitii de servicii (altele decat AIC de servicii cf reg B2B), pentru care care beneficiarul din Romania este obligat la plata TVA 5%',
    percentage: '5',
  },
  '300504': {
    kind: 'purchases',
    description:
      'Achizitii de bunuri (altele decat AIC de bunuri si importuri cu masuri de simplificare ) si achizitii de servicii (altele decat AIC de servicii cf reg B2B), pentru care care beneficiarul din Romania este obligat la plata TVA 21%',
    percentage: '21',
  },
  '300505': {
    kind: 'purchases',
    description:
      'Achizitii de bunuri (altele decat AIC de bunuri si importuri cu masuri de simplificare ) si achizitii de servicii (altele decat AIC de servicii cf reg B2B), pentru care care beneficiarul din Romania este obligat la plata TVA 11%',
    percentage: '11',
  },
  '300601': {
    kind: 'purchases',
    description: 'Import de bunuri 19% (TVA supusa masurilor de simplificare)',
    percentage: '19',
  },
  '300602': {
    kind: 'purchases',
    description: 'Import de bunuri 9% (TVA supusa masurilor de simplificare)',
    percentage: '9',
  },
  '300603': {
    kind: 'purchases',
    description: 'Import de bunuri 5% (TVA supusa masurilor de simplificare)',
    percentage: '5',
  },
  '300604': {
    kind: 'purchases',
    description: 'Import de bunuri 21% (TVA supusa masurilor de simplificare)',
    percentage: '21',
  },
  '300605': {
    kind: 'purchases',
    description: 'Import de bunuri 11% (TVA supusa masurilor de simplificare)',
    percentage: '11',
  },
  '300701': {
    kind: 'purchases',
    description: 'Achiziţii de servicii intracomunitare (AIC de servicii cf reg B2B) 19%',
    percentage: '19',
  },
  '300702': {
    kind: 'purchases',
    description: 'Achiziţii de servicii intracomunitare (AIC de servicii cf reg B2B) 9%',
    percentage: '9',
  },
  '300703': {
    kind: 'purchases',
    description: 'Achiziţii de servicii intracomunitare (AIC de servicii cf reg B2B) 5%',
    percentage: '5',
  },
  '300704': {
    kind: 'purchases',
    description: 'Achiziţii de servicii intracomunitare (AIC de servicii cf reg B2B) 21%',
    percentage: '21',
  },
  '300705': {
    kind: 'purchases',
    description: 'Achiziţii de servicii intracomunitare (AIC de servicii cf reg B2B) 11%',
    percentage: '11',
  },
  '300801': {
    kind: 'purchases',
    description:
      'Regularizări privind achiziţii de servicii intracomunitare (AIC de servicii cf reg B2B) 19%',
    percentage: '19',
  },
  '300802': {
    kind: 'purchases',
    description:
      'Regularizări privind achiziţii de servicii intracomunitare (AIC de servicii cf reg B2B) 9%',
    percentage: '9',
  },
  '300803': {
    kind: 'purchases',
    description:
      'Regularizări privind achiziţii de servicii intracomunitare (AIC de servicii cf reg B2B) 5%',
    percentage: '5',
  },
  '300804': {
    kind: 'purchases',
    description:
      'Regularizări privind achiziţii de servicii intracomunitare (AIC de servicii cf reg B2B) 21%',
    percentage: '21',
  },
  '300805': {
    kind: 'purchases',
    description:
      'Regularizări privind achiziţii de servicii intracomunitare (AIC de servicii cf reg B2B) 11%',
    percentage: '11',
  },
  '300901': {
    kind: 'purchases',
    description:
      'Achiziţii de bunuri şi servicii supuse măsurilor de simplificare taxabile cu cota de 19 %',
    percentage: '19',
  },
  '300902': {
    kind: 'purchases',
    description:
      'Achiziţii de bunuri şi servicii supuse măsurilor de simplificare taxabile cu cota de 9 %',
    percentage: '9',
  },
  '300903': {
    kind: 'purchases',
    description:
      'Achiziţii de bunuri şi servicii supuse măsurilor de simplificare taxabile cu cota de 5 %',
    percentage: '5',
  },
  '300904': {
    kind: 'purchases',
    description:
      'Achiziţii de bunuri şi servicii supuse măsurilor de simplificare taxabile cu cota de 20 %',
    percentage: '20',
  },
  '300905': {
    kind: 'purchases',
    description:
      'Achiziţii de bunuri şi servicii supuse măsurilor de simplificare taxabile cu cota de 24 %',
    percentage: '24',
  },
  '300906': {
    kind: 'purchases',
    description:
      'Achiziţii de bunuri şi servicii supuse măsurilor de simplificare taxabile cu cota de 21%',
    percentage: '21',
  },
  '300907': {
    kind: 'purchases',
    description:
      'Achiziţii de bunuri şi servicii supuse măsurilor de simplificare taxabile cu cota de 11%',
    percentage: '11',
  },
  '301101': {
    kind: 'purchases',
    description:
      'Achiziţii de bunuri şi servicii taxabile cu cota de 19%, altele decât importurile si cele supuse masurilor de simplificare',
    percentage: '19',
  },
  '301102': {
    kind: 'purchases',
    description:
      'Achiziţii de bunuri şi servicii taxabile cu cota de 9% altele decât importurile si cele supuse masurilor de simplificare',
    percentage: '9',
  },
  '301103': {
    kind: 'purchases',
    description:
      'Achiziţii de bunuri și servicii, taxabile cu cota de 5% altele decât importurile si cele supuse masurilor de simplificare',
    percentage: '5',
  },
  '301104': {
    kind: 'purchases',
    description:
      'Achiziţii de bunuri şi servicii taxabile cu cota de 21%, altele decât importurile si cele supuse masurilor de simplificare',
    percentage: '21',
  },
  '301105': {
    kind: 'purchases',
    description:
      'Achiziţii de bunuri şi servicii taxabile cu cota de 11% altele decât importurile si cele supuse masurilor de simplificare',
    percentage: '11',
  },
  '301201': { kind: 'purchases', description: 'Import de bunuri cota 19%', percentage: '19' },
  '301202': { kind: 'purchases', description: 'Import de bunuri cota 9%', percentage: '9' },
  '301203': { kind: 'purchases', description: 'Import de bunuri cota 5%', percentage: '5' },
  '301204': { kind: 'purchases', description: 'Import de bunuri cota 21%', percentage: '21' },
  '301205': { kind: 'purchases', description: 'Import de bunuri cota 11%', percentage: '11' },
  '301301': {
    kind: 'purchases',
    description: 'Achizitii pentru care se aplica TVA la incasare 19%',
    percentage: '19',
  },
  '301302': {
    kind: 'purchases',
    description: 'Achizitii pentru care se aplica TVA la incasare 9%',
    percentage: '9',
  },
  '301303': {
    kind: 'purchases',
    description: 'Achizitii pentru care se aplica TVA la incasare 5%',
    percentage: '5',
  },
  '301304': {
    kind: 'purchases',
    description:
      'Achizitii de bunuri/servicii care nu sunt raportabile in decontul de TVA din Romania si care se raporteaza in decontul de TVA din alte tari',
    percentage: '0',
  },
  '301305': {
    kind: 'purchases',
    description: 'Achizitii pentru care se aplica TVA la incasare 21%',
    percentage: '21',
  },
  '301306': {
    kind: 'purchases',
    description: 'Achizitii pentru care se aplica TVA la incasare 11%',
    percentage: '11',
  },
  '306301': {
    kind: 'purchases',
    description:
      'Achizitii intra-comunitare de bunuri taxabile - altele decat mijloacele de transport noi si produsele accizabile',
    percentage: '19',
  },
  '306302': {
    kind: 'purchases',
    description: 'Achizitii intra-comunitare de mijloacele de transport noi',
    percentage: '19',
  },
  '306303': {
    kind: 'purchases',
    description: 'Achizitii intra-comunitare de produsele accizabile',
    percentage: '19',
  },
  '306304': {
    kind: 'purchases',
    description:
      'Operaţiuni prevăzute la art.307 alin. (3), (5) si (6) din Codul fiscal precum și operațiuni prevăzute la art 307, alin (2) din Codul fiscal altele decât achiziţii de servicii intracomunitare pentru care beneficiarul este obligat la plata TVA cf.art. 307 alin.(2) din Codul fiscal',
    percentage: '19',
  },
  '306306': {
    kind: 'purchases',
    description:
      'Achiziţii de servicii intracomunitare pentru care beneficiarul este obligat la plata TVA cf.art. 307 alin.(2) din Codul fiscal',
    percentage: '19',
  },
  '306307': {
    kind: 'purchases',
    description:
      'Achiziţii de servicii intracomunitare pentru care beneficiarul este obligat la plata TVA cf.art. 307 alin.(2) din Codul fiscal',
    percentage: '9',
  },
  '306308': {
    kind: 'purchases',
    description:
      'Achiziţii de servicii intracomunitare pentru care beneficiarul este obligat la plata TVA cf.art. 307 alin.(2) din Codul fiscal',
    percentage: '5',
  },
  '306309': {
    kind: 'purchases',
    description:
      'Operaţiuni prevăzute la art.307 alin. (3), (5) si (6) din Codul fiscal precum și operațiuni prevăzute la art 307, alin (2) din Codul fiscal altele decât achiziţii de servicii intracomunitare pentru care beneficiarul este obligat la plata TVA cf.art. 307 alin.(2) din Codul fiscal',
    percentage: '9',
  },
  '306310': {
    kind: 'purchases',
    description:
      'Operaţiuni prevăzute la art.307 alin. (3), (5) si (6) din Codul fiscal precum și operațiuni prevăzute la art 307, alin (2) din Codul fiscal altele decât achiziţii de servicii intracomunitare pentru care beneficiarul este obligat la plata TVA cf.art. 307 alin.(2) din Codul fiscal',
    percentage: '5',
  },
  '306311': {
    kind: 'purchases',
    description:
      'Achizitii intra-comunitare de bunuri taxabile - altele decat mijloacele de transport noi si produsele accizabile',
    percentage: '9',
  },
  '306312': {
    kind: 'purchases',
    description:
      'Achizitii intra-comunitare de bunuri taxabile - altele decat mijloacele de transport noi si produsele accizabile',
    percentage: '5',
  },
  '306313': {
    kind: 'purchases',
    description:
      'Achizitii intra-comunitare de bunuri taxabile - altele decat mijloacele de transport noi si produsele accizabile',
    percentage: '21',
  },
  '306314': {
    kind: 'purchases',
    description:
      'Achizitii intra-comunitare de bunuri taxabile - altele decat mijloacele de transport noi si produsele accizabile',
    percentage: '11',
  },
  '306315': {
    kind: 'purchases',
    description: 'Achizitii intra-comunitare de mijloacele de transport noi',
    percentage: '21',
  },
  '306316': {
    kind: 'purchases',
    description: 'Achizitii intra-comunitare de produsele accizabile',
    percentage: '21',
  },
  '306317': {
    kind: 'purchases',
    description:
      'Operaţiuni prevăzute la art.307 alin. (3), (5) si (6) din Codul fiscal precum și operațiuni prevăzute la art 307, alin (2) din Codul fiscal altele decât achiziţii de servicii intracomunitare pentru care beneficiarul este obligat la plata TVA cf.art. 307 alin.(2) din Codul fiscal',
    percentage: '21',
  },
  '306318': {
    kind: 'purchases',
    description:
      'Operaţiuni prevăzute la art.307 alin. (3), (5) si (6) din Codul fiscal precum și operațiuni prevăzute la art 307, alin (2) din Codul fiscal altele decât achiziţii de servicii intracomunitare pentru care beneficiarul este obligat la plata TVA cf.art. 307 alin.(2) din Codul fiscal',
    percentage: '11',
  },
  '306319': {
    kind: 'purchases',
    description:
      'Achiziţii de servicii intracomunitare pentru care beneficiarul este obligat la plata TVA cf.art. 307 alin.(2) din Codul fiscal',
    percentage: '21',
  },
  '306320': {
    kind: 'purchases',
    description:
      'Achiziţii de servicii intracomunitare pentru care beneficiarul este obligat la plata TVA cf.art. 307 alin.(2) din Codul fiscal',
    percentage: '11',
  },
  '307301': { kind: 'purchases', description: 'Ajustări conform pro-rata', percentage: '24' },
  '307302': { kind: 'purchases', description: 'Ajustări de taxă', percentage: '24' },
  '307303': {
    kind: 'purchases',
    description: 'Facturi primite dupa inspectia fiscala 19%',
    percentage: '19',
  },
  '307304': {
    kind: 'purchases',
    description: 'Facturi primite dupa inspectia fiscala 9%',
    percentage: '9',
  },
  '307305': {
    kind: 'purchases',
    description: 'Facturi primite dupa inspectia fiscala 5%',
    percentage: '5',
  },
  '307311': { kind: 'purchases', description: 'Ajustări conform pro-rata', percentage: '19' },
  '307312': { kind: 'purchases', description: 'Ajustări conform pro-rata', percentage: '9' },
  '307313': { kind: 'purchases', description: 'Ajustări conform pro-rata', percentage: '5' },
  '307314': { kind: 'purchases', description: 'Ajustări conform pro-rata', percentage: '20' },
  '307321': { kind: 'purchases', description: 'Ajustări de taxă', percentage: '19' },
  '307322': { kind: 'purchases', description: 'Ajustări de taxă', percentage: '9' },
  '307323': { kind: 'purchases', description: 'Ajustări de taxă', percentage: '5' },
  '307324': { kind: 'purchases', description: 'Ajustări de taxă', percentage: '20' },
  '307325': {
    kind: 'purchases',
    description: 'Facturi primite dupa inspectia fiscala 21%',
    percentage: '21',
  },
  '307326': {
    kind: 'purchases',
    description: 'Facturi primite dupa inspectia fiscala 11%',
    percentage: '11',
  },
  '307327': { kind: 'purchases', description: 'Ajustări conform pro-rata', percentage: '21' },
  '307328': { kind: 'purchases', description: 'Ajustări conform pro-rata', percentage: '11' },
  '307329': { kind: 'purchases', description: 'Ajustări de taxă', percentage: '21' },
  '307330': { kind: 'purchases', description: 'Ajustări de taxă', percentage: '11' },
  '308301': {
    kind: 'purchases',
    description:
      'Achiziții de produse și servicii agricole de la furnizori care aplică regimul special pentru agricultori',
    percentage: '8',
  },
  '308302': {
    kind: 'purchases',
    description:
      'Achiziţii de bunuri şi servicii scutite de taxă sau neimpozabile altele decat AIC servicii scutite de taxa',
    percentage: '0',
  },
  '308303': {
    kind: 'purchases',
    description: 'Achiziţii de servicii intracomunitare scutite de taxă',
    percentage: '0',
  },
  '308304': {
    kind: 'purchases',
    description:
      'TVA efectiv restituită cumpărătorilor străini, inclusiv comisionul unităţilor autorizate',
    percentage: '19',
  },
  '308305': {
    kind: 'purchases',
    description:
      'TVA efectiv restituită cumpărătorilor străini, inclusiv comisionul unităţilor autorizate',
    percentage: '9',
  },
  '308306': {
    kind: 'purchases',
    description:
      'TVA efectiv restituită cumpărătorilor străini, inclusiv comisionul unităţilor autorizate',
    percentage: '5',
  },
  '308307': {
    kind: 'purchases',
    description: 'Regularizări privind compensaţia în cotă forfetară',
    percentage: '8',
  },
  '308308': {
    kind: 'purchases',
    description:
      'TVA efectiv restituită cumpărătorilor străini, inclusiv comisionul unităţilor autorizate',
    percentage: '21',
  },
  '308309': {
    kind: 'purchases',
    description:
      'TVA efectiv restituită cumpărătorilor străini, inclusiv comisionul unităţilor autorizate',
    percentage: '11',
  },
  '309101': { kind: 'purchases', description: 'Regularizări taxă dedusă 19%', percentage: '19' },
  '309102': { kind: 'purchases', description: 'Regularizări taxă dedusă 9%', percentage: '9' },
  '309103': { kind: 'purchases', description: 'Regularizări taxă dedusă 5%', percentage: '5' },
  '309104': { kind: 'purchases', description: 'Regularizări taxă dedusă 20%', percentage: '20' },
  '309105': { kind: 'purchases', description: 'Regularizări taxă dedusă 24%', percentage: '24' },
  '309106': { kind: 'purchases', description: 'Regularizări taxă dedusă 21%', percentage: '21' },
  '309107': { kind: 'purchases', description: 'Regularizări taxă dedusă 11%', percentage: '11' },
  '310301': {
    kind: 'sales',
    description: 'Livrări intracomunitare de bunuri, scutite',
    percentage: '0',
  },
  '310302': {
    kind: 'sales',
    description: 'Regularizări livrări intracomunitare scutite',
    percentage: '0',
  },
  '310303': {
    kind: 'sales',
    description:
      'Livrări intracomunitare de bunuri, scutite conform art. 294 alin.(2) lit.b) şi c) din Codul Fiscal',
    percentage: '0',
  },
  '310304': {
    kind: 'sales',
    description:
      'Livrare de bunuri pentru care locul livrarii este in afara Romaniei (in UE sau non-UE)',
    percentage: '0',
  },
  '310305': {
    kind: 'sales',
    description: 'Prestare de servicii pentru care locul prestarii este in afara UE',
    percentage: '0',
  },
  '310306': {
    kind: 'sales',
    description:
      'Prestări de servicii intracomunitare care beneficiază de scutire in statul membru in care taxa este datorată',
    percentage: '0',
  },
  '310307': {
    kind: 'sales',
    description:
      'Prestări de servicii intracomunitare care nu beneficiază de scutire in statul membru in care taxa este datorată (servicii cf reg B2B)',
    percentage: '0',
  },
  '310308': {
    kind: 'sales',
    description:
      'Regularizări privind prestări de servicii intracomunitare care nu beneficiază de scutire in statul membru in care taxa este datorată (servicii cf reg B2B)',
    percentage: '0',
  },
  '310309': {
    kind: 'sales',
    description: 'Livrări de bunuri şi prestări de servicii taxabile cu cota 19%',
    percentage: '19',
  },
  '310310': {
    kind: 'sales',
    description: 'Livrări de bunuri şi prestări de servicii taxabile cu cota 9%',
    percentage: '9',
  },
  '310311': {
    kind: 'sales',
    description: 'Livrări de bunuri şi prestări de servicii taxabile cu cota 5%',
    percentage: '5',
  },
  '310312': {
    kind: 'sales',
    description:
      'Livrari de bunuri si prestari de servicii supuse masurilor de simplificare (taxare inversa)',
    percentage: '0',
  },
  '310313': {
    kind: 'sales',
    description:
      'Livrari de bunuri scutite cu drept de deducere cf Art. 294 alin (1) lit a) si b) din Codul Fiscal (Exporturi)',
    percentage: '0',
  },
  '310314': {
    kind: 'sales',
    description:
      'Livrari de bunuri si /sau prestari de servicii scutite cu drept de deducere, altele decat Exporturile si operatiunile prevazute la art 294 alin (5) din Codul Fiscal',
    percentage: '0',
  },
  '310315': { kind: 'sales', description: 'Regularizari taxa colectata 24%', percentage: '24' },
  '310316': { kind: 'sales', description: 'Regularizari taxa colectata 20%', percentage: '20' },
  '310317': { kind: 'sales', description: 'Regularizări taxă colectată 19%', percentage: '19' },
  '310318': { kind: 'sales', description: 'Regularizări taxă colectată 9%', percentage: '9' },
  '310319': { kind: 'sales', description: 'Regularizări taxă colectată 5%', percentage: '5' },
  '310320': {
    kind: 'sales',
    description:
      'Vânzări intracomunitare de bunuri la distanță și prestări de servicii de telecomunicaţii, de radiodifuziune şi televiziune, precum și servicii furnizate pe cale electronică către persoane neimpozabile dintr-un alt stat membru, pentru care locul livrării/prestării este în România, conform art. 278 alin. (1) din Codul fiscal',
    percentage: '19',
  },
  '310321': {
    kind: 'sales',
    description:
      'Regularizări privind vânzările intracomunitare de bunuri la distanță și prestările de servicii de telecomunicaţii, de radiodifuziune şi televiziune, precum și servicii furnizate pe cale electronică către persoane neimpozabile dintr-un alt stat membru, conform art. 278 alin. (1) din Codul fiscal',
    percentage: '19',
  },
  '310322': {
    kind: 'sales',
    description: 'Facturi emise dupa inspectia fiscala 19%',
    percentage: '19',
  },
  '310323': {
    kind: 'sales',
    description:
      'Facturi emise, conform art. 11 alin (6) si (8) din Codul Fiscal, dupa inregistrara in scopuri de TVA pentru operatiuni efectuate in perioada in care codul de inregistrare in scopuri de TVA a fost anulat',
    percentage: '24',
  },
  '310324': {
    kind: 'sales',
    description: 'Operatiuni care nu intra in sfera de aplicare a TVA',
    percentage: '0',
  },
  '310325': {
    kind: 'sales',
    description:
      'Livrari de bunuri/ prestari de servicii care nu sunt raportabile in decontul de TVA din Romania si care se raporteaza in decontul de TVA din alte tari',
    percentage: '0',
  },
  '310326': {
    kind: 'sales',
    description: 'Livrări de bunuri și prestări de servicii scutite fără drept de deducere',
    percentage: '0',
  },
  '310327': {
    kind: 'sales',
    description:
      'Livrări de bunuri și prestări servicii pentru care este evidențiată suma taxei colectate (*)',
    percentage: '0',
  },
  '310328': {
    kind: 'sales',
    description:
      'Vânzări intracomunitare de bunuri la distanță și prestări de servicii de telecomunicaţii, de radiodifuziune şi televiziune, precum și servicii furnizate pe cale electronică către persoane neimpozabile dintr-un alt stat membru, pentru care locul livrării/prestării este în România, conform art. 278 alin. (1) din Codul fiscal',
    percentage: '5',
  },
  '310329': {
    kind: 'sales',
    description:
      'Regularizări privind vânzările intracomunitare de bunuri la distanță și prestările de servicii de telecomunicaţii, de radiodifuziune şi televiziune, precum și servicii furnizate pe cale electronică către persoane neimpozabile dintr-un alt stat membru, conform art. 278 alin. (1) din Codul fiscal',
    percentage: '5',
  },
  '310330': {
    kind: 'sales',
    description:
      'Facturi emise, conform art. 11 alin (6) si (8) din Codul Fiscal, dupa inregistrara in scopuri de TVA pentru operatiuni efectuate in perioada in care codul de inregistrare in scopuri de TVA a fost anulat',
    percentage: '20',
  },
  '310331': {
    kind: 'sales',
    description:
      'Facturi emise, conform art. 11 alin (6) si (8) din Codul Fiscal, dupa inregistrara in scopuri de TVA pentru operatiuni efectuate in perioada in care codul de inregistrare in scopuri de TVA a fost anulat',
    percentage: '19',
  },
  '310332': {
    kind: 'sales',
    description:
      'Facturi emise, conform art. 11 alin (6) si (8) din Codul Fiscal, dupa inregistrara in scopuri de TVA pentru operatiuni efectuate in perioada in care codul de inregistrare in scopuri de TVA a fost anulat',
    percentage: '9',
  },
  '310333': {
    kind: 'sales',
    description:
      'Facturi emise, conform art. 11 alin (6) si (8) din Codul Fiscal, dupa inregistrara in scopuri de TVA pentru operatiuni efectuate in perioada in care codul de inregistrare in scopuri de TVA a fost anulat',
    percentage: '5',
  },
  '310334': {
    kind: 'sales',
    description:
      'Facturi emise, conform art. 11 alin (6) si (8) din Codul Fiscal, dupa inregistrara in scopuri de TVA pentru operatiuni efectuate in perioada in care codul de inregistrare in scopuri de TVA a fost anulat',
    percentage: '0',
  },
  '310335': {
    kind: 'sales',
    description: 'Livrări/ prestări de către furnizorii care aplică TVA la încasare 19%',
    percentage: '19',
  },
  '310336': {
    kind: 'sales',
    description: 'Livrări/ prestări de către furnizorii care aplică TVA la încasare 9%',
    percentage: '9',
  },
  '310337': {
    kind: 'sales',
    description: 'Livrări/ prestări de către furnizorii care aplică TVA la încasare 5%',
    percentage: '5',
  },
  '310338': {
    kind: 'sales',
    description: 'Facturi emise dupa inspectia fiscala 9%',
    percentage: '9',
  },
  '310339': {
    kind: 'sales',
    description: 'Facturi emise dupa inspectia fiscala 5%',
    percentage: '5',
  },
  '310340': {
    kind: 'sales',
    description: 'Livrări de bunuri expediate/ transportate din RO sau servicii prestate din RO',
    percentage: null,
  },
  '310341': {
    kind: 'sales',
    description:
      'Livrari de bunuri scutite cu drept de deducere cf Art. 294 alin (5) lit a) si b) din Codul Fiscal',
    percentage: '0',
  },
  '310342': {
    kind: 'sales',
    description:
      'Livrari de bunuri scutite cu drept de deducere cf Art. 294 alin (5) lit c) si d) din Codul Fiscal',
    percentage: '0',
  },
  '310343': {
    kind: 'sales',
    description:
      'Vânzări intracomunitare de bunuri la distanță și prestări de servicii de telecomunicaţii, de radiodifuziune şi televiziune, precum și servicii furnizate pe cale electronică către persoane neimpozabile dintr-un alt stat membru, pentru care locul livrării/prestării este în România, conform art. 278 alin. (1) din Codul fiscal',
    percentage: '9',
  },
  '310344': {
    kind: 'sales',
    description: 'Livrări de bunuri şi prestări de servicii taxabile cu cota 21%',
    percentage: '21',
  },
  '310345': { kind: 'sales', description: 'Regularizări taxă colectată 21%', percentage: '21' },
  '310346': {
    kind: 'sales',
    description:
      'Vânzări intracomunitare de bunuri la distanță și prestări de servicii de telecomunicaţii, de radiodifuziune şi televiziune, precum și servicii furnizate pe cale electronică către persoane neimpozabile dintr-un alt stat membru, pentru care locul livrării/prestării este în România, conform art. 278 alin. (1) din Codul fiscal',
    percentage: '21',
  },
  '310347': {
    kind: 'sales',
    description:
      'Regularizări privind vânzările intracomunitare de bunuri la distanță și prestările de servicii de telecomunicaţii, de radiodifuziune şi televiziune, precum și servicii furnizate pe cale electronică către persoane neimpozabile dintr-un alt stat membru, conform art. 278 alin. (1) din Codul fiscal',
    percentage: '21',
  },
  '310348': {
    kind: 'sales',
    description: 'Facturi emise dupa inspectia fiscala 21%',
    percentage: '21',
  },
  '310349': {
    kind: 'sales',
    description:
      'Facturi emise, conform art. 11 alin (6) si (8) din Codul Fiscal, dupa inregistrara in scopuri de TVA pentru operatiuni efectuate in perioada in care codul de inregistrare in scopuri de TVA a fost anulat',
    percentage: '21',
  },
  '310350': {
    kind: 'sales',
    description: 'Livrări/ prestări de către furnizorii care aplică TVA la încasare 21%',
    percentage: '21',
  },
  '310351': {
    kind: 'sales',
    description: 'Livrări de bunuri şi prestări de servicii taxabile cu cota 11%',
    percentage: '11',
  },
  '310352': { kind: 'sales', description: 'Regularizări taxă colectată 11%', percentage: '11' },
  '310353': {
    kind: 'sales',
    description:
      'Facturi emise, conform art. 11 alin (6) si (8) din Codul Fiscal, dupa inregistrara in scopuri de TVA pentru operatiuni efectuate in perioada in care codul de inregistrare in scopuri de TVA a fost anulat',
    percentage: '11',
  },
  '310354': {
    kind: 'sales',
    description: 'Livrări/ prestări de către furnizorii care aplică TVA la încasare 11%',
    percentage: '11',
  },
  '310355': {
    kind: 'sales',
    description: 'Facturi emise dupa inspectia fiscala 11%',
    percentage: '11',
  },
  '310356': {
    kind: 'sales',
    description:
      'Vânzări intracomunitare de bunuri la distanță și prestări de servicii de telecomunicaţii, de radiodifuziune şi televiziune, precum și servicii furnizate pe cale electronică către persoane neimpozabile dintr-un alt stat membru, pentru care locul livrării/prestării este în România, conform art. 278 alin. (1) din Codul fiscal',
    percentage: '11',
  },
  '310357': {
    kind: 'sales',
    description:
      'Livrări de bunuri şi prestări de servicii taxabile cu cota 9% conform art.III din Legea nr.141/ 2025',
    percentage: '9',
  },
  '310358': {
    kind: 'sales',
    description:
      'Livrări de bunuri şi prestări de servicii taxabile cu cota 9% conform art.III din Legea nr.141/ 2025 efectuate de către furnizorii care aplică TVA la încasare',
    percentage: '9',
  },
  '310359': {
    kind: 'sales',
    description:
      'Regularizări privind vânzările intracomunitare de bunuri la distanță și prestările de servicii de telecomunicaţii, de radiodifuziune şi televiziune, precum și servicii furnizate pe cale electronică către persoane neimpozabile dintr-un alt stat membru, conform art. 278 alin. (1) din Codul fiscal',
    percentage: '11',
  },
  '340201': {
    kind: 'purchases50',
    description:
      'Achiziţii intracomunitara de bunuri de la un furnizor înregistrat în scopuri de TVA în statul membru din care a avut loc livrarea intracomunitară 19%',
    percentage: '19',
  },
  '340202': {
    kind: 'purchases50',
    description:
      'Achiziţii intracomunitara de bunuri de la un furnizor înregistrat în scopuri de TVA în statul membru din care a avut loc livrarea intracomunitară 9%',
    percentage: '9',
  },
  '340203': {
    kind: 'purchases50',
    description:
      'Achiziţii intracomunitara de bunuri de la un furnizor înregistrat în scopuri de TVA în statul membru din care a avut loc livrarea intracomunitară 5%',
    percentage: '5',
  },
  '340204': {
    kind: 'purchases50',
    description:
      'Achiziţii intracomunitara de bunuri de la un furnizor înregistrat în scopuri de TVA în statul membru din care a avut loc livrarea intracomunitară 21%',
    percentage: '21',
  },
  '340205': {
    kind: 'purchases50',
    description:
      'Achiziţii intracomunitara de bunuri de la un furnizor înregistrat în scopuri de TVA în statul membru din care a avut loc livrarea intracomunitară 11%',
    percentage: '11',
  },
  '340301': {
    kind: 'purchases50',
    description:
      'Achiziţii intracomunitare de bunuri pentru care cumpărătorul este obligat la plata TVA (taxare inversă) 19% altele decat achiziţiile intracomunitare pentru care cumpărătorul este obligat la plata TVA (taxare inversă), iar furnizorul este înregistrat în scopuri de TVA în statul membru din care a avut loc livrarea intracomunitară',
    percentage: '19',
  },
  '340302': {
    kind: 'purchases50',
    description:
      'Achiziţii intracomunitare de bunuri pentru care cumpărătorul este obligat la plata TVA (taxare inversă) 9% altele decat achiziţiile intracomunitare pentru care cumpărătorul este obligat la plata TVA (taxare inversă), iar furnizorul este înregistrat în scopuri de TVA în statul membru din care a avut loc livrarea intracomunitară',
    percentage: '9',
  },
  '340303': {
    kind: 'purchases50',
    description:
      'Achiziţii intracomunitare de bunuri pentru care cumpărătorul este obligat la plata TVA (taxare inversă) 5% altele decat achiziţiile intracomunitare pentru care cumpărătorul este obligat la plata TVA (taxare inversă), iar furnizorul este înregistrat în scopuri de TVA în statul membru din care a avut loc livrarea intracomunitară',
    percentage: '5',
  },
  '340304': {
    kind: 'purchases50',
    description:
      'Achiziţii intracomunitare de bunuri pentru care cumpărătorul este obligat la plata TVA (taxare inversă) 21% altele decat achiziţiile intracomunitare pentru care cumpărătorul este obligat la plata TVA (taxare inversă), iar furnizorul este înregistrat în scopuri de TVA în statul membru din care a avut loc livrarea intracomunitară',
    percentage: '21',
  },
  '340305': {
    kind: 'purchases50',
    description:
      'Achiziţii intracomunitare de bunuri pentru care cumpărătorul este obligat la plata TVA (taxare inversă) 11% altele decat achiziţiile intracomunitare pentru care cumpărătorul este obligat la plata TVA (taxare inversă), iar furnizorul este înregistrat în scopuri de TVA în statul membru din care a avut loc livrarea intracomunitară',
    percentage: '11',
  },
  '340401': {
    kind: 'purchases50',
    description: 'Regularizări privind achiziţiile intracomunitare de bunuri 19%',
    percentage: '19',
  },
  '340402': {
    kind: 'purchases50',
    description: 'Regularizări privind achiziţiile intracomunitare de bunuri 9%',
    percentage: '9',
  },
  '340403': {
    kind: 'purchases50',
    description: 'Regularizări privind achiziţiile intracomunitare de bunuri 5%',
    percentage: '5',
  },
  '340404': {
    kind: 'purchases50',
    description: 'Regularizări privind achiziţiile intracomunitare de bunuri 21%',
    percentage: '21',
  },
  '340405': {
    kind: 'purchases50',
    description: 'Regularizări privind achiziţiile intracomunitare de bunuri 11%',
    percentage: '11',
  },
  '340501': {
    kind: 'purchases50',
    description:
      'Achizitii de bunuri (altele decat AIC de bunuri si importuri cu masuri de simplificare ) si achizitii de servicii (altele decat AIC de servicii cf reg B2B), pentru care care beneficiarul din Romania este obligat la plata TVA 19%',
    percentage: '19',
  },
  '340502': {
    kind: 'purchases50',
    description:
      'Achizitii de bunuri (altele decat AIC de bunuri si importuri cu masuri de simplificare ) si achizitii de servicii (altele decat AIC de servicii cf reg B2B), pentru care care beneficiarul din Romania este obligat la plata TVA 9%',
    percentage: '9',
  },
  '340503': {
    kind: 'purchases50',
    description:
      'Achizitii de bunuri (altele decat AIC de bunuri si importuri cu masuri de simplificare) si achizitii de servicii (altele decat AIC de servicii cf reg B2B), pentru care care beneficiarul din Romania este obligat la plata TVA 5%',
    percentage: '5',
  },
  '340504': {
    kind: 'purchases50',
    description:
      'Achizitii de bunuri (altele decat AIC de bunuri si importuri cu masuri de simplificare ) si achizitii de servicii (altele decat AIC de servicii cf reg B2B), pentru care care beneficiarul din Romania este obligat la plata TVA 21%',
    percentage: '21',
  },
  '340505': {
    kind: 'purchases50',
    description:
      'Achizitii de bunuri (altele decat AIC de bunuri si importuri cu masuri de simplificare ) si achizitii de servicii (altele decat AIC de servicii cf reg B2B), pentru care care beneficiarul din Romania este obligat la plata TVA 11%',
    percentage: '11',
  },
  '340601': {
    kind: 'purchases50',
    description: 'Import de bunuri 19% (TVA supusa masurilor de simplificare)',
    percentage: '19',
  },
  '340602': {
    kind: 'purchases50',
    description: 'Import de bunuri 9% (TVA supusa masurilor de simplificare)',
    percentage: '9',
  },
  '340603': {
    kind: 'purchases50',
    description: 'Import de bunuri 5% (TVA supusa masurilor de simplificare)',
    percentage: '5',
  },
  '340604': {
    kind: 'purchases50',
    description: 'Import de bunuri 21% (TVA supusa masurilor de simplificare)',
    percentage: '21',
  },
  '340605': {
    kind: 'purchases50',
    description: 'Import de bunuri 11% (TVA supusa masurilor de simplificare)',
    percentage: '11',
  },
  '340701': {
    kind: 'purchases50',
    description: 'Achiziţii de servicii intracomunitare (AIC de servicii cf reg B2B) 19%',
    percentage: '19',
  },
  '340702': {
    kind: 'purchases50',
    description: 'Achiziţii de servicii intracomunitare (AIC de servicii cf reg B2B) 9%',
    percentage: '9',
  },
  '340703': {
    kind: 'purchases50',
    description: 'Achiziţii de servicii intracomunitare (AIC de servicii cf reg B2B) 5%',
    percentage: '5',
  },
  '340704': {
    kind: 'purchases50',
    description: 'Achiziţii de servicii intracomunitare (AIC de servicii cf reg B2B) 21%',
    percentage: '21',
  },
  '340705': {
    kind: 'purchases50',
    description: 'Achiziţii de servicii intracomunitare (AIC de servicii cf reg B2B) 11%',
    percentage: '11',
  },
  '340801': {
    kind: 'purchases50',
    description:
      'Regularizări privind achiziţii de servicii intracomunitare (AIC de servicii cf reg B2B) 19%',
    percentage: '19',
  },
  '340802': {
    kind: 'purchases50',
    description:
      'Regularizări privind achiziţii de servicii intracomunitare (AIC de servicii cf reg B2B) 9%',
    percentage: '9',
  },
  '340803': {
    kind: 'purchases50',
    description:
      'Regularizări privind achiziţii de servicii intracomunitare (AIC de servicii cf reg B2B) 5%',
    percentage: '5',
  },
  '340804': {
    kind: 'purchases50',
    description:
      'Regularizări privind achiziţii de servicii intracomunitare (AIC de servicii cf reg B2B) 21%',
    percentage: '21',
  },
  '340805': {
    kind: 'purchases50',
    description:
      'Regularizări privind achiziţii de servicii intracomunitare (AIC de servicii cf reg B2B) 11%',
    percentage: '11',
  },
  '340901': {
    kind: 'purchases50',
    description:
      'Achiziţii de bunuri şi servicii supuse măsurilor de simplificare taxabile cu cota de 19 %',
    percentage: '19',
  },
  '340902': {
    kind: 'purchases50',
    description:
      'Achiziţii de bunuri şi servicii supuse măsurilor de simplificare taxabile cu cota de 9 %',
    percentage: '9',
  },
  '340903': {
    kind: 'purchases50',
    description:
      'Achiziţii de bunuri şi servicii supuse măsurilor de simplificare taxabile cu cota de 5 %',
    percentage: '5',
  },
  '340904': {
    kind: 'purchases50',
    description:
      'Achiziţii de bunuri şi servicii supuse măsurilor de simplificare taxabile cu cota de 20 %',
    percentage: '20',
  },
  '340905': {
    kind: 'purchases50',
    description:
      'Achiziţii de bunuri şi servicii supuse măsurilor de simplificare taxabile cu cota de 24 %',
    percentage: '24',
  },
  '340906': {
    kind: 'purchases50',
    description:
      'Achiziţii de bunuri şi servicii supuse măsurilor de simplificare taxabile cu cota de 21 %',
    percentage: '21',
  },
  '340907': {
    kind: 'purchases50',
    description:
      'Achiziţii de bunuri şi servicii supuse măsurilor de simplificare taxabile cu cota de 11 %',
    percentage: '11',
  },
  '341101': {
    kind: 'purchases50',
    description:
      'Achiziţii de bunuri şi servicii taxabile cu cota de 19%, altele decât importurile si cele supuse masurilor de simplificare',
    percentage: '19',
  },
  '341102': {
    kind: 'purchases50',
    description:
      'Achiziţii de bunuri şi servicii taxabile cu cota de 9% altele decât importurile si cele supuse masurilor de simplificare',
    percentage: '9',
  },
  '341103': {
    kind: 'purchases50',
    description:
      'Achiziţii de bunuri și servicii, taxabile cu cota de 5% altele decât importurile si cele supuse masurilor de simplificare',
    percentage: '5',
  },
  '341104': {
    kind: 'purchases50',
    description:
      'Achiziţii de bunuri şi servicii taxabile cu cota de 21%, altele decât importurile si cele supuse masurilor de simplificare',
    percentage: '21',
  },
  '341105': {
    kind: 'purchases50',
    description:
      'Achiziţii de bunuri şi servicii taxabile cu cota de 11% altele decât importurile si cele supuse masurilor de simplificare',
    percentage: '11',
  },
  '341201': { kind: 'purchases50', description: 'Import de bunuri cota 19%', percentage: '19' },
  '341202': { kind: 'purchases50', description: 'Import de bunuri cota 9%', percentage: '9' },
  '341203': { kind: 'purchases50', description: 'Import de bunuri cota 5%', percentage: '5' },
  '341204': { kind: 'purchases50', description: 'Import de bunuri cota 21%', percentage: '21' },
  '341205': { kind: 'purchases50', description: 'Import de bunuri cota 11%', percentage: '11' },
  '341301': {
    kind: 'purchases50',
    description: 'Achizitii pentru care se aplica TVA la incasare 19%',
    percentage: '19',
  },
  '341302': {
    kind: 'purchases50',
    description: 'Achizitii pentru care se aplica TVA la incasare 9%',
    percentage: '9',
  },
  '341303': {
    kind: 'purchases50',
    description: 'Achizitii pentru care se aplica TVA la incasare 5%',
    percentage: '5',
  },
  '341304': {
    kind: 'purchases50',
    description:
      'Achizitii de bunuri/servicii care nu sunt raportabile in decontul de TVA din Romania si care se raporteaza in decontul de TVA din alte tari',
    percentage: '0',
  },
  '341305': {
    kind: 'purchases50',
    description: 'Achizitii pentru care se aplica TVA la incasare 11%',
    percentage: '11',
  },
  '341306': {
    kind: 'purchases50',
    description: 'Achizitii pentru care se aplica TVA la incasare 21%',
    percentage: '21',
  },
  '346301': {
    kind: 'purchases50',
    description:
      'Achizitii intra-comunitare de bunuri taxabile - altele decat mijloacele de transport noi si produsele accizabile',
    percentage: '19',
  },
  '346302': {
    kind: 'purchases50',
    description: 'Achizitii intra-comunitare de mijloacele de transport noi',
    percentage: '19',
  },
  '346303': {
    kind: 'purchases50',
    description: 'Achizitii intra-comunitare de produsele accizabile',
    percentage: '19',
  },
  '346304': {
    kind: 'purchases50',
    description:
      'Operaţiuni prevăzute la art.307 alin. (3), (5) si (6) din Codul fiscal precum și operațiuni prevăzute la art 307, alin (2) din Codul fiscal altele decât achiziţii de servicii intracomunitare pentru care beneficiarul este obligat la plata TVA cf.art. 307 alin.(2) din Codul fiscal',
    percentage: '19',
  },
  '346306': {
    kind: 'purchases50',
    description:
      'Achiziţii de servicii intracomunitare pentru care beneficiarul este obligat la plata TVA cf.art. 307 alin.(2) din Codul fiscal',
    percentage: '19',
  },
  '346307': {
    kind: 'purchases50',
    description:
      'Achiziţii de servicii intracomunitare pentru care beneficiarul este obligat la plata TVA cf.art. 307 alin.(2) din Codul fiscal',
    percentage: '9',
  },
  '346308': {
    kind: 'purchases50',
    description:
      'Achiziţii de servicii intracomunitare pentru care beneficiarul este obligat la plata TVA cf.art. 307 alin.(2) din Codul fiscal',
    percentage: '5',
  },
  '346309': {
    kind: 'purchases50',
    description:
      'Operaţiuni prevăzute la art.307 alin. (3), (5) si (6) din Codul fiscal precum și operațiuni prevăzute la art 307, alin (2) din Codul fiscal altele decât achiziţii de servicii intracomunitare pentru care beneficiarul este obligat la plata TVA cf.art. 307 alin.(2) din Codul fiscal',
    percentage: '9',
  },
  '346310': {
    kind: 'purchases50',
    description:
      'Operaţiuni prevăzute la art.307 alin. (3), (5) si (6) din Codul fiscal precum și operațiuni prevăzute la art 307, alin (2) din Codul fiscal altele decât achiziţii de servicii intracomunitare pentru care beneficiarul este obligat la plata TVA cf.art. 307 alin.(2) din Codul fiscal',
    percentage: '5',
  },
  '346311': {
    kind: 'purchases50',
    description:
      'Achizitii intra-comunitare de bunuri taxabile - altele decat mijloacele de transport noi si produsele accizabile',
    percentage: '9',
  },
  '346312': {
    kind: 'purchases50',
    description:
      'Achizitii intra-comunitare de bunuri taxabile - altele decat mijloacele de transport noi si produsele accizabile',
    percentage: '5',
  },
  '346313': {
    kind: 'purchases50',
    description:
      'Achizitii intra-comunitare de bunuri taxabile - altele decat mijloacele de transport noi si produsele accizabile',
    percentage: '21',
  },
  '346314': {
    kind: 'purchases50',
    description:
      'Achizitii intra-comunitare de bunuri taxabile - altele decat mijloacele de transport noi si produsele accizabile',
    percentage: '11',
  },
  '346315': {
    kind: 'purchases50',
    description: 'Achizitii intra-comunitare de mijloacele de transport noi',
    percentage: '21',
  },
  '346316': {
    kind: 'purchases50',
    description: 'Achizitii intra-comunitare de produsele accizabile',
    percentage: '21',
  },
  '346317': {
    kind: 'purchases50',
    description:
      'Operaţiuni prevăzute la art.307 alin. (3), (5) si (6) din Codul fiscal precum și operațiuni prevăzute la art 307, alin (2) din Codul fiscal altele decât achiziţii de servicii intracomunitare pentru care beneficiarul este obligat la plata TVA cf.art. 307 alin.(2) din Codul fiscal',
    percentage: '21',
  },
  '346318': {
    kind: 'purchases50',
    description:
      'Operaţiuni prevăzute la art.307 alin. (3), (5) si (6) din Codul fiscal precum și operațiuni prevăzute la art 307, alin (2) din Codul fiscal altele decât achiziţii de servicii intracomunitare pentru care beneficiarul este obligat la plata TVA cf.art. 307 alin.(2) din Codul fiscal',
    percentage: '11',
  },
  '346319': {
    kind: 'purchases50',
    description:
      'Achiziţii de servicii intracomunitare pentru care beneficiarul este obligat la plata TVA cf.art. 307 alin.(2) din Codul fiscal',
    percentage: '21',
  },
  '346320': {
    kind: 'purchases50',
    description:
      'Achiziţii de servicii intracomunitare pentru care beneficiarul este obligat la plata TVA cf.art. 307 alin.(2) din Codul fiscal',
    percentage: '11',
  },
  '347301': { kind: 'purchases50', description: 'Ajustări conform pro-rata', percentage: '24' },
  '347302': { kind: 'purchases50', description: 'Ajustări de taxă', percentage: '24' },
  '347303': {
    kind: 'purchases50',
    description: 'Facturi primite dupa inspectia fiscala 19%',
    percentage: '19',
  },
  '347304': {
    kind: 'purchases50',
    description: 'Facturi primite dupa inspectia fiscala 9%',
    percentage: '9',
  },
  '347305': {
    kind: 'purchases50',
    description: 'Facturi primite dupa inspectia fiscala 5%',
    percentage: '5',
  },
  '347306': {
    kind: 'purchases50',
    description: 'Facturi primite dupa inspectia fiscala 21%',
    percentage: '21',
  },
  '347307': {
    kind: 'purchases50',
    description: 'Facturi primite dupa inspectia fiscala 11%',
    percentage: '11',
  },
  '347311': { kind: 'purchases50', description: 'Ajustări conform pro-rata', percentage: '19' },
  '347312': { kind: 'purchases50', description: 'Ajustări conform pro-rata', percentage: '9' },
  '347313': { kind: 'purchases50', description: 'Ajustări conform pro-rata', percentage: '5' },
  '347314': { kind: 'purchases50', description: 'Ajustări conform pro-rata', percentage: '20' },
  '347315': { kind: 'purchases50', description: 'Ajustări conform pro-rata', percentage: '21' },
  '347316': { kind: 'purchases50', description: 'Ajustări conform pro-rata', percentage: '11' },
  '347321': { kind: 'purchases50', description: 'Ajustări de taxă', percentage: '19' },
  '347322': { kind: 'purchases50', description: 'Ajustări de taxă', percentage: '9' },
  '347323': { kind: 'purchases50', description: 'Ajustări de taxă', percentage: '5' },
  '347324': { kind: 'purchases50', description: 'Ajustări de taxă', percentage: '20' },
  '347325': { kind: 'purchases50', description: 'Ajustări de taxă', percentage: '21' },
  '347326': { kind: 'purchases50', description: 'Ajustări de taxă', percentage: '11' },
  '348301': {
    kind: 'purchases50',
    description:
      'Achiziții de produse și servicii agricole de la furnizori care aplică regimul special pentru agricultori',
    percentage: '8',
  },
  '348302': {
    kind: 'purchases50',
    description:
      'Achiziţii de bunuri şi servicii scutite de taxă sau neimpozabile altele decat AIC servicii scutite de taxa',
    percentage: '0',
  },
  '348303': {
    kind: 'purchases50',
    description: 'Achiziţii de servicii intracomunitare scutite de taxă',
    percentage: '0',
  },
  '348304': {
    kind: 'purchases50',
    description:
      'TVA efectiv restituită cumpărătorilor străini, inclusiv comisionul unităţilor autorizate',
    percentage: '19',
  },
  '348305': {
    kind: 'purchases50',
    description:
      'TVA efectiv restituită cumpărătorilor străini, inclusiv comisionul unităţilor autorizate',
    percentage: '9',
  },
  '348306': {
    kind: 'purchases50',
    description:
      'TVA efectiv restituită cumpărătorilor străini, inclusiv comisionul unităţilor autorizate',
    percentage: '5',
  },
  '348307': {
    kind: 'purchases50',
    description:
      'TVA efectiv restituită cumpărătorilor străini, inclusiv comisionul unităţilor autorizate',
    percentage: '21',
  },
  '348308': {
    kind: 'purchases50',
    description:
      'TVA efectiv restituită cumpărătorilor străini, inclusiv comisionul unităţilor autorizate',
    percentage: '11',
  },
  '349101': { kind: 'purchases50', description: 'Regularizări taxă dedusă 19%', percentage: '19' },
  '349102': { kind: 'purchases50', description: 'Regularizări taxă dedusă 9%', percentage: '9' },
  '349103': { kind: 'purchases50', description: 'Regularizări taxă dedusă 5%', percentage: '5' },
  '349104': { kind: 'purchases50', description: 'Regularizări taxă dedusă 20%', percentage: '20' },
  '349105': { kind: 'purchases50', description: 'Regularizări taxă dedusă 24%', percentage: '24' },
  '349106': { kind: 'purchases50', description: 'Regularizări taxă dedusă 21%', percentage: '21' },
  '349107': { kind: 'purchases50', description: 'Regularizări taxă dedusă 11%', percentage: '11' },
  '350101': {
    kind: 'nondeductible',
    description:
      'Achiziţii intracomunitare de bunuri pentru care cumpărătorul este obligat la plata TVA (taxare inversă) 19% altele decat achiziţiile intracomunitare pentru care cumpărătorul este obligat la plata TVA (taxare inversă), iar furnizorul este înregistrat în scopuri de TVA în statul membru din care a avut loc livrarea intracomunitară',
    percentage: '19',
  },
  '350102': {
    kind: 'nondeductible',
    description:
      'Achiziţii intracomunitare de bunuri pentru care cumpărătorul este obligat la plata TVA (taxare inversă) 9% altele decat achiziţiile intracomunitare pentru care cumpărătorul este obligat la plata TVA (taxare inversă), iar furnizorul este înregistrat în scopuri de TVA în statul membru din care a avut loc livrarea intracomunitară',
    percentage: '9',
  },
  '350103': {
    kind: 'nondeductible',
    description:
      'Achiziţii intracomunitare de bunuri pentru care cumpărătorul este obligat la plata TVA (taxare inversă) 5% altele decat achiziţiile intracomunitare pentru care cumpărătorul este obligat la plata TVA (taxare inversă), iar furnizorul este înregistrat în scopuri de TVA în statul membru din care a avut loc livrarea intracomunitară',
    percentage: '5',
  },
  '350104': {
    kind: 'nondeductible',
    description:
      'Achiziţii intracomunitare de bunuri pentru care cumpărătorul este obligat la plata TVA (taxare inversă) 21% altele decat achiziţiile intracomunitare pentru care cumpărătorul este obligat la plata TVA (taxare inversă), iar furnizorul este înregistrat în scopuri de TVA în statul membru din care a avut loc livrarea intracomunitară',
    percentage: '21',
  },
  '350105': {
    kind: 'nondeductible',
    description:
      'Achiziţii intracomunitare de bunuri pentru care cumpărătorul este obligat la plata TVA (taxare inversă) 11% altele decat achiziţiile intracomunitare pentru care cumpărătorul este obligat la plata TVA (taxare inversă), iar furnizorul este înregistrat în scopuri de TVA în statul membru din care a avut loc livrarea intracomunitară',
    percentage: '11',
  },
  '350201': {
    kind: 'nondeductible',
    description:
      'Achiziţii intracomunitara de bunuri de la un furnizor înregistrat în scopuri de TVA în statul membru din care a avut loc livrarea intracomunitară 19%',
    percentage: '19',
  },
  '350202': {
    kind: 'nondeductible',
    description:
      'Achiziţii intracomunitara de bunuri de la un furnizor înregistrat în scopuri de TVA în statul membru din care a avut loc livrarea intracomunitară 9%',
    percentage: '9',
  },
  '350203': {
    kind: 'nondeductible',
    description:
      'Achiziţii intracomunitara de bunuri de la un furnizor înregistrat în scopuri de TVA în statul membru din care a avut loc livrarea intracomunitară 5%',
    percentage: '5',
  },
  '350204': {
    kind: 'nondeductible',
    description:
      'Achiziţii intracomunitara de bunuri de la un furnizor înregistrat în scopuri de TVA în statul membru din care a avut loc livrarea intracomunitară 21%',
    percentage: '21',
  },
  '350205': {
    kind: 'nondeductible',
    description:
      'Achiziţii intracomunitara de bunuri de la un furnizor înregistrat în scopuri de TVA în statul membru din care a avut loc livrarea intracomunitară 11%',
    percentage: '11',
  },
  '350401': {
    kind: 'nondeductible',
    description: 'Regularizări privind achiziţiile intracomunitare de bunuri 19%',
    percentage: '19',
  },
  '350402': {
    kind: 'nondeductible',
    description: 'Regularizări privind achiziţiile intracomunitare de bunuri 9%',
    percentage: '9',
  },
  '350403': {
    kind: 'nondeductible',
    description: 'Regularizări privind achiziţiile intracomunitare de bunuri 5%',
    percentage: '5',
  },
  '350404': {
    kind: 'nondeductible',
    description: 'Regularizări privind achiziţiile intracomunitare de bunuri 21%',
    percentage: '21',
  },
  '350405': {
    kind: 'nondeductible',
    description: 'Regularizări privind achiziţiile intracomunitare de bunuri 11%',
    percentage: '11',
  },
  '350501': {
    kind: 'nondeductible',
    description:
      'Achizitii de bunuri (altele decat AIC de bunuri si importuri cu masuri de simplificare ) si achizitii de servicii (altele decat AIC de servicii cf reg B2B), pentru care care beneficiarul din Romania este obligat la plata TVA 19%',
    percentage: '19',
  },
  '350502': {
    kind: 'nondeductible',
    description:
      'Achizitii de bunuri (altele decat AIC de bunuri si importuri cu masuri de simplificare ) si achizitii de servicii (altele decat AIC de servicii cf reg B2B), pentru care care beneficiarul din Romania este obligat la plata TVA 9%',
    percentage: '9',
  },
  '350503': {
    kind: 'nondeductible',
    description:
      'Achizitii de bunuri (altele decat AIC de bunuri si importuri cu masuri de simplificare) si achizitii de servicii (altele decat AIC de servicii cf reg B2B), pentru care care beneficiarul din Romania este obligat la plata TVA 5%',
    percentage: '5',
  },
  '350504': {
    kind: 'nondeductible',
    description:
      'Achizitii de bunuri (altele decat AIC de bunuri si importuri cu masuri de simplificare ) si achizitii de servicii (altele decat AIC de servicii cf reg B2B), pentru care care beneficiarul din Romania este obligat la plata TVA 21%',
    percentage: '21',
  },
  '350505': {
    kind: 'nondeductible',
    description:
      'Achizitii de bunuri (altele decat AIC de bunuri si importuri cu masuri de simplificare ) si achizitii de servicii (altele decat AIC de servicii cf reg B2B), pentru care care beneficiarul din Romania este obligat la plata TVA 11%',
    percentage: '11',
  },
  '350601': {
    kind: 'nondeductible',
    description: 'Import de bunuri 19% (TVA supusa masurilor de simplificare)',
    percentage: '19',
  },
  '350602': {
    kind: 'nondeductible',
    description: 'Import de bunuri 9% (TVA supusa masurilor de simplificare)',
    percentage: '9',
  },
  '350603': {
    kind: 'nondeductible',
    description: 'Import de bunuri 5% (TVA supusa masurilor de simplificare)',
    percentage: '5',
  },
  '350604': {
    kind: 'nondeductible',
    description: 'Import de bunuri 21% (TVA supusa masurilor de simplificare)',
    percentage: '21',
  },
  '350605': {
    kind: 'nondeductible',
    description: 'Import de bunuri 11% (TVA supusa masurilor de simplificare)',
    percentage: '11',
  },
  '350701': {
    kind: 'nondeductible',
    description: 'Achiziţii de servicii intracomunitare (AIC de servicii cf reg B2B) 19%',
    percentage: '19',
  },
  '350702': {
    kind: 'nondeductible',
    description: 'Achiziţii de servicii intracomunitare (AIC de servicii cf reg B2B) 9%',
    percentage: '9',
  },
  '350703': {
    kind: 'nondeductible',
    description: 'Achiziţii de servicii intracomunitare (AIC de servicii cf reg B2B) 5%',
    percentage: '5',
  },
  '350704': {
    kind: 'nondeductible',
    description: 'Achiziţii de servicii intracomunitare (AIC de servicii cf reg B2B) 21%',
    percentage: '21',
  },
  '350705': {
    kind: 'nondeductible',
    description: 'Achiziţii de servicii intracomunitare (AIC de servicii cf reg B2B) 11%',
    percentage: '11',
  },
  '350801': {
    kind: 'nondeductible',
    description:
      'Regularizări privind achiziţii de servicii intracomunitare (AIC de servicii cf reg B2B) 19%',
    percentage: '19',
  },
  '350802': {
    kind: 'nondeductible',
    description:
      'Regularizări privind achiziţii de servicii intracomunitare (AIC de servicii cf reg B2B) 9%',
    percentage: '9',
  },
  '350803': {
    kind: 'nondeductible',
    description:
      'Regularizări privind achiziţii de servicii intracomunitare (AIC de servicii cf reg B2B) 5%',
    percentage: '5',
  },
  '350804': {
    kind: 'nondeductible',
    description:
      'Regularizări privind achiziţii de servicii intracomunitare (AIC de servicii cf reg B2B) 21%',
    percentage: '21',
  },
  '350805': {
    kind: 'nondeductible',
    description:
      'Regularizări privind achiziţii de servicii intracomunitare (AIC de servicii cf reg B2B) 11%',
    percentage: '11',
  },
  '350901': {
    kind: 'nondeductible',
    description:
      'Achiziţii de bunuri şi servicii supuse măsurilor de simplificare taxabile cu cota de 19 %',
    percentage: '19',
  },
  '350902': {
    kind: 'nondeductible',
    description:
      'Achiziţii de bunuri şi servicii supuse măsurilor de simplificare taxabile cu cota de 9 %',
    percentage: '9',
  },
  '350903': {
    kind: 'nondeductible',
    description:
      'Achiziţii de bunuri şi servicii supuse măsurilor de simplificare taxabile cu cota de 5 %',
    percentage: '5',
  },
  '350904': {
    kind: 'nondeductible',
    description:
      'Achiziţii de bunuri şi servicii supuse măsurilor de simplificare taxabile cu cota de 20 %',
    percentage: '20',
  },
  '350905': {
    kind: 'nondeductible',
    description:
      'Achiziţii de bunuri şi servicii supuse măsurilor de simplificare taxabile cu cota de 24 %',
    percentage: '24',
  },
  '350906': {
    kind: 'nondeductible',
    description:
      'Achiziţii de bunuri şi servicii supuse măsurilor de simplificare taxabile cu cota de 21 %',
    percentage: '21',
  },
  '350907': {
    kind: 'nondeductible',
    description:
      'Achiziţii de bunuri şi servicii supuse măsurilor de simplificare taxabile cu cota de 11 %',
    percentage: '11',
  },
  '351101': {
    kind: 'nondeductible',
    description:
      'Achiziţii de bunuri şi servicii taxabile cu cota de 19%, altele decât importurile si cele supuse masurilor de simplificare',
    percentage: '19',
  },
  '351102': {
    kind: 'nondeductible',
    description:
      'Achiziţii de bunuri şi servicii taxabile cu cota de 9% altele decât importurile si cele supuse masurilor de simplificare',
    percentage: '9',
  },
  '351103': {
    kind: 'nondeductible',
    description:
      'Achiziţii de bunuri și servicii, taxabile cu cota de 5% altele decât importurile si cele supuse masurilor de simplificare',
    percentage: '5',
  },
  '351104': {
    kind: 'nondeductible',
    description:
      'Achiziţii de bunuri şi servicii taxabile cu cota de 21%, altele decât importurile si cele supuse masurilor de simplificare',
    percentage: '21',
  },
  '351105': {
    kind: 'nondeductible',
    description:
      'Achiziţii de bunuri şi servicii taxabile cu cota de 11% altele decât importurile si cele supuse masurilor de simplificare',
    percentage: '11',
  },
  '351201': { kind: 'nondeductible', description: 'Import de bunuri cota 19%', percentage: '19' },
  '351202': { kind: 'nondeductible', description: 'Import de bunuri cota 9%', percentage: '9' },
  '351203': { kind: 'nondeductible', description: 'Import de bunuri cota 5%', percentage: '5' },
  '351204': { kind: 'nondeductible', description: 'Import de bunuri cota 21%', percentage: '21' },
  '351205': { kind: 'nondeductible', description: 'Import de bunuri cota 11%', percentage: '11' },
  '351301': {
    kind: 'nondeductible',
    description: 'Achizitii pentru care se aplica TVA la incasare 19%',
    percentage: '19',
  },
  '351302': {
    kind: 'nondeductible',
    description: 'Achizitii pentru care se aplica TVA la incasare 9%',
    percentage: '9',
  },
  '351303': {
    kind: 'nondeductible',
    description: 'Achizitii pentru care se aplica TVA la incasare 5%',
    percentage: '5',
  },
  '351304': {
    kind: 'nondeductible',
    description:
      'Achizitii de bunuri/servicii care nu sunt raportabile in decontul de TVA din Romania si care se raporteaza in decontul de TVA din alte tari',
    percentage: '0',
  },
  '351305': {
    kind: 'nondeductible',
    description: 'Achizitii pentru care se aplica TVA la incasare 21%',
    percentage: '21',
  },
  '351306': {
    kind: 'nondeductible',
    description: 'Achizitii pentru care se aplica TVA la incasare 11%',
    percentage: '11',
  },
  '356301': {
    kind: 'nondeductible',
    description:
      'Achizitii intra-comunitare de bunuri taxabile - altele decat mijloacele de transport noi si produsele accizabile',
    percentage: '19',
  },
  '356302': {
    kind: 'nondeductible',
    description: 'Achizitii intra-comunitare de mijloacele de transport noi',
    percentage: '19',
  },
  '356303': {
    kind: 'nondeductible',
    description: 'Achizitii intra-comunitare de produsele accizabile',
    percentage: '19',
  },
  '356304': {
    kind: 'nondeductible',
    description:
      'Operaţiuni prevăzute la art.307 alin. (3), (5) si (6) din Codul fiscal precum și operațiuni prevăzute la art 307, alin (2) din Codul fiscal altele decât achiziţii de servicii intracomunitare pentru care beneficiarul este obligat la plata TVA cf.art. 307 alin.(2) din Codul fiscal',
    percentage: '19',
  },
  '356306': {
    kind: 'nondeductible',
    description:
      'Achiziţii de servicii intracomunitare pentru care beneficiarul este obligat la plata TVA cf.art. 307 alin.(2) din Codul fiscal',
    percentage: '19',
  },
  '356307': {
    kind: 'nondeductible',
    description:
      'Achiziţii de servicii intracomunitare pentru care beneficiarul este obligat la plata TVA cf.art. 307 alin.(2) din Codul fiscal',
    percentage: '9',
  },
  '356308': {
    kind: 'nondeductible',
    description:
      'Achiziţii de servicii intracomunitare pentru care beneficiarul este obligat la plata TVA cf.art. 307 alin.(2) din Codul fiscal',
    percentage: '5',
  },
  '356309': {
    kind: 'nondeductible',
    description:
      'Operaţiuni prevăzute la art.307 alin. (3), (5) si (6) din Codul fiscal precum și operațiuni prevăzute la art 307, alin (2) din Codul fiscal altele decât achiziţii de servicii intracomunitare pentru care beneficiarul este obligat la plata TVA cf.art. 307 alin.(2) din Codul fiscal',
    percentage: '9',
  },
  '356310': {
    kind: 'nondeductible',
    description:
      'Operaţiuni prevăzute la art.307 alin. (3), (5) si (6) din Codul fiscal precum și operațiuni prevăzute la art 307, alin (2) din Codul fiscal altele decât achiziţii de servicii intracomunitare pentru care beneficiarul este obligat la plata TVA cf.art. 307 alin.(2) din Codul fiscal',
    percentage: '5',
  },
  '356311': {
    kind: 'nondeductible',
    description:
      'Achizitii intra-comunitare de bunuri taxabile - altele decat mijloacele de transport noi si produsele accizabile',
    percentage: '9',
  },
  '356312': {
    kind: 'nondeductible',
    description:
      'Achizitii intra-comunitare de bunuri taxabile - altele decat mijloacele de transport noi si produsele accizabile',
    percentage: '5',
  },
  '356313': {
    kind: 'nondeductible',
    description:
      'Achizitii intra-comunitare de bunuri taxabile - altele decat mijloacele de transport noi si produsele accizabile',
    percentage: '21',
  },
  '356314': {
    kind: 'nondeductible',
    description:
      'Achizitii intra-comunitare de bunuri taxabile - altele decat mijloacele de transport noi si produsele accizabile',
    percentage: '11',
  },
  '356315': {
    kind: 'nondeductible',
    description: 'Achizitii intra-comunitare de mijloacele de transport noi',
    percentage: '21',
  },
  '356316': {
    kind: 'nondeductible',
    description: 'Achizitii intra-comunitare de produsele accizabile',
    percentage: '21',
  },
  '356317': {
    kind: 'nondeductible',
    description:
      'Operaţiuni prevăzute la art.307 alin. (3), (5) si (6) din Codul fiscal precum și operațiuni prevăzute la art 307, alin (2) din Codul fiscal altele decât achiziţii de servicii intracomunitare pentru care beneficiarul este obligat la plata TVA cf.art. 307 alin.(2) din Codul fiscal',
    percentage: '21',
  },
  '356318': {
    kind: 'nondeductible',
    description:
      'Operaţiuni prevăzute la art.307 alin. (3), (5) si (6) din Codul fiscal precum și operațiuni prevăzute la art 307, alin (2) din Codul fiscal altele decât achiziţii de servicii intracomunitare pentru care beneficiarul este obligat la plata TVA cf.art. 307 alin.(2) din Codul fiscal',
    percentage: '11',
  },
  '356319': {
    kind: 'nondeductible',
    description:
      'Achiziţii de servicii intracomunitare pentru care beneficiarul este obligat la plata TVA cf.art. 307 alin.(2) din Codul fiscal',
    percentage: '21',
  },
  '356320': {
    kind: 'nondeductible',
    description:
      'Achiziţii de servicii intracomunitare pentru care beneficiarul este obligat la plata TVA cf.art. 307 alin.(2) din Codul fiscal',
    percentage: '11',
  },
  '357301': { kind: 'nondeductible', description: 'Ajustări conform pro-rata', percentage: '24' },
  '357302': { kind: 'nondeductible', description: 'Ajustări de taxă', percentage: '24' },
  '357303': {
    kind: 'nondeductible',
    description: 'Facturi primite dupa inspectia fiscala 19%',
    percentage: '19',
  },
  '357304': {
    kind: 'nondeductible',
    description: 'Facturi primite dupa inspectia fiscala 9%',
    percentage: '9',
  },
  '357305': {
    kind: 'nondeductible',
    description: 'Facturi primite dupa inspectia fiscala 5%',
    percentage: '5',
  },
  '357306': {
    kind: 'nondeductible',
    description: 'Facturi primite dupa inspectia fiscala 21%',
    percentage: '21',
  },
  '357307': {
    kind: 'nondeductible',
    description: 'Facturi primite dupa inspectia fiscala 11%',
    percentage: '11',
  },
  '357311': { kind: 'nondeductible', description: 'Ajustări conform pro-rata', percentage: '19' },
  '357312': { kind: 'nondeductible', description: 'Ajustări conform pro-rata', percentage: '9' },
  '357313': { kind: 'nondeductible', description: 'Ajustări conform pro-rata', percentage: '5' },
  '357314': { kind: 'nondeductible', description: 'Ajustări conform pro-rata', percentage: '20' },
  '357315': { kind: 'nondeductible', description: 'Ajustări conform pro-rata', percentage: '21' },
  '357316': { kind: 'nondeductible', description: 'Ajustări conform pro-rata', percentage: '11' },
  '357321': { kind: 'nondeductible', description: 'Ajustări de taxă', percentage: '19' },
  '357322': { kind: 'nondeductible', description: 'Ajustări de taxă', percentage: '9' },
  '357323': { kind: 'nondeductible', description: 'Ajustări de taxă', percentage: '5' },
  '357324': { kind: 'nondeductible', description: 'Ajustări de taxă', percentage: '20' },
  '357325': { kind: 'nondeductible', description: 'Ajustări de taxă', percentage: '21' },
  '357326': { kind: 'nondeductible', description: 'Ajustări de taxă', percentage: '11' },
  '358301': {
    kind: 'nondeductible',
    description:
      'Achiziții de produse și servicii agricole de la furnizori care aplică regimul special pentru agricultori',
    percentage: '8',
  },
  '358302': {
    kind: 'nondeductible',
    description:
      'Achiziţii de bunuri şi servicii scutite de taxă sau neimpozabile altele decat AIC servicii scutite de taxa',
    percentage: '0',
  },
  '358303': {
    kind: 'nondeductible',
    description: 'Achiziţii de servicii intracomunitare scutite de taxă',
    percentage: '0',
  },
  '358304': {
    kind: 'nondeductible',
    description:
      'TVA efectiv restituită cumpărătorilor străini, inclusiv comisionul unităţilor autorizate',
    percentage: '19',
  },
  '358305': {
    kind: 'nondeductible',
    description:
      'TVA efectiv restituită cumpărătorilor străini, inclusiv comisionul unităţilor autorizate',
    percentage: '9',
  },
  '358306': {
    kind: 'nondeductible',
    description:
      'TVA efectiv restituită cumpărătorilor străini, inclusiv comisionul unităţilor autorizate',
    percentage: '5',
  },
  '358307': {
    kind: 'nondeductible',
    description:
      'TVA efectiv restituită cumpărătorilor străini, inclusiv comisionul unităţilor autorizate',
    percentage: '21',
  },
  '358308': {
    kind: 'nondeductible',
    description:
      'TVA efectiv restituită cumpărătorilor străini, inclusiv comisionul unităţilor autorizate',
    percentage: '11',
  },
  '359101': {
    kind: 'nondeductible',
    description: 'Regularizări taxă dedusă 19%',
    percentage: '19',
  },
  '359102': { kind: 'nondeductible', description: 'Regularizări taxă dedusă 9%', percentage: '9' },
  '359103': { kind: 'nondeductible', description: 'Regularizări taxă dedusă 5%', percentage: '5' },
  '359104': {
    kind: 'nondeductible',
    description: 'Regularizări taxă dedusă 20%',
    percentage: '20',
  },
  '359105': {
    kind: 'nondeductible',
    description: 'Regularizări taxă dedusă 24%',
    percentage: '24',
  },
  '359106': {
    kind: 'nondeductible',
    description: 'Regularizări taxă dedusă 21%',
    percentage: '21',
  },
  '359107': {
    kind: 'nondeductible',
    description: 'Regularizări taxă dedusă 11%',
    percentage: '11',
  },
  '380001': { kind: 'ledger', description: 'Autocolectare TVA 19%', percentage: '19' },
  '380002': { kind: 'ledger', description: 'Autocolectare TVA 9%', percentage: '9' },
  '380003': { kind: 'ledger', description: 'Autocolectare TVA 5%', percentage: '5' },
  '380004': { kind: 'ledger', description: 'Autocolectare TVA 20%', percentage: '20' },
  '380005': { kind: 'ledger', description: 'Autocolectare TVA 24%', percentage: '24' },
  '380006': { kind: 'ledger', description: 'Autocolectare TVA 21%', percentage: '21' },
  '380007': { kind: 'ledger', description: 'Autocolectare TVA 11%', percentage: '11' },
  '380101': { kind: 'ledger', description: 'TVA neexigibilă 19%(*)', percentage: '19' },
  '380102': { kind: 'ledger', description: 'TVA neexigibilă 9% (*)', percentage: '9' },
  '380103': { kind: 'ledger', description: 'TVA neexigibilă 5% (*)', percentage: '5' },
  '380104': { kind: 'ledger', description: 'TVA neexigibilă 20%(*)', percentage: '20' },
  '380105': { kind: 'ledger', description: 'TVA neexigibilă 24%(*)', percentage: '24' },
  '380106': { kind: 'ledger', description: 'TVA neexigibilă 21%(*)', percentage: '21' },
  '380107': { kind: 'ledger', description: 'TVA neexigibilă 11% (*)', percentage: '11' },
  '380200': { kind: 'ledger', description: 'Notă închidere TVA (*)', percentage: null },
  '380301': {
    kind: 'ledger',
    description:
      'Livrări/ prestări pentru care nu există obligația emiterii facturii cu cotă de 19%, conform Art. 319 aliniat 10 din Cod Fiscal',
    percentage: '19',
  },
  '380302': {
    kind: 'ledger',
    description:
      'Livrări/ prestări pentru care nu există obligația emiterii facturii cu cotă de 9% conform Art. 319 aliniat 10 din Cod Fiscal',
    percentage: '9',
  },
  '380303': {
    kind: 'ledger',
    description:
      'Livrări/ prestări pentru care nu există obligația emiterii facturii cu cotă de 5% conform Art. 319 aliniat 10 din Cod Fiscal',
    percentage: '5',
  },
  '380304': {
    kind: 'ledger',
    description:
      'Livrări/ prestări pentru care nu există obligația emiterii facturii și nu sunt supuse TVA, conform Art. 319 aliniat 10 din Cod Fiscal',
    percentage: '0',
  },
  '380305': {
    kind: 'ledger',
    description:
      'Livrări/ prestări pentru care nu există obligația emiterii facturii cu cotă de 21%, conform Art. 319 aliniat 10 din Cod Fiscal',
    percentage: '21',
  },
  '380306': {
    kind: 'ledger',
    description:
      'Livrări/ prestări pentru care nu există obligația emiterii facturii cu cotă de 11% conform Art. 319 aliniat 10 din Cod Fiscal',
    percentage: '11',
  },
};
