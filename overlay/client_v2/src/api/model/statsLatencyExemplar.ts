export interface StatsLatencyExemplar {
    time: string;
    ts_unix_micros: number;
    latency_us: number;
    path: string;
    upstream?: string;
    domain: string;
    client: string;
    rcode?: string;
}
