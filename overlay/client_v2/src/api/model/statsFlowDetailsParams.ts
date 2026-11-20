import type { StatsFlowDetailsStatus } from './statsFlowDetailsStatus';
import type { StatsFlowDetailsView } from './statsFlowDetailsView';
import type { StatsFlowDetailsWindow } from './statsFlowDetailsWindow';

export type StatsFlowDetailsParams = {
    window?: StatsFlowDetailsWindow;
    client?: string;
    tag?: string;
    protocol?: string;
    status?: StatsFlowDetailsStatus;
    upstream?: string;
    rcode?: string;
    domain?: string;
    view?: StatsFlowDetailsView;
    category?: string;
    service?: string;
    filter_list?: string;
    reason?: string;
    rule?: string;
    qtype?: string;
    /**
     * @minimum 1
     * @maximum 200
     */
    limit?: number;
};
