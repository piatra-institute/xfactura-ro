import {
    useRef,
    useState,
    useEffect,
} from 'react';

import {
    acceptedInvoiceFiles,
    extractorTitles,
    extractorDescriptions,
} from '@/data';

import {
    uploadIcon,
    photoIcon,
    microphoneIcon,
} from '@/data/icons';

import LinkButton from '@/components/LinkButton';
import Tooltip from '@/components/Tooltip';
import ActsModal from '@/components/ActsModal';



export default function Extractors({
    hasMediaDevices,
    setShowCamera,
    setShowMicrophone,
    extractInvoiceFromFile,
} : {
    hasMediaDevices: boolean;
    setShowCamera: (value: boolean) => void;
    setShowMicrophone: (value: boolean) => void;
    extractInvoiceFromFile: (file: File) => void;
}) {
    const configInput = useRef<HTMLInputElement | null>(null);


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


    return (
        <div
            className="grid gap-4 justify-center items-center justify-items-center text-center min-h-[50px] md:flex md:gap-6"
        >
            <div
                className="mb-4"
            >
                <input
                    ref={configInput}
                    type="file"
                    accept={acceptedInvoiceFiles}
                    className="hidden"
                    onChange={() => handleReadInput()}
                />
                <Tooltip
                    content={extractorDescriptions.upload}
                >
                    <div
                        className="flex items-center gap-1"
                    >
                        <LinkButton
                            text={extractorTitles.upload}
                            onClick={() => {
                                setShowActsModal(true);
                                setActsModalType('upload');
                                setActsModalTitle(extractorTitles.upload);
                                setActsModalDescription(extractorDescriptions.upload);
                            }}
                            icon={uploadIcon}
                        />
                    </div>
                </Tooltip>
            </div>

            {hasMediaDevices && (
                <>
                    <div
                        className="mb-4"
                    >
                        <Tooltip
                            content={extractorDescriptions.camera}
                        >
                            <div
                                className="flex items-center gap-1"
                            >
                                <LinkButton
                                    text={extractorTitles.camera}
                                    onClick={() => {
                                        setShowActsModal(true);
                                        setActsModalType('camera');
                                        setActsModalTitle(extractorTitles.camera);
                                        setActsModalDescription(extractorDescriptions.camera);
                                    }}
                                    icon={photoIcon}
                                />
                            </div>
                        </Tooltip>
                    </div>

                    <div
                        className="mb-4"
                    >
                        <Tooltip
                            content={extractorDescriptions.record}
                        >
                            <div
                                className="flex items-center gap-1"
                            >
                                <LinkButton
                                    text={extractorTitles.record}
                                    onClick={() => {
                                        setShowActsModal(true);
                                        setActsModalType('record');
                                        setActsModalTitle(extractorTitles.record);
                                        setActsModalDescription(extractorDescriptions.record);
                                    }}
                                    icon={microphoneIcon}
                                />
                            </div>
                        </Tooltip>
                    </div>
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
}
