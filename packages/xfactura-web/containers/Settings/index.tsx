import {
    useRef,
} from 'react';

import {
    smartActsLabels,
} from '@/data';

import MenuBack from '@/components/MenuBack';
import Deleter from '@/components/Deleter';
import LinkButton from '@/components/LinkButton';
import Toggle from '@/components/Toggle';
import Dropdown from '@/components/Dropdown';
import Subtitle from '@/components/Subtitle';

import {
    isObject,
} from '@/logic/validation';

import {
    downloadTextFile,
    defocus,
} from '@/logic/utilities';

import useStore, {
    useVolatileStore,
} from '@/store';



export default function Settings({
    back,
} : {
    back: () => void;
}) {
    const importInput = useRef<HTMLInputElement | null>(null);


    const {
        user,

        usingLocalStorage,
        toggleUsingLocalStorage,

        generateEinvoiceLocally,
        toggleGenerateEinvoiceLocally,

        smartActs,
        setSmartActs,

        storeGoogleDrive,
        toggleStoreGoogleDrive,

        defaultSeller,
        setDefaultSeller,

        companies,
        invoices,
        inventory,

        loadData,

        clearStore,
    } = useStore();

    const {
        clearVolatileStore,
    } = useVolatileStore();


    const exportData = () => {
        const data = {
            exportedAt: Date.now(),
            defaultSeller,
            companies,
            invoices,
            inventory,
        };

        const date = new Date().toISOString().split('T')[0];

        downloadTextFile(
            `xfactura-ro-export-${date}.json`,
            JSON.stringify(data, null, 2),
            'application/json',
        );
    }

    const triggerImport = () => {
        if (!importInput?.current) {
            return;
        }
        importInput.current.click();
    }

    const handleImport = () => {
        if (!importInput?.current) {
            return;
        }

        const files = importInput.current.files;
        if (!files) {
            return;
        }

        const file = files[0];
        if (!file) {
            return;
        }

        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const data = event.target?.result;
                if (!data) {
                    return;
                }

                const parsedData = JSON.parse(data as string);
                if (!parsedData) {
                    return;
                }

                if (
                    typeof parsedData.defaultSeller === 'string' && parsedData.defaultSeller
                    && isObject(parsedData.companies)
                    && isObject(parsedData.invoices)
                    && isObject(parsedData.inventory)
                ) {
                    setDefaultSeller(parsedData.defaultSeller);

                    loadData({
                        companies: parsedData.companies,
                        invoices: parsedData.invoices,
                        inventory: parsedData.inventory,
                    });

                    setTimeout(() => {
                        // TODO notify
                        location.reload();
                    }, 1_000);
                }
            } catch (error) {
                return;
            }
        };
        reader.readAsText(file);
    }

    const reload = () => {
        setTimeout(() => {
            // TODO notify
            location.reload();
        }, 1_000);
    }


    return (
        <div
            className="p-4"
        >
            <Subtitle
                text="setări"
                centered={true}
            />

            <div
                className="grid gap-4 md:min-w-[300px]"
            >
                <Toggle
                    text="stocare date locale"
                    value={usingLocalStorage}
                    toggle={() => {
                        toggleUsingLocalStorage();
                    }}
                />

                <Toggle
                    text="generare efactura local"
                    value={generateEinvoiceLocally}
                    toggle={() => {
                        toggleGenerateEinvoiceLocally();

                        reload();
                    }}
                    tooltip={(
                        <>
                            <p>
                                dacă această opțiune este activată, efactura se va genera în browser, fără a fi trimisă către serverul xfactura.ro · recomandat în browser-ul Chrome sau Firefox pe desktop
                            </p>
                            <p
                                className="mb-0"
                            >
                                dacă această opțiune este dezactivată, efactura se va genera pe serverul xfactura.ro fără a fi stocate datele
                            </p>
                        </>
                    )}
                />

                <Dropdown
                    name="acte inteligente"
                    selected={(smartActsLabels as any)[smartActs]}
                    selectables={[
                        ...Object.values(smartActsLabels),
                    ]}
                    atSelect={(selected) => {
                        Object.keys(smartActsLabels).forEach((key) => {
                            if ((smartActsLabels as any)[key] === selected) {
                                setSmartActs(key);
                            }
                        });
                    }}
                    tooltip={(
                        <>
                            <p>
                                actele inteligente pot fi folosite pentru a genera automat xfacturi din imagini, documente, sau folosind vocea
                            </p>
                            <p>
                                modelele neuronale pentru actele inteligente pot rula în browser (local—complet gratuit) sau pe serverul xfactura.ro (cloud—contra cost)
                            </p>
                            <p
                                className="mb-0"
                            >
                                prin selectarea acestei opțiuni generarea inteligentă va rula direct modelul neuronal local sau în cloud
                            </p>
                        </>
                    )}
                />

                {user && (
                    <Toggle
                        text="sincronizare Google Drive"
                        value={storeGoogleDrive}
                        toggle={() => toggleStoreGoogleDrive()}
                        tooltip={(
                            <>
                                <p
                                    className="mb-0"
                                >
                                    stocarea datelor în Google Drive permite sincronizarea datelor între dispozitive și crearea de copii de siguranță
                                </p>
                            </>
                        )}
                    />
                )}

                <LinkButton
                    text="export"
                    onClick={() => {
                        exportData();
                        defocus();
                    }}
                />

                <input
                    ref={importInput}
                    type="file"
                    accept={'.json'}
                    className="hidden"
                    onChange={() => handleImport()}
                />
                <LinkButton
                    text="import"
                    onClick={() => {
                        triggerImport();
                    }}
                />

                <Deleter
                    title="ștergere totală"
                    atDelete={() => {
                        clearStore();
                        clearVolatileStore();

                        reload();
                    }}
                />
            </div>

            <MenuBack
                back={back}
            />
        </div>
    );
}
