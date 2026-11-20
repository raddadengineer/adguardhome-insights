export interface StatsFlowDetailsDomain {
    domain: string;
    count: number;
    blocked: number;
    reason?: string;
    rule?: string;
    service?: string;
    service_name?: string;
    category?: string;
    filter_list?: string;
    qtypes?: string[];
    clients: number;
}
