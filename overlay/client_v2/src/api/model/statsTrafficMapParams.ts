import type { StatsTrafficMapWindow } from './statsTrafficMapWindow';

export type StatsTrafficMapParams = {
    window?: StatsTrafficMapWindow;
    /**
     * @minimum 1
     * @maximum 200
     */
    limit?: number;
};
