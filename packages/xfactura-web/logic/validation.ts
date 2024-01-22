import {
    NewParty,
    InvoiceLine,
    Metadata,

    countyMap,
    countryMap,
} from '../data';



export const normalizeDiacritics = (
    value: string,
) => {
    return value
        .replace(/ă/g, 'a')
        .replace(/â/g, 'a')
        .replace(/î/g, 'i')
        .replace(/ș/g, 's')
        .replace(/ş/g, 's')
        .replace(/ț/g, 't')
        .replace(/ţ/g, 't');
}


export const normalizeCountyString = (
    value: string,
) => {
    const normalizedValue = value
        .trim()
        .toLowerCase()
        .replace(/ /g, '')
        .replace(/-/g, '')

    return normalizeDiacritics(normalizedValue);
}

export const normalizeUserCounty = (
    userCounty: string,
    userCountry: string,
) => {
    const normalizedUserCounty = normalizeCountyString(userCounty);

    for (const [key, value] of Object.entries(countyMap)) {
        const normalizedKey = normalizeCountyString(key);

        if (normalizedKey === normalizedUserCounty) {
            return normalizeUserCountry(userCountry) + '-' + value;
        }
    }
}

export const normalizeUserCountry = (
    value: string,
) => {
    const normalizedValue = normalizeDiacritics(
        toNormalCase(value),
    );
    const country = countryMap[normalizedValue];

    return country || 'RO';
}


export const checkValidParty = (party: NewParty) => {
    const validName = party.name.length > 0;
    const validVatNumber = party.vatNumber.length > 0;
    const validCounty = party.county.length > 0 && !!normalizeUserCounty(party.county, party.country);
    const validCity = party.city.length > 0;
    const validAddress = party.address.length > 0;

    return (
        validName &&
        validVatNumber &&
        validCounty &&
        validCity &&
        validAddress
    );
}


export const checkValidLine = (line: InvoiceLine) => {
    const validName = line.name.length > 0;
    const validQuantity = line.quantity > 0;
    const validPrice = line.price > 0;

    return (
        validName &&
        validQuantity &&
        validPrice
    );
}


export const checkValidMetadata = (metadata: Metadata) => {
    const validNumber = metadata.number.length > 0;
    const validCurrency = metadata.currency.length > 0;
    const validIssueDate = metadata.issueDate > 0;
    const validDueDate = metadata.dueDate > 0;

    return (
        validNumber &&
        validCurrency &&
        validIssueDate &&
        validDueDate
    );
}


export const normalizeVatNumber = (
    vatNumber: string | null | undefined,
) => {
    if (!vatNumber) {
        return '';
    }

    let value = vatNumber
        .toUpperCase()
        .replace(/\s/g, '');

    if (value.startsWith('RO')) {
        return value;
    }

    return 'RO' + value;
}


export const toNormalCase = (
    value: string,
) => {
    const letters = [];
    const chars = [...value];

    for (const [idx, letter] of chars.entries()) {
        if (idx === 0) {
            letters.push(letter.toUpperCase());
            continue;
        }

        const previousChar = chars[idx - 1];
        if (previousChar === ' ' || previousChar === '-') {
            letters.push(letter.toUpperCase());
            continue;
        } else {
            letters.push(letter.toLowerCase());
        }
    }

    return letters.join('').trim();
}


export const normalizePartyName = (
    value: string,
) => {
    return toNormalCase(value)
        .replace(/S.r.l.$/, 'SRL')
        .replace(/S.a.$/, 'SA');
}


export const normalizePartyCity = (
    value: string,
) => {
    return value.replace('Mun. ', '');
}


export const normalizePartyCounty = (
    value: string,
) => {
    return toNormalCase(value);
}


export const verifyPartyData = (
    data: NewParty,
) => {
    try {
        return typeof data.vatNumber === 'string'
            && data.vatNumber
            && data.vatNumber.length > 5
            && typeof data.name === 'string'
            && data.name
            && typeof data.country === 'string'
            && data.country
            && typeof data.county === 'string'
            && data.county
            && typeof data.city === 'string'
            && data.city
            && typeof data.address === 'string'
            && data.address
    } catch (error) {
        return false;
    }
}


export const isObject = (
    value: any,
) => {
    return typeof value === 'object'
        && value !== null
        && !Array.isArray(value);
}



export const verifyInputVatNumber = (
    value: string | null | undefined,
) => {
    if (typeof value !== 'string') {
        return '';
    }

    return value
        .toUpperCase()
        .trim()
        .replace(/\s/g, '')
        .replace('RO', '');
}

export const verifyInputUserName = (
    value: string | null | undefined,
) => {
    if (typeof value !== 'string') {
        return '';
    }

    return value;
}

export const verifyInputUserCountry = (
    value: string | null | undefined,
) => {
    if (typeof value !== 'string') {
        return '';
    }

    return value;
}

export const verifyInputUserCounty = (
    value: string | null | undefined,
) => {
    if (typeof value !== 'string') {
        return '';
    }

    return value;
}

export const verifyInputUserCity = (
    value: string | null | undefined,
) => {
    if (typeof value !== 'string') {
        return '';
    }

    return value;
}

export const verifyInputUserAddress = (
    value: string | null | undefined,
) => {
    if (typeof value !== 'string') {
        return '';
    }

    return value;
}

export const verifyInputUserInvoiceNumber = (
    value: string | null | undefined,
) => {
    if (typeof value !== 'string') {
        return '';
    }

    return value;
}

export const verifyInputUserCurrency = (
    value: string | null | undefined,
) => {
    if (typeof value !== 'string') {
        return '';
    }

    return value;
}

export const verifyInputUserDate = (
    value: string | null | undefined,
) => {
    if (typeof value !== 'string') {
        return Date.now();
    }

    try {
        const date = new Date(value);

        if (isNaN(date.getTime())) {
            return Date.now();
        }

        return date.getTime();
    } catch (error) {
        return Date.now();
    }
}
