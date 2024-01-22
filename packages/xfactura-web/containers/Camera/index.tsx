import Camera from 'react-html5-camera-photo';
import 'react-html5-camera-photo/build/css/index.css';

import LinkButton from '../../components/LinkButton';



export default function CameraContainer({
    extractInvoiceFromCamera,
    back,
} : {
    extractInvoiceFromCamera: (dataUri: string) => void;
    back: () => void;
}) {
    return (
        <div
            className="h-full bg-black fixed top-0 left-0 right-0 bottom-0 z-50 items-center grid gap-4"
        >
            <div
                className="fixed m-auto top-4 left-0 right-0 flex justify-center m-4"
            >
                <LinkButton
                    text="anulare"
                    onClick={() => back()}
                />
            </div>

            <Camera
                onTakePhoto={(dataUri) => {
                    extractInvoiceFromCamera(dataUri);
                }}
                idealFacingMode="environment"
                isMaxResolution={true}
                imageType="png"
                imageCompression={1}
            />
        </div>
    );
}
