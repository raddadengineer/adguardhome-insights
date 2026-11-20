import type { StatsLatencyExemplar } from 'panel/api/model/statsLatencyExemplar';
import { heatStrength } from './heatmap';

export const LATENCY_PATHS = ['cache', 'upstream', 'local', 'blocked'] as const;
export type LatencyPath = (typeof LATENCY_PATHS)[number];

export type LatencyColors = {
    ink: string;
    bg: string;
    muted: string;
    threshold: string;
    pathColors: Record<string, string>;
};

export type LatencyHit =
    | { kind: 'exemplar'; exemplar: StatsLatencyExemplar }
    | { kind: 'cell'; col: number; row: number; count: number; start: number; label: string };

export function formatLatencyBound(us: number): string {
    if (us >= 1_000_000) {
        const sec = us / 1_000_000;
        return `${Number.isInteger(sec) ? sec : sec.toFixed(1)} s`;
    }
    if (us >= 1_000) {
        const ms = us / 1_000;
        return `${Number.isInteger(ms) ? ms : ms.toFixed(1)} ms`;
    }
    return `${us} µs`;
}

export function latencyRowLabel(row: number, boundsUs: number[]): string {
    if (row < boundsUs.length) {
        return `≤ ${formatLatencyBound(boundsUs[row])}`;
    }
    const last = boundsUs[boundsUs.length - 1] ?? 5_000_000;
    return `> ${formatLatencyBound(last)}`;
}

export function latencyRowOf(us: number, boundsUs: number[]): number {
    const idx = boundsUs.findIndex((b) => us <= b);
    return idx < 0 ? boundsUs.length : idx;
}

export function aggregateLatencyGrid(
    starts: number[],
    boundsUs: number[],
    series: Record<string, number[][]>,
    activeKeys: string[],
): { grid: number[][]; max: number; rows: number } {
    const rows = boundsUs.length + 1;
    const grid = starts.map((_, c) =>
        Array.from({ length: rows }, (__, r) =>
            activeKeys.reduce((acc, k) => acc + (series[k]?.[c]?.[r] ?? 0), 0),
        ),
    );

    let max = 0;
    for (const col of grid) {
        for (const val of col) {
            if (val > max) {
                max = val;
            }
        }
    }

    return { grid, max, rows };
}

export type LatencyCanvasParams = {
    width: number;
    labelWidth: number;
    rowHeight: number;
    topPad: number;
    starts: number[];
    stepSeconds: number;
    boundsUs: number[];
    grid: number[][];
    max: number;
    rows: number;
    thresholdMs: number | null;
    exemplars: StatsLatencyExemplar[];
    showExemplars: boolean;
};

export function latencyCanvasHeight(rows: number, rowHeight = 12, topPad = 6): number {
    return topPad + rows * rowHeight + 22;
}

export function drawLatencyHeatmap(
    ctx: CanvasRenderingContext2D,
    params: LatencyCanvasParams,
    colors: LatencyColors,
): void {
    const {
        width,
        labelWidth,
        rowHeight,
        topPad,
        starts,
        stepSeconds,
        boundsUs,
        grid,
        max,
        rows,
        thresholdMs,
        exemplars,
        showExemplars,
    } = params;

    const totalH = latencyCanvasHeight(rows, rowHeight, topPad);
    const cw = starts.length > 0 ? Math.max(1, (width - labelWidth - 6) / starts.length) : 1;
    const cellW = Math.max(1, cw - (cw > 3 ? 1 : 0));
    const yOf = (r: number) => topPad + (rows - 1 - r) * rowHeight;

    ctx.font = '10px system-ui, sans-serif';
    ctx.textBaseline = 'middle';

    for (let r = 0; r < rows; r += 1) {
        if (r % 2 === 0 || rows <= 10) {
            ctx.fillStyle = colors.muted;
            ctx.fillText(latencyRowLabel(r, boundsUs), 0, yOf(r) + rowHeight / 2);
        }
    }

    grid.forEach((col, c) => {
        const x = labelWidth + c * cw;
        col.forEach((val, r) => {
            ctx.fillStyle = colors.bg;
            ctx.fillRect(x, yOf(r), cellW, rowHeight - 1);

            const alpha = heatStrength(val, max);
            if (alpha > 0) {
                ctx.save();
                ctx.globalAlpha = alpha;
                ctx.fillStyle = colors.ink;
                ctx.fillRect(x, yOf(r), cellW, rowHeight - 1);
                ctx.restore();
            }
        });
    });

    // X-axis time labels.
    if (starts.length > 0) {
        const labelStep = Math.max(1, Math.ceil(56 / Math.max(1, cw)));
        ctx.fillStyle = colors.muted;
        const axisY = topPad + rows * rowHeight + 11;
        for (let c = 0; c < starts.length; c += labelStep) {
            const d = new Date(starts[c] * 1000);
            const txt =
                stepSeconds >= 3600
                    ? d.toLocaleDateString([], { month: 'short', day: 'numeric' })
                    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
            ctx.fillText(txt, labelWidth + c * cw, axisY);
        }
    }

    if (thresholdMs !== null && thresholdMs > 0) {
        const tr = latencyRowOf(thresholdMs * 1000, boundsUs);
        const ty = yOf(tr);
        ctx.save();
        ctx.strokeStyle = colors.threshold;
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(labelWidth, ty - 0.5);
        ctx.lineTo(width, ty - 0.5);
        ctx.stroke();
        ctx.restore();
    }

    if (showExemplars && starts.length > 0) {
        const start0 = starts[0];
        const endT = starts[starts.length - 1] + stepSeconds;
        for (const ex of exemplars) {
            const tSec = ex.ts_unix_micros / 1_000_000;
            if (tSec < start0 || tSec > endT) {
                continue;
            }
            const x = labelWidth + ((tSec - start0) / stepSeconds) * cw;
            const r = latencyRowOf(ex.latency_us, boundsUs);
            const y = yOf(r) + rowHeight / 2;
            ctx.save();
            ctx.fillStyle = colors.pathColors[ex.path] ?? colors.ink;
            ctx.strokeStyle = colors.bg;
            ctx.lineWidth = 1.25;
            ctx.beginPath();
            ctx.arc(x, y, 3.2, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.restore();
        }
    }

    if (totalH < 0) {
        // unreachable guard
    }
}

export function hitLatencyTarget(x: number, y: number, params: LatencyCanvasParams): LatencyHit | null {
    const {
        width,
        labelWidth,
        rowHeight,
        topPad,
        starts,
        stepSeconds,
        boundsUs,
        grid,
        rows,
        exemplars,
        showExemplars,
    } = params;
    if (starts.length === 0) {
        return null;
    }

    const cw = Math.max(1, (width - labelWidth - 6) / starts.length);
    const yOf = (r: number) => topPad + (rows - 1 - r) * rowHeight;

    if (showExemplars) {
        const start0 = starts[0];
        let best: { dist: number; ex: StatsLatencyExemplar } | null = null;
        for (const ex of exemplars) {
            const exX = labelWidth + ((ex.ts_unix_micros / 1_000_000 - start0) / stepSeconds) * cw;
            const exY = yOf(latencyRowOf(ex.latency_us, boundsUs)) + rowHeight / 2;
            const dist = Math.hypot(x - exX, y - exY);
            if (dist <= 7 && (!best || dist < best.dist)) {
                best = { dist, ex };
            }
        }
        if (best) {
            return { kind: 'exemplar', exemplar: best.ex };
        }
    }

    const col = Math.floor((x - labelWidth) / cw);
    const rowFromTop = Math.floor((y - topPad) / rowHeight);
    const row = rows - 1 - rowFromTop;
    if (col < 0 || col >= starts.length || row < 0 || row >= rows) {
        return null;
    }

    return {
        kind: 'cell',
        col,
        row,
        count: grid[col]?.[row] ?? 0,
        start: starts[col],
        label: latencyRowLabel(row, boundsUs),
    };
}
