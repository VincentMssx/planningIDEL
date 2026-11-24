import { useEffect, useEffectEvent, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  canReadPlanning, readAccount, readFeed, readSnapshot, todayInParis, defaultMonth, dayKey,
  dayLabel, shortDayLabel, timeLabel, effectiveStatus, slot, MONTHS, PEOPLE, STATUS,
  type Audit, type Client, type Message, type Snapshot, type Tour,
} from './data'

type Props = { db: Client; id: string; token: string; signOut: () => void; accessLost: () => void }
type Feed = Awaited<ReturnType<typeof readFeed>>
type FeedTable = 'audit' | 'messages'
type View = 'calendar' | 'contacts' | FeedTable
const tabs = [
  { view: 'calendar', label: 'Planning', icon: 'M3 6h18v15H3z M3 10h18 M7 3v5 M17 3v5' },
  { view: 'audit', label: 'Historique', icon: 'M4 11a8 8 0 1 1 2 7 M4 5v6h6 M12 8v5l3 2' },
  { view: 'messages', label: 'Chat', icon: 'M3 4h18v12H9l-6 4z M7 9h10 M7 12h6' },
  { view: 'contacts', label: 'Collègues', icon: 'M3 5h18v14H3z M3 6l9 7 9-7' },
] as const
const tours = [0, 1, 2] as const
const colleagueNames = ['Linda', 'Julie', 'Lucie'] as const
export type Contacts = Partial<Record<typeof colleagueNames[number], string>>
export type WorkspaceSource = {
  today: () => string
  allowed: () => Promise<boolean>
  snapshot: (day: string | null) => Promise<Snapshot>
  feed: (table: FeedTable, day: string, cursor?: Audit | Message) => Promise<Feed>
  contacts: () => Promise<Contacts>
  mutate: (name: string, args: Record<string, unknown>, signal: AbortSignal) => PromiseLike<{ status: number; error: { code: string; message: string } | null }>
}
const weekday = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim']
const auditTitles: Record<string, string> = { import: 'Import du planning officiel', proposal: 'Nouvelle demande', vote: 'Vote', withdrawn: 'Retrait', accepted: 'Accord appliqué', rejected: 'Refus', obsolete: 'Demande devenue obsolète' }

export function Workspace({ db, id, token, signOut, accessLost }: Props) {
  const source: WorkspaceSource = {
    today: todayInParis,
    async allowed() {
      const account = await readAccount(db)
      return account.active && !account.must_change_password && await canReadPlanning(db, id)
    },
    snapshot: (day) => readSnapshot(db, day),
    feed: (table, day, cursor) => readFeed(db, table, day, cursor),
    async contacts() {
      const { data, error } = await db.rpc('read_colleague_contacts')
      if (error) throw error
      return data as Contacts
    },
    mutate: (name, args, signal) => db.rpc(name, args).retry(false).abortSignal(signal),
  }
  return <WorkspaceView {...{ source, id, token, signOut, accessLost }} />
}

export function WorkspaceView({ source, id, token, signOut, accessLost, controls }: Omit<Props, 'db'> & { source: WorkspaceSource; controls?: ReactNode }) {
  const [today, setToday] = useState(source.today)
  const [month, setMonth] = useState(() => defaultMonth(today))
  const [tourFilter, setTourFilter] = useState<(typeof tours)[number]>(0)
  const [nurse, setNurse] = useState('')
  const [day, setDay] = useState<string | null>(null)
  const [view, setView] = useState<View>('calendar')
  const [filter, setFilter] = useState('')
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const [contacts, setContacts] = useState<Contacts>()
  const [feeds, setFeeds] = useState<{ audit?: Feed; messages?: Feed; filter: string }>({ filter: '' })
  const [draft, setDraft] = useState('')
  const [stale, setStale] = useState(false)
  const [refreshing, setRefreshing] = useState(true)
  const [busy, setBusy] = useState(false)
  const [paging, setPaging] = useState(false)
  const [notice, setNotice] = useState('')
  const [unconfirmed, setUnconfirmed] = useState(false)
  const serial = useRef(0)
  const sending = useRef(false)
  const scroll = useRef<HTMLDivElement>(null)
  const sheet = useRef<HTMLDialogElement>(null)

  async function refresh() {
    const request = ++serial.current
    setRefreshing(true)
    setPaging(false)
    setToday(source.today())
    try {
      if (!await source.allowed()) {
        if (request === serial.current) accessLost()
        return
      }
      if (request !== serial.current) return
      const [planning, audit, messages] = await Promise.all([
        source.snapshot(day),
        view === 'audit' ? source.feed('audit', filter) : undefined,
        view === 'messages' ? source.feed('messages', '') : undefined,
      ])
      if (request !== serial.current) return
      // RLS can silently return empty rows if authorization changed during the reads.
      if (!planning.members.some((m) => m.id === id && m.active)) { accessLost(); return }
      if (view === 'contacts' && planning.members.some((m) => m.id === id && m.name === 'Fanny')) {
        const data = await source.contacts()
        if (request !== serial.current) return
        setContacts(data)
      }
      setSnapshot(planning)
      setFeeds((old) => ({ filter, audit: audit ?? (old.filter === filter ? old.audit : undefined), messages: messages ?? old.messages }))
      setStale(false)
      setUnconfirmed(false)
    } catch (error) {
      if (request !== serial.current) return
      if (['42501', 'PGRST301', 'PGRST303'].includes((error as { code?: string })?.code ?? '')) { accessLost(); return }
      setStale(true)
    } finally {
      if (request === serial.current) setRefreshing(false)
    }
  }

  const refreshFromEffect = useEffectEvent(refresh)
  useEffect(() => { void refreshFromEffect() }, [token, day, view, filter])
  useEffect(() => {
    function visible() { if (document.visibilityState === 'visible') void refreshFromEffect() }
    document.addEventListener('visibilitychange', visible)
    window.addEventListener('online', visible)
    return () => {
      serial.current++
      document.removeEventListener('visibilitychange', visible)
      window.removeEventListener('online', visible)
    }
  }, [])

  function jumpMonth(index: number) {
    const container = scroll.current
    const section = container?.querySelector(`[data-month="${index}"]`)
    if (container && section) container.scrollTop = index === 0 ? 0 : container.scrollTop + section.getBoundingClientRect().top - container.getBoundingClientRect().top
    setMonth(index)
  }

  const restoreMonth = useEffectEvent(() => jumpMonth(month))
  const calendarVisible = !!snapshot && view === 'calendar'
  useEffect(() => { if (calendarVisible) restoreMonth() }, [calendarVisible])

  const sheetVisible = calendarVisible && day !== null
  useEffect(() => {
    if (sheetVisible && !sheet.current?.open) sheet.current?.showModal()
  }, [sheetVisible])

  async function mutate(name: string, args: Record<string, unknown>, onConfirmed?: () => void) {
    if (sending.current || refreshing || stale || unconfirmed) return
    sending.current = true
    setBusy(true)
    setNotice('')
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 15_000)
    try {
      const { error, status } = await source.mutate(name, args, controller.signal)
      if (error) {
        if (status === 0 || status === 408 || status >= 500) throw error
        setNotice(status === 400 && error.code === '22023' ? error.message : 'Action refusée par le serveur.')
      } else {
        onConfirmed?.()
        setNotice('Action enregistrée.')
      }
    } catch {
      setUnconfirmed(true)
      setNotice('Action non confirmée. Vérifiez les données actualisées avant toute nouvelle tentative.')
    } finally {
      window.clearTimeout(timeout)
      await refresh()
      sending.current = false
      setBusy(false)
    }
  }

  async function more(table: FeedTable, feed: Feed) {
    if (paging || refreshing || stale) return
    const request = serial.current
    setPaging(true)
    try {
      const next = await source.feed(table, filter, feed.rows.at(-1))
      if (request !== serial.current) return
      setFeeds((old) => ({ ...old, [table]: { ...next, rows: [...feed.rows, ...next.rows] } }))
    } catch {
      if (request === serial.current) { setNotice('Impossible de lire la page suivante.'); await refresh() }
    } finally { if (request === serial.current) setPaging(false) }
  }

  const person = (member: string | null) => snapshot?.members.find((m) => m.id === member)?.name ?? (member ? 'Membre' : 'Import')
  const isFanny = person(id) === 'Fanny'
  const bySlot = new Map(snapshot?.assignments.map((a) => [slot(a.day, a.tour), a]))
  const open = new Set(snapshot?.proposals.filter((p) => effectiveStatus(p, today) === 'pending').map((p) => p.id))
  const openSlots = new Set(snapshot?.lines.filter((l) => open.has(l.proposal_id)).map((l) => slot(l.day, l.tour)))
  const markedDays = new Set(snapshot?.lines.filter((l) => open.has(l.proposal_id)).map((l) => l.day))
  const toVote = [...open].filter((key) => !snapshot?.votes.some((v) => v.member_id === id && v.proposal_id === key))
  const dayProposals = snapshot?.proposals.filter((p) => snapshot.lines.some((l) => l.day === day && l.proposal_id === p.id))
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)) ?? []
  const locked = busy || refreshing || stale || unconfirmed
  const feed = view === 'messages' ? feeds.messages : view === 'audit' && feeds.filter === filter ? feeds.audit : undefined

  function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const body = draft.trim()
    if (body) void mutate('post_message', { p_body: body }, () => setDraft(''))
  }

  function saveContacts(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const input = new FormData(e.currentTarget)
    void mutate('save_colleague_contacts', {
      p_linda: String(input.get('Linda')).trim(),
      p_julie: String(input.get('Julie')).trim(),
      p_lucie: String(input.get('Lucie')).trim(),
    })
  }

  return <main className="idel-app">
    {controls}
    <header className="topbar">
      <h1 className="brand"><span className="brand-dot" aria-hidden="true" />Tournées IDEL</h1>
      <div className="top-actions">
        <span className="account-chip">{person(id)}</span>
        <button className="icon-button" aria-label="Actualiser" title="Actualiser" disabled={busy || refreshing} onClick={() => void refresh()}><Icon path="M20 5v6h-6 M20 11a8 8 0 1 0-2 7" /></button>
        {!controls && <button className="icon-button" aria-label="Déconnexion" title="Déconnexion" onClick={signOut}><Icon path="M10 4H4v16h6 M8 12h13 M17 8l4 4-4 4" /></button>}
      </div>
    </header>
    {stale && <p className="notice" role="alert">{snapshot ? 'Données non actualisées : dernière lecture disponible.' : 'Lecture indisponible.'} Vérifiez la connexion, puis actualisez.</p>}
    {notice && !sheetVisible && <p className="notice" role="status">{notice}</p>}
    {!snapshot && !stale && <p role="status">Lecture de l’espace privé…</p>}
    {snapshot && view === 'calendar' && <div className="planning-view">
      <div className="planning-controls">
        <div className="month-jump" role="group" aria-label="Mois">{MONTHS.map((name, index) =>
          <button key={name} aria-label={name} aria-pressed={month === index} onClick={() => jumpMonth(index)}>{['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin'][index]}</button>)}</div>
        <div className="filters-bar">
          <div className="tour-segment" role="group" aria-label="Tournées">{tours.map((tour) =>
            <button key={tour} aria-pressed={tourFilter === tour} aria-label={tour ? `Tournée ${tour}` : 'Les deux tournées'} onClick={() => setTourFilter(tour)}>{tour ? `T${tour}` : 'T1·T2'}</button>)}</div>
          <div className="nurse-filters" role="group" aria-label="Infirmières">
            <button aria-pressed={!nurse} onClick={() => setNurse('')}>Toutes</button>
            {PEOPLE.map((p) => <button key={p.code} className={p.color} aria-label={p.name} title={p.name} aria-pressed={nurse === p.name} onClick={() => setNurse(nurse === p.name ? '' : p.name)}>{p.code}</button>)}
          </div>
        </div>
        <div className="weekdays" aria-hidden="true">{weekday.map((label) => <span key={label}>{label}</span>)}</div>
      </div>
      <div className="planning-scroll" ref={scroll} onScroll={(event) => {
        const container = event.currentTarget
        const top = container.getBoundingClientRect().top
        const blocks = Array.from(container.querySelectorAll('[data-month]'))
        const active = blocks.findIndex((block) => block.getBoundingClientRect().bottom > top + 24)
        if (active >= 0) setMonth(active)
      }}>
        {!snapshot.assignments.length && <p className="notice">Aucun planning officiel n’a été importé.</p>}
        {MONTHS.map((name, index) => {
          const monthDays = new Date(Date.UTC(2027, index + 1, 0)).getUTCDate()
          const offset = (new Date(Date.UTC(2027, index, 1)).getUTCDay() + 6) % 7
          return <section className="month-block" key={name} data-month={index} aria-labelledby={`month-${index}`}>
            <h2 className="month-head" id={`month-${index}`}>{name} <span>2027</span></h2>
            <div className="calendar">
          {Array.from({ length: offset }, (_, i) => <span key={`gap-${i}`} />)}
          {Array.from({ length: monthDays }, (_, i) => {
            const date = dayKey(index, i + 1)
            const marked = markedDays.has(date)
            const codes = ([1, 2] as const).map((tour) => {
              const a = bySlot.get(slot(date, tour))
              return a && PEOPLE.find((p) => p.name === person(a.member_id))
            })
            return <button key={date} className={`day${marked ? ' marked' : ''}`} aria-pressed={day === date} aria-current={today === date ? 'date' : undefined}
              aria-label={`${dayLabel(date)}, tournée 1 : ${codes[0]?.name ?? 'non attribuée'}, tournée 2 : ${codes[1]?.name ?? 'non attribuée'}${marked ? ', demande ouverte' : ''}`}
              disabled={busy} onClick={() => setDay(date)}>
              <span className="day-number">{i + 1}{marked && <span className="diamond" aria-hidden="true" />}</span>
              {codes.map((p, index) => <span key={index} hidden={tourFilter !== 0 && tourFilter !== index + 1} className={`code ${p?.color ?? 'unassigned'}${nurse && p?.name !== nurse ? ' slot-dimmed' : ''}`} aria-hidden="true">{p?.code ?? '–'}</span>)}
            </button>
          })}
            </div>
          </section>
        })}
        <p className="note calendar-note">1re ligne : tournée 1 · 2e ligne : tournée 2. Le point bleu signale une demande ouverte.</p>
      </div>
      {day && <dialog className="day-sheet" ref={sheet} aria-labelledby="day-heading" onClose={() => setDay(null)}
        onClick={(event) => { if (event.target === event.currentTarget) event.currentTarget.close() }}>
        <section className="detail">
          <div className="sheet-header">
            <h2 id="day-heading">{dayLabel(day)}</h2>
            <button className="icon-button" aria-label="Fermer" autoFocus onClick={() => sheet.current?.close()}><Icon path="M6 6l12 12 M18 6L6 18" /></button>
          </div>
          <h3>Affectations officielles</h3>
          <ol className="assignments">{([1, 2] as const).map((tour) => {
            const a = bySlot.get(slot(day, tour))
            return <li key={tour}><span>Tournée {tour}</span><strong>{a ? person(a.member_id) : 'Non attribuée'}</strong></li>
          })}</ol>
          <button disabled={busy} onClick={() => { setFilter(day); setDay(null); setView('audit') }}>Historique de ce jour</button>
          {notice && <p className="notice" role="status">{notice}</p>}
          {stale && <p className="notice" role="alert">Dernière lecture disponible. Fermez la fiche pour actualiser.</p>}
          <h3>Demandes</h3>
          {!dayProposals.length && <p>{refreshing ? 'Vérification en cours…' : 'Aucune demande pour cette date.'}</p>}
          {dayProposals.map((p) => {
            const status = effectiveStatus(p, today)
            const votes = snapshot.votes.filter((v) => v.proposal_id === p.id)
            const myVote = votes.find((v) => v.member_id === id)
            return <article className="proposal" key={p.id}>
              <p><strong>{STATUS[status]}</strong> · {votes.filter((v) => v.approve).length} / 4 accords</p>
              <p className="note">Proposée par {person(p.author_id)} · {timeLabel(p.created_at)}</p>
              <ul>{snapshot.lines.filter((l) => l.proposal_id === p.id).map((l) => <li key={slot(l.day, l.tour)}>{shortDayLabel(l.day)}, tournée {l.tour} : {person(l.before_id)} → {person(l.after_id)}</li>)}</ul>
              <ul className="votes">{snapshot.members.map((m) => {
                const vote = votes.find((v) => v.member_id === m.id)
                return <li key={m.id} className={vote ? (vote.approve ? 'vote-yes' : 'vote-no') : undefined}>{m.name} : {vote ? (vote.approve ? 'oui' : 'non') : 'sans vote'}</li>
              })}</ul>
              {status === 'pending' && <div className="toolbar">
                {!myVote && <><button className="primary" disabled={locked} onClick={() => void mutate('cast_vote', { p_proposal_id: p.id, p_approve: true })}>Approuver</button><button disabled={locked} onClick={() => void mutate('cast_vote', { p_proposal_id: p.id, p_approve: false })}>Refuser</button></>}
                {p.author_id === id && <button disabled={locked} onClick={() => void mutate('withdraw_proposal', { p_proposal_id: p.id })}>Retirer</button>}
              </div>}
            </article>
          })}
          {day > today && bySlot.has(slot(day, 1)) && <ProposalForm key={day} {...{ day, today, snapshot, bySlot, openSlots, locked, mutate }} />}
          {day <= today && <p className="note">Seules les dates futures peuvent être modifiées.</p>}
        </section>
      </dialog>}
    </div>}
    {isFanny && view === 'contacts' && <section className="card feed" aria-labelledby="contacts-heading">
      <h2 id="contacts-heading">Adresses des collègues</h2>
      <p>Ces adresses sont privées. Les enregistrer ne crée pas de compte, ne change pas les identifiants et n’envoie pas d’invitation.</p>
      {!contacts && <p role="status">{stale ? 'Les adresses ne sont pas disponibles.' : 'Lecture des adresses…'}</p>}
      {contacts && <form key={JSON.stringify(colleagueNames.map((name) => contacts[name]))} onSubmit={saveContacts}>
        {colleagueNames.map((name) => <label key={name}>{name}
          <input name={name} type="email" autoComplete="off" maxLength={254} defaultValue={contacts[name] ?? ''} disabled={locked} />
        </label>)}
        <p className="note">Laissez un champ vide pour retirer l’adresse enregistrée.</p>
        <button className="primary" disabled={locked}>Enregistrer les adresses</button>
      </form>}
    </section>}
    {snapshot && (view === 'audit' || view === 'messages') && <section className={`card feed ${view === 'messages' ? 'chat-view' : 'history-view'}`}>
      <h2>{view === 'audit' ? 'Historique des décisions' : 'Chat du groupe'}</h2>
      {view === 'audit' ? <>
        <label>Filtrer par jour<input type="date" min="2027-01-01" max="2027-06-30" value={filter} onChange={(e) => setFilter(e.target.value)} /></label>
        {filter && <button onClick={() => setFilter('')}>Toutes les dates</button>}
      </> : <p id="no-patient" className="chat-info">Organisation uniquement · Aucune donnée patient</p>}
      {!feed?.rows.length && <p>{refreshing ? 'Lecture en cours…' : 'Aucun élément à afficher.'}</p>}
      <ol className="entries">{feed?.rows.map((row) => 'body' in row
        ? <li key={row.id} className={`bubble${row.member_id === id ? ' bubble-own' : ''}`}><p className="note"><strong>{person(row.member_id)}</strong> · <time dateTime={row.created_at}>{timeLabel(row.created_at)}</time></p><p className="message">{row.body}</p></li>
        : <AuditEntry key={row.id} row={row} person={person} />)}</ol>
      {feed?.more && <button disabled={paging || refreshing || stale} onClick={() => void more(view, feed)}>Afficher les éléments précédents</button>}
      {view === 'messages' && <form className="chat-compose" onSubmit={send}>
        <textarea aria-label="Message" placeholder="Écrire un message…" rows={1} maxLength={2000} required value={draft} disabled={busy} onChange={(e) => setDraft(e.target.value)} aria-describedby="no-patient" />
        <button className="primary icon-button" aria-label="Envoyer" disabled={locked || !draft.trim()}><Icon path="M12 20V4 M5 11l7-7 7 7" /></button>
      </form>}
    </section>}
    <nav className="bottom-nav" aria-label="Espace de travail">
      {tabs.filter((tab) => tab.view !== 'contacts' || isFanny).map((tab) => <button key={tab.view}
        aria-current={view === tab.view ? 'page' : undefined} disabled={busy} onClick={() => { setDay(null); if (tab.view === 'audit') setFilter(''); setView(tab.view) }}>
        <Icon path={tab.icon} /><span>{tab.label}</span>
        {tab.view === 'calendar' && toVote.length > 0 && <span className="tab-badge" aria-label={`${toVote.length} demandes à voter`}>{toVote.length}</span>}
      </button>)}
    </nav>
  </main>
}

function Icon({ path }: { path: string }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path} /></svg>
}

function ProposalForm({ day, today, snapshot, bySlot, openSlots, locked, mutate }: {
  day: string; today: string; snapshot: Snapshot; bySlot: Map<string, Snapshot['assignments'][number]>; openSlots: Set<string>; locked: boolean;
  mutate: (name: string, args: Record<string, unknown>) => Promise<void>;
}) {
  const [tour, setTour] = useState<Tour>(1)
  const [exchange, setExchange] = useState(false)
  const [choice, setChoice] = useState('')
  const current = bySlot.get(slot(day, tour))?.member_id
  const opposite = tour === 1 ? 2 : 1
  const pair = snapshot.members.filter((m) => PEOPLE.some((p) => p.name === m.name && p.tour === tour))
  const replacements = pair.filter((m) => m.id !== current && m.id !== bySlot.get(slot(day, opposite))?.member_id)
  const dates = pair.some((m) => m.id === current) ? snapshot.assignments.filter((a) =>
    a.tour === tour && a.day !== day && a.day > today && a.member_id !== current && pair.some((m) => m.id === a.member_id)
    && !openSlots.has(slot(a.day, tour)) && bySlot.get(slot(a.day, opposite))?.member_id !== current && bySlot.get(slot(day, opposite))?.member_id !== a.member_id) : []
  const options = exchange ? dates.map((a) => ({ value: a.day, label: shortDayLabel(a.day) })) : replacements.map((m) => ({ value: m.id, label: m.name }))
  const blocked = openSlots.has(slot(day, tour))
  const selected = options.some((o) => o.value === choice) ? choice : ''
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!selected || blocked || locked) return
    void mutate('create_proposal', { p_day: day, p_tour: tour, ...(exchange ? { p_other_day: selected } : { p_after_id: selected }) })
  }
  return <form className="proposal-form" onSubmit={submit}>
    <h3>Nouvelle demande</h3>
    <p className="note">Proposer compte comme votre premier oui. L’officiel ne change qu’après quatre accords.</p>
    <label>Tournée<select value={tour} onChange={(e) => { setTour(e.target.value === '2' ? 2 : 1); setChoice('') }}><option value={1}>Tournée 1</option><option value={2}>Tournée 2</option></select></label>
    <label>Type<select value={exchange ? 'exchange' : 'replace'} onChange={(e) => { setExchange(e.target.value === 'exchange'); setChoice('') }}><option value="replace">Réaffectation</option><option value="exchange">Échange de dates</option></select></label>
    <label>{exchange ? 'Autre date' : 'Nouvelle personne'}<select required value={selected} onChange={(e) => setChoice(e.target.value)} disabled={blocked || !options.length}><option value="">Choisir…</option>{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
    {blocked ? <p>Une demande est déjà ouverte pour ce créneau.</p> : !options.length && <p>Aucune option compatible.</p>}
    <button className="primary" disabled={locked || blocked || !selected}>Proposer</button>
  </form>
}

function AuditEntry({ row, person }: { row: Audit; person: (id: string | null) => string }) {
  const lines = Array.isArray(row.details.lines) ? row.details.lines as Snapshot['lines'] : []
  return <li>
    <p><strong>{auditTitles[row.kind] ?? row.kind}</strong> · {person(row.actor_id)} · <time dateTime={row.created_at}>{timeLabel(row.created_at)}</time></p>
    {row.kind === 'import' ? <p>{String(row.details.slot_count)} créneaux</p> : <p>{row.days.map(shortDayLabel).join(', ')}{row.kind === 'vote' && (row.details.approve ? ' · Oui' : ' · Non')}</p>}
    {lines.length > 0 && <ul>{lines.map((l) => <li key={slot(l.day, l.tour)}>{shortDayLabel(l.day)}, tournée {l.tour} : {person(l.before_id)} → {person(l.after_id)}</li>)}</ul>}
  </li>
}
