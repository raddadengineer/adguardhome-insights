import {
    createSignal,
    createMemo,
    createEffect,
    untrack,
    onMount,
    onCleanup,
    Show,
    For,
} from 'solid-js';
import cn from 'clsx';
import { useNavigate, useSearchParams } from '@solidjs/router';

import intl from 'panel/common/intl';
import theme from 'panel/lib/theme';
import { Breadcrumbs } from 'panel/common/ui/Breadcrumbs';
import { Button } from 'panel/common/ui/Button';
import { Icon } from 'panel/common/ui/Icon';
import { Input } from 'panel/common/controls/Input';
import { Loader } from 'panel/common/ui/Loader';
import { RoutePath, linkPathBuilder } from 'panel/components/Routes/Paths';
import {
    observabilityState,
    fetchFlow,
    fetchFlowDetails,
    clearFlowDetails,
} from 'panel/stores/observability';
import { dashboardState, getClients } from 'panel/stores/dashboard';
import { statsState, getStats } from 'panel/stores/stats';
import {
    filteringState,
    getFilteringStatus,
    blockDomain,
    unblockDomain,
} from 'panel/stores/filtering';
import {
    servicesState,
    getAllBlockedServices,
    getBlockedServices,
    allowBlockedService,
    blockService,
} from 'panel/stores/services';
import type { StatsFlowWindow } from 'panel/api/model/statsFlowWindow';
import type { StatsFlowGroupBy } from 'panel/api/model/statsFlowGroupBy';
import type { StatsFlowView } from 'panel/api/model/statsFlowView';
import type { StatsFlowParams } from 'panel/api/model/statsFlowParams';
import type { StatsFlowDetailsParams } from 'panel/api/model/statsFlowDetailsParams';
import {
    STAGES,
    MIN_FLOW_ZOOM,
    MAX_FLOW_ZOOM,
    FLOW_ZOOM_STEP,
    DEFAULT_FLOW_VIEWPORT,
    foldFlow,
    layoutSankey,
    clampViewport,
    zoomViewportAt,
    panViewport,
    formatZoomPercent,
    formatPercent,
    formatCompactCount,
    type FlowViewport,
    type PlacedNode,
    type PlacedLink,
} from 'panel/helpers/observability/sankey';
import {
    extractServiceMap,
    lookupService,
    type ServiceCatalogEntry,
} from 'panel/helpers/observability/treemap';
import { formatLatencyBound } from 'panel/helpers/observability/latencyHeatmap';
import {
    FILTER_KEYS,
    hasActiveFlowFilter,
    parseDrillTrail,
    serializeDrillTrail,
    applyDrillPatch,
    popTrailToIndex,
    stepBackTrail,
    removeFilterKey,
    nodeFilterPatch,
    isNodeSelected,
    isLinkSelected,
    buildFlowServices,
    buildQueryLogLink,
    resolveDomainBlockAction,
    type FlowFilter,
    type FlowDrillStep,
} from 'panel/helpers/observability/flowDrilldown';
import { FlowTreePanel } from './blocks/FlowTreePanel';

import s from './FlowPage.module.pcss';

const WINDOWS: readonly StatsFlowWindow[] = ['15m', '1h', '6h', '24h', '7d', '30d', '90d'];
const GROUP_BYS: readonly StatsFlowGroupBy[] = ['client', 'tag', 'protocol'];
const VIEW_LENSES: readonly StatsFlowView[] = ['auto', 'overview', 'blocked', 'content', 'dns'];
const MIN_FOLD_SHARE = 0.005;

type InspectorTab = 'hierarchy' | 'domains' | 'services' | 'devices' | 'recent';

const STATUS_VAR: Record<string, string> = {
    cached: 'var(--obs-cached)',
    forwarded: 'var(--obs-forwarded)',
    blocked: 'var(--obs-blocked)',
    rewritten: 'var(--obs-rewritten)',
    local: 'var(--obs-local)',
    error: 'var(--obs-error)',
};

function nodeColor(node: Pick<PlacedNode, 'stage' | 'name'>): string {
    if (node.name === 'other') {
        return 'var(--obs-other)';
    }
    if (node.stage === 'status') {
        return STATUS_VAR[node.name] ?? 'var(--obs-other)';
    }
    if (node.stage === 'rcode') {
        if (node.name === 'SERVFAIL' || node.name === 'REFUSED') {
            return 'var(--obs-error)';
        }
        if (node.name === 'NOERROR') {
            return 'var(--obs-cached)';
        }
        return 'var(--obs-other)';
    }
    if (node.stage === 'filter_list' || node.stage === 'rule' || node.stage === 'reason') {
        return node.name === 'None' || node.name === 'none'
            ? 'var(--obs-other)'
            : 'var(--obs-blocked)';
    }
    if (node.stage === 'category' || node.stage === 'service') {
        return 'var(--obs-rewritten)';
    }
    if (node.stage === 'qtype') {
        return 'var(--obs-local)';
    }
    if (node.stage === 'upstream') {
        return 'var(--obs-forwarded)';
    }
    return 'var(--obs-allowed)';
}

function normalizeWindow(raw: string | undefined): StatsFlowWindow {
    return WINDOWS.includes(raw as StatsFlowWindow) ? (raw as StatsFlowWindow) : '24h';
}

function normalizeGroupBy(raw: string | undefined): StatsFlowGroupBy {
    return GROUP_BYS.includes(raw as StatsFlowGroupBy) ? (raw as StatsFlowGroupBy) : 'client';
}

function normalizeView(raw: string | undefined): StatsFlowView {
    return VIEW_LENSES.includes(raw as StatsFlowView) ? (raw as StatsFlowView) : 'auto';
}

export const FlowPage = () => {
    const navigate = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams<{
        window?: string;
        group_by?: string;
        view?: string;
        trail?: string;
        client?: string;
        tag?: string;
        protocol?: string;
        status?: string;
        upstream?: string;
        rcode?: string;
        domain?: string;
        category?: string;
        service?: string;
        filter_list?: string;
        reason?: string;
        rule?: string;
        qtype?: string;
    }>();

    const win = createMemo<StatsFlowWindow>(() => normalizeWindow(searchParams.window));
    const groupBy = createMemo<StatsFlowGroupBy>(() => normalizeGroupBy(searchParams.group_by));
    const viewLens = createMemo<StatsFlowView>(() => normalizeView(searchParams.view));
    const activeClient = createMemo(() => (searchParams.client ?? '').trim());

    const flowFilter = createMemo<FlowFilter>(() => ({
        client: searchParams.client?.trim() || undefined,
        tag: searchParams.tag?.trim() || undefined,
        protocol: searchParams.protocol?.trim() || undefined,
        status: searchParams.status?.trim() || undefined,
        upstream: searchParams.upstream?.trim() || undefined,
        rcode: searchParams.rcode?.trim() || undefined,
        domain: searchParams.domain?.trim() || undefined,
        category: searchParams.category?.trim() || undefined,
        service: searchParams.service?.trim() || undefined,
        filter_list: searchParams.filter_list?.trim() || undefined,
        reason: searchParams.reason?.trim() || undefined,
        rule: searchParams.rule?.trim() || undefined,
        qtype: searchParams.qtype?.trim() || undefined,
    }));

    const trailSteps = createMemo(() => parseDrillTrail(searchParams.trail, flowFilter()));
    const hasFilter = createMemo(() => hasActiveFlowFilter(flowFilter()));

    const [clientDraft, setClientDraft] = createSignal(untrack(activeClient));
    const [hideSmall, setHideSmall] = createSignal(true);
    const [live, setLive] = createSignal(false);
    const [showTable, setShowTable] = createSignal(false);
    const [inspectAll, setInspectAll] = createSignal(false);
    const [inspectorTab, setInspectorTab] = createSignal<InspectorTab>('hierarchy');
    const [drillSearch, setDrillSearch] = createSignal('');
    const [busyActionKey, setBusyActionKey] = createSignal<string | null>(null);
    const [diagramWidth, setDiagramWidth] = createSignal(780);
    const [viewport, setViewport] = createSignal<FlowViewport>(DEFAULT_FLOW_VIEWPORT);
    const [isPanning, setIsPanning] = createSignal(false);
    const [hoverNodeId, setHoverNodeId] = createSignal<string | null>(null);
    const [hoverLink, setHoverLink] = createSignal<PlacedLink | null>(null);
    const [tipPos, setTipPos] = createSignal<{ x: number; y: number } | null>(null);

    let wrapEl: HTMLDivElement | undefined;
    let svgViewportEl: HTMLDivElement | undefined;
    let dragState: { startX: number; startY: number; origin: FlowViewport } | null = null;
    let suppressNextClick = false;
    let observer: ResizeObserver | undefined;

    createEffect(() => {
        setClientDraft(activeClient());
    });

    onMount(() => {
        if (dashboardState.clients.length === 0) {
            void getClients();
        }
        if (!statsState.statsInitialized) {
            void getStats();
        }
        if (!servicesState.allInitialized) {
            void getAllBlockedServices();
        }
        if (!servicesState.initialized) {
            void getBlockedServices();
        }
        if (!filteringState.filtersInitialized) {
            void getFilteringStatus();
        }
        if (wrapEl && typeof ResizeObserver !== 'undefined') {
            observer = new ResizeObserver((entries) => {
                const w = entries[0]?.contentRect.width;
                if (w && w > 0) {
                    setDiagramWidth(Math.round(w));
                }
            });
            observer.observe(wrapEl);
        }
    });

    onCleanup(() => {
        observer?.disconnect();
    });

    const buildFlowRequest = (
        w: StatsFlowWindow,
        gb: StatsFlowGroupBy,
        vw: StatsFlowView,
        flt: FlowFilter,
    ): StatsFlowParams => ({
        window: w,
        group_by: gb,
        view: vw === 'auto' ? undefined : vw,
        client: flt.client,
        tag: flt.tag,
        protocol: flt.protocol,
        status: flt.status as StatsFlowParams['status'],
        upstream: flt.upstream,
        rcode: flt.rcode,
        domain: flt.domain,
        category: flt.category,
        service: flt.service,
        filter_list: flt.filter_list,
        reason: flt.reason,
        rule: flt.rule,
        qtype: flt.qtype,
    });

    const buildDetailsRequest = (
        w: StatsFlowWindow,
        vw: StatsFlowView,
        flt: FlowFilter,
    ): StatsFlowDetailsParams => ({
        window: w,
        view: vw === 'auto' ? undefined : vw,
        client: flt.client,
        tag: flt.tag,
        protocol: flt.protocol,
        status: flt.status as StatsFlowDetailsParams['status'],
        upstream: flt.upstream,
        rcode: flt.rcode,
        domain: flt.domain,
        category: flt.category,
        service: flt.service,
        filter_list: flt.filter_list,
        reason: flt.reason,
        rule: flt.rule,
        qtype: flt.qtype,
        limit: 100,
    });

    createEffect(() => {
        const w = win();
        const gb = groupBy();
        const vw = viewLens();
        const flt = flowFilter();
        const shouldInspect = hasFilter() || inspectAll();
        const isLive = live();

        const flowReq = buildFlowRequest(w, gb, vw, flt);
        const detailsReq = buildDetailsRequest(w, vw, flt);

        void fetchFlow(flowReq);
        if (shouldInspect) {
            void fetchFlowDetails(detailsReq);
        } else {
            clearFlowDetails();
        }

        if (!isLive) {
            return;
        }

        const timer = window.setInterval(() => {
            void fetchFlow(flowReq, true);
            if (shouldInspect) {
                void fetchFlowDetails(detailsReq, true);
            }
        }, 15_000);

        onCleanup(() => {
            window.clearInterval(timer);
        });
    });

    const commitDrillState = (nextFilter: FlowFilter, nextTrail: FlowDrillStep[], replace = false) => {
        const update: Record<string, string | undefined> = {
            trail: serializeDrillTrail(nextTrail),
        };
        for (const key of FILTER_KEYS) {
            update[key] = nextFilter[key] || undefined;
        }
        setSearchParams(update, { replace });
    };

    const applyFilterPatch = (patch: Partial<FlowFilter>, toggleIfExact = true) => {
        const next = applyDrillPatch(flowFilter(), trailSteps(), patch, toggleIfExact);
        commitDrillState(next.filter, next.trail, false);
    };

    const handleClearAllFilters = () => {
        setClientDraft('');
        setDrillSearch('');
        setInspectAll(false);
        commitDrillState({}, [], false);
    };

    const clientSuggestions = createMemo(() => {
        const set = new Set<string>();
        for (const c of dashboardState.clients ?? []) {
            if (c.name) set.add(c.name);
            for (const id of c.ids ?? []) {
                set.add(id);
            }
        }
        for (const tc of statsState.topClients ?? []) {
            if (tc.name) set.add(tc.name);
        }
        return [...set].slice(0, 100);
    });

    const serviceMap = createMemo(() => extractServiceMap(servicesState.allServices ?? []));
    const serviceById = createMemo(() => {
        const map = new Map<string, ServiceCatalogEntry>();
        for (const svc of servicesState.allServices ?? []) {
            map.set(svc.id.toLowerCase(), {
                id: svc.id,
                name: svc.name || svc.id,
                iconSvg: svc.icon_svg,
            });
        }
        return map;
    });

    const activeStages = createMemo<readonly string[]>(() => {
        const stages = observabilityState.flow?.stages;
        return stages && stages.length > 0 ? stages : STAGES;
    });

    const folded = createMemo(() => {
        const data = observabilityState.flow;
        if (!data) {
            return null;
        }
        return foldFlow(
            data.nodes,
            data.links,
            data.total,
            hideSmall() ? MIN_FOLD_SHARE : 0,
            activeStages(),
        );
    });

    const isVertical = createMemo(() => diagramWidth() < 560);

    const diagramHeight = createMemo(() => {
        const f = folded();
        if (!f) {
            return 360;
        }
        if (isVertical()) {
            return 560;
        }
        const maxRows = Math.max(
            1,
            ...activeStages().map((st) => f.nodes.filter((n) => n.stage === st).length),
        );
        return Math.max(360, Math.min(720, maxRows * 34));
    });

    const svgWidth = createMemo(() => Math.max(240, diagramWidth()));
    const zoomScale = createMemo(() => Math.max(1, viewport().scale));
    const isDefaultViewport = createMemo(
        () => viewport().scale === 1 && viewport().tx === 0 && viewport().ty === 0,
    );

    const sankey = createMemo(() => {
        const f = folded();
        const w = diagramWidth();
        if (!f || f.nodes.length === 0 || w <= 0) {
            return null;
        }
        const padX = isVertical() ? 4 : 8;
        return layoutSankey(
            f.nodes,
            f.links,
            Math.max(240, w - padX * 2),
            diagramHeight() - (isVertical() ? 24 : 0),
            isVertical(),
            10,
            14,
            activeStages(),
        );
    });

    createEffect(() => {
        win();
        groupBy();
        viewLens();
        flowFilter();
        showTable();
        setViewport(DEFAULT_FLOW_VIEWPORT);
        setIsPanning(false);
        dragState = null;
    });

    createEffect(() => {
        const w = svgWidth();
        const h = diagramHeight();
        setViewport((prev) => clampViewport(prev, w, h));
    });

    const zoomBy = (factor: number) => {
        const w = svgWidth();
        const h = diagramHeight();
        setViewport((prev) =>
            zoomViewportAt(prev, prev.scale * factor, w / 2, h / 2, w, h),
        );
    };

    const resetZoom = () => {
        setViewport(DEFAULT_FLOW_VIEWPORT);
        setIsPanning(false);
        dragState = null;
    };

    const handleWheel = (e: WheelEvent) => {
        if (!e.ctrlKey && !e.metaKey) {
            return;
        }
        if (e.cancelable) {
            e.preventDefault();
        }
        const w = svgWidth();
        const h = diagramHeight();
        const rect = svgViewportEl?.getBoundingClientRect();
        const anchorX = rect && rect.width > 0 ? e.clientX - rect.left : w / 2;
        const anchorY = rect && rect.height > 0 ? e.clientY - rect.top : h / 2;
        const rawFactor = Math.exp(-e.deltaY * 0.008);
        const factor = Math.max(0.65, Math.min(1.5, rawFactor));

        setViewport((prev) =>
            zoomViewportAt(prev, prev.scale * factor, anchorX, anchorY, w, h),
        );
    };

    const handlePointerDown = (e: PointerEvent) => {
        if (e.button !== 0 || viewport().scale <= 1) {
            return;
        }
        dragState = {
            startX: e.clientX,
            startY: e.clientY,
            origin: viewport(),
        };
        suppressNextClick = false;
        const target = e.currentTarget as HTMLElement | null;
        if (target?.setPointerCapture) {
            try {
                target.setPointerCapture(e.pointerId);
            } catch {
                // Ignore synthetic pointer ids in unit tests.
            }
        }
    };

    const handlePointerMove = (e: PointerEvent) => {
        if (!dragState) {
            return;
        }
        const dx = e.clientX - dragState.startX;
        const dy = e.clientY - dragState.startY;
        if (Math.hypot(dx, dy) > 4) {
            suppressNextClick = true;
            setIsPanning(true);
            setTipPos(null);
        }
        if (suppressNextClick) {
            setViewport(panViewport(dragState.origin, dx, dy, svgWidth(), diagramHeight()));
        }
    };

    const handlePointerEnd = (e: PointerEvent) => {
        if (!dragState) {
            return;
        }
        dragState = null;
        setIsPanning(false);
        const target = e.currentTarget as HTMLElement | null;
        if (target?.releasePointerCapture) {
            try {
                target.releasePointerCapture(e.pointerId);
            } catch {
                // Ignore if pointer capture is not active.
            }
        }
    };

    const handleViewportKeyDown = (e: KeyboardEvent) => {
        if (e.target !== svgViewportEl) {
            return;
        }
        const step = 48;
        switch (e.key) {
            case '+':
            case '=':
                e.preventDefault();
                zoomBy(FLOW_ZOOM_STEP);
                break;
            case '-':
            case '_':
                e.preventDefault();
                zoomBy(1 / FLOW_ZOOM_STEP);
                break;
            case '0':
                e.preventDefault();
                resetZoom();
                break;
            case 'ArrowLeft':
                if (viewport().scale > 1) {
                    e.preventDefault();
                    setViewport((prev) =>
                        panViewport(prev, step, 0, svgWidth(), diagramHeight()),
                    );
                }
                break;
            case 'ArrowRight':
                if (viewport().scale > 1) {
                    e.preventDefault();
                    setViewport((prev) =>
                        panViewport(prev, -step, 0, svgWidth(), diagramHeight()),
                    );
                }
                break;
            case 'ArrowUp':
                if (viewport().scale > 1) {
                    e.preventDefault();
                    setViewport((prev) =>
                        panViewport(prev, 0, step, svgWidth(), diagramHeight()),
                    );
                }
                break;
            case 'ArrowDown':
                if (viewport().scale > 1) {
                    e.preventDefault();
                    setViewport((prev) =>
                        panViewport(prev, 0, -step, svgWidth(), diagramHeight()),
                    );
                }
                break;
            default:
                break;
        }
    };

    const nodeById = createMemo(() => {
        const map = new Map<string, PlacedNode>();
        for (const n of sankey()?.nodes ?? []) {
            map.set(n.id, n);
        }
        return map;
    });

    const filterKeyLabel = (key: keyof FlowFilter): string => {
        switch (key) {
            case 'client':
                return intl.getMessage('obs_filter_client');
            case 'tag':
                return intl.getMessage('obs_filter_tag');
            case 'protocol':
                return intl.getMessage('obs_filter_protocol');
            case 'status':
                return intl.getMessage('obs_filter_status');
            case 'upstream':
                return intl.getMessage('obs_filter_upstream');
            case 'rcode':
                return intl.getMessage('obs_filter_rcode');
            case 'domain':
                return intl.getMessage('obs_filter_domain');
            case 'category':
                return intl.getMessage('obs_filter_category');
            case 'service':
                return intl.getMessage('obs_filter_service');
            case 'filter_list':
                return intl.getMessage('obs_filter_filter_list');
            case 'reason':
                return intl.getMessage('obs_filter_reason');
            case 'rule':
                return intl.getMessage('obs_filter_rule');
            case 'qtype':
                return intl.getMessage('obs_filter_qtype');
        }
    };

    const formatStepValue = (step: FlowDrillStep): string => {
        if (step.key === 'service') {
            const entry = serviceById().get(step.value.toLowerCase());
            if (entry) {
                return entry.name;
            }
            if (step.value.startsWith('site:')) {
                return step.value.slice(5);
            }
        }
        if (step.key === 'client') {
            const fromNode =
                nodeById().get(`client:${step.value}`) ?? nodeById().get(`group:${step.value}`);
            if (fromNode?.label) {
                return fromNode.label;
            }
            const fromDetails = observabilityState.flowDetails?.clients.find(
                (c) => c.id === step.value,
            );
            if (fromDetails?.label) {
                return fromDetails.label;
            }
        }
        return step.value;
    };

    const windowLabel = (w: StatsFlowWindow): string => {
        switch (w) {
            case '15m':
                return intl.getMessage('obs_window_15m');
            case '1h':
                return intl.getMessage('obs_window_1h');
            case '6h':
                return intl.getMessage('obs_window_6h');
            case '24h':
                return intl.getMessage('obs_window_24h');
            case '7d':
                return intl.getMessage('obs_window_7d');
            case '30d':
                return intl.getMessage('obs_window_30d');
            case '90d':
                return intl.getMessage('obs_window_90d');
        }
    };

    const groupByLabel = (gb: StatsFlowGroupBy): string => {
        switch (gb) {
            case 'client':
                return intl.getMessage('obs_group_by_client');
            case 'tag':
                return intl.getMessage('obs_group_by_tag');
            case 'protocol':
                return intl.getMessage('obs_group_by_protocol');
        }
    };

    const viewLensLabel = (vw: StatsFlowView): string => {
        switch (vw) {
            case 'auto':
                return intl.getMessage('obs_lens_auto');
            case 'overview':
                return intl.getMessage('obs_lens_overview');
            case 'blocked':
                return intl.getMessage('obs_lens_blocked');
            case 'content':
                return intl.getMessage('obs_lens_content');
            case 'dns':
                return intl.getMessage('obs_lens_dns');
        }
    };

    const stageLabel = (stage: string): string => {
        switch (stage) {
            case 'group':
                return groupByLabel(groupBy());
            case 'client':
                return intl.getMessage('obs_stage_client');
            case 'status':
                return intl.getMessage('obs_stage_decision');
            case 'reason':
                return intl.getMessage('obs_stage_reason');
            case 'filter_list':
                return intl.getMessage('obs_stage_filter_list');
            case 'rule':
                return intl.getMessage('obs_stage_rule');
            case 'category':
                return intl.getMessage('obs_stage_category');
            case 'service':
                return intl.getMessage('obs_stage_service');
            case 'domain':
                return intl.getMessage('obs_stage_domain');
            case 'qtype':
                return intl.getMessage('obs_stage_qtype');
            case 'upstream':
                return intl.getMessage('obs_stage_upstream');
            default:
                return intl.getMessage('obs_stage_response');
        }
    };

    const drillNode = (node: PlacedNode) => {
        if (suppressNextClick) {
            suppressNextClick = false;
            return;
        }
        const patch = nodeFilterPatch(node, groupBy());
        if (!patch) {
            return;
        }
        applyFilterPatch(patch, true);
    };

    const drillLink = (link: Pick<PlacedLink, 'source' | 'target'>) => {
        if (suppressNextClick) {
            suppressNextClick = false;
            return;
        }
        const src = nodeById().get(link.source);
        const dst = nodeById().get(link.target);
        if (!src || !dst) {
            return;
        }
        const combined: Partial<FlowFilter> = {
            ...(nodeFilterPatch(src, groupBy()) ?? {}),
            ...(nodeFilterPatch(dst, groupBy()) ?? {}),
        };
        applyFilterPatch(combined, true);
    };

    const openQueryLogForFilter = (override?: { search?: string; status?: string }) => {
        navigate(buildQueryLogLink(flowFilter(), override));
    };

    const openHeatmapForKey = (kind: 'domain' | 'client', key: string) => {
        navigate(
            linkPathBuilder(RoutePath.Heatmap, undefined, {
                kind,
                key,
            }),
        );
    };

    const handleDomainBlockToggle = async (domain: string, action: 'block' | 'allow') => {
        const key = `domain:${domain}`;
        if (busyActionKey() === key) {
            return;
        }
        setBusyActionKey(key);
        try {
            if (action === 'allow') {
                await unblockDomain(domain);
            } else {
                await blockDomain(domain);
            }
        } finally {
            setBusyActionKey(null);
        }
    };

    const handleServiceBlockToggle = async (serviceId: string, currentlyBlocked: boolean) => {
        const key = `service:${serviceId}`;
        if (busyActionKey() === key) {
            return;
        }
        setBusyActionKey(key);
        try {
            if (currentlyBlocked) {
                await allowBlockedService(serviceId);
            } else {
                await blockService(serviceId);
            }
        } finally {
            setBusyActionKey(null);
        }
    };

    const isLinkDimmed = (link: PlacedLink): boolean => {
        const hn = hoverNodeId();
        const hl = hoverLink();
        if (hl) {
            return hl.source !== link.source || hl.target !== link.target;
        }
        if (hn) {
            return link.source !== hn && link.target !== hn;
        }
        return false;
    };

    const isNodeDimmed = (node: PlacedNode): boolean => {
        const hl = hoverLink();
        if (hl) {
            return hl.source !== node.id && hl.target !== node.id;
        }
        const hn = hoverNodeId();
        if (!hn || hn === node.id) {
            return false;
        }
        const links = sankey()?.links ?? [];
        return !links.some(
            (l) => (l.source === hn && l.target === node.id) || (l.target === hn && l.source === node.id),
        );
    };

    const updateTip = (e: MouseEvent) => {
        if (!wrapEl) return;
        const rect = wrapEl.getBoundingClientRect();
        setTipPos({
            x: Math.min(rect.width - 260, Math.max(8, e.clientX - rect.left + 12)),
            y: Math.max(8, e.clientY - rect.top - 14),
        });
    };

    const handleApplyClient = (e: Event) => {
        e.preventDefault();
        const val = clientDraft().trim();
        applyFilterPatch({ client: val || undefined }, false);
        if (!val) {
            const next = removeFilterKey(flowFilter(), trailSteps(), 'client');
            commitDrillState(next.filter, next.trail, false);
        }
    };

    const handleClearClient = () => {
        setClientDraft('');
        const next = removeFilterKey(flowFilter(), trailSteps(), 'client');
        commitDrillState(next.filter, next.trail, false);
    };

    const totalQueries = createMemo(() => observabilityState.flow?.total ?? 0);

    const tooltipText = createMemo(() => {
        const total = totalQueries();
        const hint = intl.getMessage('obs_click_to_drill_down');
        const hl = hoverLink();
        if (hl) {
            const srcNode = nodeById().get(hl.source);
            const dstNode = nodeById().get(hl.target);
            const src = srcNode?.label ?? hl.source;
            const dst = dstNode?.label ?? hl.target;
            const cnt = intl.getPlural('obs_queries_count', hl.count, {
                count: hl.count.toLocaleString(),
            });
            const clickable = Boolean(
                (srcNode && nodeFilterPatch(srcNode, groupBy())) ||
                    (dstNode && nodeFilterPatch(dstNode, groupBy())),
            );
            return clickable
                ? `${src} → ${dst} · ${cnt} (${formatPercent(hl.count, total)}) · ${hint}`
                : `${src} → ${dst} · ${cnt} (${formatPercent(hl.count, total)})`;
        }

        const hn = hoverNodeId();
        if (hn) {
            const n = nodeById().get(hn);
            if (!n) return '';
            const cnt = intl.getPlural('obs_queries_count', n.count, {
                count: n.count.toLocaleString(),
            });
            return nodeFilterPatch(n, groupBy())
                ? `${n.label} · ${cnt} (${formatPercent(n.count, total)}) · ${hint}`
                : `${n.label} · ${cnt} (${formatPercent(n.count, total)})`;
        }
        return '';
    });

    const details = createMemo(() => observabilityState.flowDetails);
    const needle = createMemo(() => drillSearch().trim().toLowerCase());
    const blockedServiceIds = createMemo(() => new Set(servicesState.list?.ids ?? []));

    const resolveDomainServiceLabel = (dom: {
        domain: string;
        service?: string;
        service_name?: string;
    }): string => {
        if (dom.service && !dom.service.startsWith('site:')) {
            return (
                serviceById().get(dom.service.toLowerCase())?.name ??
                dom.service_name ??
                dom.service
            );
        }
        return lookupService(dom.domain, serviceMap())?.name ?? dom.service_name ?? '';
    };

    const filteredDomains = createMemo(() => {
        const list = details()?.domains ?? [];
        const q = needle();
        if (!q) return list;
        return list.filter(
            (d) =>
                d.domain.toLowerCase().includes(q) ||
                (d.rule ?? '').toLowerCase().includes(q) ||
                (d.reason ?? '').toLowerCase().includes(q) ||
                (d.filter_list ?? '').toLowerCase().includes(q) ||
                (d.qtypes ?? []).some((qt) => qt.toLowerCase().includes(q)) ||
                resolveDomainServiceLabel(d).toLowerCase().includes(q),
        );
    });

    const serviceRows = createMemo(() => {
        const list = details()?.domains ?? [];
        return buildFlowServices(list, serviceMap(), serviceById());
    });

    const filteredServices = createMemo(() => {
        const list = serviceRows();
        const q = needle();
        if (!q) return list;
        return list.filter(
            (svc) =>
                svc.label.toLowerCase().includes(q) ||
                svc.members.some((m) => m.domain.toLowerCase().includes(q)),
        );
    });

    const filteredClients = createMemo(() => {
        const list = details()?.clients ?? [];
        const q = needle();
        if (!q) return list;
        return list.filter(
            (c) =>
                c.label.toLowerCase().includes(q) ||
                c.id.toLowerCase().includes(q) ||
                (c.tag ?? '').toLowerCase().includes(q),
        );
    });

    const filteredRecent = createMemo(() => {
        const list = details()?.recent ?? [];
        const q = needle();
        if (!q) return list;
        return list.filter(
            (item) =>
                item.domain.toLowerCase().includes(q) ||
                item.client.toLowerCase().includes(q) ||
                (item.client_name ?? '').toLowerCase().includes(q) ||
                (item.qtype ?? '').toLowerCase().includes(q) ||
                item.status.toLowerCase().includes(q) ||
                (item.rule ?? '').toLowerCase().includes(q) ||
                (item.reason ?? '').toLowerCase().includes(q) ||
                (item.filter_list ?? '').toLowerCase().includes(q) ||
                (item.service_name ?? item.service ?? '').toLowerCase().includes(q) ||
                (item.upstream ?? '').toLowerCase().includes(q) ||
                (item.rcode ?? '').toLowerCase().includes(q),
        );
    });

    const filteredRules = createMemo(() => {
        const list = details()?.rules ?? [];
        const q = needle();
        if (!q) return list;
        return list.filter(
            (r) =>
                r.rule.toLowerCase().includes(q) ||
                (r.reason ?? '').toLowerCase().includes(q) ||
                (r.filter_list ?? '').toLowerCase().includes(q),
        );
    });

    const formatRecentTime = (iso: string): string => {
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) {
            return iso;
        }
        return d.toLocaleTimeString([], {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
    };

    const blockedOnlyActive = createMemo(() => flowFilter().status === 'blocked');

    return (
        <div class={cn(theme.layout.container, s.containerOverride)}>
            <div class={cn(theme.layout.containerIn, s.page)}>
                <div class={s.header}>
                    <div class={s.headerLeft}>
                        <Breadcrumbs
                            parentLinks={[
                                {
                                    path: RoutePath.Dashboard,
                                    title: intl.getMessage('dashboard'),
                                },
                            ]}
                            currentTitle={intl.getMessage('obs_flow_title')}
                        />
                        <div class={s.titleRow}>
                            <h1 class={cn(theme.title.h4, theme.title.h3_tablet, s.title)}>
                                {intl.getMessage('obs_flow_title')}
                            </h1>
                            <Show when={totalQueries() > 0}>
                                <span class={s.totalBadge}>
                                    {intl.getMessage('obs_total_queries')}:{' '}
                                    {totalQueries().toLocaleString()}
                                </span>
                            </Show>
                        </div>
                    </div>

                    <div class={s.toolbar}>
                        <div class={s.segmented} role="group" aria-label={intl.getMessage('obs_flow_title')}>
                            <For each={WINDOWS}>
                                {(w) => (
                                    <button
                                        type="button"
                                        class={cn(s.segBtn, { [s.segActive]: win() === w })}
                                        onClick={() => setSearchParams({ window: w }, { replace: true })}
                                    >
                                        {windowLabel(w)}
                                    </button>
                                )}
                            </For>
                        </div>

                        <div class={s.segmented} role="group" aria-label={intl.getMessage('obs_stage_group')}>
                            <For each={GROUP_BYS}>
                                {(gb) => (
                                    <button
                                        type="button"
                                        class={cn(s.segBtn, { [s.segActive]: groupBy() === gb })}
                                        onClick={() => setSearchParams({ group_by: gb }, { replace: true })}
                                    >
                                        {groupByLabel(gb)}
                                    </button>
                                )}
                            </For>
                        </div>

                        <div class={s.segmented} role="group" aria-label={intl.getMessage('obs_lens_label')}>
                            <For each={VIEW_LENSES}>
                                {(vw) => (
                                    <button
                                        type="button"
                                        class={cn(s.segBtn, { [s.segActive]: viewLens() === vw })}
                                        onClick={() =>
                                            setSearchParams(
                                                { view: vw === 'auto' ? undefined : vw },
                                                { replace: true },
                                            )
                                        }
                                    >
                                        {viewLensLabel(vw)}
                                    </button>
                                )}
                            </For>
                        </div>

                        <form class={s.clientForm} onSubmit={handleApplyClient}>
                            <Input
                                class={s.clientInput}
                                size="small"
                                list="obs-flow-clients"
                                value={clientDraft()}
                                onInput={(e: Event) => setClientDraft((e.target as HTMLInputElement).value)}
                                placeholder={intl.getMessage('obs_client_filter_placeholder')}
                                isClearable
                                onClear={handleClearClient}
                            />
                            <datalist id="obs-flow-clients">
                                <For each={clientSuggestions()}>
                                    {(c) => <option value={c} />}
                                </For>
                            </datalist>
                            <Button type="submit" variant="secondary" size="very-small">
                                {intl.getMessage('obs_control_apply')}
                            </Button>
                        </form>

                        <div class={s.toggles}>
                            <button
                                type="button"
                                class={cn(s.toggleBtn, {
                                    [s.blockedBtnActive]: blockedOnlyActive(),
                                })}
                                aria-pressed={blockedOnlyActive()}
                                onClick={() => applyFilterPatch({ status: 'blocked' }, true)}
                            >
                                {intl.getMessage('obs_blocked_only')}
                            </button>
                            <button
                                type="button"
                                class={cn(s.toggleBtn, { [s.segActive]: hideSmall() })}
                                aria-label={intl.getMessage('obs_hide_small_aria')}
                                onClick={() => setHideSmall((prev) => !prev)}
                            >
                                {intl.getMessage('obs_fold_small')}
                            </button>
                            <button
                                type="button"
                                class={cn(s.toggleBtn, { [s.segActive]: live() })}
                                aria-label={intl.getMessage('obs_live_aria')}
                                onClick={() => setLive((prev) => !prev)}
                            >
                                {intl.getMessage('obs_live')}
                            </button>
                            <button
                                type="button"
                                class={cn(s.toggleBtn, { [s.segActive]: showTable() })}
                                aria-label={intl.getMessage('obs_table_aria')}
                                onClick={() => setShowTable((prev) => !prev)}
                            >
                                {intl.getMessage('obs_table_view')}
                            </button>
                            <Button
                                variant="ghost"
                                size="small"
                                compact
                                class={s.refreshBtn}
                                aria-label={intl.getMessage('refresh_btn')}
                                disabled={observabilityState.loadingFlow}
                                onClick={() => {
                                    const w = win();
                                    const vw = viewLens();
                                    const flt = flowFilter();
                                    void fetchFlow(buildFlowRequest(w, groupBy(), vw, flt));
                                    if (hasFilter() || inspectAll()) {
                                        void fetchFlowDetails(buildDetailsRequest(w, vw, flt));
                                    }
                                }}
                            >
                                <Icon icon="refresh" class={s.refreshIcon} />
                            </Button>
                        </div>
                    </div>
                </div>

                <Show when={trailSteps().length > 0}>
                    <div class={s.filterBar} data-testid="flow-drill-trail">
                        <div class={s.trailRow}>
                            <button
                                type="button"
                                class={s.crumbRoot}
                                onClick={handleClearAllFilters}
                            >
                                {intl.getMessage('obs_all_traffic')}
                            </button>
                            <For each={trailSteps()}>
                                {(step, idx) => (
                                    <>
                                        <span class={s.crumbSep} aria-hidden="true">
                                            ›
                                        </span>
                                        <span
                                            class={cn(s.filterChip, {
                                                [s.filterChipBlocked]:
                                                    step.key === 'status' &&
                                                    step.value === 'blocked',
                                            })}
                                        >
                                            <button
                                                type="button"
                                                class={s.crumbJumpBtn}
                                                onClick={() => {
                                                    const popped = popTrailToIndex(
                                                        trailSteps(),
                                                        idx(),
                                                    );
                                                    commitDrillState(popped.filter, popped.trail);
                                                }}
                                            >
                                                <span class={s.chipKey}>
                                                    {filterKeyLabel(step.key)}:
                                                </span>{' '}
                                                <strong class={s.chipValue}>
                                                    {formatStepValue(step)}
                                                </strong>
                                            </button>
                                            <button
                                                type="button"
                                                class={s.chipClose}
                                                aria-label={intl.getMessage(
                                                    'obs_remove_filter_aria',
                                                    {
                                                        label: `${filterKeyLabel(step.key)}: ${formatStepValue(step)}`,
                                                    },
                                                )}
                                                onClick={() => {
                                                    if (step.key === 'client') {
                                                        setClientDraft('');
                                                    }
                                                    const next = removeFilterKey(
                                                        flowFilter(),
                                                        trailSteps(),
                                                        step.key,
                                                    );
                                                    commitDrillState(next.filter, next.trail);
                                                }}
                                            >
                                                <Icon icon="cross" class={s.chipCloseIcon} />
                                            </button>
                                        </span>
                                    </>
                                )}
                            </For>
                        </div>

                        <div class={s.filterActions}>
                            <Button
                                size="very-small"
                                variant="ghost"
                                onClick={() => {
                                    const stepped = stepBackTrail(trailSteps());
                                    commitDrillState(stepped.filter, stepped.trail);
                                }}
                            >
                                ← {intl.getMessage('obs_step_back')}
                            </Button>
                            <Button
                                size="very-small"
                                variant="secondary"
                                onClick={() => openQueryLogForFilter()}
                            >
                                {intl.getMessage('obs_open_query_log')}
                            </Button>
                            <Button
                                size="very-small"
                                variant="ghost"
                                onClick={handleClearAllFilters}
                            >
                                {intl.getMessage('obs_clear_filters')}
                            </Button>
                        </div>
                    </div>
                </Show>

                <Show when={observabilityState.flow?.source === 'querylog'}>
                    <div class={s.notice}>{intl.getMessage('obs_querylog_source_notice')}</div>
                </Show>
                <Show when={observabilityState.flow?.partial}>
                    <div class={s.notice}>{intl.getMessage('obs_partial_notice')}</div>
                </Show>
                <Show when={observabilityState.flow?.truncated || details()?.truncated}>
                    <div class={s.notice}>{intl.getMessage('obs_truncated_notice')}</div>
                </Show>

                <div class={s.card} ref={wrapEl}>
                    <Show
                        when={!observabilityState.loadingFlow || observabilityState.flow !== null}
                        fallback={
                            <div class={s.loader}>
                                <Loader />
                            </div>
                        }
                    >
                        <Show
                            when={sankey() && (observabilityState.flow?.total ?? 0) > 0}
                            fallback={
                                <div class={s.empty}>{intl.getMessage('obs_empty_flow')}</div>
                            }
                        >
                            <Show
                                when={!showTable()}
                                fallback={
                                    <div class={s.tableWrap}>
                                        <table class={s.table}>
                                            <thead>
                                                <tr>
                                                    <th>{intl.getMessage('obs_source')}</th>
                                                    <th>{intl.getMessage('obs_target')}</th>
                                                    <th class={s.numCol}>
                                                        {intl.getMessage('obs_total_queries')}
                                                    </th>
                                                    <th class={s.numCol}>
                                                        {intl.getMessage('obs_share')}
                                                    </th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                <For each={folded()?.links ?? []}>
                                                    {(l) => {
                                                        const src = () => nodeById().get(l.source);
                                                        const dst = () => nodeById().get(l.target);
                                                        const selected = () =>
                                                            src() && dst()
                                                                ? isLinkSelected(
                                                                      flowFilter(),
                                                                      src() as PlacedNode,
                                                                      dst() as PlacedNode,
                                                                      groupBy(),
                                                                  )
                                                                : false;
                                                        return (
                                                            <tr
                                                                class={cn(s.clickableRow, {
                                                                    [s.selectedRow]: selected(),
                                                                })}
                                                                onClick={() => drillLink(l)}
                                                            >
                                                                <td>
                                                                    {src()?.label ?? l.source}
                                                                </td>
                                                                <td
                                                                    class={cn({
                                                                        [s.failText]: l.failure,
                                                                    })}
                                                                >
                                                                    {dst()?.label ?? l.target}
                                                                </td>
                                                                <td class={s.numCol}>
                                                                    {l.count.toLocaleString()}
                                                                </td>
                                                                <td class={s.numCol}>
                                                                    {formatPercent(
                                                                        l.count,
                                                                        totalQueries(),
                                                                    )}
                                                                </td>
                                                            </tr>
                                                        );
                                                    }}
                                                </For>
                                            </tbody>
                                        </table>
                                    </div>
                                }
                            >
                                <div class={s.diagramTopBar}>
                                    <span class={s.zoomHint}>
                                        {intl.getMessage('obs_zoom_hint')}
                                    </span>
                                    <div
                                        class={s.zoomControls}
                                        role="group"
                                        aria-label={intl.getMessage('obs_zoom_controls_aria')}
                                    >
                                        <button
                                            type="button"
                                            class={s.zoomBtn}
                                            aria-label={intl.getMessage('obs_zoom_out')}
                                            disabled={viewport().scale <= MIN_FLOW_ZOOM}
                                            onClick={() => zoomBy(1 / FLOW_ZOOM_STEP)}
                                        >
                                            −
                                        </button>
                                        <span class={s.zoomReadout} data-testid="flow-zoom-level">
                                            {formatZoomPercent(viewport().scale)}
                                        </span>
                                        <button
                                            type="button"
                                            class={s.zoomBtn}
                                            aria-label={intl.getMessage('obs_zoom_in')}
                                            disabled={viewport().scale >= MAX_FLOW_ZOOM}
                                            onClick={() => zoomBy(FLOW_ZOOM_STEP)}
                                        >
                                            +
                                        </button>
                                        <button
                                            type="button"
                                            class={s.zoomBtn}
                                            disabled={isDefaultViewport()}
                                            onClick={resetZoom}
                                        >
                                            {intl.getMessage('obs_zoom_reset')}
                                        </button>
                                    </div>
                                </div>

                                <Show when={!isVertical()}>
                                    <Show
                                        when={isDefaultViewport()}
                                        fallback={
                                            <div class={s.stageHeadersZoomed}>
                                                <For each={activeStages()}>
                                                    {(st, i) => {
                                                        const count = () => activeStages().length;
                                                        const padX = 8;
                                                        const nodeW = 14;
                                                        const along = () => Math.max(240, svgWidth() - padX * 2);
                                                        const step = () =>
                                                            count() > 1 ? (along() - nodeW) / (count() - 1) : 0;
                                                        const leftPx = () => {
                                                            const vp = viewport();
                                                            const idx = i();
                                                            const baseX =
                                                                idx === 0
                                                                    ? padX
                                                                    : idx === count() - 1
                                                                      ? padX + idx * step() + nodeW
                                                                      : padX + idx * step() + nodeW / 2;
                                                            return baseX * vp.scale + vp.tx;
                                                        };
                                                        const txPct = () => {
                                                            const idx = i();
                                                            if (idx === 0) return '0%';
                                                            if (idx === count() - 1) return '-100%';
                                                            return '-50%';
                                                        };

                                                        return (
                                                            <span
                                                                class={s.stageHeaderPinned}
                                                                style={{
                                                                    left: `${leftPx()}px`,
                                                                    transform: `translateX(${txPct()})`,
                                                                }}
                                                            >
                                                                {stageLabel(st)}
                                                            </span>
                                                        );
                                                    }}
                                                </For>
                                            </div>
                                        }
                                    >
                                        <div class={s.stageHeaders}>
                                            <For each={activeStages()}>
                                                {(st) => (
                                                    <span class={s.stageHeader}>{stageLabel(st)}</span>
                                                )}
                                            </For>
                                        </div>
                                    </Show>
                                </Show>

                                <div class={s.svgContainer}>
                                    <div
                                        ref={svgViewportEl}
                                        class={cn(s.svgViewport, {
                                            [s.svgPannable]: viewport().scale > 1,
                                            [s.svgPanning]: isPanning(),
                                        })}
                                        tabIndex={0}
                                        data-testid="flow-svg-viewport"
                                        onWheel={handleWheel}
                                        onPointerDown={handlePointerDown}
                                        onPointerMove={handlePointerMove}
                                        onPointerUp={handlePointerEnd}
                                        onPointerCancel={handlePointerEnd}
                                        onKeyDown={handleViewportKeyDown}
                                    >
                                        <svg
                                            width="100%"
                                            height={diagramHeight()}
                                            viewBox={`0 0 ${svgWidth()} ${diagramHeight()}`}
                                            class={s.svg}
                                        >
                                            <g
                                                data-testid="flow-zoom-group"
                                                transform={`translate(${viewport().tx}, ${viewport().ty}) scale(${viewport().scale}) ${isVertical() ? 'translate(4, 12)' : 'translate(8, 6)'}`}
                                            >
                                            <For each={sankey()?.links ?? []}>
                                                {(link) => {
                                                    const src = () => nodeById().get(link.source);
                                                    const dst = () => nodeById().get(link.target);
                                                    const stroke = () =>
                                                        link.failure
                                                            ? 'var(--obs-error)'
                                                            : src()
                                                              ? nodeColor(src() as PlacedNode)
                                                              : 'var(--obs-other)';
                                                    const dimmed = () => isLinkDimmed(link);
                                                    const selected = () =>
                                                        src() && dst()
                                                            ? isLinkSelected(
                                                                  flowFilter(),
                                                                  src() as PlacedNode,
                                                                  dst() as PlacedNode,
                                                                  groupBy(),
                                                              )
                                                            : false;
                                                    const srcLabel = () => src()?.label ?? link.source;
                                                    const dstLabel = () => dst()?.label ?? link.target;

                                                    return (
                                                        <path
                                                            d={link.d}
                                                            fill="none"
                                                            stroke={stroke()}
                                                            stroke-width={Math.max(1.5, link.width)}
                                                            stroke-opacity={
                                                                dimmed()
                                                                    ? 0.12
                                                                    : selected()
                                                                      ? 0.72
                                                                      : 0.45
                                                            }
                                                            class={s.linkPath}
                                                            role="button"
                                                            tabIndex={0}
                                                            aria-label={intl.getMessage('obs_link_aria', {
                                                                source: srcLabel(),
                                                                target: dstLabel(),
                                                                count: link.count.toLocaleString(),
                                                            })}
                                                            onClick={() => drillLink(link)}
                                                            onKeyDown={(e) => {
                                                                if (e.key === 'Enter' || e.key === ' ') {
                                                                    e.preventDefault();
                                                                    drillLink(link);
                                                                }
                                                            }}
                                                            onMouseEnter={(e) => {
                                                                setHoverLink(link);
                                                                setHoverNodeId(null);
                                                                updateTip(e);
                                                            }}
                                                            onMouseMove={updateTip}
                                                            onMouseLeave={() => {
                                                                setHoverLink(null);
                                                                setTipPos(null);
                                                            }}
                                                        />
                                                    );
                                                }}
                                            </For>

                                            <For each={sankey()?.nodes ?? []}>
                                                {(node) => {
                                                    const isRightEdge = () =>
                                                        !isVertical() &&
                                                        node.col === activeStages().length - 1;
                                                    const labelX = () =>
                                                        isVertical()
                                                            ? node.x + node.w / 2
                                                            : isRightEdge()
                                                              ? node.x - 6 / zoomScale()
                                                              : node.x + node.w + 6 / zoomScale();
                                                    const labelY = () =>
                                                        isVertical()
                                                            ? node.y + node.h + 12 / zoomScale()
                                                            : node.y + node.h / 2;
                                                    const anchor = () =>
                                                        isVertical()
                                                            ? 'middle'
                                                            : isRightEdge()
                                                              ? 'end'
                                                              : 'start';
                                                    const showLabel = () =>
                                                        isVertical()
                                                            ? node.w * viewport().scale >= 40
                                                            : node.h * viewport().scale >= 14;
                                                    const selected = () =>
                                                        isNodeSelected(flowFilter(), node, groupBy());

                                                    return (
                                                        <g
                                                            class={cn(s.nodeGroup, {
                                                                [s.nodeSelected]: selected(),
                                                            })}
                                                            opacity={isNodeDimmed(node) ? 0.28 : 1}
                                                            role="button"
                                                            tabIndex={0}
                                                            aria-pressed={selected()}
                                                            aria-label={intl.getMessage('obs_node_aria', {
                                                                name: node.label,
                                                                count: node.count.toLocaleString(),
                                                            })}
                                                            onClick={() => drillNode(node)}
                                                            onKeyDown={(e) => {
                                                                if (e.key === 'Enter' || e.key === ' ') {
                                                                    e.preventDefault();
                                                                    drillNode(node);
                                                                }
                                                            }}
                                                            onMouseEnter={(e) => {
                                                                setHoverNodeId(node.id);
                                                                setHoverLink(null);
                                                                updateTip(e);
                                                            }}
                                                            onMouseMove={updateTip}
                                                            onMouseLeave={() => {
                                                                setHoverNodeId(null);
                                                                setTipPos(null);
                                                            }}
                                                        >
                                                            <rect
                                                                x={node.x}
                                                                y={node.y}
                                                                width={Math.max(2, node.w)}
                                                                height={Math.max(2, node.h)}
                                                                rx={3}
                                                                fill={nodeColor(node)}
                                                            />
                                                            <Show when={showLabel()}>
                                                                <text
                                                                    x={labelX()}
                                                                    y={labelY()}
                                                                    text-anchor={anchor()}
                                                                    dominant-baseline="middle"
                                                                    font-size={`${12 / zoomScale()}px`}
                                                                    class={s.nodeLabel}
                                                                >
                                                                    {node.label} (
                                                                    {formatCompactCount(node.count)})
                                                                </text>
                                                            </Show>
                                                        </g>
                                                    );
                                                }}
                                            </For>
                                        </g>
                                    </svg>
                                </div>

                                    <Show when={tooltipText() && tipPos()}>
                                        <div
                                            class={s.tooltip}
                                            style={{
                                                left: `${tipPos()?.x ?? 0}px`,
                                                top: `${tipPos()?.y ?? 0}px`,
                                            }}
                                        >
                                            {tooltipText()}
                                        </div>
                                    </Show>
                                </div>
                            </Show>
                        </Show>
                    </Show>

                    <Show when={!hasFilter() && !inspectAll() && (observabilityState.flow?.total ?? 0) > 0}>
                        <div class={s.hintBar}>
                            <span class={s.hintText}>{intl.getMessage('obs_drilldown_hint')}</span>
                            <div class={s.hintActions}>
                                <Button
                                    size="very-small"
                                    variant="secondary"
                                    onClick={() => applyFilterPatch({ status: 'blocked' }, false)}
                                >
                                    {intl.getMessage('obs_inspect_blocked')}
                                </Button>
                                <Button
                                    size="very-small"
                                    variant="ghost"
                                    onClick={() => setInspectAll(true)}
                                >
                                    {intl.getMessage('obs_inspect_all')}
                                </Button>
                            </div>
                        </div>
                    </Show>
                </div>

                <Show when={hasFilter() || inspectAll()}>
                    <div class={s.card} data-testid="flow-drilldown-panel">
                        <div class={s.inspectorHeader}>
                            <div class={s.inspectorTitleRow}>
                                <h2 class={cn(theme.title.h5, s.inspectorTitle)}>
                                    {intl.getMessage('obs_drilldown_title')}
                                </h2>
                                <Show when={details()}>
                                    {(d) => (
                                        <div class={s.inspectorBadges}>
                                            <span class={s.totalBadge}>
                                                {intl.getMessage('obs_matching_queries')}:{' '}
                                                {d().total.toLocaleString()}
                                            </span>
                                            <Show when={d().blocked > 0}>
                                                <span class={cn(s.totalBadge, s.blockedBadge)}>
                                                    {intl.getMessage('obs_blocked')}:{' '}
                                                    {d().blocked.toLocaleString()} (
                                                    {formatPercent(d().blocked, d().total)})
                                                </span>
                                            </Show>
                                        </div>
                                    )}
                                </Show>
                            </div>

                            <div class={s.inspectorControls}>
                                <Input
                                    class={s.drillSearchInput}
                                    size="small"
                                    value={drillSearch()}
                                    onInput={(e: Event) =>
                                        setDrillSearch((e.target as HTMLInputElement).value)
                                    }
                                    placeholder={intl.getMessage(
                                        'obs_drilldown_search_placeholder',
                                    )}
                                    isClearable
                                    onClear={() => setDrillSearch('')}
                                />
                                <Button
                                    size="very-small"
                                    variant="secondary"
                                    onClick={() => openQueryLogForFilter()}
                                >
                                    {intl.getMessage('obs_open_query_log')}
                                </Button>
                                <Button
                                    size="very-small"
                                    variant="ghost"
                                    onClick={handleClearAllFilters}
                                >
                                    {intl.getMessage('obs_clear_filters')}
                                </Button>
                            </div>
                        </div>

                        <Show when={filteredRules().length > 0}>
                            <div class={s.rulesRow}>
                                <span class={s.rulesLabel}>
                                    {intl.getMessage('obs_top_rules')}:
                                </span>
                                <div class={s.rulesChips}>
                                    <For each={filteredRules().slice(0, 10)}>
                                        {(rule) => (
                                            <button
                                                type="button"
                                                class={cn(s.ruleChip, {
                                                    [s.ruleChipActive]:
                                                        flowFilter().rule === rule.rule,
                                                })}
                                                onClick={() =>
                                                    applyFilterPatch({ rule: rule.rule }, true)
                                                }
                                            >
                                                <Show when={rule.filter_list}>
                                                    <span class={s.chipKey}>
                                                        {rule.filter_list}:
                                                    </span>
                                                </Show>
                                                <code class={s.ruleCode}>{rule.rule}</code>
                                                <span class={s.ruleCount}>
                                                    ({rule.count.toLocaleString()})
                                                </span>
                                            </button>
                                        )}
                                    </For>
                                </div>
                            </div>
                        </Show>

                        <div class={s.inspectorTabs} role="tablist">
                            <button
                                type="button"
                                role="tab"
                                aria-selected={inspectorTab() === 'hierarchy'}
                                class={cn(s.tabBtn, {
                                    [s.tabActive]: inspectorTab() === 'hierarchy',
                                })}
                                onClick={() => setInspectorTab('hierarchy')}
                            >
                                {intl.getMessage('obs_hierarchy_tab')}
                            </button>
                            <button
                                type="button"
                                role="tab"
                                aria-selected={inspectorTab() === 'domains'}
                                class={cn(s.tabBtn, {
                                    [s.tabActive]: inspectorTab() === 'domains',
                                })}
                                onClick={() => setInspectorTab('domains')}
                            >
                                {intl.getMessage('obs_domains_urls')} ({filteredDomains().length})
                            </button>
                            <button
                                type="button"
                                role="tab"
                                aria-selected={inspectorTab() === 'services'}
                                class={cn(s.tabBtn, {
                                    [s.tabActive]: inspectorTab() === 'services',
                                })}
                                onClick={() => setInspectorTab('services')}
                            >
                                {intl.getMessage('obs_services')} ({filteredServices().length})
                            </button>
                            <button
                                type="button"
                                role="tab"
                                aria-selected={inspectorTab() === 'devices'}
                                class={cn(s.tabBtn, {
                                    [s.tabActive]: inspectorTab() === 'devices',
                                })}
                                onClick={() => setInspectorTab('devices')}
                            >
                                {intl.getMessage('obs_devices')} ({filteredClients().length})
                            </button>
                            <button
                                type="button"
                                role="tab"
                                aria-selected={inspectorTab() === 'recent'}
                                class={cn(s.tabBtn, {
                                    [s.tabActive]: inspectorTab() === 'recent',
                                })}
                                onClick={() => setInspectorTab('recent')}
                            >
                                {intl.getMessage('obs_recent_queries')} ({filteredRecent().length})
                            </button>
                        </div>

                        <Show
                            when={!observabilityState.loadingFlowDetails || details() !== null}
                            fallback={
                                <div class={s.loader}>
                                    <Loader />
                                </div>
                            }
                        >
                            <Show
                                when={(details()?.total ?? 0) > 0}
                                fallback={
                                    <div class={s.empty}>
                                        {intl.getMessage('obs_drilldown_empty')}
                                    </div>
                                }
                            >
                                <Show when={inspectorTab() === 'hierarchy'}>
                                    <FlowTreePanel
                                        tuples={details()?.tuples ?? []}
                                        total={details()?.total ?? 0}
                                        search={drillSearch()}
                                        onDrill={(k, v) =>
                                            applyFilterPatch({ [k]: v }, true)
                                        }
                                        onOpenQueryLog={(override) =>
                                            openQueryLogForFilter(override)
                                        }
                                        onOpenHeatmap={(kind, key) =>
                                            openHeatmapForKey(kind, key)
                                        }
                                    />
                                </Show>

                                <Show when={inspectorTab() === 'domains'}>
                                    <div class={s.tableWrap}>
                                        <table class={s.table}>
                                            <thead>
                                                <tr>
                                                    <th>{intl.getMessage('obs_domain')}</th>
                                                    <th>{intl.getMessage('obs_services')}</th>
                                                    <th>{intl.getMessage('obs_rule_reason')}</th>
                                                    <th class={s.numCol}>
                                                        {intl.getMessage('obs_devices')}
                                                    </th>
                                                    <th class={s.numCol}>
                                                        {intl.getMessage('obs_blocked')}
                                                    </th>
                                                    <th class={s.numCol}>
                                                        {intl.getMessage('obs_total_queries')}
                                                    </th>
                                                    <th />
                                                </tr>
                                            </thead>
                                            <tbody>
                                                <For each={filteredDomains()}>
                                                    {(dom) => {
                                                        const svcName = () =>
                                                            resolveDomainServiceLabel(dom);
                                                        const isFocused = () =>
                                                            flowFilter().domain?.toLowerCase() ===
                                                            dom.domain.toLowerCase();
                                                        const action = () =>
                                                            resolveDomainBlockAction(
                                                                filteringState.userRules || '',
                                                                dom.domain,
                                                                dom.blocked,
                                                            );

                                                        return (
                                                            <tr
                                                                class={cn({
                                                                    [s.selectedRow]: isFocused(),
                                                                })}
                                                            >
                                                                <td>
                                                                    <button
                                                                        type="button"
                                                                        class={s.domainBtn}
                                                                        onClick={() =>
                                                                            applyFilterPatch(
                                                                                {
                                                                                    domain: dom.domain,
                                                                                },
                                                                                true,
                                                                            )
                                                                        }
                                                                    >
                                                                        {dom.domain}
                                                                    </button>
                                                                    <Show when={(dom.qtypes ?? []).length > 0}>
                                                                        <div class={s.qtypesInline}>
                                                                            <For each={(dom.qtypes ?? []).slice(0, 3)}>
                                                                                {(qt) => (
                                                                                    <span class={s.reasonPill}>
                                                                                        {qt}
                                                                                    </span>
                                                                                )}
                                                                            </For>
                                                                        </div>
                                                                    </Show>
                                                                </td>
                                                                <td>
                                                                    <Show
                                                                        when={svcName()}
                                                                        fallback="—"
                                                                    >
                                                                        <span class={s.svcPill}>
                                                                            {svcName()}
                                                                        </span>
                                                                    </Show>
                                                                </td>
                                                                <td>
                                                                    <Show when={dom.filter_list}>
                                                                        <span class={s.subMeta}>
                                                                            {dom.filter_list}
                                                                        </span>
                                                                    </Show>
                                                                    <Show when={dom.rule}>
                                                                        <code class={s.ruleCode}>
                                                                            {dom.rule}
                                                                        </code>
                                                                    </Show>
                                                                    <Show
                                                                        when={
                                                                            !dom.rule &&
                                                                            dom.reason &&
                                                                            dom.reason !==
                                                                                'NotFilteredNotFound'
                                                                        }
                                                                    >
                                                                        <span class={s.reasonPill}>
                                                                            {dom.reason}
                                                                        </span>
                                                                    </Show>
                                                                    <Show
                                                                        when={
                                                                            !dom.rule &&
                                                                            (!dom.reason ||
                                                                                dom.reason ===
                                                                                    'NotFilteredNotFound')
                                                                        }
                                                                    >
                                                                        —
                                                                    </Show>
                                                                </td>
                                                                <td class={s.numCol}>
                                                                    {dom.clients.toLocaleString()}
                                                                </td>
                                                                <td
                                                                    class={cn(s.numCol, {
                                                                        [s.failText]:
                                                                            dom.blocked > 0,
                                                                    })}
                                                                >
                                                                    {dom.blocked.toLocaleString()}
                                                                </td>
                                                                <td class={s.numCol}>
                                                                    {dom.count.toLocaleString()}
                                                                </td>
                                                                <td class={s.actionsCol}>
                                                                    <button
                                                                        type="button"
                                                                        disabled={
                                                                            busyActionKey() ===
                                                                            `domain:${dom.domain}`
                                                                        }
                                                                        class={cn(
                                                                            s.inlineActionBtn,
                                                                            action() === 'allow'
                                                                                ? s.allowActionBtn
                                                                                : s.blockActionBtn,
                                                                        )}
                                                                        onClick={() =>
                                                                            void handleDomainBlockToggle(
                                                                                dom.domain,
                                                                                action(),
                                                                            )
                                                                        }
                                                                    >
                                                                        {action() === 'allow'
                                                                            ? intl.getMessage(
                                                                                  'obs_action_allow',
                                                                              )
                                                                            : intl.getMessage(
                                                                                  'obs_action_block',
                                                                              )}
                                                                    </button>
                                                                    <button
                                                                        type="button"
                                                                        class={s.inlineActionBtn}
                                                                        onClick={() =>
                                                                            applyFilterPatch(
                                                                                {
                                                                                    domain: dom.domain,
                                                                                },
                                                                                true,
                                                                            )
                                                                        }
                                                                    >
                                                                        {intl.getMessage(
                                                                            'obs_drill_in',
                                                                        )}
                                                                    </button>
                                                                    <button
                                                                        type="button"
                                                                        class={s.inlineActionBtn}
                                                                        onClick={() =>
                                                                            openQueryLogForFilter({
                                                                                search: dom.domain,
                                                                            })
                                                                        }
                                                                    >
                                                                        {intl.getMessage(
                                                                            'obs_open_query_log',
                                                                        )}
                                                                    </button>
                                                                    <button
                                                                        type="button"
                                                                        class={s.inlineActionBtn}
                                                                        onClick={() =>
                                                                            openHeatmapForKey(
                                                                                'domain',
                                                                                dom.domain,
                                                                            )
                                                                        }
                                                                    >
                                                                        {intl.getMessage(
                                                                            'obs_open_heatmap',
                                                                        )}
                                                                    </button>
                                                                </td>
                                                            </tr>
                                                        );
                                                    }}
                                                </For>
                                            </tbody>
                                        </table>
                                    </div>
                                </Show>

                                <Show when={inspectorTab() === 'services'}>
                                    <div class={s.tableWrap}>
                                        <table class={s.table}>
                                            <thead>
                                                <tr>
                                                    <th>{intl.getMessage('obs_services')}</th>
                                                    <th>{intl.getMessage('obs_domains_urls')}</th>
                                                    <th class={s.numCol}>
                                                        {intl.getMessage('obs_blocked')}
                                                    </th>
                                                    <th class={s.numCol}>
                                                        {intl.getMessage('obs_total_queries')}
                                                    </th>
                                                    <th class={s.numCol}>
                                                        {intl.getMessage('obs_share')}
                                                    </th>
                                                    <th />
                                                </tr>
                                            </thead>
                                            <tbody>
                                                <For each={filteredServices()}>
                                                    {(svc) => {
                                                        const isCatalog = () =>
                                                            svc.service &&
                                                            !svc.id.startsWith('site:');
                                                        const svcBlocked = () =>
                                                            blockedServiceIds().has(svc.id);

                                                        return (
                                                            <tr>
                                                                <td>
                                                                    <div class={s.svcCell}>
                                                                        <button
                                                                            type="button"
                                                                            class={s.domainBtn}
                                                                            onClick={() =>
                                                                                applyFilterPatch(
                                                                                    {
                                                                                        service:
                                                                                            svc.id,
                                                                                    },
                                                                                    true,
                                                                                )
                                                                            }
                                                                        >
                                                                            {svc.label}
                                                                        </button>
                                                                        <span
                                                                            class={cn(s.kindBadge, {
                                                                                [s.kindService]:
                                                                                    svc.service,
                                                                            })}
                                                                        >
                                                                            {svc.service
                                                                                ? intl.getMessage(
                                                                                      'obs_service_badge',
                                                                                  )
                                                                                : intl.getMessage(
                                                                                      'obs_site_badge',
                                                                                  )}
                                                                        </span>
                                                                    </div>
                                                                </td>
                                                                <td>
                                                                    <div class={s.memberChips}>
                                                                        <For
                                                                            each={svc.members.slice(
                                                                                0,
                                                                                5,
                                                                            )}
                                                                        >
                                                                            {(m) => (
                                                                                <button
                                                                                    type="button"
                                                                                    class={cn(
                                                                                        s.memberBtn,
                                                                                        {
                                                                                            [s.memberBlocked]:
                                                                                                m.blocked >
                                                                                                0,
                                                                                        },
                                                                                    )}
                                                                                    onClick={() =>
                                                                                        applyFilterPatch(
                                                                                            {
                                                                                                domain: m.domain,
                                                                                            },
                                                                                            true,
                                                                                        )
                                                                                    }
                                                                                >
                                                                                    {m.domain} (
                                                                                    {m.count})
                                                                                </button>
                                                                            )}
                                                                        </For>
                                                                        <Show
                                                                            when={
                                                                                svc.members.length >
                                                                                5
                                                                            }
                                                                        >
                                                                            <span
                                                                                class={s.memberMore}
                                                                            >
                                                                                {intl.getMessage(
                                                                                    'obs_members_more',
                                                                                    {
                                                                                        count:
                                                                                            svc
                                                                                                .members
                                                                                                .length -
                                                                                            5,
                                                                                    },
                                                                                )}
                                                                            </span>
                                                                        </Show>
                                                                    </div>
                                                                </td>
                                                                <td
                                                                    class={cn(s.numCol, {
                                                                        [s.failText]:
                                                                            svc.blocked > 0,
                                                                    })}
                                                                >
                                                                    {svc.blocked.toLocaleString()}
                                                                </td>
                                                                <td class={s.numCol}>
                                                                    {svc.count.toLocaleString()}
                                                                </td>
                                                                <td class={s.numCol}>
                                                                    {formatPercent(
                                                                        svc.count,
                                                                        details()?.total ?? 0,
                                                                    )}
                                                                </td>
                                                                <td class={s.actionsCol}>
                                                                    <Show when={isCatalog()}>
                                                                        <button
                                                                            type="button"
                                                                            disabled={
                                                                                busyActionKey() ===
                                                                                `service:${svc.id}`
                                                                            }
                                                                            class={cn(
                                                                                s.inlineActionBtn,
                                                                                svcBlocked()
                                                                                    ? s.allowActionBtn
                                                                                    : s.blockActionBtn,
                                                                            )}
                                                                            onClick={() =>
                                                                                void handleServiceBlockToggle(
                                                                                    svc.id,
                                                                                    svcBlocked(),
                                                                                )
                                                                            }
                                                                        >
                                                                            {svcBlocked()
                                                                                ? intl.getMessage(
                                                                                      'obs_action_allow_service',
                                                                                  )
                                                                                : intl.getMessage(
                                                                                      'obs_action_block_service',
                                                                                  )}
                                                                        </button>
                                                                    </Show>
                                                                    <button
                                                                        type="button"
                                                                        class={s.inlineActionBtn}
                                                                        onClick={() =>
                                                                            applyFilterPatch(
                                                                                { service: svc.id },
                                                                                true,
                                                                            )
                                                                        }
                                                                    >
                                                                        {intl.getMessage(
                                                                            'obs_drill_in',
                                                                        )}
                                                                    </button>
                                                                </td>
                                                            </tr>
                                                        );
                                                    }}
                                                </For>
                                            </tbody>
                                        </table>
                                    </div>
                                </Show>

                                <Show when={inspectorTab() === 'devices'}>
                                    <div class={s.tableWrap}>
                                        <table class={s.table}>
                                            <thead>
                                                <tr>
                                                    <th>{intl.getMessage('obs_devices')}</th>
                                                    <th>{intl.getMessage('obs_filter_tag')}</th>
                                                    <th class={s.numCol}>
                                                        {intl.getMessage('obs_blocked')}
                                                    </th>
                                                    <th class={s.numCol}>
                                                        {intl.getMessage('obs_total_queries')}
                                                    </th>
                                                    <th class={s.numCol}>
                                                        {intl.getMessage('obs_share')}
                                                    </th>
                                                    <th />
                                                </tr>
                                            </thead>
                                            <tbody>
                                                <For each={filteredClients()}>
                                                    {(cli) => {
                                                        const isFocused = () =>
                                                            flowFilter().client === cli.id;
                                                        return (
                                                            <tr
                                                                class={cn({
                                                                    [s.selectedRow]: isFocused(),
                                                                })}
                                                            >
                                                                <td>
                                                                    <button
                                                                        type="button"
                                                                        class={s.domainBtn}
                                                                        onClick={() =>
                                                                            applyFilterPatch(
                                                                                { client: cli.id },
                                                                                true,
                                                                            )
                                                                        }
                                                                    >
                                                                        {cli.label}
                                                                    </button>
                                                                    <Show when={cli.label !== cli.id}>
                                                                        <span class={s.subMeta}>
                                                                            {cli.id}
                                                                        </span>
                                                                    </Show>
                                                                </td>
                                                                <td>
                                                                    <Show when={cli.tag} fallback="—">
                                                                        <span class={s.reasonPill}>
                                                                            {cli.tag}
                                                                        </span>
                                                                    </Show>
                                                                </td>
                                                                <td
                                                                    class={cn(s.numCol, {
                                                                        [s.failText]:
                                                                            cli.blocked > 0,
                                                                    })}
                                                                >
                                                                    {cli.blocked.toLocaleString()}
                                                                </td>
                                                                <td class={s.numCol}>
                                                                    {cli.count.toLocaleString()}
                                                                </td>
                                                                <td class={s.numCol}>
                                                                    {formatPercent(
                                                                        cli.count,
                                                                        details()?.total ?? 0,
                                                                    )}
                                                                </td>
                                                                <td class={s.actionsCol}>
                                                                    <button
                                                                        type="button"
                                                                        class={s.inlineActionBtn}
                                                                        onClick={() =>
                                                                            applyFilterPatch(
                                                                                { client: cli.id },
                                                                                true,
                                                                            )
                                                                        }
                                                                    >
                                                                        {intl.getMessage(
                                                                            'obs_drill_in',
                                                                        )}
                                                                    </button>
                                                                    <button
                                                                        type="button"
                                                                        class={s.inlineActionBtn}
                                                                        onClick={() =>
                                                                            openQueryLogForFilter({
                                                                                search: cli.id,
                                                                            })
                                                                        }
                                                                    >
                                                                        {intl.getMessage(
                                                                            'obs_open_query_log',
                                                                        )}
                                                                    </button>
                                                                    <button
                                                                        type="button"
                                                                        class={s.inlineActionBtn}
                                                                        onClick={() =>
                                                                            openHeatmapForKey(
                                                                                'client',
                                                                                cli.id,
                                                                            )
                                                                        }
                                                                    >
                                                                        {intl.getMessage(
                                                                            'obs_open_heatmap',
                                                                        )}
                                                                    </button>
                                                                </td>
                                                            </tr>
                                                        );
                                                    }}
                                                </For>
                                            </tbody>
                                        </table>
                                    </div>
                                </Show>

                                <Show when={inspectorTab() === 'recent'}>
                                    <div class={s.tableWrap}>
                                        <table class={s.table}>
                                            <thead>
                                                <tr>
                                                    <th>{intl.getMessage('obs_time')}</th>
                                                    <th>{intl.getMessage('obs_devices')}</th>
                                                    <th>{intl.getMessage('obs_domain')}</th>
                                                    <th>{intl.getMessage('obs_stage_qtype')}</th>
                                                    <th>{intl.getMessage('obs_status')}</th>
                                                    <th>{intl.getMessage('obs_rule_reason')}</th>
                                                    <th>{intl.getMessage('obs_stage_upstream')}</th>
                                                    <th class={s.numCol}>
                                                        {intl.getMessage('obs_latency')}
                                                    </th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                <For each={filteredRecent()}>
                                                    {(q) => (
                                                        <tr>
                                                            <td class={s.monoCell}>
                                                                {formatRecentTime(q.time)}
                                                            </td>
                                                            <td>{q.client_name || q.client}</td>
                                                            <td>
                                                                <button
                                                                    type="button"
                                                                    class={s.domainBtn}
                                                                    onClick={() =>
                                                                        applyFilterPatch(
                                                                            { domain: q.domain },
                                                                            true,
                                                                        )
                                                                    }
                                                                >
                                                                    {q.domain}
                                                                </button>
                                                            </td>
                                                            <td class={s.monoCell}>
                                                                {q.qtype || '—'}
                                                            </td>
                                                            <td>
                                                                <span
                                                                    class={cn(s.statusTag, {
                                                                        [s.statusBlocked]:
                                                                            q.status === 'blocked',
                                                                        [s.statusError]:
                                                                            q.status === 'error' ||
                                                                            q.rcode === 'SERVFAIL',
                                                                    })}
                                                                >
                                                                    {q.status}
                                                                    <Show when={q.rcode}>
                                                                        {' '}
                                                                        ({q.rcode})
                                                                    </Show>
                                                                </span>
                                                            </td>
                                                            <td>
                                                                <Show when={q.filter_list && q.filter_list !== 'None'}>
                                                                    <span class={s.subMeta}>
                                                                        {q.filter_list}
                                                                    </span>
                                                                </Show>
                                                                <Show when={q.rule}>
                                                                    <code class={s.ruleCode}>
                                                                        {q.rule}
                                                                    </code>
                                                                </Show>
                                                                <Show
                                                                    when={
                                                                        !q.rule &&
                                                                        (q.service_name || q.service)
                                                                    }
                                                                >
                                                                    <span class={s.svcPill}>
                                                                        {q.service_name ||
                                                                            q.service}
                                                                    </span>
                                                                </Show>
                                                                <Show
                                                                    when={
                                                                        !q.rule &&
                                                                        !q.service_name &&
                                                                        !q.service &&
                                                                        q.reason &&
                                                                        q.reason !==
                                                                            'NotFilteredNotFound'
                                                                    }
                                                                >
                                                                    <span class={s.reasonPill}>
                                                                        {q.reason}
                                                                    </span>
                                                                </Show>
                                                                <Show
                                                                    when={
                                                                        !q.rule &&
                                                                        !q.service_name &&
                                                                        !q.service &&
                                                                        (!q.reason ||
                                                                            q.reason ===
                                                                                'NotFilteredNotFound')
                                                                    }
                                                                >
                                                                    —
                                                                </Show>
                                                            </td>
                                                            <td class={s.monoCell}>
                                                                {q.upstream || '—'}
                                                            </td>
                                                            <td class={s.numCol}>
                                                                {formatLatencyBound(q.latency_us)}
                                                            </td>
                                                        </tr>
                                                    )}
                                                </For>
                                            </tbody>
                                        </table>
                                    </div>
                                </Show>
                            </Show>
                        </Show>
                    </div>
                </Show>
            </div>
        </div>
    );
};
