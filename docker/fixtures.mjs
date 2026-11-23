import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { days, validate } from './planning.mjs'

// This address is only resolvable inside the local Compose network.
const base = 'http://web'
const { IDEL_LOCAL_JWT_SECRET: secret, IDEL_LOCAL_ANON_KEY: anon } = process.env
assert.ok(secret && anon, 'Run this script using the local Compose fixtures service.')
const password = 'IDEL-local-2027-temporaire!'
const names = ['Linda', 'Julie', 'Lucie', 'Fanny']
const email = (name) => `${name.toLowerCase()}@example.test`
const json64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
const unsigned = `${json64({ alg: 'HS256', typ: 'JWT' })}.${json64({ role: 'service_role', exp: Math.floor(Date.now() / 1000) + 600 })}`
const admin = `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`

async function request(path, { method = 'GET', token = anon, body, prefer } = {}) {
  const response = await fetch(`${base}/${path}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { apikey: anon, Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(prefer ? { Prefer: prefer } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { ok: response.ok, status: response.status, data: await response.json().catch(() => null) }
}

async function get(path, options = {}) {
  const result = await request(path, options)
  assert.ok(result.ok, `${options.method ?? 'GET'} ${path}: HTTP ${result.status} ${result.data?.code ?? result.data?.error_code ?? ''} ${result.data?.message ?? ''}`)
  return result.data
}

const rpcPath = (name) => `rest/v1/rpc/${name}`
const rpc = (name, token, body = {}) => get(rpcPath(name), { method: 'POST', token, body })
const official = (token) => get('rest/v1/assignments?order=day,tour', { token })
const adminUsers = 'auth/v1/admin/users'

async function seed() {
  const existing = await get('rest/v1/members?select=id,name', { token: admin })
  const { users } = await get(adminUsers, { token: admin })
  for (const name of names) {
    if (existing.some((m) => m.name === name && users.some((u) => u.id === m.id && u.email === email(name)))) continue
    assert.ok(!existing.some((m) => m.name === name), 'Non-fixture member found: leave this database intact.')
    const user = users.find((u) => u.email === email(name)) ?? await get(adminUsers, {
      method: 'POST', token: admin, body: { email: email(name), password, email_confirm: true },
    })
    await get('rest/v1/members', { method: 'POST', token: admin, body: { id: user.id, name } })
  }
  const csv = ['date,tournee_1,tournee_2', ...days.map((day, i) => `${day},${i % 2 ? 'J,Lu' : 'L,F'}`)].join('\n')
  const { rows, errors } = validate(csv)
  assert.deepEqual(errors, [])
  const count = (await official(admin)).length
  if (!count) assert.equal(await rpc('import_schedule', admin, { p_rows: rows }), 362)
  else assert.equal(count, 362)
  return rows
}

function totp(key) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const bits = [...key.toUpperCase().replace(/=+$/, '')].map((c) => alphabet.indexOf(c).toString(2).padStart(5, '0')).join('')
  const binary = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => Number.parseInt(b, 2)))
  const time = Buffer.alloc(8)
  time.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)))
  const hmac = createHmac('sha1', binary).update(time).digest()
  return String((hmac.readUInt32BE(hmac.at(-1) & 15) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}

const login = (name, pwd = password) => get('auth/v1/token?grant_type=password', { method: 'POST', body: { email: email(name), password: pwd } })

async function verify(rows) {
  const tokens = []
  const users = []
  assert.equal((await request('rest/v1/assignments')).status, 401)
  assert.equal((await request('auth/v1/signup', { method: 'POST', body: { email: 'outsider@example.test', password } })).ok, false)
  assert.equal((await request(rpcPath('import_schedule'), { method: 'POST', token: admin, body: { p_rows: rows } })).ok, false)
  const members = await get('rest/v1/members?select=id,name,must_change_password', { token: admin })
  assert.ok(members.every((member) => member.must_change_password), 'Run verify only on fresh fixtures; it changes passwords and enrolls TOTP.')

  for (const name of names) {
    const session = await login(name)
    const token = session.access_token
    assert.deepEqual(await rpc('account_state', token), { active: true, must_change_password: true })
    assert.deepEqual(await official(token), [])
    assert.equal((await request(rpcPath('complete_password_change'), { method: 'POST', token, body: {} })).ok, false)
    await get('auth/v1/user', { method: 'PUT', token, body: { password: `${password}${name}` } })
    await rpc('complete_password_change', token)
    assert.deepEqual(await rpc('account_state', token), { active: true, must_change_password: false })
    assert.deepEqual(await official(token), [])
    const factor = await get('auth/v1/factors', { method: 'POST', token, body: { factor_type: 'totp' } })
    const challenge = await get(`auth/v1/factors/${factor.id}/challenge`, { method: 'POST', token, body: {} })
    const verified = await get(`auth/v1/factors/${factor.id}/verify`, { method: 'POST', token, body: { challenge_id: challenge.id, code: totp(factor.totp.secret) } })
    assert.equal((await official(verified.access_token)).length, 362)
    assert.deepEqual(await official(token), [])
    tokens.push(verified.access_token)
    users.push({ id: session.user.id, factor: factor.id })
  }

  const [alice, bob, chloe, fanny] = tokens
  assert.equal((await request(rpcPath('import_schedule'), { method: 'POST', token: alice, body: { p_rows: [] } })).ok, false)
  assert.equal((await request('rest/v1/assignments?tour=eq.1', { method: 'PATCH', token: alice, body: { version: 99 } })).ok, false)
  const planning = await official(alice)
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Paris' }).format(new Date())
  const first = planning.find((a) => a.tour === 1 && a.day > today && planning.some((b) => b.tour === a.tour && b.day > a.day && b.day.slice(0, 7) !== a.day.slice(0, 7) && b.member_id !== a.member_id))
  const second = first && planning.find((a) => a.tour === 1 && a.day > first.day && a.day.slice(0, 7) !== first.day.slice(0, 7) && a.member_id !== first.member_id)
  assert.ok(first && second, 'Two future months are needed for the exchange scenario.')
  const create = { p_tour: 1, p_day: first.day, p_other_day: second.day }
  const concurrent = await Promise.all([alice, bob].map((token) => request(rpcPath('create_proposal'), { method: 'POST', token, body: create })))
  assert.equal(concurrent.filter((result) => result.ok).length, 1)
  const winner = concurrent.findIndex((result) => result.ok)
  const id = concurrent[winner].data
  const accept = (token) => rpc('cast_vote', token, { p_proposal_id: id, p_approve: true })
  assert.equal(await accept(tokens[1 - winner]), 'pending')
  assert.equal(await accept(chloe), 'pending')
  assert.deepEqual(await official(alice), planning)
  assert.deepEqual(await Promise.all([accept(fanny), accept(fanny)]), ['accepted', 'accepted'])
  const updated = await official(alice)
  const slot = (day) => updated.find((a) => a.day === day && a.tour === 1)
  assert.equal(slot(first.day).member_id, second.member_id)
  assert.equal(slot(second.day).member_id, first.member_id)
  assert.equal(slot(first.day).version, first.version + 1)
  assert.equal(slot(second.day).version, second.version + 1)
  await rpc('post_message', alice, { p_body: '  Recette locale fictive  ' })
  assert.equal((await get('rest/v1/messages?select=body', { token: bob }))[0].body, 'Recette locale fictive')

  const tested = users[0]
  const setActive = (active) => get(`rest/v1/members?id=eq.${tested.id}`, { method: 'PATCH', token: admin, body: { active } })
  await setActive(false)
  assert.deepEqual(await official(alice), [])
  await get('auth/v1/logout?scope=global', { method: 'POST', token: alice })
  await get(`${adminUsers}/${tested.id}/factors/${tested.factor}`, { method: 'DELETE', token: admin })
  await get(`${adminUsers}/${tested.id}`, { method: 'PUT', token: admin, body: { password } })
  await rpc('require_password_change', admin, { p_member_id: tested.id })
  await setActive(true)
  assert.deepEqual(await rpc('account_state', alice), { active: false, must_change_password: false })
  assert.deepEqual(await official(alice), [])
  const recovered = await login('Linda')
  assert.deepEqual(await rpc('account_state', recovered.access_token), { active: true, must_change_password: true })
  assert.deepEqual((await get('auth/v1/user', { token: recovered.access_token })).factors ?? [], [])
  console.log('Verified: real Auth tokens, TOTP, access control, concurrent creation and final vote, official exchange, chat and account recovery.')
}

switch (process.argv[2]) {
  case 'seed':
    await seed()
    console.log('362 fictitious slots. Test accounts: linda@example.test, julie@example.test, lucie@example.test, fanny@example.test.')
    console.log(`Initial local password: ${password}`)
    break
  case 'verify':
    await verify(await seed())
    break
  default:
    throw new Error('Usage: docker compose run --rm fixtures seed|verify')
}
