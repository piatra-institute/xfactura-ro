import {
    useState,
    useEffect,
} from 'react';

import Image from 'next/image';

import localStorage from '@/data/localStorage';

import LinkButton from '@/components/LinkButton';

import CompaniesList from '@/containers/CompaniesList';
import InventoryList from '@/containers/InventoryList';
import InvoicesList from '@/containers/InvoicesList';
import About from '@/containers/About';
import AI from '@/containers/AI';
import Settings from '@/containers/Settings';

import {
    logout,
} from '@/logic/user';

import {
    volatileStore,
} from '@/store';

import MenuIcon from './MenuIcon';



export default function Menu() {
    const {
        showMenu,
        setShowMenu,

        menuView,
        setMenuView,
    } = volatileStore();


    const [
        showUser,
        setShowUser,
    ] = useState(false);

    const [
        showBgBlack,
        setShowBgBlack,
    ] = useState(true);


    useEffect(() => {
        setMenuView('general');

        if (!showMenu) {
            setShowBgBlack(false);
        }
    }, [
        showMenu,
        setMenuView,
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
        setShowMenu,
    ]);

    useEffect(() => {
        setShowUser(true);
    }, []);


    let viewElement: JSX.Element | undefined;
    switch (menuView) {
        case 'companies':
            viewElement = (
                <CompaniesList
                    back={() => setMenuView('general')}
                />
            );
            break;
        case 'inventory':
            viewElement = (
                <InventoryList
                    back={() => setMenuView('general')}
                />
            );
            break;
        case 'invoices':
            viewElement = (
                <InvoicesList
                    back={() => setMenuView('general')}
                />
            );
            break;
        case 'about':
            viewElement = (
                <About
                    back={() => setMenuView('general')}
                />
            );
            break;
        case 'ai':
            viewElement = (
                <AI
                    back={() => setMenuView('general')}
                />
            );
            break;
        case 'settings':
            viewElement = (
                <Settings
                    back={() => setMenuView('general')}
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
                            onClick={() => setMenuView('companies')}
                        />
                    </li>
                    <li className="m-4">
                        <LinkButton
                            text="stocuri"
                            onClick={() => setMenuView('inventory')}
                        />
                    </li>
                    <li className="m-4">
                        <LinkButton
                            text="xfacturi"
                            onClick={() => setMenuView('invoices')}
                        />
                    </li>

                    <li className="m-4 mt-8">
                        <LinkButton
                            text="despre xfactura.ro"
                            onClick={() => setMenuView('about')}
                        />
                    </li>
                    <li className="m-4">
                        <LinkButton
                            text="acte inteligente"
                            onClick={() => setMenuView('ai')}
                        />
                    </li>
                    <li className="m-4">
                        <LinkButton
                            text="setări"
                            onClick={() => setMenuView('settings')}
                        />
                    </li>

                    {showUser && localStorage.user && (
                        <li
                            className="m-4 mt-8 cursor-pointer"
                            onClick={() => {
                                logout();
                                setShowUser(false);
                            }}
                        >
                            <LinkButton
                                text="delogare"
                                onClick={() => {}}
                            />

                            <div
                                className="flex flex-row items-center justify-center gap-2 mt-2"
                            >
                                <Image
                                    src={localStorage.user.picture || ''}
                                    alt={localStorage.user.name}
                                    width={30}
                                    height={30}
                                    className="rounded-full"
                                />

                                <div
                                    className="text-xs font-bold"
                                >
                                    {localStorage.user.name || localStorage.user.email}
                                </div>
                            </div>
                        </li>
                    )}
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
                    className={`
                        ${showBgBlack ? 'bg-black': 'animate-fadeIn backdrop-blur-md'}
                        fixed z-40 top-0 h-screen right-0 left-0 botom-0
                        grid place-items-center text-center
                    `}
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
