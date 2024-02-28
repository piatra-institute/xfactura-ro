import {
    Metadata,
} from '@/data';

import Input from '@/components/Input';
import Datepicker from '@/components/Datepicker';
import Subtitle from '@/components/Subtitle';



export default function Metadata({
    metadata,
    updateMetadata,
    updateDate,
} : {
    metadata: Metadata;
    updateMetadata: (
        type: keyof Metadata,
        value: string | number,
    ) => void;
    updateDate: (
        kind: 'issueDate' | 'dueDate',
        timestamp: number,
    ) => void;
}) {
    return (
        <div
            className="max-w-[500px] mx-auto grid md:place-content-center p-4"
        >
            <Subtitle
                text="metadata"
            />

            <Input
                text="număr"
                value={metadata.number}
                setValue={(value) => updateMetadata('number', value)}
                inputProps={{
                    placeholder: 'SERIE-0001',
                }}
            />

            <Input
                text="monedă"
                value={metadata.currency}
                setValue={(value) => updateMetadata('currency', value)}
                inputProps={{
                    placeholder: 'RON | EUR | USD',
                }}
            />

            <Datepicker
                text="emitere"
                atSelect={(value) => updateDate('issueDate', value)}
                defaultValue={metadata.issueDate}
            />

            <Datepicker
                text="scadență"
                atSelect={(value) => updateDate('dueDate', value)}
                defaultValue={metadata.dueDate}
            />
        </div>
    );
}
