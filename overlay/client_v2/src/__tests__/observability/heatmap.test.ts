import { describe, expect, it } from 'vitest';
import {
    layoutHeatmap,
    heatStrength,
    heatmapGeometry,
    hitHeatmapCell,
} from 'panel/helpers/observability/heatmap';
import {
    aggregateLatencyGrid,
    formatLatencyBound,
    latencyRowOf,
    latencyRowLabel,
    hitLatencyTarget,
} from 'panel/helpers/observability/latencyHeatmap';

describe('heatmap and latency heatmap helpers', () => {
    it('lays out activity grids and folds weekdays cleanly', () => {
        const day0 = Math.floor(new Date(2026, 0, 5, 0, 0, 0).getTime() / 1000); // Mon
        const day7 = Math.floor(new Date(2026, 0, 12, 0, 0, 0).getTime() / 1000); // Next Mon

        const starts = [day0, day0 + 3600, day7];
        const values = [10, 20, 30];
        const covered = [true, false, true];

        const daily = layoutHeatmap(starts, values, covered, 3600, false);
        expect(daily.rows).toHaveLength(2);
        expect(daily.cols).toBe(24);
        expect(daily.cells[0][0].value).toBe(10);
        expect(daily.cells[0][1].covered).toBe(false);
        expect(daily.cells[0][1].value).toBeNull();
        expect(daily.max).toBe(30);

        const folded = layoutHeatmap(starts, values, covered, 3600, true);
        expect(folded.rows).toHaveLength(7);
        // Mon col 0 mean of 10 and 30 = 20
        expect(folded.cells[0][0].value).toBe(20);
        expect(folded.cells[0][0].days).toBe(2);
        expect(folded.cells[0][1].covered).toBe(false);

        const geo = heatmapGeometry(folded, 600, 96, 52, 300);
        expect(hitHeatmapCell(folded, geo, geo.x0 + 2, geo.y0 + 2)).toEqual([0, 0]);
        expect(hitHeatmapCell(folded, geo, 0, 0)).toBeNull();

        expect(heatStrength(null, 100)).toBe(0);
        expect(heatStrength(0, 100)).toBe(0);
        expect(heatStrength(25, 100)).toBeCloseTo(0.56, 2);
    });

    it('aggregates latency series and resolves exemplar hits', () => {
        const bounds = [50, 1000, 50_000, 5_000_000];
        expect(formatLatencyBound(50)).toBe('50 µs');
        expect(formatLatencyBound(1_000)).toBe('1 ms');
        expect(formatLatencyBound(5_000_000)).toBe('5 s');
        expect(latencyRowOf(40, bounds)).toBe(0);
        expect(latencyRowOf(30_000, bounds)).toBe(2);
        expect(latencyRowOf(7_000_000, bounds)).toBe(4);
        expect(latencyRowLabel(4, bounds)).toBe('> 5 s');

        const starts = [1_700_000_000, 1_700_000_060];
        const series = {
            cache: [
                [10, 1, 0, 0, 0],
                [5, 0, 0, 0, 0],
            ],
            upstream: [
                [0, 2, 4, 1, 0],
                [0, 0, 8, 0, 1],
            ],
        };

        const agg = aggregateLatencyGrid(starts, bounds, series, ['cache', 'upstream']);
        expect(agg.rows).toBe(5);
        expect(agg.max).toBe(10);
        expect(agg.grid[0][2]).toBe(4);
        expect(agg.grid[1][4]).toBe(1);

        const hit = hitLatencyTarget(68 + 1, 6 + 4 * 12 + 6, {
            width: 400,
            labelWidth: 68,
            rowHeight: 12,
            topPad: 6,
            starts,
            stepSeconds: 60,
            boundsUs: bounds,
            grid: agg.grid,
            max: agg.max,
            rows: agg.rows,
            thresholdMs: null,
            exemplars: [
                {
                    time: '2026-01-01T00:00:00Z',
                    ts_unix_micros: 1_700_000_000 * 1_000_000,
                    latency_us: 40,
                    path: 'cache',
                    domain: 'a.example',
                    client: '10.0.0.1',
                },
            ],
            showExemplars: true,
        });
        expect(hit?.kind).toBe('exemplar');
    });
});
