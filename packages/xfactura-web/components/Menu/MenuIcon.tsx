const closeIcon = (
    <path
        d="M 7.71875 6.28125 L 6.28125 7.71875 L 23.5625 25 L 6.28125 42.28125 L 7.71875 43.71875 L 25 26.4375 L 42.28125 43.71875 L 43.71875 42.28125 L 26.4375 25 L 43.71875 7.71875 L 42.28125 6.28125 L 25 23.5625 Z"
    >
    </path>
);


const hamburgerIcon = (
    <path
        d="M 0 9 L 0 11 L 50 11 L 50 9 Z M 0 24 L 0 26 L 50 26 L 50 24 Z M 0 39 L 0 41 L 50 41 L 50 39 Z"
    >
    </path>
);


const MenuIcon = ({
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
                <>{closeIcon}</>
            ) : (
                <>{hamburgerIcon}</>
            )}
        </svg>
    </button>
);



export default MenuIcon;
