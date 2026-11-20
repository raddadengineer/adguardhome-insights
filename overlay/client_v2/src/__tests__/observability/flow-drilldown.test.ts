import { describe, expect, it } from 'vitest';
import { copy } from 'panel/__tests__/helpers/copy';
import {
    hasActiveFlowFilter,
    nodeFilterPatch,
    toggleNodeFilter,
    applyLinkFilter,
    isNodeSelected,
    isLinkSelected,
    parseDrillTrail,
    serializeDrillTrail,
    applyDrillPatch,
    popTrailToIndex,
    stepBackTrail,
    buildFlowServices,
    buildFlowTree,
    buildQueryLogLink,
    resolveDomainBlockAction,
} from 'panel/helpers/observability/flowDrilldown';
import type { ServiceCatalogEntry } from 'panel/helpers/observability/treemap';
import type { StatsFlowDetailsTuple } from 'panel/api/model/statsFlowDetailsTuple';

describe('flowDrilldown helpers', () => {
    it('maps nodes across all overview and dynamic drill stages', () => {
        expect(nodeFilterPatch({ stage: 'group', name: '192.168.1.50' }, 'client')).toEqual({
            client: '192.168.1.50',
        });
        expect(nodeFilterPatch({ stage: 'group', name: 'device_laptop' }, 'tag')).toEqual({
            tag: 'device_laptop',
        });
        expect(nodeFilterPatch({ stage: 'group', name: 'doh' }, 'protocol')).toEqual({
            protocol: 'doh',
        });
        expect(nodeFilterPatch({ stage: 'client', name: '127.0.0.1' }, 'client')).toEqual({
            client: '127.0.0.1',
        });
        expect(nodeFilterPatch({ stage: 'filter_list', name: copy('custom_filtering_rules') }, 'client')).toEqual({
            filter_list: copy('custom_filtering_rules'),
        });
        expect(nodeFilterPatch({ stage: 'service', name: 'tiktok' }, 'client')).toEqual({
            service: 'tiktok',
        });
        expect(nodeFilterPatch({ stage: 'category', name: 'social_network' }, 'client')).toEqual({
            category: 'social_network',
        });
        expect(nodeFilterPatch({ stage: 'domain', name: 'ads.youtube.com' }, 'client')).toEqual({
            domain: 'ads.youtube.com',
        });
        expect(nodeFilterPatch({ stage: 'rule', name: '||doubleclick.net^' }, 'client')).toEqual({
            rule: '||doubleclick.net^',
        });
        expect(nodeFilterPatch({ stage: 'qtype', name: 'HTTPS' }, 'client')).toEqual({
            qtype: 'HTTPS',
        });
        expect(nodeFilterPatch({ stage: 'status', name: 'blocked' }, 'client')).toEqual({
            status: 'blocked',
        });
        expect(nodeFilterPatch({ stage: 'upstream', name: '1.1.1.1:53' }, 'client')).toEqual({
            upstream: '1.1.1.1:53',
        });
        expect(nodeFilterPatch({ stage: 'rcode', name: 'SERVFAIL' }, 'client')).toEqual({
            rcode: 'SERVFAIL',
        });
        expect(nodeFilterPatch({ stage: 'group', name: 'other' }, 'client')).toBeNull();
        expect(nodeFilterPatch({ stage: 'upstream', name: 'direct' }, 'client')).toBeNull();
    });

    it('manages ordered multi-level breadcrumb trail push, pop, and step back', () => {
        let state = applyDrillPatch({}, [], { status: 'blocked' });
        state = applyDrillPatch(state.filter, state.trail, { client: '127.0.0.1' });
        state = applyDrillPatch(state.filter, state.trail, { service: 'tiktok' });

        expect(state.trail).toEqual([
            { key: 'status', value: 'blocked' },
            { key: 'client', value: '127.0.0.1' },
            { key: 'service', value: 'tiktok' },
        ]);

        const raw = serializeDrillTrail(state.trail);
        expect(parseDrillTrail(raw, state.filter)).toEqual(state.trail);

        const popped = popTrailToIndex(state.trail, 1);
        expect(popped.trail).toEqual([
            { key: 'status', value: 'blocked' },
            { key: 'client', value: '127.0.0.1' },
        ]);
        expect(popped.filter).toEqual({ status: 'blocked', client: '127.0.0.1' });

        const steppedBack = stepBackTrail(popped.trail);
        expect(steppedBack.filter).toEqual({ status: 'blocked' });
    });

    it('toggles node and link filters symmetrically', () => {
        let f = toggleNodeFilter({}, { stage: 'status', name: 'blocked' }, 'client');
        expect(f).toEqual({ status: 'blocked' });
        expect(hasActiveFlowFilter(f)).toBe(true);
        expect(isNodeSelected(f, { stage: 'status', name: 'blocked' }, 'client')).toBe(true);

        f = toggleNodeFilter(f, { stage: 'status', name: 'blocked' }, 'client');
        expect(f.status).toBeUndefined();
        expect(hasActiveFlowFilter(f)).toBe(false);

        const src = { stage: 'group', name: '127.0.0.1' };
        const dst = { stage: 'status', name: 'blocked' };
        const linked = applyLinkFilter({}, src, dst, 'client');
        expect(linked).toEqual({ client: '127.0.0.1', status: 'blocked' });
        expect(isLinkSelected(linked, src, dst, 'client')).toBe(true);

        const toggledOff = applyLinkFilter(linked, src, dst, 'client');
        expect(hasActiveFlowFilter(toggledOff)).toBe(false);
    });

    it('aggregates domains into AdGuard services and eTLD+1 sites', () => {
        const youtube: ServiceCatalogEntry = { id: 'youtube', name: 'YouTube' };
        const serviceMap = new Map<string, ServiceCatalogEntry>([
            ['youtube.com', youtube],
            ['googlevideo.com', youtube],
        ]);
        const serviceById = new Map<string, ServiceCatalogEntry>([['youtube', youtube]]);

        const services = buildFlowServices(
            [
                { domain: 'www.youtube.com', count: 12, blocked: 2, clients: 2 },
                { domain: 'r1.googlevideo.com', count: 8, blocked: 8, service: 'youtube', clients: 1 },
                { domain: 'ads.doubleclick.net', count: 5, blocked: 5, clients: 2 },
            ],
            serviceMap,
            serviceById,
        );

        expect(services).toHaveLength(2);
        expect(services[0].label).toBe('YouTube');
        expect(services[0].service).toBe(true);
        expect(services[0].count).toBe(20);
        expect(services[0].blocked).toBe(10);
        expect(services[1].label).toBe('doubleclick.net');
        expect(services[1].service).toBe(false);
    });

    it('builds 4-level hierarchy trees across device, service, and rule pivots with search auto-expand', () => {
        const tuples: StatsFlowDetailsTuple[] = [
            {
                client_id: '127.0.0.1',
                client_label: 'Laptop',
                tag: 'device_laptop',
                service_id: 'tiktok',
                service_name: 'TikTok',
                category: 'social_network',
                domain: 'analytics.tiktok.com',
                filter_list: copy('blocked_services'),
                reason: 'FilteredBlockedService',
                rule: 'tiktok',
                qtype: 'HTTPS',
                status: 'blocked',
                count: 10,
                blocked: 10,
            },
            {
                client_id: '::1',
                client_label: 'Living Room TV',
                tag: 'device_tv',
                service_id: 'site:doubleclick.net',
                service_name: 'doubleclick.net',
                category: 'other',
                domain: 'ads.doubleclick.net',
                filter_list: copy('custom_filtering_rules'),
                reason: 'FilteredBlackList',
                rule: '||doubleclick.net^',
                qtype: 'AAAA',
                status: 'blocked',
                count: 6,
                blocked: 6,
            },
        ];

        const byDevice = buildFlowTree(tuples, 'device');
        expect(byDevice).toHaveLength(2);
        expect(byDevice[0].kind).toBe('client');
        expect(byDevice[0].children[0].kind).toBe('service');
        expect(byDevice[0].children[0].children[0].kind).toBe('domain');
        expect(byDevice[0].children[0].children[0].children[0].kind).toBe('rule');

        const byRule = buildFlowTree(tuples, 'rule');
        expect(byRule[0].kind).toBe('filter_list');
        expect(byRule[0].label).toBe(copy('blocked_services'));

        const searched = buildFlowTree(tuples, 'service', 'aaaa');
        expect(searched).toHaveLength(1);
        expect(searched[0].autoExpand).toBe(true);
        expect(searched[0].children[0].domain).toBe('ads.doubleclick.net');
    });

    it('builds valid Query Log links and resolves domain block/allow action', () => {
        const url = buildQueryLogLink({
            client: '127.0.0.1',
            domain: 'doubleclick.net',
            status: 'blocked',
        });
        expect(url).toContain('/logs');
        expect(url).toContain('search=doubleclick.net');
        expect(url).toContain('status=blocked');

        expect(resolveDomainBlockAction('', 'ads.example.com', 5)).toBe('allow');
        expect(resolveDomainBlockAction('@@||ads.example.com^$important\n', 'ads.example.com', 5)).toBe('block');
        expect(resolveDomainBlockAction('||custom.example.com^$important\n', 'custom.example.com', 0)).toBe('allow');
        expect(resolveDomainBlockAction('', 'clean.example.com', 0)).toBe('block');
    });
});
