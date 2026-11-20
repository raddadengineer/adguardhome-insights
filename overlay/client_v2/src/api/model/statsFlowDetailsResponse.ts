import type { StatsFlowDetailsClient } from './statsFlowDetailsClient';
import type { StatsFlowDetailsDomain } from './statsFlowDetailsDomain';
import type { StatsFlowDetailsQuery } from './statsFlowDetailsQuery';
import type { StatsFlowDetailsRule } from './statsFlowDetailsRule';
import type { StatsFlowDetailsTuple } from './statsFlowDetailsTuple';

export interface StatsFlowDetailsResponse {
    from: string;
    to: string;
    total: number;
    blocked: number;
    truncated: boolean;
    clients: StatsFlowDetailsClient[];
    domains: StatsFlowDetailsDomain[];
    rules: StatsFlowDetailsRule[];
    recent: StatsFlowDetailsQuery[];
    tuples: StatsFlowDetailsTuple[];
}
