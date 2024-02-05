import MenuBack from '@/components/MenuBack';
import Subtitle from '@/components/Subtitle';

import useStore from '@/store';



export default function CompaniesList({
    back,
} : {
    back: () => void;
}) {
    const {
        companies,
    } = useStore();


    return (
        <div>
            <Subtitle
                text="companii"
                centered={true}
            />

            {Object.values(companies).length === 0 && (
                <div>
                    nici o companie
                </div>
            )}

            {Object.values(companies).map(company => {
                return (
                    <div
                        key={company.vatNumber}
                        className="flex justify-between items-center gap-4 p-2 mb-2 w-full"
                    >
                        <div>
                            {company.vatNumber}
                        </div>

                        <div>
                            {company.name}
                        </div>
                    </div>
                );
            })}

            <MenuBack
                back={back}
            />
        </div>
    );
}
