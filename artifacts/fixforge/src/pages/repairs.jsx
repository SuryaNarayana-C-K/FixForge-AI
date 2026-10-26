import { Filter, Search, SlidersHorizontal } from 'lucide-react';
import { useMemo, useState } from 'react';
import { getListProjectsQueryKey, getListRepairsQueryKey, useListProjects, useListRepairs } from '@workspace/api-client-react';
import { EmptyState, LoadingBlock, PageIntro, QueryError, RepairRow } from '@/components/fixforge-ui';
export default function Repairs() {
    const [query, setQuery] = useState('');
    const [status, setStatus] = useState('all');
    const repairs = useListRepairs({ query: { queryKey: getListRepairsQueryKey() } });
    const projects = useListProjects({ query: { queryKey: getListProjectsQueryKey() } });
    const projectNames = useMemo(() => new Map((projects.data || []).map((project) => [project.id, project.name])), [projects.data]);
    const filtered = useMemo(() => (repairs.data || []).filter((repair) => {
        const matchesQuery = !query || repair.issue.toLowerCase().includes(query.toLowerCase()) || repair.model.toLowerCase().includes(query.toLowerCase());
        return matchesQuery && (status === 'all' || repair.status === status);
    }), [repairs.data, query, status]);
    const statuses = ['all', 'queued', 'analyzing', 'patching', 'testing', 'verifying', 'verified', 'failed'];
    return <div className="mx-auto max-w-[1280px]">
    <PageIntro eyebrow="Execution log / 02" title="Repair history" description="Every attempt, iteration, and verification result in one auditable stream." action={<div className="ff-mono rounded-lg border border-border bg-card px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground">{repairs.data?.length ?? 0} total jobs</div>}/>
    <div className="mb-5 flex flex-col gap-3 rounded-xl border border-border bg-card p-3 md:flex-row">
      <label className="relative flex-1"><Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"/><input value={query} onChange={(event) => setQuery(event.target.value)} data-testid="input-search-repairs" placeholder="Search issues or models" className="h-10 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm outline-none placeholder:text-muted-foreground/70 focus:border-accent"/></label>
      <div className="flex items-center gap-2 overflow-x-auto"><SlidersHorizontal size={14} className="ml-1 shrink-0 text-muted-foreground"/><Filter size={13} className="shrink-0 text-muted-foreground"/>{statuses.map((item) => <button key={item} onClick={() => setStatus(item)} data-testid={`button-filter-${item}`} className={`whitespace-nowrap rounded-md px-2.5 py-2 text-[11px] font-medium capitalize ${status === item ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'}`}>{item.replace('_', ' ')}</button>)}</div>
    </div>
    <section className="rounded-xl border border-border bg-card p-5">
      <div className="mb-4 flex items-center justify-between"><div><div className="ff-mono text-[10px] uppercase tracking-[.2em] text-muted-foreground">Jobs</div><h2 className="mt-1 text-base font-semibold">{filtered.length} matching repairs</h2></div><div className="hidden ff-mono text-[10px] text-muted-foreground md:block">sorted by most recent</div></div>
      <div className="hidden grid-cols-[1.6fr_1fr_.7fr_.7fr_auto] gap-4 border-b border-border px-4 pb-3 ff-mono text-[9px] uppercase tracking-[.14em] text-muted-foreground md:grid"><span>Issue / project</span><span>Status</span><span>Progress</span><span>Tests</span><span /></div>
      {repairs.isLoading ? <LoadingBlock rows={6}/> : repairs.isError ? <QueryError message="Repair history is unavailable." retry={() => repairs.refetch()}/> : filtered.length ? <div className="-mx-4">{filtered.map((repair) => <RepairRow key={repair.id} repair={repair} projectName={projectNames.get(repair.projectId)}/>)}</div> : <EmptyState title={query || status !== 'all' ? 'No matching repairs' : 'No repairs recorded'} message={query || status !== 'all' ? 'Try a different search or clear the status filter.' : 'Queue a repair to start building an evidence trail.'}/>}
    </section>
  </div>;
}
