import {
    InvoiceLine,
    Metadata,
} from './interfaces';



export const company = {
    vatNumber: '',
    name: '',
    address: '',
    city: '',
    county: '',
    country: 'România',
};

export const companyText = {
    vatNumber: 'CUI',
    name: 'nume',
    country: 'țară',
    county: 'județ',
    city: 'localitate',
    address: 'adresă',
} as const;

export const companyFields = [
    'vatNumber',
    'name',
    'country',
    'county',
    'city',
    'address',
] as const;


export const emptyInvoiceLine: InvoiceLine = {
    name: '',
    price: 100,
    quantity: 1,
    vatRate: 19,
    vatIncluded: false,
};


export const emptyMetadata: Metadata = {
    number: '',
    currency: 'RON',
    issueDate: Date.now(),
    dueDate: Date.now(),
};


export const countyMap: Record<string, string> = {
    'Alba': 'AB',
    'Arad': 'AR',
    'Arges': 'AG',
    'Bacău': 'BC',
    'Bihor': 'BH',
    'Bistrița-Năsăud': 'BN',
    'Botoşani': 'BT',
    'Braşov': 'BV',
    'Brăila': 'BR',
    'București': 'B',
    'Buzău': 'BZ',
    'Caraş-Severin': 'CS',
    'Cluj': 'CJ',
    'Constanţa': 'CT',
    'Covasna': 'CV',
    'Călărași': 'CL',
    'Dolj': 'DJ',
    'Dâmbovița': 'DB',
    'Galați': 'GL',
    'Giurgiu': 'GR',
    'Gorj': 'GJ',
    'Harghita': 'HR',
    'Hunedoara': 'HD',
    'Ialomiţa': 'IL',
    'Iaşi': 'IS',
    'Ilfov': 'IF',
    'Maramureş': 'MM',
    'Mehedinți': 'MH',
    'Mureş': 'MS',
    'Neamț': 'NT',
    'Olt': 'OT',
    'Prahova': 'PH',
    'Satu Mare': 'SM',
    'Sibiu': 'SB',
    'Suceava': 'SV',
    'Sălaj': 'SJ',
    'Teleorman': 'TR',
    'Timiș': 'TM',
    'Tulcea': 'TL',
    'Vaslui': 'VS',
    'Vrancea': 'VN',
    'Vâlcea': 'VL',
};


export const countryMap: Record<string, string> = {
    'Romania': 'RO',
};


export const acceptedInvoiceFiles = '.jpg,.jpeg,.png,.pdf,.docx,.xlsx,.xml,.json';


export const ENVIRONMENT = {
    IN_PRODUCTION: process.env.NEXT_PUBLIC_IN_PRODUCTION || '',
    X_DOMAIN: process.env.NEXT_PUBLIC_X_DOMAIN || '',
    AI_DOMAIN: process.env.NEXT_PUBLIC_AI_DOMAIN || '',
    API_DOMAIN: process.env.NEXT_PUBLIC_API_DOMAIN || '',
    STRIPE_KEY: process.env.NEXT_PUBLIC_STRIPE_KEY || '',
    GOOGLE_LOGIN: process.env.NEXT_PUBLIC_GOOGLE_LOGIN || '',
};


export const COMPANY_DETAILS_API = `${ENVIRONMENT.X_DOMAIN}/api/company_details`;
export const EINVOICE_API = `${ENVIRONMENT.X_DOMAIN}/api/einvoice`;

export const UPLOAD_AUDIO_API = `${ENVIRONMENT.AI_DOMAIN}/upload_audio`;
export const UPLOAD_FILE_API = `${ENVIRONMENT.AI_DOMAIN}/upload_file`;


export const smartActsLabels = {
    'unspecified': 'nespecificat',
    'local': 'local',
    'cloud': 'cloud',
};


export const extractorTitles = {
    'upload': 'încărcare',
    'camera': 'fotografiere',
    'record': 'înregistrare',
};

export const extractorDescriptions = {
    'upload': (
        <>
            încarcă fișier cu factura în format
            <br />
            {acceptedInvoiceFiles.replace(/\./g, ' ')}
            <br />
            pentru a detecta automat datele
        </>
    ),
    'camera': (
        <>
            folosește camera pentru a fotografia factura
            <br />
            și a detecta automat datele
        </>
    ),
    'record': (
        <>
            folosește microfonul pentru a dicta factura
            <br />
            &quot;factură de la CUI ... către CUI ... număr ... dată ... produs unu ... preț ...&quot;
        </>
    ),
};