import type { StatsLatencyExemplarsPath } from './statsLatencyExemplarsPath';
import type { StatsLatencyExemplarsWindow } from './statsLatencyExemplarsWindow';

export type StatsLatencyExemplarsParams = {
    window?: StatsLatencyExemplarsWindow;
    path?: StatsLatencyExemplarsPath;
    upstream?: string;
};
