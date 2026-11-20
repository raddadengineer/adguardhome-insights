import { describe, expect, it } from 'vitest';
import {
    MIN_FLOW_ZOOM,
    MAX_FLOW_ZOOM,
    DEFAULT_FLOW_VIEWPORT,
    foldFlow,
    layoutSankey,
    clampViewport,
    zoomViewportAt,
    panViewport,
    formatZoomPercent,
    formatPercent,
    formatCompactCount,
    type FlowNode,
    type FlowLink,
} from 'panel/helpers/observability/sankey';

describe('sankey layout helpers', () => {
    it('folds small nodes per stage while preserving a lone small node', () => {
        const nodes: FlowNode[] = [
            { id: 'group:a', stage: 'group', name: 'a', label: 'A', count: 900, dead_end: 0 },
            { id: 'group:b', stage: 'group', name: 'b', label: 'B', count: 3, dead_end: 0 },
            { id: 'group:c', stage: 'group', name: 'c', label: 'C', count: 2, dead_end: 0 },
            { id: 'status:cached', stage: 'status', name: 'cached', label: 'cached', count: 902, dead_end: 0 },
            { id: 'status:error', stage: 'status', name: 'error', label: 'error', count: 3, dead_end: 3 },
            { id: 'rcode:NOERROR', stage: 'rcode', name: 'NOERROR', label: 'NOERROR', count: 902, dead_end: 0 },
        ];
        const links: FlowLink[] = [
            { source: 'group:a', target: 'status:cached', count: 900, failure: false },
            { source: 'group:b', target: 'status:cached', count: 2, failure: false },
            { source: 'group:b', target: 'status:error', count: 1, failure: true },
            { source: 'group:c', target: 'status:error', count: 2, failure: true },
            { source: 'status:cached', target: 'rcode:NOERROR', count: 902, failure: false },
        ];

        const folded = foldFlow(nodes, links, 905, 0.005);
        expect(folded.folded).toBe(2);

        const groupOther = folded.nodes.find((n) => n.id === 'group:other');
        expect(groupOther).toBeDefined();
        expect(groupOther?.count).toBe(5);

        // Single small status node (status:error) should NOT be folded into status:other.
        expect(folded.nodes.some((n) => n.id === 'status:error')).toBe(true);
        expect(folded.nodes.some((n) => n.id === 'status:other')).toBe(false);

        const mergedErr = folded.links.find(
            (l) => l.source === 'group:other' && l.target === 'status:error',
        );
        expect(mergedErr?.count).toBe(3);
        expect(mergedErr?.failure).toBe(true);
    });

    it('lays out horizontal and vertical Sankey diagrams with monotonic band offsets', () => {
        const nodes: FlowNode[] = [
            { id: 'group:c1', stage: 'group', name: 'c1', label: 'Laptop', count: 70, dead_end: 0 },
            { id: 'group:c2', stage: 'group', name: 'c2', label: 'Phone', count: 30, dead_end: 0 },
            { id: 'status:forwarded', stage: 'status', name: 'forwarded', label: 'forwarded', count: 60, dead_end: 0 },
            { id: 'status:cached', stage: 'status', name: 'cached', label: 'cached', count: 40, dead_end: 0 },
            { id: 'upstream:1.1.1.1', stage: 'upstream', name: '1.1.1.1', label: '1.1.1.1', count: 60, dead_end: 0 },
            { id: 'rcode:NOERROR', stage: 'rcode', name: 'NOERROR', label: 'NOERROR', count: 95, dead_end: 0 },
            { id: 'rcode:SERVFAIL', stage: 'rcode', name: 'SERVFAIL', label: 'SERVFAIL', count: 5, dead_end: 0 },
        ];
        const links: FlowLink[] = [
            { source: 'group:c1', target: 'status:forwarded', count: 40, failure: false },
            { source: 'group:c1', target: 'status:cached', count: 30, failure: false },
            { source: 'group:c2', target: 'status:forwarded', count: 20, failure: false },
            { source: 'group:c2', target: 'status:cached', count: 10, failure: false },
            { source: 'status:forwarded', target: 'upstream:1.1.1.1', count: 60, failure: false },
            { source: 'status:cached', target: 'rcode:NOERROR', count: 40, failure: false },
            { source: 'upstream:1.1.1.1', target: 'rcode:NOERROR', count: 55, failure: false },
            { source: 'upstream:1.1.1.1', target: 'rcode:SERVFAIL', count: 5, failure: true },
        ];

        const hLayout = layoutSankey(nodes, links, 800, 400, false);
        expect(hLayout.nodes).toHaveLength(7);
        expect(hLayout.links).toHaveLength(8);
        for (const l of hLayout.links) {
            expect(l.d.startsWith('M')).toBe(true);
            expect(l.width).toBeGreaterThan(0);
        }
        const sumGroupsH = hLayout.nodes
            .filter((n) => n.stage === 'group')
            .reduce((acc, n) => acc + n.h, 0);
        const sumStatusesH = hLayout.nodes
            .filter((n) => n.stage === 'status')
            .reduce((acc, n) => acc + n.h, 0);
        expect(sumGroupsH).toBeCloseTo(sumStatusesH, 5);

        const vLayout = layoutSankey(nodes, links, 320, 560, true);
        expect(vLayout.vertical).toBe(true);
        expect(vLayout.links.every((l) => l.d.includes('C'))).toBe(true);
    });

    it('lays out dynamic multi-level drill stages identically', () => {
        const dynStages = ['client', 'filter_list', 'service', 'domain'] as const;
        const dynNodes: FlowNode[] = [
            { id: 'client:127.0.0.1', stage: 'client', name: '127.0.0.1', label: 'Laptop', count: 20, dead_end: 0 },
            { id: 'filter_list:Custom', stage: 'filter_list', name: 'Custom', label: 'Custom', count: 15, dead_end: 0 },
            { id: 'filter_list:Extra1', stage: 'filter_list', name: 'Extra1', label: 'Extra1', count: 3, dead_end: 0 },
            { id: 'filter_list:Extra2', stage: 'filter_list', name: 'Extra2', label: 'Extra2', count: 2, dead_end: 0 },
            { id: 'service:youtube', stage: 'service', name: 'youtube', label: 'YouTube', count: 20, dead_end: 0 },
            { id: 'domain:ads.youtube.com', stage: 'domain', name: 'ads.youtube.com', label: 'ads.youtube.com', count: 20, dead_end: 0 },
        ];
        const dynLinks: FlowLink[] = [
            { source: 'client:127.0.0.1', target: 'filter_list:Custom', count: 15, failure: false },
            { source: 'client:127.0.0.1', target: 'filter_list:Extra1', count: 3, failure: false },
            { source: 'client:127.0.0.1', target: 'filter_list:Extra2', count: 2, failure: false },
            { source: 'filter_list:Custom', target: 'service:youtube', count: 15, failure: false },
            { source: 'filter_list:Extra1', target: 'service:youtube', count: 3, failure: false },
            { source: 'filter_list:Extra2', target: 'service:youtube', count: 2, failure: false },
            { source: 'service:youtube', target: 'domain:ads.youtube.com', count: 20, failure: false },
        ];

        const folded = foldFlow(dynNodes, dynLinks, 1000, 0.005, dynStages);
        expect(folded.folded).toBe(2);
        const layout = layoutSankey(folded.nodes, folded.links, 800, 360, false, 10, 14, dynStages);
        expect(layout.nodes.find((n) => n.stage === 'domain')?.col).toBe(3);
    });

    it('formats percentages and compact counts', () => {
        expect(formatPercent(0, 100)).toBe('0%');
        expect(formatPercent(25, 100)).toBe('25%');
        expect(formatPercent(3, 100)).toBe('3.0%');
        expect(formatPercent(1, 400)).toBe('0.25%');

        expect(formatCompactCount(42)).toBe('42');
        expect(formatCompactCount(1500)).toBe('1.5k');
        expect(formatCompactCount(25_400)).toBe('25.4k');
        expect(formatCompactCount(2_500_000)).toBe('2.5M');
        expect(formatZoomPercent(1.25)).toBe('125%');
    });

    it('clamps, anchors zoom, and pans viewport safely', () => {
        expect(clampViewport({ scale: 10, tx: 0, ty: 0 }, 800, 400).scale).toBe(MAX_FLOW_ZOOM);
        expect(clampViewport({ scale: 0.1, tx: 0, ty: 0 }, 800, 400)).toEqual({
            scale: MIN_FLOW_ZOOM,
            tx: 200,
            ty: 100,
        });

        const zoomed = zoomViewportAt(DEFAULT_FLOW_VIEWPORT, 2, 200, 100, 800, 400);
        expect(zoomed).toEqual({ scale: 2, tx: -200, ty: -100 });

        expect(panViewport(DEFAULT_FLOW_VIEWPORT, 50, -30, 800, 400)).toEqual(
            DEFAULT_FLOW_VIEWPORT,
        );
        const panned = panViewport(zoomed, 400, 400, 800, 400);
        expect(panned.tx).toBe(40);
        expect(panned.ty).toBe(40);
    });
});
