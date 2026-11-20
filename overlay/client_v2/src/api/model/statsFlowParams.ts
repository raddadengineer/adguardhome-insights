import type { StatsFlowGroupBy } from './statsFlowGroupBy';
import type { StatsFlowStatus } from './statsFlowStatus';
import type { StatsFlowView } from './statsFlowView';
import type { StatsFlowWindow } from './statsFlowWindow';

export type StatsFlowParams = {
    window?: StatsFlowWindow;
    group_by?: StatsFlowGroupBy;
    client?: string;
    tag?: string;
    protocol?: string;
    status?: StatsFlowStatus;
    upstream?: string;
    rcode?: string;
    domain?: string;
    view?: StatsFlowView;
    category?: string;
    service?: string;
    filter_list?: string;
    reason?: string;
    rule?: string;
    qtype?: string;
};
