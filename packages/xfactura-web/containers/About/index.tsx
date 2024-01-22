import MenuBack from '../../components/MenuBack';
import Subtitle from '../../components/Subtitle';



export default function About({
    back,
} : {
    back: () => void;
}) {
    return (
        <div
            className="text-left"
        >
            <Subtitle
                text="despre xfactura.ro"
                centered={true}
            />

            <p>
                xfactura.ro este un proiect&nbsp;
                <a
                    href="https://github.com/plurid/open-company/tree/master/packages/interclients/specific/xfactura-ro"
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
                datele pot fi exportate și importate în format&nbsp;
                <a
                    href="https://developer.mozilla.org/en-US/docs/Learn/JavaScript/Objects/JSON"
                    target="_blank"
                >
                    JSON
                </a>
            </p>

            <p>
                xfactura.ro poate fi rulat pe propriul calculator folosind&nbsp;
                <a
                    href="https://github.com/plurid/open-company/tree/master/packages/interclients/specific/xfactura-ro#self-hosting"
                    target="_blank"
                >
                    docker
                </a>
            </p>

            <p>
                xfactura.ro poate fi susținut prin&nbsp;
                <a
                    href="https://buy.stripe.com/aEU5nj6Pma6Va6A3ch"
                    target="_blank"
                >
                    stripe
                </a>
                <br />
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
            />
        </div>
    );
}
