import * as fuzzySearch from '@m31coding/fuzzy-search';

import {
    Inventory,
    Company,
} from '@/data';



export const inventorySearcher = fuzzySearch
    .SearcherFactory
    .createDefaultSearcher<Inventory, string>();


export const companySearcher = fuzzySearch
    .SearcherFactory
    .createDefaultSearcher<Company, string>();


export default fuzzySearch;
