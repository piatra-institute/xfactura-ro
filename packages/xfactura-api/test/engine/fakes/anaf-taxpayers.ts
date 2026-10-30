import {
  parseTaxpayerAnswer,
  TAXPAYER_BATCH,
  TaxpayerLookupFailed,
  type TaxpayerAnswer,
  type TaxpayerQuery,
  type TaxpayerRegistryPort,
} from '../../../source/engine/adapters/anaf-taxpayers';

/**
 * How ANAF answers the next request:
 * - `answer`: the registers, in the documented v9 JSON;
 * - `unavailable`: no answer (a timeout);
 * - `rejected`: HTTP 200 without the documented envelope, as live answers are reported to be.
 */
export type Behaviour = 'answer' | 'unavailable' | 'rejected';

type Taxpayer = {
  name: string;
  vatPayer: boolean;
  cashVat: boolean;
  splitVat: boolean;
  eInvoice: boolean;
  /** Entries in the register of inactive taxpayers: inactive from `from`, reactivated `until`. */
  inactive: { from: string; until?: string }[];
  struckOffOn?: string;
};

/**
 * ANAF's registers of taxpayers, deterministic: what each CUI held on a date, answered in the
 * documented v9 JSON and read back by the live client's parser, in requests of at most 100.
 */
export class FakeTaxpayers implements TaxpayerRegistryPort {
  /** Behaviours of the next requests, in order; `answer` once it is empty. */
  script: Behaviour[] = [];
  readonly requests: TaxpayerQuery[][] = [];
  private readonly taxpayers = new Map<string, Taxpayer>();

  /** Registers a CUI, a VAT payer in good standing unless `details` says otherwise. */
  taxpayer(cui: string, details: Partial<Taxpayer> = {}) {
    this.taxpayers.set(cui, {
      name: `Companie ${cui}`,
      vatPayer: true,
      cashVat: false,
      splitVat: false,
      eInvoice: true,
      inactive: [],
      ...details,
    });
    return this;
  }

  /** Enters a registered CUI in the register of inactive taxpayers from `from`. */
  inactivate(cui: string, from: string, until?: string) {
    this.taxpayers.get(cui)!.inactive.push({ from, ...(until ? { until } : {}) });
    return this;
  }

  async lookup(queries: readonly TaxpayerQuery[]) {
    const answers: TaxpayerAnswer[] = [];
    for (let start = 0; start < queries.length; start += TAXPAYER_BATCH) {
      const batch = queries.slice(start, start + TAXPAYER_BATCH);
      this.requests.push(batch);
      const behaviour = this.script.shift() ?? 'answer';
      if (behaviour === 'unavailable')
        throw new TaxpayerLookupFailed('ANAF nu a răspuns: The operation timed out.', answers);
      const raw = new TextEncoder().encode(
        JSON.stringify(behaviour === 'rejected' ? this.answer(batch).found : this.answer(batch)),
      );
      try {
        answers.push({ raw, results: parseTaxpayerAnswer(raw, batch) });
      } catch (error) {
        throw new TaxpayerLookupFailed((error as Error).message, answers);
      }
    }
    return answers;
  }

  /** The v9 answer about a request's CUIs, each on its date. */
  answer(batch: readonly TaxpayerQuery[]) {
    const known = batch.filter((query) => this.taxpayers.has(query.cui));
    return {
      cod: 200,
      message: 'SUCCESS',
      found: known.map((query) => {
        const taxpayer = this.taxpayers.get(query.cui)!;
        const entry = taxpayer.inactive.findLast((item) => item.from <= query.date);
        const inactive = !!entry && (!entry.until || query.date < entry.until);
        return {
          date_generale: {
            cui: Number(query.cui),
            data: query.date,
            denumire: taxpayer.name,
            adresa: 'MUNICIPIUL BUCUREŞTI, SECTOR 1, STR. EXEMPLU, NR.1',
            nrRegCom: 'J40/1/2010',
            stare_inregistrare: 'INREGISTRAT din data 01.02.2010',
            statusRO_e_Factura: taxpayer.eInvoice,
          },
          inregistrare_scop_Tva: {
            scpTVA: taxpayer.vatPayer,
            perioade_TVA: taxpayer.vatPayer
              ? [
                  {
                    data_inceput_ScpTVA: '2010-02-01',
                    data_sfarsit_ScpTVA: '',
                    data_anul_imp_ScpTVA: '',
                    mesaj_ScpTVA: '',
                  },
                ]
              : [],
          },
          inregistrare_RTVAI: {
            statusTvaIncasare: taxpayer.cashVat,
            dataInceputTvaInc: '',
            dataSfarsitTvaInc: '',
          },
          stare_inactiv: {
            dataInactivare: entry?.from ?? '',
            dataReactivare: entry?.until ?? '',
            dataPublicare: entry?.from ?? '',
            dataRadiere: taxpayer.struckOffOn ?? '',
            statusInactivi: inactive,
          },
          inregistrare_SplitTVA: { statusSplitTVA: taxpayer.splitVat },
          adresa_sediu_social: { sdenumire_Localitate: 'Mun. Bucureşti', scod_JudetAuto: 'B' },
        };
      }),
      notFound: batch
        .filter((query) => !this.taxpayers.has(query.cui))
        .map((query) => Number(query.cui)),
    };
  }
}
