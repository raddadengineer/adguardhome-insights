export interface StatsFlowDetailsQuery {
    time: string;
    domain: string;
    client: string;
    client_name?: string;
    qtype?: string;
    status: string;
    reason?: string;
    rule?: string;
    service?: string;
    service_name?: string;
    category?: string;
    filter_list?: string;
    upstream?: string;
    rcode?: string;
    latency_us: number;
}
