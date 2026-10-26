import { AlertTriangle, Check, CheckCircle2, Clock3, RefreshCw, ServerCrash } from 'lucide-react';
import { Link } from 'wouter';
export function StatusPill({ status }) {
    const tone = statusTone(status);
    const label = status.replaceAll('_', ' ');
    return <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[.08em] ${tone}`} data-testid={`status-${status}`}><span className="h-1.5 w-1.5 rounded-full bg-current"/>{label}</span>;
}
export function statusTone(status) {
    if (['verified', 'operational', 'ready', 'completed', 'success'].includes(status))
        return 'border-emerald-200 bg-emerald-50 text-emerald-700';
    if (['failed', 'offline', 'timeout', 'error'].includes(status))
        return 'border-red-200 bg-red-50 text-red-700';
    if (['degraded', 'warning'].includes(status))
        return 'border-amber-200 bg-amber-50 text-amber-700';
    return 'border-sky-200 bg-sky-50 text-sky-700';
}
export function PageIntro({ eyebrow, title, description, action }) {
    return <div className="mb-8 flex flex-col justify-between gap-5 md:flex-row md:items-end"><div className="ff-rise"><div className="ff-mono mb-2 text-[10px] font-medium uppercase tracking-[.25em] text-accent-foreground/65">{eyebrow}</div><h1 className="text-3xl font-semibold tracking-[-.045em] text-foreground md:text-[38px]">{title}</h1>{description && <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>}</div>{action && <div className="ff-rise ff-delay-1 shrink-0">{action}</div>}</div>;
}
export function MetricCard({ label, value, detail, accent = false, icon }) {
    return <div className={`relative overflow-hidden rounded-xl border p-5 shadow-[0_1px_0_rgba(18,55,67,.03)] ${accent ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card'}`}><div className="flex items-center justify-between"><span className={`ff-mono text-[10px] uppercase tracking-[.18em] ${accent ? 'text-primary-foreground/60' : 'text-muted-foreground'}`}>{label}</span>{icon}</div><div className="mt-5 text-3xl font-semibold tracking-[-.05em]" data-testid={`metric-${label.toLowerCase().replaceAll(' ', '-')}`}>{value}</div><div className={`mt-2 text-xs ${accent ? 'text-primary-foreground/65' : 'text-muted-foreground'}`}>{detail}</div>{accent && <div className="absolute -right-5 -top-8 h-28 w-28 rounded-full border-[16px] border-accent/20"/>}</div>;
}
export function SectionHeading({ kicker, title, href, linkLabel = 'View all' }) {
    return <div className="mb-4 flex items-end justify-between"><div>{kicker && <div className="ff-mono mb-1 text-[10px] uppercase tracking-[.22em] text-muted-foreground">{kicker}</div>}<h2 className="text-base font-semibold tracking-tight">{title}</h2></div>{href && <Link href={href} data-testid={`link-view-${title.toLowerCase().replaceAll(' ', '-')}`} className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">{linkLabel} <span aria-hidden>→</span></Link>}</div>;
}
export function QueryError({ message = 'Could not load this signal.', retry }) {
    return <div className="flex min-h-36 flex-col items-center justify-center rounded-xl border border-red-200 bg-red-50/60 p-6 text-center"><ServerCrash size={20} className="mb-3 text-red-600"/><p className="text-sm font-medium text-red-900">{message}</p>{retry && <button onClick={retry} data-testid="button-retry" className="mt-3 inline-flex items-center gap-2 text-xs font-semibold text-red-700 hover:text-red-900"><RefreshCw size={13}/> Retry connection</button>}</div>;
}
export function EmptyState({ title, message, action }) {
    return <div className="flex min-h-52 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/60 p-8 text-center"><div className="mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-secondary text-muted-foreground"><Check size={17}/></div><h3 className="text-sm font-semibold">{title}</h3><p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">{message}</p>{action && <div className="mt-5">{action}</div>}</div>;
}
export function LoadingBlock({ rows = 3 }) {
    return <div className="space-y-3">{Array.from({ length: rows }).map((_, i) => <div key={i} className="ff-skeleton h-14 rounded-lg"/>)}</div>;
}
export function ServiceRow({ service }) {
    return <div className="flex items-center gap-3 border-b border-border/70 py-3 last:border-0"><span className={`h-2 w-2 shrink-0 rounded-full ${service.status === 'operational' ? 'bg-emerald-500' : service.status === 'degraded' ? 'bg-amber-500' : 'bg-red-500'}`}/><div className="min-w-0 flex-1"><div className="text-sm font-medium">{service.name}</div><div className="truncate text-xs text-muted-foreground">{service.detail}</div></div><div className="text-right"><div className="ff-mono text-[11px] text-foreground">{service.latencyMs === null ? '—' : `${service.latencyMs}ms`}</div><div className="ff-mono text-[9px] uppercase tracking-wider text-muted-foreground">{service.status}</div></div></div>;
}
export function ActivityRow({ event }) {
    return <div className="flex gap-3 border-b border-border/70 py-3.5 last:border-0"><div className={`mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${event.status === 'success' ? 'bg-emerald-100 text-emerald-700' : event.status === 'error' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>{event.status === 'success' ? <CheckCircle2 size={13}/> : event.status === 'error' ? <AlertTriangle size={13}/> : <Clock3 size={13}/>}</div><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-4"><span className="text-xs font-semibold">{event.event}</span><time className="ff-mono shrink-0 text-[10px] text-muted-foreground">{relativeTime(event.createdAt)}</time></div><p className="mt-1 text-xs leading-5 text-muted-foreground">{event.message}</p>{event.repairId && <Link href={`/repairs/${event.repairId}`} data-testid={`link-activity-repair-${event.id}`} className="mt-1 inline-block ff-mono text-[10px] text-accent-foreground hover:underline">repair {event.repairId.slice(0, 8)}</Link>}</div></div>;
}
export function ProjectRow({ project }) {
    return <Link href={`/projects/${project.id}`} data-testid={`link-project-${project.id}`} className="group flex items-center gap-3 border-b border-border/70 px-4 py-3.5 last:border-0 hover:bg-secondary/45"><div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-[11px] font-bold text-primary-foreground">{project.name.slice(0, 2).toUpperCase()}</div><div className="min-w-0 flex-1"><div className="truncate text-sm font-medium group-hover:text-accent-foreground">{project.name}</div><div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground"><span>{project.language}</span><span className="h-0.5 w-0.5 rounded-full bg-muted-foreground/50"/><span className="truncate">{project.repository}</span></div></div><div className="hidden text-right sm:block"><StatusPill status={project.status}/><div className="mt-1 ff-mono text-[9px] text-muted-foreground">{project.repairCount} repairs</div></div><span className="text-muted-foreground/50 group-hover:text-foreground">→</span></Link>;
}
export function RepairRow({ repair, projectName }) {
    const percent = repair.testsTotal > 0 ? Math.round((repair.testsPassed / repair.testsTotal) * 100) : 0;
    return <Link href={`/repairs/${repair.id}`} data-testid={`link-repair-${repair.id}`} className="group grid grid-cols-[1fr_auto] gap-4 border-b border-border/70 px-4 py-4 hover:bg-secondary/45 md:grid-cols-[1.6fr_1fr_.7fr_.7fr_auto]"><div className="min-w-0"><div className="truncate text-sm font-medium group-hover:text-accent-foreground">{repair.issue}</div><div className="mt-1 ff-mono text-[10px] text-muted-foreground">{projectName || repair.projectId.slice(0, 12)} · {repair.model}</div></div><div className="hidden items-center md:flex"><StatusPill status={repair.status}/></div><div className="hidden text-sm text-muted-foreground md:block">{repair.iteration}/{repair.maxIterations}</div><div className="hidden text-sm text-muted-foreground md:block">{repair.testsTotal ? `${repair.testsPassed}/${repair.testsTotal}` : '—'} <span className="text-[10px]">({percent}%)</span></div><div className="flex items-center gap-2"><div className="md:hidden"><StatusPill status={repair.status}/></div><span className="text-muted-foreground/50 group-hover:text-foreground">→</span></div></Link>;
}
export function relativeTime(date) {
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 1000));
    if (seconds < 60)
        return `${seconds}s ago`;
    if (seconds < 3600)
        return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400)
        return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}
export function formatDate(date) {
    return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(date));
}
