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
import { Button } from 'panel/common/ui/Button';
import { Icon } from 'panel/common/ui/Icon';
import { Input } from 'panel/common/controls/Input';
import { Loader } from 'panel/common/ui/Loader';
import { RoutePath, linkPathBuilder } from 'panel/components/Routes/Paths';
import { observabilityState, fetchHeatmap } from 'panel/stores/observability';
import { dashboardState, getClients } from 'panel/stores/dashboard';
import { statsState, getStats } from 'panel/stores/stats';
import type { StatsHeatmapWindow } from 'panel/api/model/statsHeatmapWindow';
import type { StatsHeatmapGrain } from 'panel/api/model/statsHeatmapGrain';
import type { StatsHeatmapKind } from 'panel/api/model/statsHeatmapKind';
import type { StatsHeatmapMeasure } from 'panel/api/model/statsHeatmapMeasure';
import {
    layoutHeatmap,
    heatmapGeometry,
    heatmapHeight,
    hitHeatmapCell,
    drawHeatmap,
} from 'panel/helpers/observability/heatmap';

import s from './HeatmapBlocks.module.pcss';

const WINDOWS: readonly StatsHeatmapWindow[] = ['24h', '7d', '30d', '90d'];
const KINDS: readonly StatsHeatmapKind[] = ['network', 'client', 'domain'];
const GRAINS: readonly StatsHeatmapGrain[] = ['minute', '15m', 'hour'];
const MEASURES: readonly StatsHeatmapMeasure[] = ['queries', 'blocked'];

function cssToken(name: string, fallback: string): string {
    if (typeof window === 'undefined') return fallback;
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export const ActivityHeatmap = () => {
    const navigate = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams<{
        kind?: string;
        key?: string;
        window?: string;
        grain?: string;
        measure?: string;
    }>();

    const kind = createMemo<StatsHeatmapKind>(() =>
        KINDS.includes(searchParams.kind as StatsHeatmapKind)
            ? (searchParams.kind as StatsHeatmapKind)
            : 'network',
    );
    const activeKey = createMemo(() => (searchParams.key ?? '').trim());
    const win = createMemo<StatsHeatmapWindow>(() =>
        WINDOWS.includes(searchParams.window as StatsHeatmapWindow)
            ? (searchParams.window as StatsHeatmapWindow)
            : '7d',
    );
    const requestedGrain = createMemo<StatsHeatmapGrain>(() =>
        GRAINS.includes(searchParams.grain as StatsHeatmapGrain)
            ? (searchParams.grain as StatsHeatmapGrain)
            : '15m',
    );
    const measure = createMemo<StatsHeatmapMeasure>(() =>
        MEASURES.includes(searchParams.measure as StatsHeatmapMeasure)
            ? (searchParams.measure as StatsHeatmapMeasure)
            : 'queries',
    );

    const [keyDraft, setKeyDraft] = createSignal(untrack(activeKey));
    const [foldWeekdays, setFoldWeekdays] = createSignal(false);
    const [showTable, setShowTable] = createSignal(false);
    const [canvasWidth, setCanvasWidth] = createSignal(760);
    const [focusCell, setFocusCell] = createSignal<[number, number] | null>(null);
    const [tip, setTip] = createSignal<{ x: number; y: number; text: string } | null>(null);
    const [themeTick, setThemeTick] = createSignal(0);

    let wrapEl: HTMLDivElement | undefined;
    let canvasEl: HTMLCanvasElement | undefined;
    let resizeObs: ResizeObserver | undefined;
    let themeObs: MutationObserver | undefined;

    createEffect(() => {
        setKeyDraft(activeKey());
    });

    const effectiveGrain = createMemo<StatsHeatmapGrain>(() => {
        const w = win();
        const g = requestedGrain();
        if (canvasWidth() < 480) {
            return 'hour';
        }
        if (g === 'minute' && (w === '30d' || w === '90d')) {
            return 'hour';
        }
        if (g === '15m' && w === '90d') {
            return 'hour';
        }
        return g;
    });

    onMount(() => {
        if (dashboardState.clients.length === 0) {
            void getClients();
        }
        if (!statsState.statsInitialized) {
            void getStats();
        }
        if (wrapEl && typeof ResizeObserver !== 'undefined') {
            resizeObs = new ResizeObserver((entries) => {
                const w = entries[0]?.contentRect.width;
                if (w && w > 0) {
                    setCanvasWidth(Math.round(w));
                }
            });
            resizeObs.observe(wrapEl);
        }

        const bumpTheme = () => setThemeTick((t) => t + 1);
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        mq.addEventListener('change', bumpTheme);
        if (typeof MutationObserver !== 'undefined') {
            themeObs = new MutationObserver(bumpTheme);
            themeObs.observe(document.documentElement, {
                attributes: true,
                attributeFilter: ['data-theme'],
            });
        }

        onCleanup(() => {
            mq.removeEventListener('change', bumpTheme);
            themeObs?.disconnect();
            resizeObs?.disconnect();
        });
    });

    createEffect(() => {
        const k = kind();
        const keyVal = activeKey();
        const w = win();
        const g = effectiveGrain();
        const m = measure();

        if (k !== 'network' && !keyVal) {
            return;
        }

        void fetchHeatmap({
            window: w,
            grain: g,
            kind: k,
            key: k === 'network' ? undefined : keyVal,
            measure: m,
        });
    });

    const suggestions = createMemo(() => {
        if (kind() === 'client') {
            const set = new Set<string>();
            for (const c of dashboardState.clients ?? []) {
                if (c.name) set.add(c.name);
                for (const id of c.ids ?? []) set.add(id);
            }
            for (const tc of statsState.topClients ?? []) {
                if (tc.name) set.add(tc.name);
            }
            return [...set].slice(0, 100);
        }
        if (kind() === 'domain') {
            const set = new Set<string>();
            for (const d of statsState.topQueriedDomains ?? []) set.add(d.name);
            for (const d of statsState.topBlockedDomains ?? []) set.add(d.name);
            return [...set].slice(0, 100);
        }
        return [];
    });

    const grid = createMemo(() => {
        const data = observabilityState.heatmap;
        if (!data || data.starts.length === 0) {
            return null;
        }
        return layoutHeatmap(
            data.starts,
            data.values,
            data.covered,
            data.slot_seconds,
            foldWeekdays(),
        );
    });

    const geo = createMemo(() => {
        const g = grid();
        if (!g || canvasWidth() <= 0) {
            return null;
        }
        return heatmapGeometry(g, canvasWidth(), 96, 52, 420);
    });

    const canvasH = createMemo(() => {
        const g = grid();
        const gm = geo();
        return g && gm ? heatmapHeight(g, gm) : 260;
    });

    createEffect(() => {
        void themeTick();
        const g = grid();
        const gm = geo();
        const w = canvasWidth();
        const h = canvasH();
        const focus = focusCell();

        if (!canvasEl || !g || !gm || showTable() || w <= 0) {
            return;
        }

        const dpr = window.devicePixelRatio || 1;
        canvasEl.width = Math.round(w * dpr);
        canvasEl.height = Math.round(h * dpr);
        canvasEl.style.height = `${h}px`;

        const ctx = canvasEl.getContext('2d');
        if (!ctx) {
            return;
        }

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);

        drawHeatmap(
            ctx,
            g,
            gm,
            {
                ink: cssToken(
                    measure() === 'blocked' ? '--obs-hm-blocked-ink' : '--obs-hm-ink',
                    '#5c67ae',
                ),
                bg: cssToken('--obs-hm-bg', '#f6f6f6'),
                muted: cssToken('--default-description-text', '#5b5b5b'),
                hatch: cssToken('--obs-hm-hatch', '#d2d2d2'),
                focus: cssToken('--default-focus-outline', '#366642'),
            },
            focus,
        );
    });

    const formatCellTip = (row: number, col: number): string => {
        const g = grid();
        if (!g) return '';
        const cell = g.cells[row]?.[col];
        if (!cell) return '';

        const d = new Date(cell.start * 1000);
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        const slotEnd = new Date((cell.start + g.slot) * 1000);
        const eh = String(slotEnd.getHours()).padStart(2, '0');
        const em = String(slotEnd.getMinutes()).padStart(2, '0');
        const timeStr = `${g.rows[row].label} ${hh}:${mm}–${eh}:${em}`;

        if (!cell.covered) {
            return intl.getMessage('obs_heatmap_uncovered_tip', { time: timeStr });
        }

        const rounded = Math.round(cell.value ?? 0);
        const countLabel = intl.getPlural('obs_queries_count', rounded, {
            count: rounded.toLocaleString(),
        });
        const suffix =
            foldWeekdays() && cell.days > 1
                ? ` (${intl.getMessage('obs_avg_per_slot', { count: cell.days })})`
                : '';

        return intl.getMessage('obs_heatmap_cell_tip', {
            time: timeStr,
            count: `${countLabel}${suffix}`,
        });
    };

    const drillCell = (row: number, col: number) => {
        const g = grid();
        if (!g || !g.cells[row]?.[col]) return;
        const query: Record<string, string> = {};
        if (kind() !== 'network' && activeKey()) {
            query.search = activeKey();
        }
        if (measure() === 'blocked') {
            query.status = 'blocked';
        }
        navigate(linkPathBuilder(RoutePath.Logs, undefined, query));
    };

    const handleCanvasMove = (e: MouseEvent) => {
        const g = grid();
        const gm = geo();
        if (!canvasEl || !g || !gm) return;
        const rect = canvasEl.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const hit = hitHeatmapCell(g, gm, x, y);
        if (!hit) {
            setTip(null);
            return;
        }
        const [r, c] = hit;
        setTip({
            x: Math.min(rect.width - 220, Math.max(8, x + 12)),
            y: Math.max(8, y - 24),
            text: formatCellTip(r, c),
        });
    };

    const handleCanvasClick = (e: MouseEvent) => {
        const g = grid();
        const gm = geo();
        if (!canvasEl || !g || !gm) return;
        const rect = canvasEl.getBoundingClientRect();
        const hit = hitHeatmapCell(g, gm, e.clientX - rect.left, e.clientY - rect.top);
        if (hit) {
            setFocusCell(hit);
            drillCell(hit[0], hit[1]);
        }
    };

    const handleCanvasKeyDown = (e: KeyboardEvent) => {
        const g = grid();
        if (!g || g.rows.length === 0) return;
        const cur = focusCell() ?? [0, 0];
        let [r, c] = cur;

        if (e.key === 'ArrowUp') r = Math.max(0, r - 1);
        else if (e.key === 'ArrowDown') r = Math.min(g.rows.length - 1, r + 1);
        else if (e.key === 'ArrowLeft') c = Math.max(0, c - 1);
        else if (e.key === 'ArrowRight') c = Math.min(g.cols - 1, c + 1);
        else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            drillCell(r, c);
            return;
        } else {
            return;
        }

        e.preventDefault();
        setFocusCell([r, c]);
    };

    const kindLabel = (k: StatsHeatmapKind): string => {
        switch (k) {
            case 'network':
                return intl.getMessage('obs_kind_network');
            case 'client':
                return intl.getMessage('obs_kind_client');
            case 'domain':
                return intl.getMessage('obs_kind_domain');
        }
    };

    const windowLabel = (w: StatsHeatmapWindow): string => {
        switch (w) {
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

    const grainLabel = (g: StatsHeatmapGrain): string => {
        switch (g) {
            case 'minute':
                return intl.getMessage('obs_grain_1m');
            case '15m':
                return intl.getMessage('obs_grain_15m');
            case 'hour':
                return intl.getMessage('obs_grain_1h');
        }
    };

    const precisionLabel = () => {
        switch (observabilityState.heatmap?.precision) {
            case 'querylog':
                return intl.getMessage('obs_precision_querylog');
            case 'top_list':
                return intl.getMessage('obs_precision_top_list');
            default:
                return intl.getMessage('obs_precision_exact');
        }
    };

    const applyKey = (e: Event) => {
        e.preventDefault();
        setSearchParams({ key: keyDraft().trim() || undefined }, { replace: true });
    };

    return (
        <div class={s.root}>
            <div class={s.toolbar}>
                <div class={s.segmented} role="group">
                    <For each={KINDS}>
                        {(k) => (
                            <button
                                type="button"
                                class={cn(s.segBtn, { [s.segActive]: kind() === k })}
                                onClick={() => setSearchParams({ kind: k }, { replace: true })}
                            >
                                {kindLabel(k)}
                            </button>
                        )}
                    </For>
                </div>

                <Show when={kind() !== 'network'}>
                    <form class={s.keyForm} onSubmit={applyKey}>
                        <Input
                            class={s.keyInput}
                            size="small"
                            list="obs-heatmap-keys"
                            value={keyDraft()}
                            onInput={(e: Event) => setKeyDraft((e.target as HTMLInputElement).value)}
                            placeholder={
                                kind() === 'client'
                                    ? intl.getMessage('obs_client_filter_placeholder')
                                    : intl.getMessage('obs_domain_filter_placeholder')
                            }
                            isClearable
                            onClear={() => {
                                setKeyDraft('');
                                setSearchParams({ key: undefined }, { replace: true });
                            }}
                        />
                        <datalist id="obs-heatmap-keys">
                            <For each={suggestions()}>{(item) => <option value={item} />}</For>
                        </datalist>
                        <Button type="submit" variant="secondary" size="very-small">
                            {intl.getMessage('obs_control_apply')}
                        </Button>
                    </form>
                </Show>

                <div class={s.segmented} role="group">
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

                <div class={s.segmented} role="group">
                    <For each={GRAINS}>
                        {(g) => (
                            <button
                                type="button"
                                class={cn(s.segBtn, { [s.segActive]: effectiveGrain() === g })}
                                onClick={() => setSearchParams({ grain: g }, { replace: true })}
                            >
                                {grainLabel(g)}
                            </button>
                        )}
                    </For>
                </div>

                <div class={s.segmented} role="group">
                    <For each={MEASURES}>
                        {(m) => (
                            <button
                                type="button"
                                class={cn(s.segBtn, { [s.segActive]: measure() === m })}
                                onClick={() => setSearchParams({ measure: m }, { replace: true })}
                            >
                                {m === 'blocked'
                                    ? intl.getMessage('obs_measure_blocked')
                                    : intl.getMessage('obs_measure_queries')}
                            </button>
                        )}
                    </For>
                </div>

                <div class={s.toggles}>
                    <button
                        type="button"
                        class={cn(s.toggleBtn, { [s.segActive]: foldWeekdays() })}
                        onClick={() => setFoldWeekdays((prev) => !prev)}
                    >
                        {intl.getMessage('obs_fold_weekdays')}
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
                        disabled={observabilityState.loadingHeatmap}
                        onClick={() => {
                            if (kind() === 'network' || activeKey()) {
                                void fetchHeatmap({
                                    window: win(),
                                    grain: effectiveGrain(),
                                    kind: kind(),
                                    key: kind() === 'network' ? undefined : activeKey(),
                                    measure: measure(),
                                });
                            }
                        }}
                    >
                        <Icon icon="refresh" class={s.refreshIcon} />
                    </Button>
                </div>
            </div>

            <Show when={observabilityState.heatmap?.partial}>
                <div class={s.notice}>{intl.getMessage('obs_partial_notice')}</div>
            </Show>
            <Show when={observabilityState.heatmap?.truncated}>
                <div class={s.notice}>{intl.getMessage('obs_truncated_notice')}</div>
            </Show>

            <div class={s.card} ref={wrapEl}>
                <Show
                    when={kind() === 'network' || activeKey() !== ''}
                    fallback={<div class={s.empty}>{intl.getMessage('obs_enter_key_prompt')}</div>}
                >
                    <Show
                        when={!observabilityState.loadingHeatmap || observabilityState.heatmap !== null}
                        fallback={
                            <div class={s.loader}>
                                <Loader />
                            </div>
                        }
                    >
                        <Show
                            when={grid() && (grid()?.max ?? 0) >= 0}
                            fallback={
                                <div class={s.empty}>{intl.getMessage('obs_empty_heatmap')}</div>
                            }
                        >
                            <Show
                                when={!showTable()}
                                fallback={
                                    <div class={s.tableWrap}>
                                        <table class={s.table}>
                                            <thead>
                                                <tr>
                                                    <th>{intl.getMessage('obs_heatmap_title')}</th>
                                                    <th class={s.numCol}>
                                                        {intl.getMessage('obs_total_queries')}
                                                    </th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                <For each={grid()?.rows ?? []}>
                                                    {(rowMeta, ri) => (
                                                        <tr>
                                                            <td>{rowMeta.label}</td>
                                                            <td class={s.numCol}>
                                                                {Math.round(
                                                                    grid()?.rowSums[ri()] ?? 0,
                                                                ).toLocaleString()}
                                                            </td>
                                                        </tr>
                                                    )}
                                                </For>
                                            </tbody>
                                        </table>
                                    </div>
                                }
                            >
                                <div class={s.canvasWrap}>
                                    <canvas
                                        ref={canvasEl}
                                        class={s.canvas}
                                        tabIndex={0}
                                        aria-label={intl.getMessage('obs_activity_heatmap')}
                                        onMouseMove={handleCanvasMove}
                                        onMouseLeave={() => setTip(null)}
                                        onClick={handleCanvasClick}
                                        onKeyDown={handleCanvasKeyDown}
                                    />
                                    <Show when={tip()}>
                                        {(t) => (
                                            <div
                                                class={s.tooltip}
                                                style={{
                                                    left: `${t().x}px`,
                                                    top: `${t().y}px`,
                                                }}
                                            >
                                                {t().text}
                                            </div>
                                        )}
                                    </Show>
                                </div>

                                <div class={s.legendBar}>
                                    <div class={s.scaleGroup}>
                                        <span>{intl.getMessage('obs_scale_low')}</span>
                                        <span class={cn(s.swatch, s.swatchEmpty)} />
                                        <span
                                            class={cn(s.swatch, {
                                                [s.swatchBlockedLow]: measure() === 'blocked',
                                                [s.swatchAllowedLow]: measure() !== 'blocked',
                                            })}
                                        />
                                        <span
                                            class={cn(s.swatch, {
                                                [s.swatchBlockedHigh]: measure() === 'blocked',
                                                [s.swatchAllowedHigh]: measure() !== 'blocked',
                                            })}
                                        />
                                        <span>{intl.getMessage('obs_scale_high')}</span>
                                        <span class={cn(s.swatch, s.swatchHatched)} />
                                        <span>{intl.getMessage('obs_covered_legend')}</span>
                                    </div>
                                    <span class={s.precisionTag}>{precisionLabel()}</span>
                                </div>
                            </Show>
                        </Show>
                    </Show>
                </Show>
            </div>
        </div>
    );
};
