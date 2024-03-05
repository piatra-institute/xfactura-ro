import * as fuzzySearch from '@m31coding/fuzzy-search';

import {
    Inventory,
    Company,
} from '@/data';

import {
    normalizeDiacritics,
} from '@/logic/validation';



export const inventorySearcher = fuzzySearch
    .SearcherFactory
    .createDefaultSearcher<Inventory, string>();


export const companySearcher = fuzzySearch
    .SearcherFactory
    .createDefaultSearcher<Company, string>();


export const countySearcher = fuzzySearch
    .SearcherFactory
    .createDefaultSearcher<string, string>();


export const citySearcher = fuzzySearch
    .SearcherFactory
    .createDefaultSearcher<string, string>();


export class CityData {
    private data: Record<string, string[]> = {};
    private loading = false;

    private async load() {
        try {
            if (this.loading) {
                return;
            }
            this.loading = true;

            const request = await fetch('/assets/places.json');
            const data = await request.json();

            const newData: Record<string, string[]> = {};
            for (const key of Object.keys(data)) {
                newData[
                    normalizeDiacritics(key).toLowerCase()
                ] = data[key];
            }

            this.data = newData;
        } catch (error) {
            console.error(error);
        }
    }

    public getByCounty(
        county: string,
    ): string[] {
        if (Object.keys(this.data).length === 0) {
            this.load();
            return [];
        }

        return this.data[county] || [];
    }
}

export const cityDataFetcher = new CityData();


export default fuzzySearch;
