import { useCallback, useEffect, useMemo, useState } from 'react';

type Profile = {
  age: number | null;
  income: number | null;
  state: string | null;
  gender: string | null;
  category: string | null;
  occupations: string[];
  children: number | null;
  fieldSources?: Record<string, string>;
};

type Blocker = { field: string; detail: string; gap: string };

type Scheme = {
  slug: string;
  name: string;
  jurisdiction: string;
  level: string;
  summary: string;
  benefitAmount: number;
  benefitKind: string;
  benefitLine: string;
  minAge?: number;
  maxAge?: number;
  incomeCeiling: number;
  hasAgeRule?: boolean;
  hasIncomeRule?: boolean;
  womenOnly: boolean;
  docsCount: number;
  officialLink: string;
  tags: string[];
};

type Candidate = {
  scheme: Scheme;
  similarity: number | null;
  score: number;
  reasons: string[];
  blockers: Blocker[];
  shared?: string[];
};

type Result = {
  profile: Profile;
  parsedBy: string;
  matches: Candidate[];
  nearMisses: Candidate[];
  also?: Array<{ slug: string; name: string }>;
  counts: { matched: number; near: number; scanned: number; total: number; semanticPassed: number };
  receipts: {
    vectorLayer: string;
    tableLayer: string;
    vectorMs: number;
    tableMs: number;
    totalMs: number;
    semanticCandidates: number;
    tableCandidates: number;
    union: number;
    killedByRules: number;
    queries: string[];
  };
  error?: string;
};

const EXAMPLES = [
  ['a tailor in Hyderabad', '34, ₹2.4 lakh a year, two kids in school'],
  ['a farmer in Warangal', '61, two acres, ₹90,000 a year'],
  ['a dairy worker in Nizamabad', '28, about ₹1.5 lakh a year'],
];

const SENTENCES = [
  'I am a 34 year old tailor in Hyderabad, I make about 2.4 lakh a year, two kids in school',
  'I am a 61 year old farmer in Warangal with 2 acres, income around 90 thousand',
  'I run a small dairy at home in Nizamabad, I am 28, about 1.5 lakh a year',
];

function rupees(n: number): string {
  if (!n) return '';
  if (n >= 1_00_00_000) return `₹${(n / 1_00_00_000).toFixed(n % 1_00_00_000 === 0 ? 0 : 2)} crore`;
  if (n >= 1_00_000) return `₹${(n / 1_00_000).toFixed(n % 1_00_000 === 0 ? 0 : 2)} lakh`;
  return `₹${n.toLocaleString('en-IN')}`;
}

function money(c: Candidate): { big: string; small: string } {
  const { benefitAmount, benefitKind, benefitLine } = c.scheme;
  if (benefitKind === 'loan' && benefitAmount) return { big: rupees(benefitAmount), small: 'loan up to' };
  if (benefitAmount) return { big: rupees(benefitAmount), small: benefitKind === 'one-time' ? 'one-time' : 'benefit' };
  if (benefitLine) return { big: benefitLine.slice(0, 44), small: 'benefit' };
  return { big: 'Support', small: 'no amount stated' };
}

function profileChips(p: Profile): Array<{ label: string; value: string; known: boolean; key: string }> {
  return [
    { key: 'age', label: 'age', value: p.age ? `${p.age}` : 'not said', known: Boolean(p.age) },
    { key: 'income', label: 'income', value: p.income ? `${rupees(p.income)} a year` : 'not said', known: Boolean(p.income) },
    { key: 'state', label: 'state', value: p.state ?? 'not said', known: Boolean(p.state) },
    { key: 'work', label: 'work', value: p.occupations.length ? p.occupations.join(', ') : 'not said', known: p.occupations.length > 0 },
    { key: 'children', label: 'children', value: p.children ? `${p.children} in school` : 'none mentioned', known: Boolean(p.children) },
  ];
}

export default function App() {
  const [text, setText] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<'match' | 'money'>('match');
  const [meta, setMeta] = useState<{ schemes?: number; jurisdictions?: number; mode?: string } | null>(null);

  useEffect(() => {
    fetch('/api/meta')
      .then((r) => r.json())
      .then(setMeta)
      .catch(() => setMeta(null));
  }, []);

  const run = useCallback(async (sentence: string, profile?: Partial<Profile>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: sentence, profile }),
      });
      if (!res.ok) throw new Error(`Search failed (${res.status})`);
      const data = (await res.json()) as Result;
      setResult(data);
      if (data.error) setError('The database call failed, so this answer came from the local index.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    void run(text.trim());
  };

  const chips = useMemo(() => (result ? profileChips(result.profile) : []), [result]);

  const sorted = useMemo(() => {
    if (!result) return [];
    const list = [...result.matches];
    if (sort === 'money') list.sort((a, b) => (b.scheme.benefitAmount || 0) - (a.scheme.benefitAmount || 0));
    return list;
  }, [result, sort]);

  const tail = useMemo(() => {
    const list = result?.also ?? [];
    const q = filter.trim().toLowerCase();
    return q ? list.filter((s) => s.name.toLowerCase().includes(q)) : list;
  }, [result, filter]);

  const totals = useMemo(() => {
    if (!result) return null;
    const scanned = result.counts.scanned || meta?.schemes || 2066;
    const passed = result.counts.matched;
    const refused = result.receipts.killedByRules;
    const shortlisted = result.receipts.union || passed + refused;
    return {
      scanned,
      shortlisted,
      passed,
      refused,
      shown: result.matches.length,
      passedPct: Math.max(0, Math.min(100, (passed / scanned) * 100)),
      refusedPct: Math.max(0, Math.min(100, (refused / scanned) * 100)),
    };
  }, [result, meta]);

  const schemesLabel = meta?.schemes ? meta.schemes.toLocaleString('en-IN') : '2,066';

  return (
    <div className="wrap">
      <header className="masthead">
        <div className="brand">
          <span className="mark" aria-hidden="true" />
          Eligible
        </div>
        <div className="mast-meta">
          <span className="hide-sm">{schemesLabel} schemes</span>
          <span className="hide-sm">{meta?.jurisdictions ?? 36} states &amp; UTs</span>
          <a href="https://github.com/harishkotra/eligible" target="_blank" rel="noreferrer" className="hide-sm">Source</a>
          <a href="https://harishkotra.me" target="_blank" rel="noreferrer">Harish Kotra</a>
        </div>
      </header>

      <main>
        <section className="hero">
          <div className="hero-copy">
            <span className="eyebrow kicker">Central + state schemes, matched to your life</span>
            <h1>Government money you are <em>already</em> eligible for.</h1>
            <p className="lede">
              Describe your life in one sentence. Eligible checks it against {schemesLabel} eligibility
              rules, keeps the ones that pass, and names the single number that kept you out of the rest.
            </p>

            <form className="ask" onSubmit={submit}>
              <div className="ask-head">
                <label className="field-label eyebrow" htmlFor="story">Your situation, in your own words</label>
                <span className="count">no signup</span>
              </div>
              <textarea
                id="story"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="I am a 47-year-old tailor in Warangal, household income about ₹1.8 lakh, one daughter in college…"
                aria-describedby="ask-hint"
              />
              <div className="ask-foot">
                <button className="btn" type="submit" disabled={busy || !text.trim()}>
                  {busy ? <><span className="spin" aria-hidden="true" /> Reading the rules…</> : 'Show me what I qualify for'}
                </button>
                <span className="hint" id="ask-hint">Age, work, income and state do most of the work. Add what you know.</span>
              </div>
            </form>

            <div className="examples" role="group" aria-label="Example sentences">
              <span className="ex-label">Try</span>
              {EXAMPLES.map(([who, detail], i) => (
                <button key={who} type="button" className="chip" onClick={() => setText(SENTENCES[i])}>
                  {who}
                  <span>{detail}</span>
                </button>
              ))}
            </div>

            {result && (
              <div className="profile-bar">
                <span className="pb-label">We read</span>
                {chips.map((c) => (
                  <span key={c.key} className={`pb-chip${c.known ? '' : ' unknown'}`}>
                    <b>{c.label}</b> {c.value}
                  </span>
                ))}
                <button className="pb-edit" onClick={() => setEditing((v) => !v)} aria-expanded={editing}>
                  {editing ? 'Close' : 'Something wrong? Fix it'}
                </button>
              </div>
            )}

            {editing && result && (
              <EditPanel
                profile={result.profile}
                onApply={(patch) => {
                  setEditing(false);
                  void run(text || result.profile.fieldSources?.text || 'profile edit', patch);
                }}
              />
            )}
          </div>

          <aside className="method" aria-label="How the answer is decided">
            <div className="method-head">How the match is decided</div>
            <dl>
              <dt>One database reads meaning<span>VectorsDB</span></dt>
              <dd>It finds schemes that talk about a life like yours, not just pages with the same words.</dd>
              <dt>One database checks the facts<span>TablesDB</span></dt>
              <dd>State, age band, income ceiling, rupee amount, read off each scheme's own wording.</dd>
            </dl>
            <p className="method-foot">
              One record joins the two by id. Where a scheme never states a threshold, Eligible does not
              invent one, so nothing is refused for a field a scheme never mentions.
            </p>
          </aside>
        </section>

        {busy && !result && (
          <section className="results" aria-busy="true">
            <div className="grid">
              {[0, 1, 2, 3, 4].map((i) => <div key={i} className="skeleton" />)}
            </div>
          </section>
        )}

        {result && totals && (
          <section className="results" aria-live="polite">
            <div className="verdict">
              <span className="eyebrow">Verdict</span>
              <div className="res-head">
                <h2>
                  {totals.passed > 0
                    ? <><span className="n">{totals.passed}</span> schemes fit you</>
                    : 'Nothing survived the rules for this profile'}
                </h2>
                <span className="sortnote">read by the {result.parsedBy === 'rules' ? 'built-in parser' : result.parsedBy}</span>
              </div>

              <p className="res-sub">
                Of those, <b>{result.receipts.semanticCandidates}</b> came back on meaning alone, without needing
                the exact words.
                {totals.refused > 0 && (
                  <> <b>{totals.refused}</b> were stopped by one age or income number, and sit in the{' '}
                    <a className="inline-link" href="#near">refused list</a> with that number named.</>
                )}
              </p>

              <div className="scale">
                <div
                  className="scale-bar"
                  role="img"
                  aria-label={`${totals.scanned} schemes read, ${totals.shortlisted} shortlisted, ${totals.passed} passed, ${totals.refused} refused`}
                >
                  <span className="seg-passed" style={{ width: `${totals.passedPct}%` }} />
                  <span className="seg-refused" style={{ width: `${totals.refusedPct}%` }} />
                </div>
                <dl className="legend">
                  <div className="read"><dt>Read</dt><dd>{totals.scanned.toLocaleString('en-IN')}</dd></div>
                  <div className="short"><dt>Shortlisted</dt><dd>{totals.shortlisted.toLocaleString('en-IN')}</dd></div>
                  <div className="pass"><dt>Passed</dt><dd>{totals.passed.toLocaleString('en-IN')}</dd></div>
                  <div className="refuse"><dt>Refused</dt><dd>{totals.refused.toLocaleString('en-IN')}</dd></div>
                </dl>
                <p className="scale-cap">The bar is drawn to scale against every scheme that was read</p>
              </div>
            </div>

            {error && <div className="empty"><h3>Heads up</h3><p>{error}</p></div>}

            {totals.passed > 0 ? (
              <>
                <div className="list-head">
                  <div className="lh-left">
                    <span className="lh-label">What you can claim</span>
                    <span className="lh-count">{totals.shown} listed of {totals.passed}</span>
                  </div>
                  <div className="sort" role="group" aria-label="Sort the list">
                    <button type="button" aria-pressed={sort === 'match'} onClick={() => setSort('match')}>Best match</button>
                    <button type="button" aria-pressed={sort === 'money'} onClick={() => setSort('money')}>Biggest amount</button>
                  </div>
                </div>

                <div className="cols" aria-hidden="true">
                  <span>Amount</span>
                  <span>Scheme and the rule it meets</span>
                  <span>The rule</span>
                </div>

                <div className="grid">
                  {sorted.map((c) => {
                    const m = money(c);
                    const docs = c.scheme.docsCount;
                    return (
                      <article className="card" key={c.scheme.slug}>
                        <div className="money">
                          <small>{m.small}</small>
                          {m.big}
                        </div>
                        <div className="card-main">
                          <h3>{c.scheme.name}</h3>
                          <div className="meta-line">
                            <span>{c.scheme.jurisdiction}</span>
                            <span>{c.scheme.level}</span>
                            {c.scheme.womenOnly && <span className="flag">women only</span>}
                            {c.similarity !== null && <span>match {(c.similarity * 100).toFixed(0)}%</span>}
                          </div>
                          {(c.shared?.length || c.reasons.length > 0) && (
                            <ul className="why">
                              {c.shared && c.shared.length > 0 && (
                                <li className="shared">Your words “{c.shared.join('”, “')}” appear in the scheme text</li>
                              )}
                              {c.reasons.slice(0, 3).map((r) => <li key={r}>{r}</li>)}
                            </ul>
                          )}
                        </div>
                        <div className="card-act">
                          <button className="linkbtn" onClick={() => setOpen(c.scheme.slug)}>See the rule</button>
                          <span className="docs">{docs > 0 ? `${docs} documents` : 'no papers listed'}</span>
                        </div>
                      </article>
                    );
                  })}
                </div>

                {totals.passed > totals.shown && (
                  <div className="also">
                    <div className="also-row">
                      <div>
                        <b>{totals.passed - totals.shown}</b> more schemes are open to you with no rule in the way,
                        mostly central schemes that never mention your trade.
                      </div>
                      <button className="linkbtn" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
                        {showAll ? 'Hide them' : 'Show the list'}
                      </button>
                    </div>
                    {showAll && (
                      <>
                        <div className="also-tools">
                          <input
                            value={filter}
                            onChange={(e) => setFilter(e.target.value)}
                            placeholder="Filter by name, e.g. pension, scholarship, housing"
                            aria-label="Filter the long tail by name"
                          />
                          <span className="lh-count">{tail.length} of {(result.also ?? []).length}</span>
                        </div>
                        <ul className="also-list">
                          {tail.map((c) => (
                            <li key={c.slug}>
                              <button className="linkbtn" onClick={() => setOpen(c.slug)}>{c.name}</button>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="empty">
                <h3>No scheme passed every rule you meet.</h3>
                <p>
                  That is a real answer, not a failure. The refused list below shows which single rule is in the way,
                  so you know whether it is fixable: an income ceiling you are just over, an age band you have left,
                  or a scheme that only exists in another state.
                </p>
              </div>
            )}

            {result.nearMisses.length > 0 && (
              <div className="section" id="near">
                <div className="section-head">
                  <h2>Refused, and the number that refused you</h2>
                  <p>
                    Each of these came back from the meaning search because the words matched. The table then
                    rejected it, and the figure that did the rejecting is on the right.
                  </p>
                </div>
                {result.nearMisses.map((c) => (
                  <div className="miss" key={c.scheme.slug}>
                    <div className="miss-main">
                      <h3>{c.scheme.name}</h3>
                      <div className="detail">{c.blockers.map((b) => b.detail).join(' · ')}</div>
                    </div>
                    <span className="gap">{c.blockers[0]?.gap ?? 'rule not met'}</span>
                  </div>
                ))}
              </div>
            )}

            <Receipts result={result} />
          </section>
        )}
      </main>

      <footer className="foot">
        <div>
          Scheme text from the public MyScheme corpus, {schemesLabel} schemes. Rules are extracted
          conservatively: where a scheme does not state a threshold, Eligible does not invent one.
        </div>
        <div>
          Built By <a href="https://harishkotra.me" target="_blank" rel="noreferrer">Harish Kotra</a> ·
          {' '}<a href="https://dailybuild.xyz" target="_blank" rel="noreferrer">Checkout my other builds</a>
        </div>
      </footer>

      {open && <Detail slug={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function EditPanel({ profile, onApply }: { profile: Profile; onApply: (p: Partial<Profile>) => void }) {
  const [age, setAge] = useState(profile.age?.toString() ?? '');
  const [income, setIncome] = useState(profile.income?.toString() ?? '');
  const [state, setState] = useState(profile.state ?? '');

  return (
    <div className="panel">
      <label className="field"><span>Age</span>
        <input inputMode="numeric" value={age} onChange={(e) => setAge(e.target.value)} placeholder="34" />
      </label>
      <label className="field"><span>Yearly income (₹)</span>
        <input inputMode="numeric" value={income} onChange={(e) => setIncome(e.target.value)} placeholder="240000" />
      </label>
      <label className="field"><span>State</span>
        <input value={state} onChange={(e) => setState(e.target.value)} placeholder="Telangana" />
      </label>
      <div className="field">
        <button
          className="btn"
          onClick={() => onApply({
            age: age.trim() ? Number(age) : null,
            income: income.trim() ? Number(income) : null,
            state: state.trim() || null,
          })}
        >
          Re-run with this
        </button>
      </div>
    </div>
  );
}

function Receipts({ result }: { result: Result }) {
  const r = result.receipts;
  return (
    <details className="receipts">
      <summary>
        <span><span className="rlabel">The receipt</span> · both layers, counted not estimated</span>
        <span className="ms">{r.totalMs} ms</span>
      </summary>
      <div className="body">
        <div className="stat-row">
          <div className="stat"><b>{r.semanticCandidates}</b><span>candidates by meaning</span></div>
          <div className="stat"><b>{result.counts.semanticPassed}</b><span>of those passed the rules</span></div>
          <div className="stat"><b>{r.killedByRules}</b><span>refused by a number</span></div>
          <div className="stat"><b>{r.vectorMs} / {r.tableMs}</b><span>vector / table ms</span></div>
        </div>
        <div className="qblock">
          <div className="stat"><span>Layer one</span></div>
          <div className="q">{r.vectorLayer}</div>
        </div>
        <div className="qblock">
          <div className="stat"><span>Layer two</span></div>
          <div className="q">{r.tableLayer}</div>
        </div>
        <div className="qblock">
          <div className="stat"><span>Queries that ran</span></div>
          <div className="q">{r.queries.join('\n')}</div>
        </div>
        <p className="fine">
          Counted, not estimated. If this says local index, no Appwrite key was present and the meaning layer was
          computed with a lexical scorer instead of cosine similarity; the numbers above are still the real ones.
        </p>
      </div>
    </details>
  );
}

function Detail({ slug, onClose }: { slug: string; onClose: () => void }) {
  const [doc, setDoc] = useState<any>(null);

  useEffect(() => {
    fetch(`/api/scheme/${slug}`).then((r) => r.json()).then(setDoc).catch(() => setDoc(null));
  }, [slug]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="sheet-backdrop" onClick={onClose} role="presentation">
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Scheme detail" onClick={(e) => e.stopPropagation()}>
        <button className="btn ghost close" onClick={onClose}>Close</button>
        {!doc ? (
          <p style={{ color: 'var(--ink-3)' }}>Loading the rule…</p>
        ) : (
          <>
            <h2>{doc.name}</h2>

            <dl className="rule-table">
              <div className="rule-row"><dt>Applies in</dt><dd>{doc.jurisdiction}</dd></div>
              <div className="rule-row"><dt>Level</dt><dd>{doc.level}</dd></div>
              {doc.hasIncomeRule && (
                <div className="rule-row"><dt>Income ceiling</dt><dd>{rupees(doc.incomeCeiling)} a year</dd></div>
              )}
              {doc.hasAgeRule && (
                <div className="rule-row"><dt>Age band</dt><dd>{doc.minAge}–{doc.maxAge}</dd></div>
              )}
              {doc.docsCount > 0 && (
                <div className="rule-row"><dt>Papers asked for</dt><dd>{doc.docsCount}</dd></div>
              )}
            </dl>

            <div className="block">
              <h4>What it gives</h4>
              <p>{doc.benefitLine || doc.summary || 'The source does not state a single amount.'}</p>
            </div>

            <div className="block">
              <h4>Eligibility, as written</h4>
              <p style={{ whiteSpace: 'pre-wrap' }}>{(doc.eligibilityExcerpt || doc.summary || '').slice(0, 1400)}</p>
            </div>

            {doc.documents?.length > 0 && (
              <div className="block">
                <h4>Documents it asks for</h4>
                <ul>{doc.documents.slice(0, 12).map((d: string) => <li key={d}>{d}</li>)}</ul>
              </div>
            )}

            {doc.officialLink && (
              <div className="block">
                <h4>Official page</h4>
                <p><a href={doc.officialLink} target="_blank" rel="noreferrer">Open the government page →</a></p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
