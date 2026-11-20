import type { StatsLatencyHeatmapResponseSeries } from './statsLatencyHeatmapResponseSeries';

export interface StatsLatencyHeatmapResponse {
    from: string;
    to: string;
    step: string;
    by: string;
    bounds_us: number[];
    starts: number[];
    series: StatsLatencyHeatmapResponseSeries;
    partial: boolean;
}
