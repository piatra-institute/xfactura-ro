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

        const nextSeriesNumber = seriesNumber + 1;
        const nextSeriesNumberString = nextSeriesNumber
            .toString()
            .padStart(seriesNumberString.length, '0');
        const nextSeries = seriesLabelUnclean + nextSeriesNumberString;

        return {
            seriesLabel,
            seriesNumberString,
            seriesNumber,
            nextSeriesNumber,
            nextSeries,
        };
    } catch (error) {
        console.log(error);

        return;
    }
}
