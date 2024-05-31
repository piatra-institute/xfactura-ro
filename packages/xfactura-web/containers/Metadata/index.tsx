import {
    Metadata as IMetadata,
} from '@/data';

import Input from '@/components/Input';
import Datepicker from '@/components/Datepicker';
import Subtitle from '@/components/Subtitle';



export default function Metadata({
    metadata,
    updateMetadata,
    updateDate,
} : {
    metadata: IMetadata;
    updateMetadata: (
        type: keyof IMetadata,
        value: string | number,
    ) => void;
    updateDate: (
        kind: 'issueDate' | 'dueDate',
        timestamp: number,
    ) => void;
}) {
    return (
        <div
            className="md:max-w-[500px] mx-auto grid md:place-content-center p-4"
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
                multipleChoices={['RON', 'EUR', 'USD']}
                atChoice={(value) => {
                    if (typeof value === 'string') {
                        updateMetadata('currency', value);
                    }
                }}
                multipleChoiceFocusable={true}
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
