export type HeatmapCell = {
    value: number | null;
    covered: boolean;
    start: number;
    days: number;
};

export type HeatmapGrid = {
    rows: { label: string; start: number }[];
    cols: number;
    slot: number;
    cells: HeatmapCell[][];
    max: number;
    rowSums: number[];
    colSums: number[];
};

export type HeatmapGeometry = {
    x0: number;
    y0: number;
    cw: number;
    ch: number;
    marginal: number;
};

export type HeatmapColors = {
    ink: string;
    bg: string;
    muted: string;
    hatch: string;
    focus: string;
};

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function localDayStart(tSec: number): number {
    const d = new Date(tSec * 1000);
    d.setHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
}

function slotColumnInDay(tSec: number, slotSec: number, cols: number): number {
    const d = new Date(tSec * 1000);
    const secs = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
    return Math.min(cols - 1, Math.floor(secs / slotSec));
}

/**
 * Lays UTC Unix-second slots onto local calendar days (or folded onto Mon..Sun
 * weekday means).
 */
export function layoutHeatmap(
    starts: number[],
    values: number[],
    covered: boolean[] | null | undefined,
    slotSeconds: number,
    foldWeekdays: boolean,
): HeatmapGrid {
    const cols = Math.max(1, Math.round(86_400 / Math.max(60, slotSeconds)));
    const emptyCell = (start: number): HeatmapCell => ({
        value: null,
        covered: true,
        start,
        days: 0,
    });

    const rows: { label: string; start: number }[] = [];
    const cells: HeatmapCell[][] = [];

    if (foldWeekdays) {
        const accum = Array.from({ length: 7 }, () =>
            Array.from({ length: cols }, () => ({ sum: 0, n: 0, start: 0, covered: true })),
        );

        starts.forEach((t, i) => {
            const wd = (new Date(t * 1000).getDay() + 6) % 7;
            const col = slotColumnInDay(t, slotSeconds, cols);
            const bucket = accum[wd][col];

            if (covered && !covered[i]) {
                bucket.covered = bucket.n > 0 ? bucket.covered : false;
                return;
            }

            bucket.sum += values[i] ?? 0;
            bucket.n += 1;
            bucket.covered = true;
            bucket.start = Math.max(bucket.start, t);
        });

        for (let wd = 0; wd < 7; wd += 1) {
            rows.push({ label: WEEKDAYS[wd], start: 0 });
            cells.push(
                accum[wd].map((b) => ({
                    value: b.n > 0 ? b.sum / b.n : null,
                    covered: b.n > 0 || b.covered,
                    start: b.start,
                    days: b.n,
                })),
            );
        }
    } else {
        const dayRowIdx = new Map<number, number>();

        starts.forEach((t, i) => {
            const day = localDayStart(t);
            let r = dayRowIdx.get(day);
            if (r === undefined) {
                r = rows.length;
                dayRowIdx.set(day, r);
                rows.push({
                    label: new Date(day * 1000).toLocaleDateString([], {
                        weekday: 'short',
                        month: 'short',
                        day: 'numeric',
                    }),
                    start: day,
                });
                cells.push(Array.from({ length: cols }, (_, c) => emptyCell(day + c * slotSeconds)));
            }

            const col = slotColumnInDay(t, slotSeconds, cols);
            const cell = cells[r][col];
            cell.start = t;
            cell.days = 1;

            if (covered && !covered[i]) {
                cell.covered = false;
                return;
            }

            cell.value = (cell.value ?? 0) + (values[i] ?? 0);
        });
    }

    const rowSums = cells.map((row) => row.reduce((acc, c) => acc + (c.value ?? 0), 0));
    const colSums = Array.from({ length: cols }, (_, c) =>
        cells.reduce((acc, row) => acc + (row[c].value ?? 0), 0),
    );

    let max = 0;
    for (const row of cells) {
        for (const c of row) {
            if (c.value !== null && c.value > max) {
                max = c.value;
            }
        }
    }

    return { rows, cols, slot: slotSeconds, cells, max, rowSums, colSums };
}

/** Perceptual square-root color ramp keeping quiet cells discernible. */
export function heatStrength(value: number | null, max: number): number {
    if (value === null || value <= 0 || max <= 0) {
        return 0;
    }
    return 0.12 + 0.88 * Math.sqrt(value / max);
}

export function heatmapGeometry(
    grid: HeatmapGrid,
    width: number,
    labelWidth = 96,
    marginal = 52,
    room = 0,
): HeatmapGeometry {
    const cw = Math.max(1, (width - labelWidth - marginal - 8) / grid.cols);
    const base = grid.cols > 100 ? 14 : Math.max(14, Math.min(26, cw));
    const fill = room > 0 ? Math.floor((room - 18 - 34) / Math.max(1, grid.rows.length)) : base;
    const ch = Math.max(base, Math.min(64, fill));

    return { x0: labelWidth, y0: 18, cw, ch, marginal };
}

export function heatmapHeight(grid: HeatmapGrid, geo: HeatmapGeometry): number {
    return geo.y0 + grid.rows.length * geo.ch + 34;
}

export function hitHeatmapCell(
    grid: HeatmapGrid,
    geo: HeatmapGeometry,
    x: number,
    y: number,
): [number, number] | null {
    const col = Math.floor((x - geo.x0) / geo.cw);
    const row = Math.floor((y - geo.y0) / geo.ch);
    if (row < 0 || row >= grid.rows.length || col < 0 || col >= grid.cols) {
        return null;
    }
    return [row, col];
}

export function drawHeatmap(
    ctx: CanvasRenderingContext2D,
    grid: HeatmapGrid,
    geo: HeatmapGeometry,
    colors: HeatmapColors,
    focus: [number, number] | null,
): void {
    const { x0, y0, cw, ch, marginal } = geo;
    const cellW = Math.max(1, cw - (cw > 3 ? 1 : 0));
    const cellH = Math.max(1, ch - 1);

    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = colors.muted;

    const perHour = Math.max(1, Math.round(3600 / grid.slot));
    const stepH = cw * perHour < 22 ? 6 : cw * perHour < 40 ? 3 : 1;
    for (let h = 0; h < 24; h += stepH) {
        ctx.fillText(String(h).padStart(2, '0'), x0 + h * perHour * cw, 8);
    }

    const maxRowSum = Math.max(1, ...grid.rowSums);
    const maxColSum = Math.max(1, ...grid.colSums);
    const barOriginX = x0 + grid.cols * cw + 6;
    const barOriginY = y0 + grid.rows.length * ch + 4;

    grid.rows.forEach((rowMeta, ri) => {
        const y = y0 + ri * ch;
        ctx.fillStyle = colors.muted;
        ctx.fillText(rowMeta.label, 0, y + ch / 2);

        grid.cells[ri].forEach((cell, ci) => {
            const x = x0 + ci * cw;
            ctx.fillStyle = colors.bg;
            ctx.fillRect(x, y, cellW, cellH);

            if (!cell.covered) {
                ctx.save();
                ctx.beginPath();
                ctx.rect(x, y, cellW, cellH);
                ctx.clip();
                ctx.strokeStyle = colors.hatch;
                ctx.lineWidth = 1;
                ctx.beginPath();
                for (let k = -cellH; k < cellW; k += 4) {
                    ctx.moveTo(x + k, y + cellH);
                    ctx.lineTo(x + k + cellH, y);
                }
                ctx.stroke();
                ctx.restore();
                return;
            }

            const alpha = heatStrength(cell.value, grid.max);
            if (alpha > 0) {
                ctx.save();
                ctx.globalAlpha = alpha;
                ctx.fillStyle = colors.ink;
                ctx.fillRect(x, y, cellW, cellH);
                ctx.restore();
            }
        });

        // Right-hand row marginal bar.
        const rowBarW = Math.round((grid.rowSums[ri] / maxRowSum) * Math.max(8, marginal - 10));
        if (rowBarW > 0) {
            ctx.save();
            ctx.globalAlpha = 0.55;
            ctx.fillStyle = colors.ink;
            ctx.fillRect(barOriginX, y + Math.max(2, ch * 0.2), rowBarW, Math.max(2, ch * 0.6));
            ctx.restore();
        }
    });

    // Bottom column marginal bars.
    grid.colSums.forEach((sum, ci) => {
        const colBarH = Math.round((sum / maxColSum) * 24);
        if (colBarH > 0) {
            ctx.save();
            ctx.globalAlpha = 0.55;
            ctx.fillStyle = colors.ink;
            ctx.fillRect(x0 + ci * cw, barOriginY, cellW, colBarH);
            ctx.restore();
        }
    });

    if (focus) {
        const [fr, fc] = focus;
        if (fr >= 0 && fr < grid.rows.length && fc >= 0 && fc < grid.cols) {
            ctx.strokeStyle = colors.focus;
            ctx.lineWidth = 2;
            ctx.strokeRect(x0 + fc * cw + 0.5, y0 + fr * ch + 0.5, Math.max(2, cw - 2), Math.max(2, ch - 2));
        }
    }
}
