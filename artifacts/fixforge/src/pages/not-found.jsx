import { Link } from 'wouter';
import { ArrowLeft, CircleOff } from 'lucide-react';
export default function NotFound() {
    return (<div className="flex min-h-[60dvh] items-center justify-center">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-secondary text-muted-foreground"><CircleOff size={21}/></div>
        <div className="ff-mono text-[10px] uppercase tracking-[.25em] text-muted-foreground">Signal not found</div>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">That route is outside the forge.</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">The page you requested does not exist in this workspace.</p>
        <Link href="/" data-testid="link-not-found-home" className="mt-6 inline-flex items-center gap-2 text-xs font-semibold text-accent-foreground hover:underline"><ArrowLeft size={14}/> Return to overview</Link>
      </div>
    </div>);
}
