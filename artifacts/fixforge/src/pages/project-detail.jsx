import { ArrowLeft, ArrowUpRight, CalendarDays, Code2, GitBranch, History, Play, ShieldCheck } from 'lucide-react';
import { Link, useParams } from 'wouter';
import { getGetProjectQueryKey, getListRepairsQueryKey, useGetProject, useListRepairs } from '@workspace/api-client-react';
import { EmptyState, formatDate, LoadingBlock, PageIntro, QueryError, RepairRow, StatusPill } from '@/components/fixforge-ui';
export default function ProjectDetail() {
    const params = useParams();
    const projectId = params.id || '';
    const project = useGetProject(projectId, { query: { queryKey: getGetProjectQueryKey(projectId), enabled: Boolean(projectId) } });
    const repairs = useListRepairs({ query: { queryKey: getListRepairsQueryKey() } });
    if (project.isLoading)
        return <div className="mx-auto max-w-[1120px]"><div className="ff-skeleton mb-8 h-24 w-3/4 rounded"/><div className="ff-skeleton h-64 rounded-xl"/></div>;
    if (project.isError || !project.data)
        return <div className="mx-auto max-w-[1120px]"><QueryError message="This project could not be found." retry={() => project.refetch()}/></div>;
    const item = project.data;
    const projectRepairs = (repairs.data || []).filter((repair) => repair.projectId === item.id);
    return <div className="mx-auto max-w-[1120px]">
    <Link href="/" data-testid="link-back-dashboard" className="mb-6 inline-flex items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground"><ArrowLeft size={14}/> Overview</Link>
    <PageIntro eyebrow="Project record / 04" title={item.name} description={item.repository} action={<StatusPill status={item.status}/>}/>
    <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><InfoCard icon={<GitBranch size={15}/>} label="Repository" value={item.repository}/><InfoCard icon={<Code2 size={15}/>} label="Stack" value={`${item.language} · ${item.testFramework || 'No framework'}`}/><InfoCard icon={<History size={15}/>} label="Repairs" value={String(item.repairCount)}/><InfoCard icon={<CalendarDays size={15}/>} label="Last updated" value={formatDate(item.updatedAt)}/></div>
    <div className="grid gap-6 lg:grid-cols-[1.3fr_.7fr]">
      <section className="rounded-xl border border-border bg-card p-5"><div className="mb-4 flex items-center justify-between"><div><div className="ff-mono text-[10px] uppercase tracking-[.2em] text-muted-foreground">Repair history</div><h2 className="mt-1 text-base font-semibold">{projectRepairs.length} jobs for this project</h2></div><Link href="/new-repair" data-testid="link-project-new-repair" className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-accent-foreground"><Play size={13}/> New repair</Link></div><div className="hidden grid-cols-[1.6fr_1fr_.7fr_.7fr_auto] gap-4 border-b border-border px-4 pb-3 ff-mono text-[9px] uppercase tracking-[.14em] text-muted-foreground md:grid"><span>Issue / project</span><span>Status</span><span>Progress</span><span>Tests</span><span /></div>{repairs.isLoading ? <LoadingBlock rows={4}/> : repairs.isError ? <QueryError message="Project repairs are unavailable." retry={() => repairs.refetch()}/> : projectRepairs.length ? <div className="-mx-4">{projectRepairs.map((repair) => <RepairRow key={repair.id} repair={repair} projectName={item.name}/>)}</div> : <EmptyState title="No repairs for this project" message="Start a repair when this repository needs attention."/>}</section>
      <section className="rounded-xl border border-border bg-primary p-6 text-primary-foreground"><div className="mb-5 flex h-10 w-10 items-center justify-center rounded-xl bg-accent text-accent-foreground"><ShieldCheck size={19}/></div><div className="ff-mono text-[10px] uppercase tracking-[.2em] text-primary-foreground/50">Record integrity</div><h2 className="mt-2 text-xl font-semibold tracking-tight">An auditable project trail.</h2><p className="mt-3 text-xs leading-6 text-primary-foreground/65">FixForge keeps every repair tied to its repository context, verification policy, and test outcome.</p><div className="mt-6 border-t border-primary-foreground/10 pt-4"><div className="flex items-center justify-between text-xs"><span className="text-primary-foreground/55">Created</span><span className="ff-mono text-[10px]">{formatDate(item.createdAt)}</span></div><a href={item.repository} target="_blank" rel="noreferrer" data-testid="link-project-repository" className="mt-4 inline-flex items-center gap-2 text-xs font-semibold text-accent hover:underline">Open repository <ArrowUpRight size={14}/></a></div></section>
    </div>
  </div>;
}
function InfoCard({ icon, label, value }) { return <div className="rounded-xl border border-border bg-card p-4"><div className="mb-3 flex items-center gap-2 text-muted-foreground">{icon}<span className="ff-mono text-[10px] uppercase tracking-wider">{label}</span></div><div className="truncate text-sm font-medium" title={value}>{value}</div></div>; }
