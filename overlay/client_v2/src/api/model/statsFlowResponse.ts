import type { StatsFlowLink } from './statsFlowLink';
import type { StatsFlowNode } from './statsFlowNode';
import type { StatsFlowResponseGroupBy } from './statsFlowResponseGroupBy';
import type { StatsFlowResponseSource } from './statsFlowResponseSource';

export interface StatsFlowResponse {
    from: string;
    to: string;
    source: StatsFlowResponseSource;
    group_by: StatsFlowResponseGroupBy;
    view?: string;
    stages?: string[];
    client?: string;
    total: number;
    nodes: StatsFlowNode[];
    links: StatsFlowLink[];
    partial: boolean;
    truncated: boolean;
}
