import {
    Dispatch,
    SetStateAction,
} from 'react';

import {
    AudioRecorder,
    useAudioRecorder,
} from 'react-audio-voice-recorder';

import {
    closeIcon,
} from '../../data/icons';



export default function Audio({
    setShowMicrophone,
    extractInvoiceFromAudio,
    hide,
} : {
    setShowMicrophone: Dispatch<SetStateAction<boolean>>;
    extractInvoiceFromAudio: (blob: Blob) => void;
    hide: () => void;
}) {
    const recorderControls = useAudioRecorder();


    return (
        <div
            className="flex justify-center items-center gap-4 m-2"
        >
            <AudioRecorder
                onRecordingComplete={(blob) => {
                    setShowMicrophone(false);
                    extractInvoiceFromAudio(blob);
                }}
                recorderControls={recorderControls}
                audioTrackConstraints={{
                    noiseSuppression: true,
                    echoCancellation: true,
                }}
            />

            <div
                onClick={() => {
                    if (recorderControls.isRecording) {
                        recorderControls.stopRecording();
                    }

                    hide();
                }}
                className="cursor-pointer scale-75"
            >
                {closeIcon}
            </div>
        </div>
    );
}
