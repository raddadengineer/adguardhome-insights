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
import { useNavigate } from '@solidjs/router';

import intl from 'panel/common/intl';
import { Button } from 'panel/common/ui/Button';
import { Icon } from 'panel/common/ui/Icon';
import { Select } from 'panel/common/controls/Select';
import { Loader } from 'panel/common/ui/Loader';
import { RoutePath, linkPathBuilder } from 'panel/components/Routes/Paths';
import { observabilityState, fetchLatencyHeatmap } from 'panel/stores/observability';
import type { StatsLatencyHeatmapWindow } from 'panel/api/model/statsLatencyHeatmapWindow';
import type { StatsLatencyHeatmapBy } from 'panel/api/model/statsLatencyHeatmapBy';
import type { StatsLatencyExemplarsWindow } from 'panel/api/model/statsLatencyExemplarsWindow';
import type { IOption } from 'panel/lib/helpers/utils';
import {
    LATENCY_PATHS,
    aggregateLatencyGrid,
    latencyCanvasHeight,
    drawLatencyHeatmap,
    hitLatencyTarget,
    formatLatencyBound,
    type LatencyPath,
    type LatencyCanvasParams,
} from 'panel/helpers/observability/latencyHeatmap';

import s from './HeatmapBlocks.module.pcss';

const WINDOWS: readonly StatsLatencyHeatmapWindow[] = ['1h', '6h', '24h', '7d', '30d'];
const BY_OPTIONS: readonly StatsLatencyHeatmapBy[] = ['path', 'upstream'];
const SLO_CHOICES = [100, 250, 500, 1000, 0] as const;

function cssToken(name: string, fallback: string): string {
    if (typeof window === 'undefined') return fallback;
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export const LatencyHeatmap = () => {
    const navigate = useNavigate();

    const [win, setWin] = createSignal<StatsLatencyHeatmapWindow>('6h');
    const [by, setBy] = createSignal<StatsLatencyHeatmapBy>('path');
    const [activePaths, setActivePaths] = createSignal<LatencyPath[]>([...LATENCY_PATHS]);
    const [selectedUpstream, setSelectedUpstream] = createSignal<string>('');
    const [sloMs, setSloMs] = createSignal<number>(250);
    const [showExemplars, setShowExemplars] = createSignal(true);
    const [showTable, setShowTable] = createSignal(false);
    const [canvasWidth, setCanvasWidth] = createSignal(760);
    const [tip, setTip] = createSignal<{ x: number; y: number; text: string } | null>(null);
    const [themeTick, setThemeTick] = createSignal(0);

    let wrapEl: HTMLDivElement | undefined;
    let canvasEl: HTMLCanvasElement | undefined;
    let resizeObs: ResizeObserver | undefined;
    let themeObs: MutationObserver | undefined;

    const effectiveStep = createMemo(() => (win() === '7d' || win() === '30d' ? 'hour' : 'minute'));
    const exemplarWindow = createMemo<StatsLatencyExemplarsWindow>(() => {
        const w = win();
        if (w === '1h' || w === '6h' || w === '24h') return w;
        return '24h';
    });

    onMount(() => {
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
        void fetchLatencyHeatmap(
            { window: win(), step: effectiveStep(), by: by() },
            { window: exemplarWindow() },
        );
    });

    const upstreamKeys = createMemo(() =>
        Object.keys(observabilityState.latencyHeatmap?.series ?? {}),
    );

    const upstreamOptions = createMemo<IOption<string>[]>(() => [
        { value: '', label: intl.getMessage('obs_upstream_all') },
        ...upstreamKeys().map((u) => ({ value: u, label: u })),
    ]);

    const activeSeriesKeys = createMemo<string[]>(() => {
        if (by() === 'upstream') {
            const up = selectedUpstream();
            return up ? [up] : upstreamKeys();
        }
        return activePaths();
    });

    const aggregated = createMemo(() => {
        const data = observabilityState.latencyHeatmap;
        if (!data || data.starts.length === 0) {
            return null;
        }
        return aggregateLatencyGrid(data.starts, data.bounds_us, data.series, activeSeriesKeys());
    });

    const visibleExemplars = createMemo(() => {
        const list = observabilityState.latencyExemplars;
        if (by() === 'upstream') {
            const up = selectedUpstream();
            return up ? list.filter((ex) => ex.upstream === up) : list;
        }
        const paths = activePaths();
        return list.filter((ex) => paths.includes(ex.path as LatencyPath));
    });

    const canvasParams = createMemo<LatencyCanvasParams | null>(() => {
        const data = observabilityState.latencyHeatmap;
        const agg = aggregated();
        if (!data || !agg || canvasWidth() <= 0) {
            return null;
        }
        return {
            width: canvasWidth(),
            labelWidth: 68,
            rowHeight: 13,
            topPad: 6,
            starts: data.starts,
            stepSeconds: data.step === 'hour' ? 3600 : 60,
            boundsUs: data.bounds_us,
            grid: agg.grid,
            max: agg.max,
            rows: agg.rows,
            thresholdMs: sloMs() > 0 ? sloMs() : null,
            exemplars: visibleExemplars(),
            showExemplars: showExemplars(),
        };
    });

    const canvasH = createMemo(() => {
        const p = canvasParams();
        return p ? latencyCanvasHeight(p.rows, p.rowHeight, p.topPad) : 260;
    });

    createEffect(() => {
        void themeTick();
        const p = canvasParams();
        const h = canvasH();
        if (!canvasEl || !p || showTable()) {
            return;
        }

        const dpr = window.devicePixelRatio || 1;
        canvasEl.width = Math.round(p.width * dpr);
        canvasEl.height = Math.round(h * dpr);
        canvasEl.style.height = `${h}px`;

        const ctx = canvasEl.getContext('2d');
        if (!ctx) {
            return;
        }

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, p.width, h);

        drawLatencyHeatmap(ctx, p, {
            ink: cssToken('--obs-hm-ink', '#5c67ae'),
            bg: cssToken('--obs-hm-bg', '#f6f6f6'),
            muted: cssToken('--default-description-text', '#5b5b5b'),
            threshold: cssToken('--obs-error', '#dc4918'),
            pathColors: {
                cache: cssToken('--obs-cached', '#67b279'),
                upstream: cssToken('--obs-forwarded', '#6b76bd'),
                local: cssToken('--obs-local', '#a870b2'),
                blocked: cssToken('--obs-blocked', '#e9653a'),
            },
        });
    });

    const togglePath = (p: LatencyPath) => {
        setActivePaths((prev) =>
            prev.includes(p) ? (prev.length > 1 ? prev.filter((x) => x !== p) : prev) : [...prev, p],
        );
    };

    const pathLabel = (p: LatencyPath): string => {
        switch (p) {
            case 'cache':
                return intl.getMessage('obs_path_cache');
            case 'upstream':
                return intl.getMessage('obs_path_upstream');
            case 'local':
                return intl.getMessage('obs_path_local');
            case 'blocked':
                return intl.getMessage('obs_path_blocked');
        }
    };

    const windowLabel = (w: StatsLatencyHeatmapWindow): string => {
        switch (w) {
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
        }
    };

    const handleMove = (e: MouseEvent) => {
        const p = canvasParams();
        if (!canvasEl || !p) return;
        const rect = canvasEl.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const hit = hitLatencyTarget(x, y, p);
        if (!hit) {
            setTip(null);
            return;
        }
        if (hit.kind === 'exemplar') {
            const ex = hit.exemplar;
            setTip({
                x: Math.min(rect.width - 240, Math.max(8, x + 12)),
                y: Math.max(8, y - 24),
                text: intl.getMessage('obs_exemplar_tooltip', {
                    latency: formatLatencyBound(ex.latency_us),
                    domain: ex.domain,
                    client: ex.client,
                    path: ex.path,
                }),
            });
            return;
        }

        const timeStr = new Date(hit.start * 1000).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        });
        const countLabel = intl.getPlural('obs_queries_count', hit.count, {
            count: hit.count.toLocaleString(),
        });
        setTip({
            x: Math.min(rect.width - 220, Math.max(8, x + 12)),
            y: Math.max(8, y - 24),
            text: intl.getMessage('obs_latency_cell_tip', {
                time: timeStr,
                bucket: hit.label,
                count: countLabel,
            }),
        });
    };

    const handleClick = (e: MouseEvent) => {
        const p = canvasParams();
        if (!canvasEl || !p) return;
        const rect = canvasEl.getBoundingClientRect();
        const hit = hitLatencyTarget(e.clientX - rect.left, e.clientY - rect.top, p);
        if (hit?.kind === 'exemplar') {
            navigate(linkPathBuilder(RoutePath.Logs, undefined, { search: hit.exemplar.domain }));
        }
    };

    return (
        <div class={s.root}>
            <div class={s.toolbar}>
                <div class={s.segmented} role="group">
                    <For each={WINDOWS}>
                        {(w) => (
                            <button
                                type="button"
                                class={cn(s.segBtn, { [s.segActive]: win() === w })}
                                onClick={() => setWin(w)}
                            >
                                {windowLabel(w)}
                            </button>
                        )}
                    </For>
                </div>

                <div class={s.segmented} role="group">
                    <For each={BY_OPTIONS}>
                        {(b) => (
                            <button
                                type="button"
                                class={cn(s.segBtn, { [s.segActive]: by() === b })}
                                onClick={() => setBy(b)}
                            >
                                {b === 'upstream'
                                    ? intl.getMessage('obs_latency_by_upstream')
                                    : intl.getMessage('obs_latency_by_path')}
                            </button>
                        )}
                    </For>
                </div>

                <Show
                    when={by() === 'path'}
                    fallback={
                        <div class={s.selectWrap}>
                            <Select
                                options={upstreamOptions()}
                                value={
                                    upstreamOptions().find((o) => o.value === selectedUpstream()) ??
                                    upstreamOptions()[0]
                                }
                                onChange={(opt) => setSelectedUpstream(opt?.value ?? '')}
                                size="small"
                            />
                        </div>
                    }
                >
                    <div class={s.chips}>
                        <For each={LATENCY_PATHS}>
                            {(p) => (
                                <button
                                    type="button"
                                    class={cn(s.toggleBtn, {
                                        [s.segActive]: activePaths().includes(p),
                                    })}
                                    onClick={() => togglePath(p)}
                                >
                                    {pathLabel(p)}
                                </button>
                            )}
                        </For>
                    </div>
                </Show>

                <div class={s.toggles}>
                    <button
                        type="button"
                        class={cn(s.toggleBtn, { [s.segActive]: sloMs() > 0 })}
                        onClick={() => {
                            const idx = SLO_CHOICES.indexOf(sloMs() as (typeof SLO_CHOICES)[number]);
                            setSloMs(SLO_CHOICES[(idx + 1) % SLO_CHOICES.length]);
                        }}
                    >
                        {sloMs() > 0
                            ? intl.getMessage('obs_slo_target', { label: `${sloMs()} ms` })
                            : intl.getMessage('obs_slo_off')}
                    </button>
                    <button
                        type="button"
                        class={cn(s.toggleBtn, { [s.segActive]: showExemplars() })}
                        onClick={() => setShowExemplars((prev) => !prev)}
                    >
                        {intl.getMessage('obs_show_exemplars')}
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
                        disabled={observabilityState.loadingLatency}
                        onClick={() =>
                            void fetchLatencyHeatmap(
                                { window: win(), step: effectiveStep(), by: by() },
                                { window: exemplarWindow() },
                            )
                        }
                    >
                        <Icon icon="refresh" class={s.refreshIcon} />
                    </Button>
                </div>
            </div>

            <Show when={observabilityState.latencyHeatmap?.partial}>
                <div class={s.notice}>{intl.getMessage('obs_partial_notice')}</div>
            </Show>

            <div class={s.card} ref={wrapEl}>
                <Show
                    when={
                        !observabilityState.loadingLatency ||
                        observabilityState.latencyHeatmap !== null
                    }
                    fallback={
                        <div class={s.loader}>
                            <Loader />
                        </div>
                    }
                >
                    <Show
                        when={canvasParams()}
                        fallback={<div class={s.empty}>{intl.getMessage('obs_empty_latency')}</div>}
                    >
                        <Show
                            when={!showTable()}
                            fallback={
                                <div class={s.tableWrap}>
                                    <table class={s.table}>
                                        <thead>
                                            <tr>
                                                <th>{intl.getMessage('obs_recent_exemplars')}</th>
                                                <th>{intl.getMessage('obs_clients')}</th>
                                                <th>{intl.getMessage('obs_status')}</th>
                                                <th class={s.numCol}>
                                                    {intl.getMessage('obs_latency_heatmap')}
                                                </th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            <For each={visibleExemplars().slice(0, 40)}>
                                                {(ex) => (
                                                    <tr>
                                                        <td>{ex.domain}</td>
                                                        <td>{ex.client}</td>
                                                        <td>{ex.path}</td>
                                                        <td class={s.numCol}>
                                                            {formatLatencyBound(ex.latency_us)}
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
                                    aria-label={intl.getMessage('obs_latency_heatmap')}
                                    onMouseMove={handleMove}
                                    onMouseLeave={() => setTip(null)}
                                    onClick={handleClick}
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
                        </Show>
                    </Show>
                </Show>
            </div>
        </div>
    );
};
