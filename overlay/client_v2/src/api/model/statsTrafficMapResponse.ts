import type { StatsTrafficMapItem } from './statsTrafficMapItem';

export interface StatsTrafficMapResponse {
    from: string;
    to: string;
    window: string;
    allowed: StatsTrafficMapItem[];
    blocked: StatsTrafficMapItem[];
}
