import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@solidjs/testing-library';
import { MemoryRouter, Route, createMemoryHistory } from '@solidjs/router';
import { copyInDom } from 'panel/__tests__/helpers/copy';

vi.mock('panel/common/intl', async () =>
    (await import('panel/__tests__/helpers/copy')).createIntlMock(),
);

const filteringMocks = vi.hoisted(() => ({
    filteringState: {
        filtersInitialized: true,
        userRules: '',
    },
    getFilteringStatus: vi.fn(),
    blockDomain: vi.fn().mockResolvedValue(true),
    unblockDomain: vi.fn().mockResolvedValue(true),
}));

const servicesMocks = vi.hoisted(() => ({
    servicesState: {
        initialized: true,
        allInitialized: true,
        list: { ids: ['tiktok'] },
        allServices: [
            {
                id: 'youtube',
                name: 'YouTube',
                icon_svg: '',
                rules: ['||youtube.com^'],
                group_id: 'streaming',
            },
            {
                id: 'tiktok',
                name: 'TikTok',
                icon_svg: '',
                rules: ['||tiktok.com^'],
                group_id: 'social_network',
            },
        ],
    },
    getAllBlockedServices: vi.fn(),
    getBlockedServices: vi.fn(),
    allowBlockedService: vi.fn().mockResolvedValue(true),
    blockService: vi.fn().mockResolvedValue(true),
}));

const obsMocks = vi.hoisted(() => ({
    fetchFlow: vi.fn(),
    fetchFlowDetails: vi.fn(),
    clearFlowDetails: vi.fn(),
    fetchTrafficMap: vi.fn(),
    fetchHeatmap: vi.fn(),
    fetchLatencyHeatmap: vi.fn(),
    observabilityState: {
        flow: {
            from: '2026-01-01T00:00:00Z',
            to: '2026-01-02T00:00:00Z',
            source: 'buckets' as const,
            group_by: 'client' as const,
            view: 'overview',
            stages: ['group', 'status', 'upstream', 'rcode'],
            total: 100,
            nodes: [
                {
                    id: 'group:192.168.1.10',
                    stage: 'group' as const,
                    name: '192.168.1.10',
                    label: 'Laptop',
                    count: 100,
                    dead_end: 0,
                },
                {
                    id: 'status:cached',
                    stage: 'status' as const,
                    name: 'cached',
                    label: 'cached',
                    count: 60,
                    dead_end: 0,
                },
                {
                    id: 'status:blocked',
                    stage: 'status' as const,
                    name: 'blocked',
                    label: 'blocked',
                    count: 40,
                    dead_end: 0,
                },
                {
                    id: 'rcode:NOERROR',
                    stage: 'rcode' as const,
                    name: 'NOERROR',
                    label: 'NOERROR',
                    count: 100,
                    dead_end: 0,
                },
            ],
            links: [
                {
                    source: 'group:192.168.1.10',
                    target: 'status:cached',
                    count: 60,
                    failure: false,
                },
                {
                    source: 'group:192.168.1.10',
                    target: 'status:blocked',
                    count: 40,
                    failure: false,
                },
                {
                    source: 'status:cached',
                    target: 'rcode:NOERROR',
                    count: 60,
                    failure: false,
                },
                {
                    source: 'status:blocked',
                    target: 'rcode:NOERROR',
                    count: 40,
                    failure: false,
                },
            ],
            partial: false,
            truncated: false,
        },
        loadingFlow: false,
        flowError: null as string | null,
        flowDetails: {
            from: '2026-01-01T00:00:00Z',
            to: '2026-01-02T00:00:00Z',
            total: 40,
            blocked: 40,
            truncated: false,
            clients: [
                {
                    id: '192.168.1.10',
                    label: 'Laptop',
                    tag: 'device_laptop',
                    count: 40,
                    blocked: 40,
                },
            ],
            domains: [
                {
                    domain: 'ads.youtube.com',
                    count: 40,
                    blocked: 40,
                    reason: 'FilteredBlackList',
                    rule: '||ads.youtube.com^',
                    service: 'youtube',
                    service_name: 'YouTube',
                    category: 'streaming',
                    filter_list: 'Filter #1',
                    qtypes: ['A', 'HTTPS'],
                    clients: 1,
                },
            ],
            rules: [
                {
                    rule: '||ads.youtube.com^',
                    reason: 'FilteredBlackList',
                    filter_list: 'Filter #1',
                    count: 40,
                },
            ],
            recent: [
                {
                    time: '2026-01-01T12:00:00Z',
                    domain: 'ads.youtube.com',
                    client: '192.168.1.10',
                    client_name: 'Laptop',
                    qtype: 'HTTPS',
                    status: 'blocked',
                    reason: 'FilteredBlackList',
                    rule: '||ads.youtube.com^',
                    service: 'youtube',
                    service_name: 'YouTube',
                    category: 'streaming',
                    filter_list: 'Filter #1',
                    latency_us: 120,
                },
            ],
            tuples: [
                {
                    client_id: '192.168.1.10',
                    client_label: 'Laptop',
                    tag: 'device_laptop',
                    service_id: 'youtube',
                    service_name: 'YouTube',
                    category: 'streaming',
                    domain: 'ads.youtube.com',
                    filter_list: 'Filter #1',
                    reason: 'FilteredBlackList',
                    rule: '||ads.youtube.com^',
                    qtype: 'HTTPS',
                    status: 'blocked',
                    count: 40,
                    blocked: 40,
                },
            ],
        },
        loadingFlowDetails: false,
        flowDetailsError: null as string | null,
        trafficMap: {
            from: '2026-01-01T00:00:00Z',
            to: '2026-01-01T01:00:00Z',
            window: 'current_hour',
            allowed: [{ domain: 'www.youtube.com', count: 80 }],
            blocked: [{ domain: 'tracker.example.net', count: 20 }],
        },
        loadingTrafficMap: false,
        trafficMapError: null as string | null,
        heatmap: {
            from: '2026-01-01T00:00:00Z',
            to: '2026-01-02T00:00:00Z',
            grain: 'hour',
            kind: 'network',
            measure: 'queries',
            slot_seconds: 3600,
            precision: 'exact' as const,
            starts: [1_767_225_600, 1_767_229_200],
            values: [15, 25],
            covered: [true, true],
            partial: false,
            truncated: false,
        },
        loadingHeatmap: false,
        heatmapError: null as string | null,
        latencyHeatmap: {
            from: '2026-01-01T00:00:00Z',
            to: '2026-01-01T06:00:00Z',
            step: 'minute',
            by: 'path',
            bounds_us: [50, 1000, 50_000, 5_000_000],
            starts: [1_767_225_600],
            series: {
                cache: [[10, 1, 0, 0, 0]],
                upstream: [[0, 2, 4, 0, 0]],
                local: [[0, 0, 0, 0, 0]],
                blocked: [[0, 0, 0, 0, 0]],
            },
            partial: false,
        },
        latencyExemplars: [
            {
                time: '2026-01-01T00:00:00Z',
                ts_unix_micros: 1_767_225_600_000_000,
                latency_us: 25_000,
                path: 'upstream',
                upstream: '1.1.1.1:53',
                domain: 'api.example.com',
                client: '192.168.1.10',
                rcode: 'NOERROR',
            },
        ],
        loadingLatency: false,
        latencyError: null as string | null,
    },
}));

vi.mock('panel/stores/observability', () => obsMocks);
vi.mock('panel/stores/filtering', () => filteringMocks);
vi.mock('panel/stores/services', () => servicesMocks);
vi.mock('panel/stores/dashboard', () => ({
    dashboardState: { clients: [] },
    getClients: vi.fn(),
}));
vi.mock('panel/stores/stats', () => ({
    statsState: { statsInitialized: true, topClients: [], topQueriedDomains: [], topBlockedDomains: [] },
    getStats: vi.fn(),
}));

import { FlowPage, TrafficMapPage, HeatmapPage } from 'panel/components/Observability';

const renderWithRouter = (ui: () => any, initialUrl = '/flow') => {
    const history = createMemoryHistory();
    history.set({ value: initialUrl });
    return render(() => (
        <MemoryRouter history={history}>
            <Route path="/*" component={ui} />
        </MemoryRouter>
    ));
};

describe('Observability pages', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('renders FlowPage SVG diagram, drills down multi-level breadcrumbs, hierarchy tree, and domain allow action', async () => {
        const { container } = renderWithRouter(() => <FlowPage />, '/flow');
        expect(screen.getByRole('heading', { name: copyInDom('obs_flow_title') })).toBeInTheDocument();
        expect(obsMocks.fetchFlow).toHaveBeenCalled();
        expect(obsMocks.clearFlowDetails).toHaveBeenCalled();
        expect(container.querySelector('svg')).not.toBeNull();

        fireEvent.click(screen.getByRole('button', { name: copyInDom('obs_blocked_only') }));
        await waitFor(() => {
            expect(obsMocks.fetchFlow).toHaveBeenLastCalledWith(
                expect.objectContaining({ status: 'blocked' }),
            );
            expect(obsMocks.fetchFlowDetails).toHaveBeenLastCalledWith(
                expect.objectContaining({ status: 'blocked' }),
            );
        });

        expect(screen.getByTestId('flow-drill-trail')).toBeInTheDocument();
        expect(screen.getByTestId('flow-drilldown-panel')).toBeInTheDocument();
        expect(screen.getAllByText('ads.youtube.com').length).toBeGreaterThan(0);

        const allowButtons = screen.getAllByRole('button', {
            name: copyInDom('obs_action_allow'),
        });
        fireEvent.click(allowButtons[0]);
        expect(filteringMocks.unblockDomain).toHaveBeenCalledWith('ads.youtube.com');

        fireEvent.click(
            screen.getByRole('tab', { name: new RegExp(copyInDom('obs_domains_urls'), 'i') }),
        );
        expect(screen.getAllByText('ads.youtube.com').length).toBeGreaterThan(0);

        fireEvent.click(
            screen.getByRole('tab', { name: new RegExp(copyInDom('obs_services'), 'i') }),
        );
        expect(screen.getAllByText('YouTube').length).toBeGreaterThan(0);

        fireEvent.click(
            screen.getByRole('button', { name: new RegExp(copyInDom('obs_step_back'), 'i') }),
        );
        await waitFor(() => {
            expect(obsMocks.clearFlowDetails).toHaveBeenCalled();
        });
    });

    it('zooms in, zooms out, handles Ctrl+wheel, and resets Query Flow diagram zoom', () => {
        renderWithRouter(() => <FlowPage />, '/flow');

        const readout = screen.getByTestId('flow-zoom-level');
        expect(readout).toHaveTextContent('100%');

        const zoomInBtn = screen.getByRole('button', { name: copyInDom('obs_zoom_in') });
        const zoomOutBtn = screen.getByRole('button', { name: copyInDom('obs_zoom_out') });
        const resetBtn = screen.getByRole('button', { name: copyInDom('obs_zoom_reset') });
        expect(resetBtn).toBeDisabled();

        fireEvent.click(zoomInBtn);
        expect(screen.getByTestId('flow-zoom-level')).toHaveTextContent('125%');
        expect(screen.getByTestId('flow-zoom-group').getAttribute('transform')).toContain(
            'scale(1.25)',
        );
        expect(resetBtn).not.toBeDisabled();

        fireEvent.click(zoomOutBtn);
        fireEvent.click(zoomOutBtn);
        expect(screen.getByTestId('flow-zoom-level')).toHaveTextContent('80%');

        const viewport = screen.getByTestId('flow-svg-viewport');
        fireEvent.wheel(viewport, { deltaY: -100, ctrlKey: true });
        expect(screen.getByTestId('flow-zoom-level').textContent).not.toBe('80%');

        fireEvent.click(resetBtn);
        expect(screen.getByTestId('flow-zoom-level')).toHaveTextContent('100%');
        expect(resetBtn).toBeDisabled();
    });

    it('pans zoomed Query Flow via pointer drag, wheel scroll, and scrollbars while keeping clicks functional', async () => {
        const dispatchPointer = (
            target: EventTarget,
            type: 'pointerdown' | 'pointermove' | 'pointerup',
            init: MouseEventInit & { pointerId?: number },
        ) => {
            const evt = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
            if (init.pointerId !== undefined) {
                Object.defineProperty(evt, 'pointerId', { value: init.pointerId });
            }
            target.dispatchEvent(evt);
        };

        renderWithRouter(() => <FlowPage />, '/flow');

        expect(screen.queryByTestId('flow-pan-x')).not.toBeInTheDocument();
        expect(screen.queryByTestId('flow-pan-y')).not.toBeInTheDocument();

        const zoomInBtn = screen.getByRole('button', { name: copyInDom('obs_zoom_in') });
        fireEvent.click(zoomInBtn);
        fireEvent.click(zoomInBtn);
        expect(screen.getByTestId('flow-zoom-level')).toHaveTextContent('156%');
        expect(screen.getByTestId('flow-pan-x')).toBeInTheDocument();
        expect(screen.getByTestId('flow-pan-y')).toBeInTheDocument();

        const viewport = screen.getByTestId('flow-svg-viewport');
        const zoomGroup = screen.getByTestId('flow-zoom-group');
        const beforeDragTransform = zoomGroup.getAttribute('transform');

        dispatchPointer(viewport, 'pointerdown', {
            clientX: 100,
            clientY: 100,
            button: 0,
            pointerId: 1,
        });
        dispatchPointer(window, 'pointermove', { clientX: 140, clientY: 120, pointerId: 1 });
        dispatchPointer(window, 'pointerup', { clientX: 140, clientY: 120, pointerId: 1 });
        const afterDragTransform = zoomGroup.getAttribute('transform');
        expect(afterDragTransform).not.toBe(beforeDragTransform);

        fireEvent.wheel(viewport, { deltaX: 30, deltaY: 20 });
        const afterWheelTransform = zoomGroup.getAttribute('transform');
        expect(afterWheelTransform).not.toBe(afterDragTransform);

        fireEvent.wheel(viewport, { deltaY: 40, shiftKey: true });
        expect(zoomGroup.getAttribute('transform')).not.toBe(afterWheelTransform);

        obsMocks.fetchFlow.mockClear();
        const clientNode = screen.getByRole('button', {
            name: copyInDom('obs_node_aria', { name: 'Laptop', count: '100' }),
        });
        dispatchPointer(clientNode, 'pointerdown', {
            clientX: 50,
            clientY: 50,
            button: 0,
            pointerId: 2,
        });
        dispatchPointer(window, 'pointerup', { clientX: 50, clientY: 50, pointerId: 2 });
        fireEvent.click(clientNode);

        await waitFor(() => {
            expect(obsMocks.fetchFlow).toHaveBeenCalledWith(
                expect.objectContaining({ client: '192.168.1.10' }),
            );
        });

        fireEvent.click(screen.getByRole('button', { name: copyInDom('obs_zoom_reset') }));
        expect(screen.queryByTestId('flow-pan-x')).not.toBeInTheDocument();
        expect(screen.queryByTestId('flow-pan-y')).not.toBeInTheDocument();
    });

    it('switches to 5 min and Live windows with fast polling and pause/resume controls', async () => {
        vi.useFakeTimers();
        let unmount: (() => void) | undefined;
        try {
            ({ unmount } = renderWithRouter(() => <FlowPage />, '/flow'));

            fireEvent.click(screen.getByRole('button', { name: copyInDom('obs_window_5m') }));
            await vi.advanceTimersByTimeAsync(0);
            expect(obsMocks.fetchFlow).toHaveBeenLastCalledWith(
                expect.objectContaining({ window: '5m' }),
            );

            fireEvent.click(screen.getByRole('button', { name: copyInDom('obs_window_live') }));
            await vi.advanceTimersByTimeAsync(0);
            expect(obsMocks.fetchFlow).toHaveBeenLastCalledWith(
                expect.objectContaining({ window: 'live' }),
            );
            expect(screen.getByTestId('flow-live-badge')).toHaveTextContent(
                copyInDom('obs_live_status_streaming'),
            );

            obsMocks.fetchFlow.mockClear();
            await vi.advanceTimersByTimeAsync(3_000);
            expect(obsMocks.fetchFlow).toHaveBeenCalledWith(
                expect.objectContaining({ window: 'live' }),
                true,
            );

            fireEvent.click(screen.getByRole('button', { name: copyInDom('obs_live_pause') }));
            await vi.advanceTimersByTimeAsync(0);
            expect(screen.getByTestId('flow-live-badge')).toHaveTextContent(
                copyInDom('obs_live_status_paused'),
            );

            obsMocks.fetchFlow.mockClear();
            await vi.advanceTimersByTimeAsync(6_000);
            expect(obsMocks.fetchFlow).not.toHaveBeenCalled();

            fireEvent.click(screen.getByRole('button', { name: copyInDom('obs_live_resume') }));
            await vi.advanceTimersByTimeAsync(0);
            expect(obsMocks.fetchFlow).toHaveBeenCalledWith(
                expect.objectContaining({ window: 'live' }),
                true,
            );

            obsMocks.fetchFlow.mockClear();
            await vi.advanceTimersByTimeAsync(3_000);
            expect(obsMocks.fetchFlow).toHaveBeenCalledWith(
                expect.objectContaining({ window: 'live' }),
                true,
            );
        } finally {
            unmount?.();
            vi.useRealTimers();
        }
    });

    it('renders TrafficMapPage service tiles and toggles table view', () => {
        renderWithRouter(() => <TrafficMapPage />, '/traffic_map');
        expect(
            screen.getByRole('heading', { name: copyInDom('obs_traffic_map_title') }),
        ).toBeInTheDocument();
        expect(obsMocks.fetchTrafficMap).toHaveBeenCalled();
        expect(screen.getByText('YouTube')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: copyInDom('obs_table_aria') }));
        expect(screen.getByRole('table')).toBeInTheDocument();
    });

    it('renders HeatmapPage activity and latency tabs', () => {
        renderWithRouter(() => <HeatmapPage />, '/heatmap');
        expect(
            screen.getByRole('heading', { name: copyInDom('obs_heatmap_title') }),
        ).toBeInTheDocument();
        expect(obsMocks.fetchHeatmap).toHaveBeenCalled();
        expect(screen.getByLabelText(copyInDom('obs_activity_heatmap'))).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: copyInDom('obs_latency_heatmap') }));
        expect(obsMocks.fetchLatencyHeatmap).toHaveBeenCalled();
        expect(screen.getByLabelText(copyInDom('obs_latency_heatmap'))).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: copyInDom('obs_table_aria') }));
        expect(screen.getByText('api.example.com')).toBeInTheDocument();
    });
});
