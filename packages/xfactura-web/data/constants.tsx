import {
    InvoiceLine,
    InvoiceLineAllowance,
    Metadata,
    Inventory,
} from './interfaces';

import {
    uploadIcon,
    chatIcon,
    photoIcon,
    microphoneIcon,
} from '@/data/icons';



export const company = {
    vatNumber: '',
    name: '',
    address: '',
    city: '',
    county: '',
    country: 'România',
    contact: '',
    IBAN: '',
};

export const companyText = {
    vatNumber: 'CUI',
    name: 'nume',
    country: 'țară',
    county: 'județ',
    city: 'localitate',
    address: 'adresă',
    contact: 'contact',
    IBAN: 'IBAN',
} as const;

export const companyFields = [
    'vatNumber',
    'name',
    'country',
    'county',
    'city',
    'address',
    'contact',
    'IBAN',
] as const;

export const companyPlaceholder = {
    'vatNumber': 'RO12345678',
    'name': 'Companie SRL',
    'address': 'Strada nr. 1',
    'contact': 'telefon, email'
} as const;


export const emptyInvoiceLine: InvoiceLine = {
    name: '',
    price: 100,
    quantity: 1,
    vatRate: 19,
    vatIncluded: false,
};

export const emptyInvoiceLineAllowance: InvoiceLineAllowance = {
    amount: 0,
    fixedAmount: true,
    reason: 'Discount',
};


export const emptyMetadata: Metadata = {
    number: '',
    currency: 'RON',
    issueDate: Date.now(),
    dueDate: Date.now(),
};


export const emptyInventory: Inventory = {
    id: '',
    belongsTo: '',
    name: '',
    price: 1,
    leftInStock: 0,
    unit: 'buc',
    currency: 'RON',
    vatRate: 19,
    vatIncluded: false,
    history: [],
};


export const countyMap: Record<string, string> = {
    'Alba': 'AB',
    'Arad': 'AR',
    'Arges': 'AG',
    'Bacău': 'BC',
    'Bihor': 'BH',
    'Bistrița-Năsăud': 'BN',
    'Botoșani': 'BT',
    'Brașov': 'BV',
    'Brăila': 'BR',
    'București': 'B',
    'Buzău': 'BZ',
    'Caraș-Severin': 'CS',
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
    'Iași': 'IS',
    'Ilfov': 'IF',
    'Maramureș': 'MM',
    'Mehedinți': 'MH',
    'Mureș': 'MS',
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


export const EINVOICE_API = ENVIRONMENT.X_DOMAIN + '/api/einvoice';

export const UPLOAD_AUDIO_API = ENVIRONMENT.AI_DOMAIN + '/upload_audio';
export const UPLOAD_FILE_API = ENVIRONMENT.AI_DOMAIN + '/upload_file';
export const UPLOAD_TEXT_API = ENVIRONMENT.AI_DOMAIN + '/upload_text';

export const COMPANY_DETAILS_API = ENVIRONMENT.API_DOMAIN + '/company-details';


export const smartActsLabels = {
    'unspecified': 'nespecificat',
    'local': 'local',
    'cloud': 'cloud',
};


export const extractorTitles = {
    'upload': 'încărcare',
    'text': 'text',
    'camera': 'fotografiere',
    'record': 'înregistrare',
};

export const extractorInvoiceText = `factură de la CUI/nume companie ... către CUI/nume companie ... număr ... dată ... produs unu ... preț ...`;

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
    'text': (
        <>
            scrie text pentru a da comenzi către xfactura.ro
            <br />
            &quot;{extractorInvoiceText}&quot;
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
            &quot;{extractorInvoiceText}&quot;
        </>
    ),
};

export const extractorIcons = {
    'upload': uploadIcon,
    'text': chatIcon,
    'camera': photoIcon,
    'record': microphoneIcon,
};
