export interface StatsFlowDetailsTuple {
    client_id: string;
    client_label: string;
    tag?: string;
    service_id: string;
    service_name: string;
    category: string;
    domain: string;
    filter_list: string;
    reason?: string;
    rule?: string;
    qtype: string;
    status: string;
    count: number;
    blocked: number;
}
