import type { StatsLatencyHeatmapBy } from './statsLatencyHeatmapBy';
import type { StatsLatencyHeatmapStep } from './statsLatencyHeatmapStep';
import type { StatsLatencyHeatmapWindow } from './statsLatencyHeatmapWindow';

export type StatsLatencyHeatmapParams = {
    window?: StatsLatencyHeatmapWindow;
    step?: StatsLatencyHeatmapStep;
    by?: StatsLatencyHeatmapBy;
};
