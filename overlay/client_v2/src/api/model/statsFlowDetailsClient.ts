export interface StatsFlowDetailsClient {
    id: string;
    label: string;
    tag?: string;
    count: number;
    blocked: number;
}
