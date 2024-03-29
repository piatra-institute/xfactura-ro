import {
    useContext,
    useState,
    useEffect,
} from 'react';

import Image from 'next/image';

import LinkButton from '@/components/LinkButton';

import ListCompanies from '@/containers/ListCompanies';
import EditCompany from '@/containers/EditCompany';
import ListInventory from '@/containers/ListInventory';
import EditInventory from '@/containers/EditInventory';
import ListInvoices from '@/containers/ListInvoices';
import EditInvoice from '@/containers/EditInvoice';
import About from '@/containers/About';
import AI from '@/containers/AI';
import Settings from '@/containers/Settings';

import {
    useLogout,
    computeTotalIntelligentActs,
} from '@/logic/user';

import {
    styleTrim,
} from '@/logic/utilities';

import {
    useVolatileStore,
} from '@/store';

import {
    UserContext,
} from '@/logic/context';

import MenuIcon from './MenuIcon';



export default function Menu() {
    // #region context
    const {
        user,
    } = useContext(UserContext);
    // #endregion context


    // #region state
    const {
        showMenu,
        setShowMenu,
        setShowActsModal,

        menuView,
        setMenuView,
    } = useVolatileStore();

    const [
        showBgBlack,
        setShowBgBlack,
    ] = useState(true);

    const logout = useLogout();
    // #endregion state


    // #region effects
    /** Background */
    useEffect(() => {
        setMenuView('general');

        if (!showMenu) {
            setShowBgBlack(false);
        }
    }, [
        showMenu,
        setMenuView,
    ]);

    /** Keybinds */
    useEffect(() => {
        const isEventWithinScrollableDiv = (event: Event) => {
            try {
                // HACK
                let current = event.target as any;

                while (current) {
                    if (current.classList?.contains('scrollable-view')) {
                        // if (current.clientHeight > current.scrollHeight) {
                        //     return false;
                        // }
                        return true;
                    }
                    current = current.parentNode;
                }

                return false;
            } catch (error) {
                return false;
            }
        }

        const handleScroll = (event: Event) => {
            if (showMenu) {
                const isScrollableDiv = isEventWithinScrollableDiv(event);
                if (isScrollableDiv) {
                    event.stopPropagation();
                    return;
                }

                // Prevent scroll otherwise.
                event.preventDefault();
                event.stopPropagation();
            }
        }

        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                if (menuView !== 'general') {
                    setMenuView('general');
                    return;
                }

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
        menuView,
        setMenuView,
    ]);
    // #endregion effects


    // #region render
    let viewElement: JSX.Element | undefined;
    switch (menuView) {
        case 'companies':
            viewElement = (
                <ListCompanies
                    back={() => setMenuView('general')}
                />
            );
            break;
        case 'edit-company':
            viewElement = (
                <EditCompany
                    back={() => setMenuView('general')}
                />
            );
            break;
        case 'inventory':
            viewElement = (
                <ListInventory
                    back={() => setMenuView('general')}
                />
            );
            break;
        case 'edit-inventory':
            viewElement = (
                <EditInventory
                    back={() => setMenuView('general')}
                />
            );
            break;
        case 'invoices':
            viewElement = (
                <ListInvoices
                    back={() => setMenuView('general')}
                />
            );
            break;
        case 'edit-invoice':
            viewElement = (
                <EditInvoice
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
                <div
                    className="max-w-xl m-auto p-4 grid place-items-center"
                >
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
                            text="facturi"
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
                            text={user ? `acte inteligente [${computeTotalIntelligentActs(user)}]` : 'acte inteligente'}
                            onClick={() => setMenuView('ai')}
                        />
                    </li>
                    <li className="m-4">
                        <LinkButton
                            text="setări"
                            onClick={() => setMenuView('settings')}
                        />
                    </li>

                    {user && (
                        <li
                            className="m-4 mt-8 cursor-pointer"
                            onClick={() => {
                                logout();
                            }}
                        >
                            <LinkButton
                                text="delogare"
                                onClick={() => {}}
                            />

                            <div
                                className="flex flex-row items-center justify-center gap-2 mt-2"
                            >
                                {user.picture && (
                                    <Image
                                        src={user.picture}
                                        alt={user.name}
                                        width={30}
                                        height={30}
                                        className="rounded-full"
                                    />
                                )}

                                <div
                                    className="text-xs font-bold"
                                >
                                    {user.name || user.email}
                                </div>
                            </div>
                        </li>
                    )}
                </ul>
                </div>
            );
            break;
    }

    return (
        <>
            <MenuIcon
                show={showMenu}
                atClick={() => {
                    setShowMenu(!showMenu);
                    setShowActsModal(false);
                }}
            />

            {showMenu && (
                <div
                    className={styleTrim(`
                        ${showBgBlack ? 'bg-black': 'animate-fadeIn backdrop-blur-md'}
                        fixed z-40 top-0 h-screen right-0 left-0 bottom-0
                        text-center
                        grid md:place-items-center
                    `)}
                >
                    {viewElement}
                </div>
            )}
        </>
    );
    // #endregion render
}
