import {
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
