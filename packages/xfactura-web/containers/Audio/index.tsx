import {
    AudioRecorder,
    useAudioRecorder,
} from 'react-audio-voice-recorder';

import {
    closeIcon,
} from '@/data/icons';

import {
    focusStyle,
} from '@/data/styles';

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

            <button
                onClick={() => {
                    if (recorderControls.isRecording) {
                        recorderControls.stopRecording();
                    }

                    setShowMicrophone(false);
                }}
                className={focusStyle}
            >
                <div
                    className="scale-75 p-1"
                >
                    {closeIcon}
                </div>
            </button>
        </div>
    );
}
