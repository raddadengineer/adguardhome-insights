import type { StatsHeatmapGrain } from './statsHeatmapGrain';
import type { StatsHeatmapKind } from './statsHeatmapKind';
import type { StatsHeatmapMeasure } from './statsHeatmapMeasure';
import type { StatsHeatmapWindow } from './statsHeatmapWindow';

export type StatsHeatmapParams = {
    window?: StatsHeatmapWindow;
    grain?: StatsHeatmapGrain;
    kind?: StatsHeatmapKind;
    key?: string;
    measure?: StatsHeatmapMeasure;
};
