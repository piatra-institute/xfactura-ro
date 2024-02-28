import * as fuzzySearch from '@m31coding/fuzzy-search';

import {
    Inventory,
} from '@/data';



export const inventorySearcher = fuzzySearch
    .SearcherFactory
    .createDefaultSearcher<Inventory, string>();


export default fuzzySearch;
