import MenuBack from '@/components/MenuBack';
import Subtitle from '@/components/Subtitle';

import {
    useVolatileStore,
} from '@/store';



export default function About({
    back,
} : {
    back: () => void;
}) {
    const {
        setMenuView,
    } = useVolatileStore();


    return (
        <div
            className="scrollable-view max-w-xl h-full overflow-scroll flex flex-col md:justify-center py-2 px-4 text-left text-sm md:text-base"
        >
            <Subtitle
                text="despre xfactura.ro"
                centered={true}
            />

            <p>
                xfactura.ro este un proiect&nbsp;
                <a
                    href="https://github.com/piatra-institute/xfactura-ro/tree/main"
                    target="_blank"
                >
                    open source
                </a>
            </p>

            <p>
                xfactura.ro nu este asociat cu nicio instituție publică
            </p>

            <p>
                xfactura.ro poate fi rulat complet local în browser și nu stochează datele în nicio bază de date externă decât la cererea utilizatorului
                <br />
                toate datele sunt stocate folosind&nbsp;
                <a
                    href="https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage"
                    target="_blank"
                >
                    localStorage
                </a>
                <br />
                xfactura.ro nu partajează date despre utilizatori cu instrumente terțe, inclusiv cu modele neuronale
                <br />
                datele pot fi exportate și importate în format&nbsp;
                <a
                    href="https://developer.mozilla.org/en-US/docs/Learn/JavaScript/Objects/JSON"
                    target="_blank"
                >
                    JSON
                </a>
            </p>

            <p>
                xfactura.ro poate stoca datele în Google Drive pentru cont-urile logate folosind Google în conformitate cu politica de confidențialitate a&nbsp;
                <a
                    href="https://developers.google.com/terms/api-services-user-data-policy"
                    target="_blank"
                >
                    Google
                </a>
            </p>

            <p>
                xfactura.ro poate fi rulat pe propriul calculator folosind&nbsp;
                <a
                    href="https://github.com/piatra-institute/xfactura-ro/tree/main?tab=readme-ov-file#self-hosting"
                    target="_blank"
                >
                    Docker
                </a>
            </p>

            <p>
                xfactura.ro poate fi susținut prin utilizarea&nbsp;
                <span
                    className="font-bold cursor-pointer"
                    onClick={() => {
                        setMenuView('ai');
                    }}
                >
                    actelor inteligente
                </span>
            </p>

            <p>
                pentru cereri de funcționalitate sau raportări de probleme&nbsp;
                <a
                    href="mailto:contact@xfactura.ro?subject=xfactura.ro"
                    target="_blank"
                >
                    contact
                </a>
            </p>

            <MenuBack
                back={back}
                bottomSpace={true}
            />
        </div>
    );
}
