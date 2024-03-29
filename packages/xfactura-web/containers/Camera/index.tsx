import Camera from 'react-html5-camera-photo';
import 'react-html5-camera-photo/build/css/index.css';

import LinkButton from '@/components/LinkButton';

import {
    useUnscrollable,
} from '@/logic/hooks';

import {
    useVolatileStore,
} from '@/store';



export default function CameraContainer({
    extractInvoiceFromCamera,
} : {
    extractInvoiceFromCamera: (dataUri: string) => void;
}) {
    const {
        setShowCamera,
    } = useVolatileStore();

    useUnscrollable();

    return (
        <div
            className="h-full bg-black fixed top-0 left-0 right-0 bottom-0 z-50 items-center grid gap-4"
        >
            <div
                className="fixed m-auto top-12 z-40 left-0 right-0 flex justify-center m-4"
            >
                <LinkButton
                    text="anulare"
                    onClick={() => {
                        setShowCamera(false);
                    }}
                />
            </div>

            <Camera
                onTakePhoto={(dataUri) => {
                    extractInvoiceFromCamera(dataUri);
                }}
                idealFacingMode="environment"
                isMaxResolution={true}
                isFullscreen={true}
                imageType="png"
                imageCompression={1}
            />
        </div>
    );
}
