import {
    focusStyle,
} from '@/data/styles';

import {
    closeMenuIcon,
    hamburgerMenuIcon,
} from '@/data/icons';

import {
    defocus,
    styleTrim,
} from '@/logic/utilities';



const MenuIcon = ({
    show,
    atClick,
}: {
    show: boolean;
    atClick: () => void;
}) => (
    <button
        className={styleTrim(`
            z-50 fixed top-[4px] left-0
            m-3 cursor-pointer
            ${focusStyle}
        `)}
        onClick={(event) => {
            event.stopPropagation();
            event.preventDefault();
            defocus();

            atClick();
        }}
    >
        <svg
            xmlns="http://www.w3.org/2000/svg"
            x="0px" y="0px" width="100" height="100" viewBox="0 0 50 50"
            style={{
                filter: 'invert(1)', width: '25px', height: '25px',
                margin: '0.2rem',
            }}
        >
            {show ? (
                <>{closeMenuIcon}</>
            ) : (
                <>{hamburgerMenuIcon}</>
            )}
        </svg>
    </button>
);



export default MenuIcon;
