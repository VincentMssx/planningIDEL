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

type Phase = 'loading' | 'denied' | 'password' | 'email' | 'ready' | 'admin' | 'unavailable'

function Gate({ db, session }: { db: Client; session: Session }) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [retry, setRetry] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [mailStatus, setMailStatus] = useState('')
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
        if (!account.active) { gated.current = false; setPhase('denied'); return }
        if (account.must_change_password) { gated.current = false; setPhase('password'); return }
        if (account.operator) {
          gated.current = false
          setPhase(account.verified ? 'admin' : 'email')
          return
        }
        const allowed = await canReadPlanning(db, id)
        if (!current) return
        gated.current = allowed
        setPhase(allowed ? 'ready' : 'email')
      } catch {
        if (current && !gated.current) setPhase('unavailable')
      }
    }
    if (!signedOut) void check()
    return () => { current = false }
  }, [db, token, id, retry, signedOut])

  function accessLost() {
    gated.current = false
    setMailStatus('')
    setPhase('loading')
    setRetry((n) => n + 1)
  }

  async function signOut() {
    setSignedOut(true)
    setMailStatus('')
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

  function sendCode() {
    void act(async () => {
      const result = await db.rpc('request_email_code').retry(false)
      if (result.error) throw result.error
      switch (result.data) {
        case 'sent': setMailStatus('Code envoyé. Il est valable 10 minutes. Pensez à vérifier les indésirables.'); break
        case 'wait': setError('Attendez une minute entre deux envois.'); break
        case 'limit': setError('Limite d’envoi atteinte. Réessayez plus tard.'); break
        case 'denied':
        case 'verified': setRetry((n) => n + 1); break
        default: throw new Error('Envoi indisponible')
      }
    }, 'Envoi non confirmé. Vérifiez votre boîte de réception avant de réessayer.')
  }

  function verify(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const code = String(new FormData(form).get('code')).trim()
    void act(async () => {
      const result = await db.rpc('verify_email_code', { p_code: code }).retry(false)
      if (result.error) throw result.error
      switch (result.data) {
        case 'denied':
        case 'verified': form.reset(); setRetry((n) => n + 1); break
        case 'invalid': setError('Code incorrect. Vérifiez les six chiffres reçus.'); break
        case 'expired': setError('Code expiré ou absent pour cette session. Demandez un nouveau code.'); break
        case 'limit': setError('Trop de tentatives. Demandez un nouveau code.'); break
        default: throw new Error('Vérification indisponible')
      }
    }, 'Code non confirmé. Réessayez avec le dernier code reçu.')
  }

  if (signedOut) return <Panel title="Déconnexion"><p role="status">{error || 'Fermeture de la session…'}</p>{error && <button onClick={() => void signOut()}>Réessayer</button>}</Panel>
  if (phase === 'ready') return <Workspace db={db} id={id} token={token} signOut={() => void signOut()} accessLost={accessLost} />
  if (phase === 'admin') return <Admin db={db} token={token} signOut={() => void signOut()} accessLost={accessLost} />
  return <Panel title={{ loading: 'Vérification de la session', denied: 'Accès indisponible', unavailable: 'Service inaccessible', password: 'Nouveau mot de passe', email: 'Code de connexion' }[phase]}>
    {phase === 'loading' && <p role="status">Vérification en cours…</p>}
    {phase === 'denied' && <p>Cette session ne donne pas accès à l’espace privé. Si vous n’avez plus accès à votre boîte e-mail, contactez la personne chargée des comptes.</p>}
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
    {phase === 'email' && <>
      <p>Recevez un code à usage unique sur l’adresse e-mail associée à votre compte.</p>
      {mailStatus && <p role="status">{mailStatus}</p>}
      <form onSubmit={verify}>
        <label>Code à six chiffres<input name="code" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required /></label>
        <button className="primary" disabled={busy}>Vérifier le code</button>
      </form>
      <button disabled={busy} onClick={sendCode}>{mailStatus ? 'Renvoyer un code' : 'Envoyer le code par e-mail'}</button>
    </>}
    {error && <p role="alert">{error}</p>}
    <button className="quiet" disabled={busy} onClick={() => void signOut()}>Déconnexion</button>
  </Panel>
}
