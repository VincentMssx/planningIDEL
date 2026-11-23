import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { canReadPlanning, readAccount, type Client } from './data'
import { Workspace } from './workspace'

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
    <p>Janvier à juin 2027. Cet espace est réservé aux quatre membres du groupe.</p>
    <form onSubmit={submit}>
      <label>Adresse e-mail<input name="email" type="email" autoComplete="username" required /></label>
      <label>Mot de passe<input name="password" type="password" autoComplete="current-password" required /></label>
      <button className="primary" disabled={busy}>Se connecter</button>
    </form>
    {error && <p role="alert">{error}</p>}
  </Panel>
}

type Phase = 'loading' | 'denied' | 'password' | 'mfa' | 'ready' | 'unavailable'
type Enrollment = { id: string; qr: string; secret: string }

function Gate({ db, session }: { db: Client; session: Session }) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [retry, setRetry] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [factor, setFactor] = useState<string>()
  const [enrollment, setEnrollment] = useState<Enrollment>()
  const [signedOut, setSignedOut] = useState(false)
  const gated = useRef(false)
  const id = session.user.id
  const token = session.access_token

  useEffect(() => {
    let current = true
    async function check() {
      try {
        const account = await readAccount(db)
        if (!current) return
        if (!account.active) { gated.current = false; setEnrollment(undefined); setPhase('denied'); return }
        if (account.must_change_password) { gated.current = false; setEnrollment(undefined); setPhase('password'); return }
        const assurance = await db.auth.mfa.getAuthenticatorAssuranceLevel(token)
        if (!current) return
        if (assurance.error) throw assurance.error
        if (assurance.data.currentLevel === 'aal2') {
          const allowed = await canReadPlanning(db, id)
          if (!current) return
          gated.current = allowed
          setEnrollment(undefined)
          setPhase(allowed ? 'ready' : 'denied')
          return
        }
        gated.current = false
        const list = await db.auth.mfa.listFactors()
        if (!current) return
        if (list.error) throw list.error
        setFactor(list.data.totp[0]?.id)
        setPhase('mfa')
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
    setEnrollment(undefined)
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

  function enroll() {
    void act(async () => {
      const list = await db.auth.mfa.listFactors()
      if (list.error) throw list.error
      if (list.data.totp[0]) { setFactor(list.data.totp[0].id); return }
      for (const old of list.data.all.filter((f) => f.factor_type === 'totp' && f.status === 'unverified')) {
        const removed = await db.auth.mfa.unenroll({ factorId: old.id })
        if (removed.error) throw removed.error
      }
      const result = await db.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Planning IDEL' })
      if (result.error) throw result.error
      const { id, totp } = result.data
      const prefix = 'data:image/svg+xml;utf-8,'
      setEnrollment({ id, secret: totp.secret, qr: totp.qr_code.startsWith(prefix) ? `data:image/svg+xml,${encodeURIComponent(totp.qr_code.slice(prefix.length))}` : '' })
    }, 'Préparation du code impossible. Réessayez.')
  }

  function verify(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const code = String(new FormData(form).get('code')).trim()
    const factorId = factor ?? enrollment?.id
    if (!factorId) return
    void act(async () => {
      const challenge = await db.auth.mfa.challenge({ factorId })
      if (challenge.error) throw challenge.error
      const verified = await db.auth.mfa.verify({ factorId, challengeId: challenge.data.id, code })
      if (verified.error) throw verified.error
      form.reset()
      setRetry((n) => n + 1)
    }, 'Code non confirmé. Vérifiez le code courant et l’heure du téléphone, puis réessayez.')
  }

  if (signedOut) return <Panel title="Déconnexion"><p role="status">{error || 'Fermeture de la session…'}</p>{error && <button onClick={() => void signOut()}>Réessayer</button>}</Panel>
  if (phase === 'ready') return <Workspace db={db} id={id} token={token} signOut={() => void signOut()} accessLost={accessLost} />
  return <Panel title={{ loading: 'Vérification de la session', denied: 'Accès indisponible', unavailable: 'Service inaccessible', password: 'Nouveau mot de passe', mfa: 'Code d’authentification' }[phase]}>
    {phase === 'loading' && <p role="status">Vérification en cours…</p>}
    {phase === 'denied' && <p>Cette session ne donne pas accès à l’espace privé. En cas de perte du téléphone ou d’accès désactivé, contactez la personne chargée des comptes hors de l’application.</p>}
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
    {phase === 'mfa' && <>
      {!factor && !enrollment && <><p>Associez une application d’authentification sur votre téléphone.</p><button className="primary" disabled={busy} onClick={enroll}>Configurer le code TOTP</button></>}
      {!factor && enrollment && <>
        <p>Scannez le QR avec votre application d’authentification ou saisissez la clé manuellement si vous utilisez le même téléphone.</p>
        {enrollment.qr && <img className="qr" src={enrollment.qr} alt="QR de configuration TOTP" />}
        <p>Clé manuelle : <code className="secret">{enrollment.secret}</code></p>
      </>}
      {(factor || enrollment) && <form onSubmit={verify}>
        <label>Code à six chiffres<input name="code" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required /></label>
        <button className="primary" disabled={busy}>Vérifier le code</button>
      </form>}
    </>}
    {error && <p role="alert">{error}</p>}
    <button className="quiet" disabled={busy} onClick={() => void signOut()}>Déconnexion</button>
  </Panel>
}
