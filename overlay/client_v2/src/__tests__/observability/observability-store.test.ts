import { describe, expect, it, vi, beforeEach } from 'vitest';

const apiMocks = vi.hoisted(() => ({
    statsFlow: vi.fn(),
    statsFlowDetails: vi.fn(),
    statsTrafficMap: vi.fn(),
    statsHeatmap: vi.fn(),
    statsLatencyHeatmap: vi.fn(),
    statsLatencyExemplars: vi.fn(),
}));

const toastMocks = vi.hoisted(() => ({
    addErrorToast: vi.fn(),
}));

vi.mock('panel/api/generated', () => apiMocks);
vi.mock('panel/stores/toasts', () => toastMocks);

import {
    observabilityState,
    fetchFlow,
    fetchFlowDetails,
    clearFlowDetails,
    fetchTrafficMap,
    fetchHeatmap,
    fetchLatencyHeatmap,
} from 'panel/stores/observability';

describe('observability store', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('drops stale out-of-order flow responses', async () => {
        let resolveFirst!: (val: unknown) => void;
        let resolveSecond!: (val: unknown) => void;

        apiMocks.statsFlow
            .mockImplementationOnce(() => new Promise((res) => { resolveFirst = res; }))
            .mockImplementationOnce(() => new Promise((res) => { resolveSecond = res; }));

        const firstPromise = fetchFlow({ window: '24h' });
        const secondPromise = fetchFlow({ window: '7d' });

        resolveSecond({
            from: 't2',
            to: 't3',
            source: 'buckets',
            group_by: 'client',
            total: 42,
            nodes: [],
            links: [],
            partial: false,
            truncated: false,
        });
        await secondPromise;

        resolveFirst({
            from: 't0',
            to: 't1',
            source: 'buckets',
            group_by: 'client',
            total: 999,
            nodes: [],
            links: [],
            partial: false,
            truncated: false,
        });
        await firstPromise;

        expect(observabilityState.flow?.total).toBe(42);
    });

    it('drops stale flow details responses and supports clearing', async () => {
        let resolveFirst!: (val: unknown) => void;
        let resolveSecond!: (val: unknown) => void;

        apiMocks.statsFlowDetails
            .mockImplementationOnce(() => new Promise((res) => { resolveFirst = res; }))
            .mockImplementationOnce(() => new Promise((res) => { resolveSecond = res; }));

        const first = fetchFlowDetails({ status: 'blocked' });
        const second = fetchFlowDetails({ status: 'cached' });

        resolveSecond({
            from: 'a',
            to: 'b',
            total: 7,
            blocked: 0,
            truncated: false,
            clients: [],
            domains: [],
            rules: [],
            recent: [],
            tuples: [],
        });
        await second;

        resolveFirst({
            from: 'a',
            to: 'b',
            total: 99,
            blocked: 99,
            truncated: false,
            clients: [],
            domains: [],
            rules: [],
            recent: [],
            tuples: [],
        });
        await first;

        expect(observabilityState.flowDetails?.total).toBe(7);
        clearFlowDetails();
        expect(observabilityState.flowDetails).toBeNull();
    });

    it('fetches traffic map, heatmap, and latency data and surfaces errors via toasts', async () => {
        apiMocks.statsTrafficMap.mockResolvedValueOnce({
            from: 'a',
            to: 'b',
            window: 'current_hour',
            allowed: [{ domain: 'example.com', count: 5 }],
            blocked: [],
        });
        await fetchTrafficMap({ window: 'current_hour' });
        expect(observabilityState.trafficMap?.allowed).toHaveLength(1);

        apiMocks.statsHeatmap.mockRejectedValueOnce(new Error('network error'));
        await fetchHeatmap({ window: '7d' });
        expect(toastMocks.addErrorToast).toHaveBeenCalledTimes(1);
        expect(observabilityState.heatmapError).toContain('network error');

        apiMocks.statsLatencyHeatmap.mockResolvedValueOnce({
            from: 'a',
            to: 'b',
            step: 'minute',
            by: 'path',
            bounds_us: [50, 1000],
            starts: [100],
            series: { cache: [[1, 0, 0]] },
            partial: false,
        });
        apiMocks.statsLatencyExemplars.mockResolvedValueOnce({
            items: [
                {
                    time: '2026-01-01T00:00:00Z',
                    ts_unix_micros: 100_000_000,
                    latency_us: 40,
                    path: 'cache',
                    domain: 'example.com',
                    client: '127.0.0.1',
                },
            ],
        });
        await fetchLatencyHeatmap({ window: '6h' }, { window: '6h' });
        expect(observabilityState.latencyHeatmap?.starts).toEqual([100]);
        expect(observabilityState.latencyExemplars).toHaveLength(1);
    });
});
