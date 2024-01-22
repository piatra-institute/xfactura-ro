import {
    useState,
} from 'react';

import {
    defocus,
} from '../../logic/utilities';



export default function Deleter({
    title,
    atDelete,
}: {
    atDelete: () => void;
    title?: string;
}) {
    const [
        showDelete,
        setShowDelete,
    ] = useState(false);


    if (showDelete) {
        return (
            <div
                className="select-none flex gap-14 items-center justify-center text-center min-w-[90px] min-h-[25px]"
            >
                <button
                    onClick={() => {
                        atDelete();
                        setShowDelete(false);
                        defocus();
                    }}
                    className="focus:outline-none focus:ring-2 focus:ring-white"
                >
                    <svg
                        xmlns="http://www.w3.org/2000/svg" x="0px" y="0px" width="100" height="100" viewBox="0 0 32 32"
                        className="cursor-pointer"
                        style={{
                            filter: 'invert(1)', width: '20px', height: '20px',
                        }}
                    >
                        <path d="M 28.28125 6.28125 L 11 23.5625 L 3.71875 16.28125 L 2.28125 17.71875 L 10.28125 25.71875 L 11 26.40625 L 11.71875 25.71875 L 29.71875 7.71875 Z">
                            {/* check */}
                        </path>
                    </svg>
                </button>

                <button
                    onClick={() => setShowDelete(false)}
                    className="focus:outline-none focus:ring-2 focus:ring-white"
                >
                    <svg
                        xmlns="http://www.w3.org/2000/svg" x="0px" y="0px" width="100" height="100" viewBox="0 0 50 50"
                        className="cursor-pointer"
                        style={{
                            filter: 'invert(1)', width: '20px', height: '20px',
                        }}
                    >
                        <path d="M 9.15625 6.3125 L 6.3125 9.15625 L 22.15625 25 L 6.21875 40.96875 L 9.03125 43.78125 L 25 27.84375 L 40.9375 43.78125 L 43.78125 40.9375 L 27.84375 25 L 43.6875 9.15625 L 40.84375 6.3125 L 25 22.15625 Z">
                            {/* close */}
                        </path>
                    </svg>
                </button>
            </div>
        );
    }

    return (
        <div
            className="select-none flex gap-4 items-center justify-center text-center min-w-[90px] min-h-[25px]"
        >
            <button
                onClick={() => {
                    setShowDelete(true);
                    defocus();
                }}
                className="font-bold focus:outline-none focus:ring-2 focus:ring-white"
            >
                {title || 'ștergere'}
            </button>
        </div>
    );
}
