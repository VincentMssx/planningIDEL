import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { canReadPlanning, readAccount, type Client } from './data'
import { Workspace } from './workspace'
import { Admin } from './admin'

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return <main className="access"><p className="eyebrow">Planning IDEL · 2027</p><h1>{title}</h1>{children}</main>
}

export function App({ db }: { db: Client }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  useEffect(() => {
    const { data } = db.auth.onAuthStateChange((event, next) => {
      if (event !== 'PASSWORD_RECOVERY') setSession(next)
    })
    return () => data.subscription.unsubscribe()
  }, [db])
  if (session === undefined) return <Panel title="Connexion"><p role="status">Vérification de la session…</p></Panel>
  if (!session) return <Login db={db} />
  return <Gate key={session.user.id} db={db} session={session} />
}

function Login({ db }: { db: Client }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (busy) return
    const form = e.currentTarget
    const fields = new FormData(form)
    setBusy(true)
    setError('')
    try {
      const result = await db.auth.signInWithPassword({ email: String(fields.get('email')).trim(), password: String(fields.get('password')) })
      if (result.error) throw result.error
      form.reset()
    } catch { setError('Connexion impossible. Vérifiez les identifiants et la connexion réseau.') }
    finally { setBusy(false) }
  }
  return <Panel title="Espace privé des tournées">
    <p>Janvier à juin 2027. Connexion réservée aux membres et à l’administrateur.</p>
    <form onSubmit={submit}>
      <label>Adresse e-mail<input name="email" type="email" autoComplete="username" required /></label>
      <label>Mot de passe<input name="password" type="password" autoComplete="current-password" required /></label>
      <button className="primary" disabled={busy}>Se connecter</button>
    </form>
    {error && <p role="alert">{error}</p>}
  </Panel>
}

type Phase = 'loading' | 'denied' | 'password' | 'mfa' | 'reauth' | 'ready' | 'admin' | 'unavailable'

function Gate({ db, session }: { db: Client; session: Session }) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [retry, setRetry] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [signedOut, setSignedOut] = useState(false)
  const [operatorFactorId, setOperatorFactorId] = useState<string | null>(null)
  const gated = useRef(false)
  const id = session.user.id
  const token = session.access_token

  useEffect(() => {
    let current = true
    async function check() {
      try {
        const account = await readAccount(db)
        if (!current) return
        if (!account.active) { gated.current = false; setPhase('denied'); return }
        if (account.must_change_password) { gated.current = false; setPhase('password'); return }
        if (account.operator) {
          gated.current = false
          if (account.operator_factor_id === undefined) { setPhase('unavailable'); return }
          setOperatorFactorId(account.operator_factor_id)
          setPhase(!account.operator_session_fresh ? 'reauth' : account.verified && account.operator_factor_id ? 'admin' : 'mfa')
          return
        }
        const allowed = await canReadPlanning(db, id)
        if (!current) return
        gated.current = allowed
        setPhase(allowed ? 'ready' : 'denied')
      } catch {
        if (current && !gated.current) setPhase('unavailable')
      }
    }
    if (!signedOut) void check()
    return () => { current = false }
  }, [db, token, id, retry, signedOut])

  function accessLost() {
    gated.current = false
    setPhase('loading')
    setRetry((n) => n + 1)
  }

  async function signOut() {
    setSignedOut(true)
    setError('')
    try {
      const result = await db.auth.signOut({ scope: 'local' })
      if (result.error) throw result.error
    } catch { setError('Déconnexion non confirmée. Réessayez avant de quitter un appareil partagé.') }
  }

  async function act(operation: () => Promise<void>, failure: string) {
    if (busy) return
    setBusy(true)
    setError('')
    try { await operation() }
    catch { setError(failure) }
    finally { setBusy(false) }
  }

  function password(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const values = new FormData(form)
    const next = String(values.get('password'))
    if (next !== values.get('repeat')) { setError('Les deux saisies ne correspondent pas.'); return }
    void act(async () => {
      const update = await db.auth.updateUser({ password: next })
      if (update.error) throw update.error
      form.reset()
      const complete = await db.rpc('complete_password_change')
      if (complete.error) throw complete.error
      setRetry((n) => n + 1)
    }, 'Changement non confirmé. Si le nouveau mot de passe a été enregistré, utilisez « Vérifier le changement ».')
  }

  if (signedOut) return <Panel title="Déconnexion"><p role="status">{error || 'Fermeture de la session…'}</p>{error && <button onClick={() => void signOut()}>Réessayer</button>}</Panel>
  if (phase === 'ready') return <Workspace db={db} id={id} token={token} signOut={() => void signOut()} accessLost={accessLost} />
  if (phase === 'admin') return <Admin db={db} token={token} signOut={() => void signOut()} accessLost={accessLost} />
  if (phase === 'mfa') return <OperatorMfa db={db} pinned={operatorFactorId} onVerified={() => setRetry((n) => n + 1)} signOut={() => void signOut()} />
  return <Panel title={{ loading: 'Vérification de la session', denied: 'Accès indisponible', unavailable: 'Service inaccessible', password: 'Nouveau mot de passe', reauth: 'Reconnexion nécessaire' }[phase]}>
    {phase === 'loading' && <p role="status">Vérification en cours…</p>}
    {phase === 'denied' && <p>Cette session ne donne pas accès à l’espace privé. Contactez la personne chargée des comptes.</p>}
    {phase === 'reauth' && <p>La session d’administration a expiré. Déconnectez-vous puis reconnectez-vous avec votre mot de passe.</p>}
    {phase === 'unavailable' && <button onClick={() => setRetry((n) => n + 1)}>Vérifier à nouveau</button>}
    {phase === 'password' && <>
      <p>Remplacez le mot de passe temporaire par un mot de passe unique d’au moins 14 caractères.</p>
      <form onSubmit={password}>
        <label>Nouveau mot de passe<input name="password" type="password" autoComplete="new-password" minLength={14} required /></label>
        <label>Confirmer le mot de passe<input name="repeat" type="password" autoComplete="new-password" minLength={14} required /></label>
        <button className="primary" disabled={busy}>Changer le mot de passe</button>
      </form>
      <button disabled={busy} onClick={() => void act(async () => {
        const result = await db.rpc('complete_password_change')
        if (result.error) throw result.error
        setRetry((n) => n + 1)
      }, 'Aucun changement confirmé. Remplacez d’abord le mot de passe temporaire.')}>Vérifier le changement</button>
    </>}
    {error && <p role="alert">{error}</p>}
    <button className="quiet" disabled={busy} onClick={() => void signOut()}>Déconnexion</button>
  </Panel>
}

type MfaStep =
  | { kind: 'loading' | 'retry' | 'start' | 'missing' }
  | { kind: 'verify'; id: string }
  | { kind: 'setup'; id: string; qr: string; secret: string }
  | { kind: 'pending'; ids: string[] }

function OperatorMfa({ db, pinned, onVerified, signOut }: { db: Client; pinned: string | null; onVerified: () => void; signOut: () => void }) {
  const [step, setStep] = useState<MfaStep>({ kind: 'loading' })
  const [retry, setRetry] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let current = true
    async function load() {
      try {
        const { data, error } = await db.auth.mfa.listFactors()
        if (error) throw error
        if (!current) return
        const ids = data.totp.map((factor) => factor.id)
        setStep(pinned ? (ids.includes(pinned) ? { kind: 'verify', id: pinned } : { kind: 'missing' })
          : (ids.length ? { kind: 'pending', ids } : { kind: 'start' }))
      } catch { if (current) setStep({ kind: 'retry' }) }
    }
    void load()
    return () => { current = false }
  }, [db, pinned, retry])

  async function enroll() {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const { data, error } = await db.auth.mfa.enroll({ factorType: 'totp', issuer: 'Planning IDEL' })
      if (error) throw error
      // Supabase JS wraps the raw SVG in a data URL; encode SVG characters for img.
      const svg = data.totp.qr_code.replace(/^data:image\/svg\+xml;utf-8,/, '')
      setStep({ kind: 'setup', id: data.id, qr: `data:image/svg+xml,${encodeURIComponent(svg)}`, secret: data.totp.secret })
    } catch { setError('Configuration indisponible. Réessayez ou contactez le responsable du service.') }
    finally { setBusy(false) }
  }

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || (step.kind !== 'setup' && step.kind !== 'verify')) return
    const form = event.currentTarget
    const code = String(new FormData(form).get('code') ?? '').trim()
    if (!/^\d{6}$/.test(code)) return
    setBusy(true)
    setError('')
    try {
      const { error } = await db.auth.mfa.challengeAndVerify({ factorId: step.id, code })
      if (error) throw error
      form.reset()
      if (step.kind === 'setup') setStep({ kind: 'pending', ids: [step.id] })
      onVerified()
    } catch { setError('Code non confirmé. Vérifiez la connexion ou saisissez le prochain code de votre application.') }
    finally { setBusy(false) }
  }

  return <Panel title="Vérification de l’administration">
    {step.kind === 'loading' && <p role="status">Vérification du second facteur…</p>}
    {step.kind === 'retry' && <><p role="alert">Impossible de vérifier le second facteur.</p><button onClick={() => { setStep({ kind: 'loading' }); setRetry((n) => n + 1) }}>Réessayer</button></>}
    {step.kind === 'missing' && <p role="alert">Le second facteur autorisé n’est plus disponible. Contactez le responsable du service.</p>}
    {step.kind === 'start' && <><p>Configurez une application d’authentification. Le responsable du service devra ensuite approuver cet appareil avant le premier accès.</p>
      <button className="primary" disabled={busy} onClick={() => void enroll()}>Configurer le second facteur</button></>}
    {step.kind === 'setup' && <>
      <p>Scannez ce QR code avec votre application d’authentification. Ne partagez ni le QR code ni sa clé.</p>
      <img src={step.qr} width="180" height="180" alt="QR code de configuration du second facteur" />
      <details><summary>Afficher la clé de configuration manuelle</summary><code>{step.secret}</code></details>
    </>}
    {(step.kind === 'setup' || step.kind === 'verify') && <form onSubmit={verify}>
      <label>Code de l’application d’authentification<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required /></label>
      <button className="primary" disabled={busy}>Vérifier le code</button>
    </form>}
    {step.kind === 'pending' && <>
      <p>Second facteur vérifié. Communiquez sa référence au responsable du service, puis reconnectez-vous après son approbation.</p>
      <ul>{step.ids.map((id) => <li key={id}><code>{id}</code></li>)}</ul>
    </>}
    {error && <p role="alert">{error}</p>}
    <button className="quiet" disabled={busy} onClick={signOut}>Déconnexion</button>
  </Panel>
}
