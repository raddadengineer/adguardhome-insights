import {
    createSignal,
    createMemo,
    createEffect,
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
import { Loader } from 'panel/common/ui/Loader';
import { RoutePath, linkPathBuilder } from 'panel/components/Routes/Paths';
import { observabilityState, fetchTrafficMap } from 'panel/stores/observability';
import { servicesState, getAllBlockedServices } from 'panel/stores/services';
import type { StatsTrafficMapWindow } from 'panel/api/model/statsTrafficMapWindow';
import { LocalStorageHelper, LOCAL_STORAGE_KEYS } from 'panel/helpers/localStorageHelper';
import {
    squarify,
    extractServiceMap,
    buildTrafficTiles,
    type TrafficMapMode,
    type TrafficMapShow,
    type TrafficTile,
} from 'panel/helpers/observability/treemap';
import { formatPercent, formatCompactCount } from 'panel/helpers/observability/sankey';

import s from './TrafficMapPage.module.pcss';

const MODES: readonly TrafficMapMode[] = ['service', 'site', 'name'];
const SHOWS: readonly TrafficMapShow[] = ['all', 'allowed', 'blocked'];
const WINDOWS: readonly StatsTrafficMapWindow[] = [
    'current_hour',
    'prev_hour',
    '24h',
    '7d',
    '30d',
];

function getInitialMode(): TrafficMapMode {
    const stored = LocalStorageHelper.getItem<string>(LOCAL_STORAGE_KEYS.TRAFFIC_MAP_MODE);
    return MODES.includes(stored as TrafficMapMode) ? (stored as TrafficMapMode) : 'service';
}

function normalizeWindow(raw: string | undefined): StatsTrafficMapWindow {
    return WINDOWS.includes(raw as StatsTrafficMapWindow)
        ? (raw as StatsTrafficMapWindow)
        : 'current_hour';
}

export const TrafficMapPage = () => {
    const navigate = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams<{ window?: string }>();
    const win = createMemo<StatsTrafficMapWindow>(() => normalizeWindow(searchParams.window));

    const [mode, setMode] = createSignal<TrafficMapMode>(getInitialMode());
    const [show, setShow] = createSignal<TrafficMapShow>('all');
    const [live, setLive] = createSignal(true);
    const [showTable, setShowTable] = createSignal(false);
    const [selectedTile, setSelectedTile] = createSignal<TrafficTile | null>(null);
    const [boxSize, setBoxSize] = createSignal<{ w: number; h: number }>({ w: 800, h: 480 });
    const [prevCounts, setPrevCounts] = createSignal<Map<string, number>>(new Map());
    const [lastWindow, setLastWindow] = createSignal<StatsTrafficMapWindow | null>(null);

    let mapEl: HTMLDivElement | undefined;
    let observer: ResizeObserver | undefined;
    let currentSnapshot = new Map<string, number>();

    onMount(() => {
        if (!servicesState.allInitialized) {
            void getAllBlockedServices();
        }
        if (mapEl && typeof ResizeObserver !== 'undefined') {
            observer = new ResizeObserver((entries) => {
                const rect = entries[0]?.contentRect;
                if (rect && rect.width > 0) {
                    setBoxSize({
                        w: Math.round(rect.width),
                        h: Math.max(360, Math.min(620, Math.round(rect.width * 0.52))),
                    });
                }
            });
            observer.observe(mapEl);
        }
    });

    onCleanup(() => {
        observer?.disconnect();
    });

    createEffect(() => {
        LocalStorageHelper.setItem(LOCAL_STORAGE_KEYS.TRAFFIC_MAP_MODE, mode());
    });

    // Capture previous refresh counts to compute live deltas on `current_hour`.
    createEffect(() => {
        const data = observabilityState.trafficMap;
        if (!data) {
            return;
        }
        const curWin = data.window as StatsTrafficMapWindow;
        if (curWin === 'current_hour' && lastWindow() === 'current_hour') {
            setPrevCounts(new Map(currentSnapshot));
        } else {
            setPrevCounts(new Map());
        }

        const next = new Map<string, number>();
        for (const item of data.allowed) {
            next.set(`allowed:${item.domain}`, item.count);
        }
        for (const item of data.blocked) {
            next.set(`blocked:${item.domain}`, item.count);
        }
        currentSnapshot = next;
        setLastWindow(curWin);
    });

    createEffect(() => {
        const w = win();
        const isLive = live() && w === 'current_hour';

        void fetchTrafficMap({ window: w, limit: 120 });

        if (!isLive) {
            return;
        }

        const timer = window.setInterval(() => {
            void fetchTrafficMap({ window: w, limit: 120 }, true);
        }, 5_000);

        onCleanup(() => {
            window.clearInterval(timer);
        });
    });

    const serviceMap = createMemo(() => extractServiceMap(servicesState.allServices ?? []));

    const tiles = createMemo(() => {
        const data = observabilityState.trafficMap;
        if (!data) {
            return [];
        }
        return buildTrafficTiles(
            data.allowed,
            data.blocked,
            mode(),
            show(),
            serviceMap(),
            prevCounts(),
            5,
        );
    });

    const totalCount = createMemo(() => tiles().reduce((acc, t) => acc + t.count, 0));

    const rects = createMemo(() => {
        const list = tiles();
        const { w, h } = boxSize();
        return squarify(
            list.map((t) => t.count),
            w,
            h,
        );
    });

    const modeLabel = (m: TrafficMapMode): string => {
        switch (m) {
            case 'service':
                return intl.getMessage('obs_mode_service');
            case 'site':
                return intl.getMessage('obs_mode_site');
            case 'name':
                return intl.getMessage('obs_mode_name');
        }
    };

    const showLabel = (v: TrafficMapShow): string => {
        switch (v) {
            case 'all':
                return intl.getMessage('obs_filter_all');
            case 'allowed':
                return intl.getMessage('obs_filter_allowed');
            case 'blocked':
                return intl.getMessage('obs_filter_blocked');
        }
    };

    const winLabel = (w: StatsTrafficMapWindow): string => {
        switch (w) {
            case 'current_hour':
                return intl.getMessage('obs_current_hour');
            case 'prev_hour':
                return intl.getMessage('obs_prev_hour');
            case '24h':
                return intl.getMessage('obs_window_24h');
            case '7d':
                return intl.getMessage('obs_window_7d');
            case '30d':
                return intl.getMessage('obs_window_30d');
        }
    };

    const primaryDomain = (tile: TrafficTile): string => tile.members[0]?.domain ?? tile.label;

    const openQueryLog = (tile: TrafficTile) => {
        navigate(linkPathBuilder(RoutePath.Logs, undefined, { search: primaryDomain(tile) }));
    };

    const openHeatmap = (tile: TrafficTile) => {
        navigate(
            linkPathBuilder(RoutePath.Heatmap, undefined, {
                kind: 'domain',
                key: primaryDomain(tile),
            }),
        );
    };

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
                            currentTitle={intl.getMessage('obs_traffic_map_title')}
                        />
                        <div class={s.titleRow}>
                            <h1 class={cn(theme.title.h4, theme.title.h3_tablet, s.title)}>
                                {intl.getMessage('obs_traffic_map_title')}
                            </h1>
                            <Show when={totalCount() > 0}>
                                <span class={s.totalBadge}>
                                    {intl.getMessage('obs_total_queries')}:{' '}
                                    {totalCount().toLocaleString()}
                                </span>
                            </Show>
                        </div>
                    </div>

                    <div class={s.toolbar}>
                        <div class={s.segmented} role="group">
                            <For each={MODES}>
                                {(m) => (
                                    <button
                                        type="button"
                                        class={cn(s.segBtn, { [s.segActive]: mode() === m })}
                                        onClick={() => setMode(m)}
                                    >
                                        {modeLabel(m)}
                                    </button>
                                )}
                            </For>
                        </div>

                        <div class={s.segmented} role="group">
                            <For each={SHOWS}>
                                {(v) => (
                                    <button
                                        type="button"
                                        class={cn(s.segBtn, { [s.segActive]: show() === v })}
                                        onClick={() => setShow(v)}
                                    >
                                        {showLabel(v)}
                                    </button>
                                )}
                            </For>
                        </div>

                        <div class={s.segmented} role="group">
                            <For each={WINDOWS}>
                                {(w) => (
                                    <button
                                        type="button"
                                        class={cn(s.segBtn, { [s.segActive]: win() === w })}
                                        onClick={() => setSearchParams({ window: w }, { replace: true })}
                                    >
                                        {winLabel(w)}
                                    </button>
                                )}
                            </For>
                        </div>

                        <div class={s.toggles}>
                            <Show when={win() === 'current_hour'}>
                                <button
                                    type="button"
                                    class={cn(s.toggleBtn, { [s.segActive]: live() })}
                                    aria-label={intl.getMessage('obs_live_aria')}
                                    onClick={() => setLive((prev) => !prev)}
                                >
                                    {intl.getMessage('obs_live')}
                                </button>
                            </Show>
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
                                disabled={observabilityState.loadingTrafficMap}
                                onClick={() => void fetchTrafficMap({ window: win(), limit: 120 })}
                            >
                                <Icon icon="refresh" class={s.refreshIcon} />
                            </Button>
                        </div>
                    </div>
                </div>

                <div class={s.legendRow}>
                    <span class={s.legendItem}>
                        <span class={cn(s.swatch, s.swatchAllowed)} />
                        {intl.getMessage('obs_allowed')}
                    </span>
                    <span class={s.legendItem}>
                        <span class={cn(s.swatch, s.swatchBlocked)} />
                        {intl.getMessage('obs_blocked')}
                    </span>
                    <span class={s.legendItem}>
                        <span class={cn(s.swatch, s.swatchHot)} />
                        {intl.getMessage('obs_growing_now')}
                    </span>
                </div>

                <Show when={selectedTile()}>
                    {(tile) => (
                        <div class={s.inspector}>
                            <div class={s.inspectorMeta}>
                                <strong>{tile().label}</strong>
                                <span
                                    class={cn(s.statusPill, {
                                        [s.statusBlocked]: tile().status === 'blocked',
                                    })}
                                >
                                    {tile().status === 'blocked'
                                        ? intl.getMessage('obs_blocked')
                                        : intl.getMessage('obs_allowed')}
                                </span>
                                <span>
                                    {intl.getPlural('obs_queries_count', tile().count, {
                                        count: tile().count.toLocaleString(),
                                    })}{' '}
                                    ({formatPercent(tile().count, totalCount())})
                                </span>
                                <Show when={tile().delta > 0}>
                                    <span class={s.deltaPill}>+{tile().delta}</span>
                                </Show>
                            </div>
                            <div class={s.membersLine}>
                                <For each={tile().members.slice(0, 4)}>
                                    {(m) => (
                                        <span class={s.memberChip}>
                                            {m.domain} ({m.count})
                                        </span>
                                    )}
                                </For>
                                <Show when={tile().members.length > 4}>
                                    <span class={s.memberMore}>
                                        {intl.getMessage('obs_members_more', {
                                            count: tile().members.length - 4,
                                        })}
                                    </span>
                                </Show>
                            </div>
                            <div class={s.inspectorActions}>
                                <Button
                                    size="very-small"
                                    variant="secondary"
                                    onClick={() => openQueryLog(tile())}
                                >
                                    {intl.getMessage('obs_open_query_log')}
                                </Button>
                                <Button
                                    size="very-small"
                                    variant="secondary"
                                    onClick={() => openHeatmap(tile())}
                                >
                                    {intl.getMessage('obs_open_heatmap')}
                                </Button>
                            </div>
                        </div>
                    )}
                </Show>

                <div class={s.card} ref={mapEl}>
                    <Show
                        when={
                            !observabilityState.loadingTrafficMap ||
                            observabilityState.trafficMap !== null
                        }
                        fallback={
                            <div class={s.loader}>
                                <Loader />
                            </div>
                        }
                    >
                        <Show
                            when={tiles().length > 0}
                            fallback={
                                <div class={s.empty}>{intl.getMessage('obs_empty_traffic_map')}</div>
                            }
                        >
                            <Show
                                when={!showTable()}
                                fallback={
                                    <div class={s.tableWrap}>
                                        <table class={s.table}>
                                            <thead>
                                                <tr>
                                                    <th>{intl.getMessage('obs_mode_name')}</th>
                                                    <th>{intl.getMessage('obs_status')}</th>
                                                    <th class={s.numCol}>
                                                        {intl.getMessage('obs_total_queries')}
                                                    </th>
                                                    <th class={s.numCol}>
                                                        {intl.getMessage('obs_share')}
                                                    </th>
                                                    <th class={s.numCol}>
                                                        {intl.getMessage('obs_growing_now')}
                                                    </th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                <For each={tiles()}>
                                                    {(tile) => (
                                                        <tr>
                                                            <td>
                                                                <button
                                                                    type="button"
                                                                    class={s.linkBtn}
                                                                    onClick={() => openQueryLog(tile)}
                                                                >
                                                                    {tile.label}
                                                                </button>
                                                            </td>
                                                            <td>
                                                                {tile.status === 'blocked'
                                                                    ? intl.getMessage('obs_blocked')
                                                                    : intl.getMessage('obs_allowed')}
                                                            </td>
                                                            <td class={s.numCol}>
                                                                {tile.count.toLocaleString()}
                                                            </td>
                                                            <td class={s.numCol}>
                                                                {formatPercent(
                                                                    tile.count,
                                                                    totalCount(),
                                                                )}
                                                            </td>
                                                            <td class={s.numCol}>
                                                                {tile.delta > 0 ? `+${tile.delta}` : '—'}
                                                            </td>
                                                        </tr>
                                                    )}
                                                </For>
                                            </tbody>
                                        </table>
                                    </div>
                                }
                            >
                                <div
                                    class={s.treemap}
                                    style={{ height: `${boxSize().h}px` }}
                                >
                                    <For each={tiles()}>
                                        {(tile, idx) => {
                                            const rect = () => rects()[idx()];
                                            const showDetails = () =>
                                                (rect()?.w ?? 0) >= 68 && (rect()?.h ?? 0) >= 40;
                                            const showCount = () =>
                                                (rect()?.w ?? 0) >= 52 && (rect()?.h ?? 0) >= 54;

                                            return (
                                                <button
                                                    type="button"
                                                    class={cn(s.tile, {
                                                        [s.tileBlocked]: tile.status === 'blocked',
                                                        [s.tileHot]: tile.hot,
                                                        [s.tileSelected]: selectedTile()?.id === tile.id,
                                                    })}
                                                    style={{
                                                        left: `${rect()?.x ?? 0}px`,
                                                        top: `${rect()?.y ?? 0}px`,
                                                        width: `${Math.max(0, (rect()?.w ?? 0) - 2)}px`,
                                                        height: `${Math.max(0, (rect()?.h ?? 0) - 2)}px`,
                                                    }}
                                                    aria-label={intl.getMessage('obs_tile_aria', {
                                                        name: tile.label,
                                                        count: tile.count.toLocaleString(),
                                                        share: formatPercent(tile.count, totalCount()),
                                                    })}
                                                    onMouseEnter={() => setSelectedTile(tile)}
                                                    onFocus={() => setSelectedTile(tile)}
                                                    onClick={() => openQueryLog(tile)}
                                                >
                                                    <Show when={showDetails()}>
                                                        <span class={s.tileLabel}>{tile.label}</span>
                                                    </Show>
                                                    <Show when={showCount()}>
                                                        <span class={s.tileMeta}>
                                                            {formatCompactCount(tile.count)}
                                                            <Show when={tile.delta > 0}>
                                                                <span class={s.tileDelta}>
                                                                    {' '}
                                                                    +{tile.delta}
                                                                </span>
                                                            </Show>
                                                        </span>
                                                    </Show>
                                                </button>
                                            );
                                        }}
                                    </For>
                                </div>
                            </Show>
                        </Show>
                    </Show>
                </div>
            </div>
        </div>
    );
};
