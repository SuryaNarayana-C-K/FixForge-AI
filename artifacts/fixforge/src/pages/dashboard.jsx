import { useState, useEffect } from 'react';
import { Activity, ArrowRight, Brain, Gauge, GitPullRequest, Layers3, ShieldCheck, Timer, Zap } from 'lucide-react';
import { Link } from 'wouter';
import { getGetActivityQueryKey, getGetDashboardSummaryQueryKey, getGetServicesHealthQueryKey, getHealthCheckQueryKey, getListProjectsQueryKey, getListRepairsQueryKey, useGetActivity, useGetDashboardSummary, useGetServicesHealth, useHealthCheck, useListProjects, useListRepairs } from '@workspace/api-client-react';
import { ActivityRow, EmptyState, LoadingBlock, MetricCard, PageIntro, ProjectRow, QueryError, RepairRow, SectionHeading, ServiceRow } from '@/components/fixforge-ui';
export default function Dashboard() {
    const summary = useGetDashboardSummary({ query: { queryKey: getGetDashboardSummaryQueryKey() } });
    const apiHealth = useHealthCheck({ query: { queryKey: getHealthCheckQueryKey() } });
    const services = useGetServicesHealth({ query: { queryKey: getGetServicesHealthQueryKey() } });
    const activity = useGetActivity({ limit: 8 }, { query: { queryKey: getGetActivityQueryKey({ limit: 8 }) } });
    const projects = useListProjects({ query: { queryKey: getListProjectsQueryKey() } });
    const repairs = useListRepairs({ query: { queryKey: getListRepairsQueryKey() } });
    const [overview, setOverview] = useState(null);

    useEffect(() => {
        fetch('/api/observability/overview')
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => { if (d) setOverview(d); })
            .catch(() => {});
    }, []);

    const serviceList = services.data?.services || [];
    const repairList = repairs.data || [];
    const projectList = projects.data || [];
    return <div className="mx-auto max-w-[1440px]">
    <PageIntro eyebrow="Command center / 01" title="Good morning, Forge team." description="The pulse of your autonomous repair operation, with enough context to make the next decision." action={<Link href="/new-repair" data-testid="link-start-repair" className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-foreground shadow-sm hover:-translate-y-px hover:shadow-md">Start a repair <ArrowRight size={16}/></Link>}/>
    
    {/* Milestone 10: High-Level Platform Repair Intelligence */}
    <div className="mb-6 rounded-xl border border-sky-500/30 bg-gradient-to-r from-card via-card to-sky-950/20 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Brain size={16} className="text-sky-400" />
          <span className="ff-mono text-xs font-semibold uppercase tracking-wider text-sky-400">Platform Repair Intelligence & Evaluation</span>
          <span className="rounded bg-sky-500/10 px-1.5 py-0.5 ff-mono text-[9px] font-bold text-sky-300 border border-sky-500/20">M12.4 Live</span>
        </div>
        <Link href="/observability" className="text-xs text-sky-400 hover:underline">
          Open Intelligence Dashboard →
        </Link>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6 text-xs">
        <div className="rounded-lg bg-secondary/40 p-2.5 border border-border/60">
          <div className="text-[10px] text-muted-foreground uppercase ff-mono">Top Failure</div>
          <div className="mt-1 font-semibold text-foreground truncate">{overview?.topFailureCategory || 'DIVISION_BY_ZERO'}</div>
        </div>
        <div className="rounded-lg bg-secondary/40 p-2.5 border border-border/60">
          <div className="text-[10px] text-muted-foreground uppercase ff-mono">Top Language</div>
          <div className="mt-1 font-semibold text-foreground capitalize">{overview?.topLanguage || 'Python'}</div>
        </div>
        <div className="rounded-lg bg-secondary/40 p-2.5 border border-border/60">
          <div className="text-[10px] text-muted-foreground uppercase ff-mono">PRs Created</div>
          <div className="mt-1 font-semibold text-emerald-400 flex items-center gap-1">
            <GitPullRequest size={12} />
            {overview?.prCount ?? 0}
          </div>
        </div>
        <div className="rounded-lg bg-secondary/40 p-2.5 border border-border/60">
          <div className="text-[10px] text-muted-foreground uppercase ff-mono">High Confidence</div>
          <div className="mt-1 font-semibold text-sky-400">
            {overview?.confidenceDistribution?.HIGH ?? 0} repairs
          </div>
        </div>
        <div className="rounded-lg bg-secondary/40 p-2.5 border border-border/60">
          <div className="text-[10px] text-muted-foreground uppercase ff-mono">Low Risk Patches</div>
          <div className="mt-1 font-semibold text-emerald-400">
            {overview?.riskDistribution?.LOW ?? 0} patches
          </div>
        </div>
        <div className="rounded-lg bg-secondary/40 p-2.5 border border-border/60">
          <div className="text-[10px] text-muted-foreground uppercase ff-mono">Regression Rate</div>
          <div className="mt-1 font-semibold text-foreground">
            {overview?.regressionCount ? `${overview.regressionCount} detected` : '0% (Clean)'}
          </div>
        </div>
      </div>
    </div>

    <div className="mb-8 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {summary.isLoading ? <LoadingBlock rows={4}/> : summary.isError ? <div className="sm:col-span-2 xl:col-span-4"><QueryError message="Dashboard metrics are unavailable." retry={() => summary.refetch()}/></div> : <>
        <MetricCard label="Active repairs" value={summary.data?.activeRepairs ?? 0} detail="Currently in the forge" accent icon={<Zap size={17}/>}/>
        <MetricCard label="Success rate" value={`${summary.data?.successRate ?? 0}%`} detail={`${summary.data?.completedRepairs ?? 0} verified repairs`} icon={<ShieldCheck size={17} className="text-emerald-600"/>}/>
        <MetricCard label="Avg. iterations" value={summary.data?.averageIterations ?? 0} detail="Across completed jobs" icon={<Layers3 size={17} className="text-sky-600"/>}/>
        <MetricCard label="Avg. repair time" value={formatDuration(summary.data?.averageRepairTimeSeconds ?? 0)} detail={`${summary.data?.failedRepairs ?? 0} jobs need attention`} icon={<Timer size={17} className="text-amber-600"/>}/>
      </>}
    </div>
    <div className="mb-8 grid gap-6 xl:grid-cols-[1.15fr_.85fr]">
      <section className="rounded-xl border border-border bg-card p-5 ff-rise ff-delay-1">
        <SectionHeading kicker="Observability" title="Service health"/>
        {services.isLoading ? <LoadingBlock rows={3}/> : services.isError ? <QueryError message="Health check timed out." retry={() => services.refetch()}/> : <><div className="mb-4 flex items-center justify-between rounded-lg bg-secondary/60 px-3 py-2.5"><div className="flex items-center gap-2 text-xs font-medium"><span className={`h-2 w-2 rounded-full ${services.data?.status === 'operational' ? 'bg-emerald-500' : 'bg-amber-500'}`}/> Platform {services.data?.status}</div><span className="ff-mono text-[10px] text-muted-foreground">{services.data ? new Date(services.data.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'} checked · API {apiHealth.data?.status || 'checking'}</span></div>{serviceList.length ? serviceList.map((service) => <ServiceRow key={service.name} service={service}/>) : <EmptyState title="No services reported" message="The health endpoint returned an empty service roster."/>}</>}
      </section>
      <section className="rounded-xl border border-border bg-card p-5 ff-rise ff-delay-2">
        <SectionHeading kicker="Live feed" title="Recent activity" href="/repairs"/>
        {activity.isLoading ? <LoadingBlock rows={4}/> : activity.isError ? <QueryError message="Activity feed is unavailable." retry={() => activity.refetch()}/> : activity.data?.length ? activity.data.map((event) => <ActivityRow key={event.id} event={event}/>) : <EmptyState title="No activity yet" message="Your repair events will appear here once the first job starts." action={<Link href="/new-repair" data-testid="link-empty-activity" className="text-xs font-semibold text-accent-foreground hover:underline">Start your first repair</Link>}/>}
      </section>
    </div>
    <div className="grid gap-6 xl:grid-cols-[.85fr_1.15fr]">
      <section className="rounded-xl border border-border bg-card p-5 ff-rise ff-delay-2">
        <SectionHeading kicker="Your workspace" title="Current projects"/>
        {projects.isLoading ? <LoadingBlock rows={3}/> : projects.isError ? <QueryError message="Projects could not be loaded." retry={() => projects.refetch()}/> : projectList.length ? <div className="-mx-4">{projectList.slice(0, 5).map((project) => <ProjectRow key={project.id} project={project}/>)}</div> : <EmptyState title="No projects yet" message="Create a project while starting your first repair." action={<Link href="/new-repair" data-testid="link-empty-projects" className="text-xs font-semibold text-accent-foreground hover:underline">Create a project</Link>}/>}
      </section>
      <section className="rounded-xl border border-border bg-card p-5 ff-rise ff-delay-3">
        <SectionHeading kicker="Execution log" title="Latest repairs" href="/repairs"/>
        <div className="hidden grid-cols-[1.6fr_1fr_.7fr_.7fr_auto] gap-4 border-b border-border px-4 pb-3 ff-mono text-[9px] uppercase tracking-[.14em] text-muted-foreground md:grid"><span>Issue / project</span><span>Status</span><span>Progress</span><span>Tests</span><span /></div>
        {repairs.isLoading ? <LoadingBlock rows={4}/> : repairs.isError ? <QueryError message="Repair history is unavailable." retry={() => repairs.refetch()}/> : repairList.length ? <div className="-mx-4">{repairList.slice(0, 6).map((repair) => <RepairRow key={repair.id} repair={repair}/>)}</div> : <EmptyState title="No repair jobs" message="Once you submit an issue, the execution trail will land here." action={<Link href="/new-repair" data-testid="link-empty-repairs" className="text-xs font-semibold text-accent-foreground hover:underline">Queue a repair</Link>}/>}
      </section>
    </div>
    <div className="mt-8 flex items-center gap-3 rounded-xl border border-border bg-primary px-5 py-4 text-primary-foreground"><Gauge size={18} className="text-accent"/><p className="text-xs text-primary-foreground/75"><span className="font-semibold text-primary-foreground">Forge note:</span> Repair evidence is retained per job. Open any verified repair to inspect its iteration and test trail.</p><Activity size={17} className="ml-auto text-primary-foreground/40"/></div>
  </div>;
}
function formatDuration(seconds) {
    if (seconds < 60)
        return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
