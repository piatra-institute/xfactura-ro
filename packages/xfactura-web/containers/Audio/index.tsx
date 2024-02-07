import {
    AudioRecorder,
    useAudioRecorder,
} from 'react-audio-voice-recorder';

import {
    closeIcon,
} from '@/data/icons';

import {
    useVolatileStore,
} from '@/store';



export default function Audio({
    extractInvoiceFromAudio,
} : {
    extractInvoiceFromAudio: (blob: Blob) => void;
}) {
    const {
        setShowMicrophone,
    } = useVolatileStore();

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

                    setShowMicrophone(false);
                }}
                className="cursor-pointer scale-75"
            >
                {closeIcon}
            </div>
        </div>
    );
}
