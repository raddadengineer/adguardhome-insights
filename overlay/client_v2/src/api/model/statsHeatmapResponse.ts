import type { StatsHeatmapResponsePrecision } from './statsHeatmapResponsePrecision';

export interface StatsHeatmapResponse {
    from: string;
    to: string;
    grain: string;
    kind: string;
    key?: string;
    measure: string;
    slot_seconds: number;
    precision: StatsHeatmapResponsePrecision;
    starts: number[];
    values: number[];
    covered: boolean[];
    partial: boolean;
    truncated: boolean;
}
