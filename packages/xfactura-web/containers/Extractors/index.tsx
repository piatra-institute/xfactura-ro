import {
    useRef,
    useState,
    useEffect,
} from 'react';

import {
    acceptedInvoiceFiles,
    extractorTitles,
    extractorDescriptions,
    extractorIcons,
} from '@/data';

import LinkButton from '@/components/LinkButton';
import Tooltip from '@/components/Tooltip';
import ActsModal from '@/components/ActsModal';

import {
    defocus,
    styleTrim,
} from '@/logic/utilities';

import {
    useVolatileStore,
} from '@/store';



export type ExtractorType = 'upload' | 'text' | 'camera' | 'record';

export const ExtractorButton = ({
    type,
    handleClickExtractor,
    configInput,
    handleReadInput,
    last,
} : {
    type: ExtractorType;
    handleClickExtractor: (type: ExtractorType) => void;
    configInput?: React.MutableRefObject<HTMLInputElement | null>;
    handleReadInput?: () => void;
    last?: boolean;
}) => {
    return (
        <div
            className={last ? '' : 'mb-4'}
        >
            {handleReadInput
            && configInput
            && (
                <input
                    ref={configInput}
                    type="file"
                    accept={acceptedInvoiceFiles}
                    className="hidden"
                    onChange={() => handleReadInput()}
                />
            )}
            <Tooltip
                content={extractorDescriptions[type]}
            >
                <div
                    className="flex items-center gap-1"
                >
                    <LinkButton
                        text={extractorTitles[type]}
                        onClick={() => handleClickExtractor(type)}
                        icon={extractorIcons[type]}
                    />
                </div>
            </Tooltip>
        </div>
    );
}


export default function Extractors({
    extractInvoiceFromFile,
} : {
    extractInvoiceFromFile: (file: File) => void;
}) {
    // #region references
    const configInput = useRef<HTMLInputElement | null>(null);
    // #endregion references


    // #region state
    const {
        hasMediaDevices,
        setShowText,
        setShowCamera,
        setShowMicrophone,
    } = useVolatileStore();

    const [
        showActsModal,
        setShowActsModal,
    ] = useState(false);
    const [
        actsModalType,
        setActsModalType,
    ] = useState('');
    const [
        actsModalTitle,
        setActsModalTitle,
    ] = useState('');
    const [
        actsModalDescription,
        setActsModalDescription,
    ] = useState(<></>);
    // #endregion state


    // #region handlers
    const triggerReadInput = () => {
        if (!configInput?.current) {
            return;
        }
        configInput.current.click();
    }

    const handleReadInput = async () => {
        if (!configInput?.current) {
            return;
        }

        const files = configInput.current.files;
        if (!files) {
            return;
        }

        const file = files[0];
        if (!file) {
            return;
        }

        extractInvoiceFromFile(file);
    }

    const actsModalAction = (
        kind: 'local' | 'cloud',
    ) => {
        setShowActsModal(false);

        switch (actsModalType) {
            case 'upload':
                triggerReadInput();
                break;
            case 'text':
                setShowText(true);
                break;
            case 'camera':
                if (kind === 'local') {
                    setShowCamera(true);
                } else {
                    setShowCamera(true);
                }
                break;
            case 'record':
                setShowMicrophone(true);
            default:
                break;
        }

        setActsModalType('');
        setActsModalTitle('');
        setActsModalDescription(<></>);
    }

    const handleClickExtractor = (
        type: ExtractorType,
    ) => {
        defocus();
        setShowActsModal(true);
        setActsModalType(type);
        setActsModalTitle(extractorTitles[type]);
        setActsModalDescription(extractorDescriptions[type]);
    }
    // #endregion handlers


    // #region effects
    /** Keydown */
    useEffect(() => {
        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && showActsModal) {
                setShowActsModal(false);
            }
        }

        if (showActsModal) {
            window.addEventListener('keydown', handleEscape);
        }

        return () => {
            window.removeEventListener('keydown', handleEscape);
        };
    }, [
        showActsModal,
    ]);
    // #endregion effects


    // #region render
    return (
        <div
            className={styleTrim(`
                min-h-[50px] grid gap-4 justify-center items-center justify-items-center
                text-center
                md:flex md:gap-6
            `)}
        >
            <ExtractorButton
                type={'upload'}
                handleClickExtractor={handleClickExtractor}
                configInput={configInput}
                handleReadInput={handleReadInput}
            />

            <ExtractorButton
                type={'text'}
                handleClickExtractor={handleClickExtractor}
            />

            {hasMediaDevices && (
                <>
                    <ExtractorButton
                        type={'camera'}
                        handleClickExtractor={handleClickExtractor}
                    />

                    <ExtractorButton
                        type={'record'}
                        handleClickExtractor={handleClickExtractor}
                        last={true}
                    />
                </>
            )}

            {showActsModal && (
                <ActsModal
                    title={actsModalTitle}
                    description={actsModalDescription}
                    action={(kind) => {
                        actsModalAction(kind);
                    }}
                    back={() => {
                        setShowActsModal(false);
                    }}
                />
            )}
        </div>
    );
    // #endregion render
}
