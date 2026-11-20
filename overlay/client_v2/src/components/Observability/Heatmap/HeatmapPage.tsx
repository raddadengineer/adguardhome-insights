import { createEffect, createMemo, createSignal, Show, untrack } from 'solid-js';
import cn from 'clsx';
import { useSearchParams } from '@solidjs/router';

import intl from 'panel/common/intl';
import theme from 'panel/lib/theme';
import { Breadcrumbs } from 'panel/common/ui/Breadcrumbs';
import { Tabs } from 'panel/common/ui/Tabs';
import { RoutePath } from 'panel/components/Routes/Paths';

import { ActivityHeatmap } from './blocks/ActivityHeatmap';
import { LatencyHeatmap } from './blocks/LatencyHeatmap';
import s from './HeatmapPage.module.pcss';

export const HeatmapPage = () => {
    const [searchParams, setSearchParams] = useSearchParams<{ tab?: string }>();
    const [activeTab, setActiveTab] = createSignal<'activity' | 'latency'>(
        untrack(() => (searchParams.tab === 'latency' ? 'latency' : 'activity')),
    );

    createEffect(() => {
        if (searchParams.tab === 'latency' || searchParams.tab === 'activity') {
            setActiveTab(searchParams.tab);
        }
    });

    const tabs = createMemo(() => [
        {
            id: 'activity',
            label: intl.getMessage('obs_activity_heatmap'),
            content: (
                <Show when={activeTab() === 'activity'}>
                    <ActivityHeatmap />
                </Show>
            ),
        },
        {
            id: 'latency',
            label: intl.getMessage('obs_latency_heatmap'),
            content: (
                <Show when={activeTab() === 'latency'}>
                    <LatencyHeatmap />
                </Show>
            ),
        },
    ]);

    const handleTabChange = (tabId: string) => {
        const next = tabId === 'latency' ? 'latency' : 'activity';
        setActiveTab(next);
        setSearchParams({ tab: next }, { replace: true });
    };

    return (
        <div class={cn(theme.layout.container, s.containerOverride)}>
            <div class={cn(theme.layout.containerIn, s.page)}>
                <div class={s.headerLeft}>
                    <Breadcrumbs
                        parentLinks={[
                            {
                                path: RoutePath.Dashboard,
                                title: intl.getMessage('dashboard'),
                            },
                        ]}
                        currentTitle={intl.getMessage('obs_heatmap_title')}
                    />
                    <h1 class={cn(theme.title.h4, theme.title.h3_tablet, s.title)}>
                        {intl.getMessage('obs_heatmap_title')}
                    </h1>
                </div>

                <Tabs
                    tabs={tabs()}
                    activeTab={activeTab()}
                    onTabChange={handleTabChange}
                    fullWidth
                />
            </div>
        </div>
    );
};
