import { useEffect, useRef, useState } from 'react';
import { useVolatileStore } from '@/store';

export default function Audio({ extractInvoiceFromAudio }: { extractInvoiceFromAudio: (blob: Blob) => void }) {
    const { setShowMicrophone } = useVolatileStore();
    const recorder = useRef<MediaRecorder | null>(null);
    const stream = useRef<MediaStream | null>(null);
    const mounted = useRef(false);
    const keepRecording = useRef(false);
    const [recording, setRecording] = useState(false);
    const [starting, setStarting] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            keepRecording.current = false;
            if (recorder.current?.state === 'recording') recorder.current.stop();
            stream.current?.getTracks().forEach(track => track.stop());
        };
    }, []);

    async function start() {
        setStarting(true);
        setError('');
        try {
            if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('unsupported');
            const source = await navigator.mediaDevices.getUserMedia({ audio: { noiseSuppression: true, echoCancellation: true } });
            if (!mounted.current) { source.getTracks().forEach(track => track.stop()); return; }
            stream.current = source;
            const capture = new MediaRecorder(source);
            const parts: Blob[] = [];
            capture.ondataavailable = event => { if (event.data.size) parts.push(event.data); };
            capture.onstop = () => {
                source.getTracks().forEach(track => track.stop());
                if (keepRecording.current && mounted.current) {
                    setShowMicrophone(false);
                    extractInvoiceFromAudio(new Blob(parts, { type: capture.mimeType }));
                }
            };
            recorder.current = capture;
            keepRecording.current = true;
            capture.start();
            setRecording(true);
        } catch {
            if (mounted.current) setError('Microfonul nu este disponibil. Verifică permisiunea browserului sau folosește introducerea prin text.');
        } finally { if (mounted.current) setStarting(false); }
    }

    return <div className="grid gap-4 m-4 text-center" aria-live="polite">
        {error ? <p role="alert">{error}</p> : null}
        {recording ? <button className="p-2 border rounded" onClick={() => { setRecording(false); recorder.current?.stop(); }}>Oprește și procesează înregistrarea</button>
            : <button className="p-2 border rounded" disabled={starting} onClick={() => void start()}>{starting ? 'Se conectează microfonul…' : 'Începe înregistrarea'}</button>}
        <button className="p-2" onClick={() => { keepRecording.current = false; setShowMicrophone(false); }}>Anulează</button>
    </div>;
}
