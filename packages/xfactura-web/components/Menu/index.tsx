import {
    useState,
    useEffect,
} from 'react';

import { googleLogout } from '@react-oauth/google';

import LinkButton from '../../components/LinkButton';

import CompaniesList from '../../containers/CompaniesList';
import InventoryList from '../../containers/InventoryList';
import InvoicesList from '../../containers/InvoicesList';
import About from '../../containers/About';
import AI from '../../containers/AI';
import Settings from '../../containers/Settings';



export const MenuIcon = ({
    show,
    atClick,
}: {
    show: boolean;
    atClick: () => void;
}) => (
    <button
        className="z-50 fixed top-[4px] left-0 m-4 cursor-pointer"
        onClick={(event) => {
            event.stopPropagation();
            event.preventDefault();

            atClick();
        }}
    >
        <svg
            xmlns="http://www.w3.org/2000/svg" x="0px" y="0px" width="100" height="100" viewBox="0 0 50 50"
            style={{
                filter: 'invert(1)', width: '25px', height: '25px',
            }}
        >
            {show ? (
                <path d="M 7.71875 6.28125 L 6.28125 7.71875 L 23.5625 25 L 6.28125 42.28125 L 7.71875 43.71875 L 25 26.4375 L 42.28125 43.71875 L 43.71875 42.28125 L 26.4375 25 L 43.71875 7.71875 L 42.28125 6.28125 L 25 23.5625 Z">
                    {/* close */}
                </path>
            ) : (
                <path d="M 0 9 L 0 11 L 50 11 L 50 9 Z M 0 24 L 0 26 L 50 26 L 50 24 Z M 0 39 L 0 41 L 50 41 L 50 39 Z">
                    {/* hamburger */}
                </path>
            )}
        </svg>
    </button>
);


export default function Menu() {
    const [
        showBgBlack,
        setShowBgBlack,
    ] = useState(true);

    const [
        showMenu,
        setShowMenu,
    ] = useState(true);

    const [
        view,
        setView,
    ] = useState<'general' | 'about' | 'ai' | 'companies' | 'inventory' | 'invoices' | 'settings'>('general');


    useEffect(() => {
        setView('general');

        if (!showMenu) {
            setShowBgBlack(false);
        }
    }, [
        showMenu,
    ]);

    useEffect(() => {
        const handleScroll = (event: Event) => {
            if (showMenu) {
                event.preventDefault();
                event.stopPropagation();
            }
        };

        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setShowMenu(false);
            }
        }

        if (showMenu) {
            window.addEventListener('scroll', handleScroll, { passive: false });
            window.addEventListener('wheel', handleScroll, { passive: false });
            window.addEventListener('touchmove', handleScroll, { passive: false });
            window.addEventListener('keydown', handleEscape);
        }

        return () => {
            window.removeEventListener('scroll', handleScroll);
            window.removeEventListener('wheel', handleScroll);
            window.removeEventListener('touchmove', handleScroll);
            window.removeEventListener('keydown', handleEscape);
        };
    }, [
        showMenu,
    ]);


    let viewElement: JSX.Element | undefined;
    switch (view) {
        case 'companies':
            viewElement = (
                <CompaniesList
                    back={() => setView('general')}
                />
            );
            break;
        case 'inventory':
            viewElement = (
                <InventoryList
                    back={() => setView('general')}
                />
            );
            break;
        case 'invoices':
            viewElement = (
                <InvoicesList
                    back={() => setView('general')}
                />
            );
            break;
        case 'about':
            viewElement = (
                <About
                    back={() => setView('general')}
                />
            );
            break;
        case 'ai':
            viewElement = (
                <AI
                    back={() => setView('general')}
                />
            );
            break;
        case 'settings':
            viewElement = (
                <Settings
                    back={() => setView('general')}
                />
            );
            break;
        case 'general':
            viewElement = (
                <ul>
                    <li className="m-4">
                        <LinkButton
                            text="xfactură nouă"
                            onClick={() => {
                                setShowMenu(false);
                                window.scrollTo(0, 0);
                            }}
                        />
                    </li>
                    <li className="m-4">
                        <LinkButton
                            text="companii"
                            onClick={() => setView('companies')}
                        />
                    </li>
                    <li className="m-4">
                        <LinkButton
                            text="stocuri"
                            onClick={() => setView('inventory')}
                        />
                    </li>
                    <li className="m-4">
                        <LinkButton
                            text="xfacturi"
                            onClick={() => setView('invoices')}
                        />
                    </li>

                    <li className="m-4 mt-8">
                        <LinkButton
                            text="despre xfactura.ro"
                            onClick={() => setView('about')}
                        />
                    </li>
                    <li className="m-4">
                        <LinkButton
                            text="acte inteligente"
                            onClick={() => setView('ai')}
                        />
                    </li>
                    <li className="m-4">
                        <LinkButton
                            text="setări"
                            onClick={() => setView('settings')}
                        />
                    </li>

                    <li className="m-4 mt-8">
                        <LinkButton
                            text="delogare"
                            onClick={() => {
                                // if logged in

                                googleLogout();
                            }}
                        />
                    </li>
                </ul>
            );
            break;
    }

    return (
        <>
            <MenuIcon
                show={showMenu}
                atClick={() => setShowMenu(!showMenu)}
            />

            {showMenu && (
                <div
                    className={`${showBgBlack ? 'bg-black': 'animate-fadeIn backdrop-blur-md'} fixed z-40 top-0 h-screen right-0 left-0 botom-0 grid place-items-center text-center`}
                >
                    <div
                        className="max-w-xl p-4"
                    >
                        {viewElement}
                    </div>
                </div>
            )}
        </>
    );
}
