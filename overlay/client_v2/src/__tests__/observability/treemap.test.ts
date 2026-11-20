import { describe, expect, it } from 'vitest';
import {
    squarify,
    extractSite,
    extractServiceMap,
    lookupService,
    buildTrafficTiles,
} from 'panel/helpers/observability/treemap';

describe('treemap helpers', () => {
    it('squarifies weights conserving total box area', () => {
        const rects = squarify([60, 25, 10, 5], 400, 300);
        expect(rects).toHaveLength(4);
        const totalArea = rects.reduce((acc, r) => acc + r.w * r.h, 0);
        expect(totalArea).toBeCloseTo(400 * 300, 3);
        for (const r of rects) {
            expect(r.w).toBeGreaterThan(0);
            expect(r.h).toBeGreaterThan(0);
        }

        expect(squarify([], 400, 300)).toEqual([]);
        expect(squarify([0, 0], 400, 300)).toEqual([
            { x: 0, y: 0, w: 0, h: 0 },
            { x: 0, y: 0, w: 0, h: 0 },
        ]);
    });

    it('extracts registrable sites including common two-level ccTLDs', () => {
        expect(extractSite('cdn.api.github.com')).toBe('github.com');
        expect(extractSite('news.bbc.co.uk.')).toBe('bbc.co.uk');
        expect(extractSite('localhost')).toBe('localhost');
    });

    it('maps domains against blocked service rules and tracks live hot deltas', () => {
        const serviceMap = extractServiceMap([
            {
                id: 'youtube',
                name: 'YouTube',
                icon_svg: '',
                rules: ['||youtube.com^', '||googlevideo.com^'],
                group_id: 'streaming',
            },
        ]);

        expect(lookupService('r3---sn.googlevideo.com', serviceMap)?.name).toBe('YouTube');
        expect(lookupService('unrelated.example.org', serviceMap)).toBeUndefined();

        const prev = new Map<string, number>([
            ['allowed:www.youtube.com', 90],
            ['blocked:ads.example.com', 10],
        ]);

        const tiles = buildTrafficTiles(
            [
                { domain: 'www.youtube.com', count: 120 },
                { domain: 'r1.googlevideo.com', count: 30 },
                { domain: 'docs.example.org', count: 50 },
            ],
            [{ domain: 'ads.example.com', count: 25 }],
            'service',
            'all',
            serviceMap,
            prev,
            1,
        );

        expect(tiles[0].label).toBe('YouTube');
        expect(tiles[0].service).toBe(true);
        expect(tiles[0].count).toBe(150);
        expect(tiles[0].delta).toBe(30);
        expect(tiles[0].hot).toBe(true);
        expect(tiles[0].members).toHaveLength(2);

        const blockedOnly = buildTrafficTiles(
            [{ domain: 'docs.example.org', count: 50 }],
            [{ domain: 'ads.example.com', count: 25 }],
            'name',
            'blocked',
            serviceMap,
            new Map(),
        );
        expect(blockedOnly).toHaveLength(1);
        expect(blockedOnly[0].status).toBe('blocked');
    });
});
