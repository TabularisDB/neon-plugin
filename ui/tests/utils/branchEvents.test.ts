// @vitest-environment jsdom
import {act, cleanup, renderHook, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {useBranches} from '../../src/hooks/useBranches';

const {events, account, states, rpcs, translate, publish} = vi.hoisted(() => ({
    events: new Map<string, Set<(detail: unknown) => void>>(),
    account: {
        connections: [],
        importConnection: vi.fn(),
        openConnection: vi.fn(),
        callConnection: vi.fn(),
    },
    states: new Map<
        string,
        {
            scope: {projectId: string; branchId: string};
            call: ReturnType<typeof vi.fn>;
            pending: boolean;
        }
    >(),
    rpcs: new Map<string, {call: ReturnType<typeof vi.fn>}>(),
    translate: (key: string) => key,
    publish: vi.fn(),
}));
vi.mock('../../src/hooks/useNeonManagement', () => ({
    useNeonManagement: (id: string) => states.get(id),
}));
vi.mock('@tabularis/plugin-api', async () => {
    const {useEffect} = await import('react');
    return {
        usePluginAccount: () => account,
        usePluginRpc: (_plugin: string, id: string) => rpcs.get(id),
        usePluginTranslation: () => translate,
        publishPluginEvent: publish,
        usePluginEvent: (plugin: string, name: string, listener: (detail: unknown) => void) => {
            useEffect(() => {
                const key = `${plugin}:${name}`;
                const subscribed = events.get(key) ?? new Set();
                subscribed.add(listener);
                events.set(key, subscribed);
                return () => {
                    subscribed.delete(listener);
                };
            }, [plugin, name, listener]);
        },
    };
});
afterEach(cleanup);
beforeEach(() => {
    vi.clearAllMocks();
    events.clear();
    states.clear();
    rpcs.clear();
    for (const [id, projectId, branchId] of [
        ['one', 'project', 'branch'],
        ['two', 'project', 'branch'],
        ['foreign-project', 'other', 'branch'],
        ['foreign-branch', 'project', 'other'],
    ]) {
        states.set(id, {
            scope: {projectId, branchId},
            pending: false,
            call: vi
                .fn()
                .mockImplementation((method: string) =>
                    Promise.resolve(
                        method === 'account_branch_list'
                            ? {projectName: projectId, branches: []}
                            : null,
                    ),
                ),
        });
        rpcs.set(id, {
            call: vi.fn().mockResolvedValue({projectId, branchId, database: 'db', role: 'owner'}),
        });
    }
    publish.mockImplementation(async (plugin: string, name: string, detail: unknown) => {
        for (const listener of [...(events.get(`${plugin}:${name}`) ?? [])]) listener(detail);
    });
});

const lists = (id: string) =>
    states.get(id)!.call.mock.calls.filter(([method]) => method === 'account_branch_list').length;

describe('branch change events', () => {
    it('refreshes every branch view in the same project, excluding self and other projects', async () => {
        const one = renderHook(() => useBranches('one'));
        const two = renderHook(() => useBranches('two'));
        renderHook(() => useBranches('foreign-project'));
        renderHook(() => useBranches('foreign-branch'));
        await waitFor(() =>
            expect(['one', 'two', 'foreign-project', 'foreign-branch'].map(lists)).toEqual([
                1, 1, 1, 1,
            ]),
        );
        await act(async () => {
            await one.result.current.mutate('account_branch_rename', {name: 'renamed'}, 'renamed');
        });
        await waitFor(() =>
            expect(['one', 'two', 'foreign-project', 'foreign-branch'].map(lists)).toEqual([
                2, 2, 1, 2,
            ]),
        );
        expect(publish).toHaveBeenCalledWith('neon', 'branch-changed', {
            projectId: 'project',
            branchId: 'branch',
            origin: expect.any(String),
        });
        two.unmount();
        await act(() =>
            publish('neon', 'branch-changed', {
                projectId: 'project',
                branchId: 'branch',
                origin: 'external',
            }),
        );
        await waitFor(() => expect(lists('one')).toBe(3));
        expect(lists('two')).toBe(2);
        expect(lists('foreign-branch')).toBe(3);
        expect(lists('foreign-project')).toBe(1);
    });

    it('ignores malformed events and removes the old scope after switching connections', async () => {
        const view = renderHook(({id}) => useBranches(id), {initialProps: {id: 'one'}});
        await waitFor(() => expect(lists('one')).toBe(1));
        for (const detail of [
            null,
            {},
            {projectId: 'project'},
            {projectId: 'project', branchId: 'other'},
        ])
            await act(() => publish('neon', 'branch-changed', detail));
        expect(lists('one')).toBe(1);
        view.rerender({id: 'foreign-project'});
        await waitFor(() => expect(lists('foreign-project')).toBe(1));
        await act(() =>
            publish('neon', 'branch-changed', {
                projectId: 'project',
                branchId: 'branch',
                origin: 'external',
            }),
        );
        expect(lists('one')).toBe(1);
        expect(lists('foreign-project')).toBe(1);
    });
});
