import {
    logger,
} from '@/logic/utilities';



export const seriesParser = (
    series: string,
) => {
    try {
        const normalizedSeries = series.trim();
        if (!normalizedSeries) {
            return;
        }

        const seriesLabelUnclean = normalizedSeries
            .slice(0, normalizedSeries.indexOf('0'));
        const seriesLabel = seriesLabelUnclean.replace(/\-/g, '');

        const seriesNumberString = normalizedSeries
            .slice(normalizedSeries.indexOf('0'), normalizedSeries.length)
            .replace(/-/g, '');

        const seriesNumber = parseInt(seriesNumberString);
        if (isNaN(seriesNumber)) {
            return;
        }

        const formatSeries = (
            value: number,
        ) => {
            const numberString = value
                .toString()
                .padStart(seriesNumberString.length, '0');
            const series = seriesLabelUnclean + numberString;

            return series;
        }

        const previousSeriesNumber = seriesNumber > 0 ? seriesNumber - 1 : 0;
        const previousSeries = formatSeries(previousSeriesNumber);

        const nextSeriesNumber = seriesNumber + 1;
        const nextSeries = formatSeries(nextSeriesNumber);

        return {
            seriesLabel,
            seriesNumberString,
            seriesNumber,
            previousSeriesNumber,
            previousSeries,
            nextSeriesNumber,
            nextSeries,
        };
    } catch (error) {
        logger('error', error);

        return;
    }
}
