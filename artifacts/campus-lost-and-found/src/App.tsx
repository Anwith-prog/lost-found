import { useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Camera, Check, Clock3, FileWarning, ImagePlus, Inbox, MapPin, Pin, RefreshCw, Search, Sparkles, X } from 'lucide-react';
import { Link, Route, Switch, Router as WouterRouter, useLocation } from 'wouter';
import {
  getFindReportMatchesQueryKey,
  getListReportsQueryKey,
  useCreateReport,
  useFindReportMatches,
  useListReports,
} from '@workspace/api-client-react';
import type { Report, ReportInput, ReportMatch } from '@workspace/api-client-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import './index.css';

const queryClient = new QueryClient();
const CATEGORIES = ['Electronics', 'Bags & Backpacks', 'Keys', 'Clothing', 'ID / Cards', 'Books & Notes', 'Jewelry & Accessories', 'Water Bottles', 'Other'];

function formatWhen(value: string) {
  if (!value) return 'Time not specified';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

function rotation(id: string) {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) % 500;
  return `${(hash / 500) * 4 - 2}deg`;
}

function compressImage(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Unable to read image'));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error('Unable to decode image'));
      image.onload = () => {
        const max = 720;
        const scale = Math.min(1, max / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.7));
      };
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

function Shell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return (
    <div className="board-shell">
      <header className="board-topbar">
        <Link href="/" className="brand-lockup" data-testid="link-home">
          <span className="brand-mark"><Pin size={20} strokeWidth={2.4} /></span>
          <span>
            <span className="brand-name">COMMON GROUND</span>
            <span className="brand-kicker">campus lost + found</span>
          </span>
        </Link>
        <nav className="board-nav" aria-label="Main navigation">
          <Link href="/" className={`board-nav-link ${location === '/' ? 'active' : ''}`} data-testid="link-browse">Browse board</Link>
          <Link href="/submit" className={`board-nav-link ${location === '/submit' ? 'active' : ''}`} data-testid="link-submit">Pin a report</Link>
        </nav>
      </header>
      {children}
    </div>
  );
}

function BoardState({ kind, onRetry }: { kind: 'loading' | 'empty' | 'filtered' | 'error'; onRetry?: () => void }) {
  if (kind === 'loading') {
    return (
      <div className="report-grid" data-testid="state-loading">
        {[1, 2, 3, 4, 5, 6].map((item) => <div className="skeleton-card" key={item} aria-hidden="true" />)}
      </div>
    );
  }
  if (kind === 'error') {
    return (
      <div className="board-state" data-testid="state-error">
        <div>
          <FileWarning size={31} className="state-icon" />
          <h2>The board is having a moment.</h2>
          <p>We could not read the latest pins. Check your connection and try again.</p>
          <button type="button" className="filter-btn" onClick={onRetry} data-testid="button-retry-reports"><RefreshCw size={13} /> Try again</button>
        </div>
      </div>
    );
  }
  return (
    <div className="board-state" data-testid={`state-${kind}`}>
      <div>
        <Inbox size={34} className="state-icon" />
        <h2>{kind === 'empty' ? 'A blank board, for now.' : 'No pins match that search.'}</h2>
        <p>{kind === 'empty' ? 'Lost something on campus? Leave the first note for the people who are looking.' : 'Try another item, building, or category. The board remembers every detail.'}</p>
        {kind === 'empty' && <Link href="/submit" className="board-nav-link active" data-testid="link-empty-submit">Pin the first report</Link>}
      </div>
    </div>
  );
}

function ReportCard({ report, onOpen }: { report: Report; onOpen: (report: Report) => void }) {
  return (
    <article
      className="report-card"
      style={{ transform: `rotate(${rotation(report.id)})` }}
      onClick={() => onOpen(report)}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onOpen(report); }}
      role="button"
      tabIndex={0}
      data-testid={`card-report-${report.id}`}
    >
      <span className="report-pin" aria-hidden="true" />
      <span className={`report-stamp ${report.type}`}>{report.type}</span>
      {report.image ? <img className="report-image" src={report.image} alt={`Photo of ${report.description}`} data-testid={`img-report-${report.id}`} /> : <div className="report-image-empty" data-testid={`placeholder-report-${report.id}`}><Camera size={24} /></div>}
      <h3 data-testid={`text-description-${report.id}`}>{report.description.length > 58 ? `${report.description.slice(0, 58)}…` : report.description}</h3>
      <div className="card-meta" data-testid={`text-location-${report.id}`}><MapPin size={11} /> <span>{report.location}</span></div>
      <div className="card-meta" data-testid={`text-time-${report.id}`}><Clock3 size={11} /> <span>{formatWhen(report.dateTime)}</span></div>
      <span className="category-label">{report.category}</span>
    </article>
  );
}

function MatchList({ reportId }: { reportId: string }) {
  const { data: matches, isLoading, isError, refetch } = useFindReportMatches(reportId, {
    query: { queryKey: getFindReportMatchesQueryKey(reportId) },
  });
  const safeMatches = matches ?? [];
  if (isLoading) return <div className="match-loading" data-testid="matches-loading"><Sparkles size={14} /> Comparing this pin with the rest of the board…</div>;
  if (isError) return <div className="match-error" data-testid="matches-error">Matches are taking a little longer than usual.<br /><button type="button" onClick={() => refetch()} data-testid="button-retry-matches">Try again</button></div>;
  if (!safeMatches.length) return <div className="match-empty" data-testid="matches-empty">No likely matches yet. New pins can change the story.</div>;
  return (
    <div data-testid={`matches-list-${reportId}`}>
      {safeMatches.map((match: ReportMatch) => (
        <div className="match-item" key={match.report.id} data-testid={`match-${match.report.id}`}>
          {match.report.image ? <img className="match-thumb" src={match.report.image} alt={`Possible match: ${match.report.description}`} /> : <div className="match-thumb" />}
          <div className="match-copy">
            <div className="match-topline"><strong>{match.report.description}</strong><span className="confidence">{Math.round(match.confidence)}% likely</span></div>
            <p>{match.explanation}</p>
            <p><MapPin size={11} style={{ verticalAlign: 'text-bottom' }} /> {match.report.location} · {formatWhen(match.report.dateTime)}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function DetailModal({ report, onClose }: { report: Report; onClose: () => void }) {
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose} data-testid="overlay-report-detail">
      <section className="detail-panel" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="detail-title" data-testid={`panel-report-${report.id}`}>
        <button type="button" className="close-button" onClick={onClose} aria-label="Close report details" data-testid="button-close-detail"><X size={17} /></button>
        <div className="detail-content">
          {report.image && <img className="detail-image" src={report.image} alt={`Photo of ${report.description}`} data-testid={`img-detail-${report.id}`} />}
          <span className={`report-stamp ${report.type}`} style={{ position: 'static', display: 'inline-block', transform: 'rotate(-2deg)' }}>{report.type}</span>
          <h2 id="detail-title" data-testid={`detail-description-${report.id}`}>{report.description}</h2>
          <div className="detail-meta">
            <span><MapPin size={12} /> {report.location}</span>
            <span><Clock3 size={12} /> {formatWhen(report.dateTime)}</span>
            <span>{report.category}</span>
            {report.contact && <span>Contact: {report.contact}</span>}
          </div>
          <p className="detail-description">Pinned {formatWhen(report.createdAt)}. If this sounds like your item, use the contact detail above and describe one detail that is not on the card.</p>
          <div className="matches-heading"><h3><Sparkles size={13} /> Likely matches</h3><span>board intelligence</span></div>
          <MatchList reportId={report.id} />
        </div>
      </section>
    </div>
  );
}

function HomePage() {
  const { data: reports, isLoading, isError, refetch } = useListReports({ query: { queryKey: getListReportsQueryKey() } });
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'lost' | 'found'>('all');
  const [detail, setDetail] = useState<Report | null>(null);
  const safeReports = reports ?? [];
  const filtered = useMemo(() => safeReports
    .filter((report) => filter === 'all' || report.type === filter)
    .filter((report) => {
      const needle = query.trim().toLowerCase();
      return !needle || [report.description, report.location, report.category].join(' ').toLowerCase().includes(needle);
    })
    .slice()
    .reverse(), [filter, query, safeReports]);
  return (
    <>
      <main className="board-wrap">
        <section className="board-hero">
          <div>
            <div className="eyebrow">the shared campus board</div>
            <h1 className="hero-title">Leave a note.<br /><em>Find your way</em> back.</h1>
            <p className="hero-copy">A living wall for the things that go missing between lectures, late nights, and the walk home.</p>
          </div>
          <div className="hero-note"><span>RIGHT NOW</span><strong>{safeReports.length} {safeReports.length === 1 ? 'pin' : 'pins'} on the wall</strong><span>Every report stays visible to the whole campus.</span></div>
        </section>
        <section className="board-surface" aria-label="Report board">
          <div className="board-tools">
            <label className="search-field" htmlFor="report-search"><Search size={16} /><input id="report-search" type="search" placeholder="Search item, place, category…" value={query} onChange={(event) => setQuery(event.target.value)} data-testid="input-search-reports" /></label>
            <div className="filter-group" role="group" aria-label="Filter reports">
              {(['all', 'lost', 'found'] as const).map((item) => <button type="button" className={`filter-btn ${filter === item ? 'active' : ''}`} key={item} onClick={() => setFilter(item)} data-testid={`button-filter-${item}`}>{item}</button>)}
            </div>
          </div>
          {isLoading ? <BoardState kind="loading" /> : isError ? <BoardState kind="error" onRetry={() => refetch()} /> : filtered.length ? <div className="report-grid">{filtered.map((report) => <ReportCard report={report} onOpen={setDetail} key={report.id} />)}</div> : <BoardState kind={safeReports.length ? 'filtered' : 'empty'} />}
        </section>
      </main>
      {detail && <DetailModal report={detail} onClose={() => setDetail(null)} />}
    </>
  );
}

type FormState = Omit<ReportInput, 'contact' | 'image'> & { contact: string; image: string | null };

function SubmitPage() {
  const [, setLocation] = useLocation();
  const client = useQueryClient();
  const createReport = useCreateReport();
  const [form, setForm] = useState<FormState>({ type: 'lost', description: '', location: '', dateTime: '', category: CATEGORIES[0], contact: '', image: null });
  const [imageBusy, setImageBusy] = useState(false);
  const [imageError, setImageError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [submitted, setSubmitted] = useState<Report | null>(null);
  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((current) => ({ ...current, [key]: value }));
  const canSubmit = Boolean(form.description.trim() && form.location.trim() && form.dateTime && form.category);
  const handleFile = async (file?: File) => {
    if (!file) return;
    setImageBusy(true); setImageError('');
    try { update('image', await compressImage(file)); } catch { setImageError('That image could not be attached. Try a JPG or PNG under 10MB.'); }
    setImageBusy(false);
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit || createReport.isPending) return;
    setSubmitError('');
    const payload: ReportInput = { type: form.type, description: form.description.trim(), location: form.location.trim(), dateTime: form.dateTime, category: form.category, contact: form.contact.trim() || undefined, image: form.image };
    createReport.mutate({ data: payload }, {
      onSuccess: (report) => {
        client.invalidateQueries({ queryKey: getListReportsQueryKey() });
        client.invalidateQueries({ queryKey: getFindReportMatchesQueryKey(report.id) });
        setSubmitted(report);
        setForm({ type: 'lost', description: '', location: '', dateTime: '', category: CATEGORIES[0], contact: '', image: null });
      },
      onError: () => setSubmitError('The pin did not stick. Check the fields and try again.'),
    });
  };
  return (
    <main className="board-wrap">
      <div className="form-layout">
        <section className="form-heading"><div className="eyebrow">add to the wall</div><h1>What went missing?</h1><p>Give the next person enough detail to recognize it. A specific mark, a familiar place, a way to reach you.</p></section>
        {submitted && (
          <div className="success-note" data-testid="status-report-submitted">
            <Check size={20} />
            <div><strong>Your report is pinned.</strong><span>It is now visible to everyone on campus. We are checking the board for likely matches below.</span></div>
          </div>
        )}
        <form className="report-form" onSubmit={submit} data-testid="form-create-report">
          <div className="form-inner">
            <div className="type-switch" role="group" aria-label="Report type">
              <button type="button" className={form.type === 'lost' ? 'lost-active' : ''} onClick={() => update('type', 'lost')} data-testid="button-type-lost">I lost something</button>
              <button type="button" className={form.type === 'found' ? 'found-active' : ''} onClick={() => update('type', 'found')} data-testid="button-type-found">I found something</button>
            </div>
            <div className="form-grid">
              <div className="field field-full">
                <label htmlFor="report-photo">Photo <span>(optional, helps recognition)</span></label>
                <label className="upload-drop" htmlFor="report-photo" data-testid="label-upload-photo">
                  {imageBusy ? <RefreshCw className="spin" size={22} /> : form.image ? <img src={form.image} alt="Selected report preview" data-testid="img-upload-preview" /> : <ImagePlus size={24} />}
                  <span className="upload-copy"><strong>{imageBusy ? 'Preparing photo…' : form.image ? 'Photo attached — choose another' : 'Attach a photo'}</strong><span>{imageError || 'JPG or PNG · resized privately in your browser'}</span></span>
                  <input id="report-photo" type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => handleFile(event.target.files?.[0])} data-testid="input-report-photo" />
                </label>
              </div>
              <div className="field field-full"><label htmlFor="report-description">Description</label><textarea id="report-description" placeholder="Black canvas backpack, red keychain, small tear on the left strap…" value={form.description} onChange={(event) => update('description', event.target.value)} required data-testid="input-report-description" /></div>
              <div className="field"><label htmlFor="report-category">Category</label><select id="report-category" value={form.category} onChange={(event) => update('category', event.target.value)} data-testid="select-report-category">{CATEGORIES.map((category) => <option key={category} value={category}>{category}</option>)}</select></div>
              <div className="field"><label htmlFor="report-location">Where</label><input id="report-location" placeholder="Library, north stairwell…" value={form.location} onChange={(event) => update('location', event.target.value)} required data-testid="input-report-location" /></div>
              <div className="field"><label htmlFor="report-date">When</label><input id="report-date" type="datetime-local" value={form.dateTime} onChange={(event) => update('dateTime', event.target.value)} required data-testid="input-report-datetime" /></div>
              <div className="field"><label htmlFor="report-contact">How to reach you <span>(optional)</span></label><input id="report-contact" placeholder="Email or phone" value={form.contact} onChange={(event) => update('contact', event.target.value)} data-testid="input-report-contact" /></div>
            </div>
            {submitError && <p className="form-footnote" role="alert" data-testid="status-submit-error">{submitError}</p>}
            <button className="primary-button" type="submit" disabled={!canSubmit || createReport.isPending} data-testid="button-submit-report"><Pin size={15} /> {createReport.isPending ? 'Pinning your report…' : 'Pin it to the board'}</button>
            <p className="form-footnote">Your report is shared with the campus board. Include a contact method if you would like a direct reply.</p>
          </div>
        </form>
        {submitted && <section className="report-form" style={{ marginTop: 20 }}><div className="form-inner"><div className="matches-heading"><h3><Sparkles size={13} /> Likely matches for your pin</h3><span>checking now</span></div><MatchList reportId={submitted.id} /></div></section>}
        <button type="button" className="board-nav-link" style={{ display: 'block', width: 'fit-content', margin: '20px auto 0', background: 'transparent', color: '#f2e4be' }} onClick={() => setLocation('/')} data-testid="button-back-board">Back to board</button>
      </div>
    </main>
  );
}

function Router() {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}><Switch><Route path="/" component={HomePage} /><Route path="/submit" component={SubmitPage} /><Route component={NotFound} /></Switch></ErrorBoundary>;
}

function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Shell><Router /></Shell></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;