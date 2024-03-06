import {
    useState,
    useEffect,
} from 'react';



export const useUnscrollable = () => {
    useEffect(() => {
        const handleScroll = (event: Event) => {
            event.preventDefault();
            event.stopPropagation();
        };

        window.addEventListener('scroll', handleScroll, { passive: false });
        window.addEventListener('wheel', handleScroll, { passive: false });
        window.addEventListener('touchmove', handleScroll, { passive: false });

        return () => {
            window.removeEventListener('scroll', handleScroll);
            window.removeEventListener('wheel', handleScroll);
            window.removeEventListener('touchmove', handleScroll);
        };
    }, []);
}


export const useResponsiveWidth = (
    width: string | number | undefined,
) => {
    const [windowWidth, setWindowWidth] = useState(
        typeof window !== 'undefined' ? window.innerWidth : 0,
    );

    const handleResize = () => {
        setWindowWidth(window.innerWidth);
    };

    useEffect(() => {
        handleResize();

        window.addEventListener('resize', handleResize);

        return () => {
            window.removeEventListener('resize', handleResize);
        };
    }, []);

    if (typeof width === 'string') {
        return width;
    }

    return windowWidth <= 768 ? undefined : width;
}
