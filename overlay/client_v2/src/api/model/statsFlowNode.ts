import type { StatsFlowNodeStage } from './statsFlowNodeStage';

export interface StatsFlowNode {
    id: string;
    stage: StatsFlowNodeStage;
    name: string;
    label: string;
    count: number;
    dead_end: number;
}
