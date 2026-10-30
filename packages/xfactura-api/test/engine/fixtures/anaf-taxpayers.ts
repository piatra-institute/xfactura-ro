/**
 * An answer of ANAF's taxpayer service v9 in the shape its documentation gives (ANAF/WS-TVA-v9,
 * doc_WS_V9.txt): the envelope, then per CUI found its general data, VAT registration, VAT on a
 * cash basis, inactivity, split VAT and registered office, with absent dates as empty strings.
 * Written from the document, not recorded from the live service; the CUIs and names are
 * synthetic.
 */
export const recordedQueries = [
  { cui: '18547290', date: '2026-10-01' },
  { cui: '14399840', date: '2026-10-01' },
  { cui: '99999999', date: '2026-10-01' },
];

export const recordedAnswer = `{
  "cod": 200,
  "message": "SUCCESS",
  "found": [
    {
      "date_generale": {
        "cui": 18547290,
        "data": "2026-10-01",
        "denumire": "FURNIZOR ACTIV SRL",
        "adresa": "MUNICIPIUL BUCUREŞTI, SECTOR 1, STR. EXEMPLU, NR.1",
        "nrRegCom": "J40/1234/2006",
        "telefon": "",
        "fax": "",
        "codPostal": "010101",
        "act": "",
        "stare_inregistrare": "INREGISTRAT din data 10.04.2006",
        "data_inregistrare": "2006-04-10",
        "cod_CAEN": "6201",
        "iban": "",
        "statusRO_e_Factura": true,
        "organFiscalCompetent": "Administraţia Sector 1 a Finanţelor Publice",
        "forma_de_proprietate": "PROPR.PRIVATA-CAPITAL PRIVAT AUTOHTON",
        "forma_organizare": "PERSOANA JURIDICA",
        "forma_juridica": "SOCIETATE COMERCIALĂ CU RĂSPUNDERE LIMITATĂ"
      },
      "inregistrare_scop_Tva": {
        "scpTVA": true,
        "perioade_TVA": [
          {
            "data_inceput_ScpTVA": "2006-05-01",
            "data_sfarsit_ScpTVA": "",
            "data_anul_imp_ScpTVA": "",
            "mesaj_ScpTVA": ""
          }
        ]
      },
      "inregistrare_RTVAI": {
        "dataInceputTvaInc": "2024-01-01",
        "dataSfarsitTvaInc": "",
        "dataActualizareTvaInc": "2023-12-20",
        "dataPublicareTvaInc": "2023-12-21",
        "tipActTvaInc": "Inregistrare",
        "statusTvaIncasare": true
      },
      "stare_inactiv": {
        "dataInactivare": "",
        "dataReactivare": "",
        "dataPublicare": "",
        "dataRadiere": "",
        "statusInactivi": false
      },
      "inregistrare_SplitTVA": {
        "dataInceputSplitTVA": "",
        "dataAnulareSplitTVA": "",
        "statusSplitTVA": false
      },
      "adresa_sediu_social": {
        "sdenumire_Strada": "Str. Exemplu",
        "snumar_Strada": "1",
        "sdenumire_Localitate": "Mun. Bucureşti",
        "scod_Localitate": "179132",
        "sdenumire_Judet": "MUNICIPIUL BUCUREŞTI",
        "scod_Judet": "40",
        "scod_JudetAuto": "B",
        "stara": "",
        "sdetalii_Adresa": "",
        "scod_Postal": "010101"
      }
    },
    {
      "date_generale": {
        "cui": 14399840,
        "data": "2026-10-01",
        "denumire": "FURNIZOR INACTIV SRL",
        "adresa": "JUD. ILFOV, ORŞ. VOLUNTARI, STR. EXEMPLU, NR.2",
        "nrRegCom": "J23/567/2015",
        "stare_inregistrare": "INREGISTRAT din data 02.03.2015",
        "statusRO_e_Factura": false
      },
      "inregistrare_scop_Tva": {
        "scpTVA": false,
        "perioade_TVA": []
      },
      "inregistrare_RTVAI": {
        "dataInceputTvaInc": "",
        "dataSfarsitTvaInc": "",
        "dataActualizareTvaInc": "",
        "dataPublicareTvaInc": "",
        "tipActTvaInc": "",
        "statusTvaIncasare": false
      },
      "stare_inactiv": {
        "dataInactivare": "2026-09-15",
        "dataReactivare": "",
        "dataPublicare": "2026-09-16",
        "dataRadiere": "",
        "statusInactivi": true
      },
      "inregistrare_SplitTVA": {
        "dataInceputSplitTVA": "2020-02-01",
        "dataAnulareSplitTVA": "",
        "statusSplitTVA": true
      },
      "adresa_sediu_social": {
        "sdenumire_Localitate": "Oraş Voluntari",
        "scod_JudetAuto": "IF"
      }
    }
  ],
  "notFound": [99999999]
}`;
