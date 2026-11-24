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

async function createOperator(address, passphrase) {
  assert.ok(typeof address === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address), 'A valid operator email is required.')
  assert.ok(typeof passphrase === 'string' && passphrase.length >= 20, 'Use a unique password of at least 20 characters.')
  const created = await request(adminUsers, { method: 'POST', token: admin, body: { email: address, password: passphrase, email_confirm: true } })
  assert.ok(created.ok, `Operator Auth creation failed (HTTP ${created.status}); existing accounts are not promoted.`)
  try {
    await rpc('provision_operator', admin, { p_user_id: created.data.id })
  } catch {
    // Do not delete the Auth user on an ambiguous network failure: the role may already exist.
    throw new Error('Operator role not confirmed. Check the local database before retrying.')
  }
  return created.data.id
}

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

async function emailCode(name) {
  const response = await fetch(`http://mailpit:8025/api/v1/search?query=${encodeURIComponent(`to:${email(name)}`)}`)
  assert.ok(response.ok)
  const { messages } = await response.json()
  assert.ok(messages.length, 'No message arrived in Mailpit.')
  const detail = await fetch(`http://mailpit:8025/api/v1/message/${messages[0].ID}`)
  assert.ok(detail.ok)
  const code = (await detail.json()).Text.match(/ : (\d{6})\./)?.[1]
  assert.ok(code, 'Message lacks a six-digit code.')
  return code
}

const login = (name, pwd = password) => get('auth/v1/token?grant_type=password', { method: 'POST', body: { email: email(name), password: pwd } })

async function verify(rows) {
  const tokens = []
  const users = []
  assert.equal((await request('rest/v1/assignments')).status, 401)
  assert.equal((await request('auth/v1/signup', { method: 'POST', body: { email: 'outsider@example.test', password } })).ok, false)
  assert.equal((await request(rpcPath('import_schedule'), { method: 'POST', token: admin, body: { p_rows: rows } })).ok, false)
  const members = await get('rest/v1/members?select=id,name,must_change_password', { token: admin })
  assert.ok(members.every((member) => member.must_change_password), 'Run verify only on fresh fixtures; it changes passwords.')
  for (const path of ['otp', 'recover']) {
    const blocked = await request(`auth/v1/${path}`, { method: 'POST', body: { email: email('Linda') } })
    assert.equal(blocked.ok, false, `${path} must not bypass password sign-in`)
  }

  for (const name of names) {
    const session = await login(name)
    const token = session.access_token
    assert.deepEqual(await rpc('account_state', token), { active: true, must_change_password: true })
    assert.deepEqual(await official(token), [])
    assert.equal(await rpc('request_email_code', token), 'denied')
    assert.equal((await request(rpcPath('complete_password_change'), { method: 'POST', token, body: {} })).ok, false)
    await get('auth/v1/user', { method: 'PUT', token, body: { password: `${password}${name}` } })
    await rpc('complete_password_change', token)
    assert.deepEqual(await rpc('account_state', token), { active: true, must_change_password: false })
    assert.deepEqual(await official(token), [])
    assert.equal(await rpc('request_email_code', token), 'sent')
    assert.equal(await rpc('request_email_code', token), 'wait')
    const code = await emailCode(name)
    if (name === 'Linda') {
      const other = (await login(name, `${password}${name}`)).access_token
      assert.equal(await rpc('verify_email_code', other, { p_code: code }), 'expired')
      assert.deepEqual(await official(other), [])
    }
    assert.equal(await rpc('verify_email_code', token, { p_code: code === '000000' ? '000001' : '000000' }), 'invalid')
    assert.deepEqual(await official(token), [])
    assert.equal(await rpc('verify_email_code', token, { p_code: code }), 'verified')
    assert.equal((await official(token)).length, 362)
    tokens.push(token)
    users.push(session.user.id)
  }

  const [alice, bob, chloe, fanny] = tokens
  const contactInput = { p_linda: 'linda-contact@example.test', p_julie: 'julie-contact@example.test', p_lucie: '' }
  assert.deepEqual(await rpc('read_colleague_contacts', fanny), {})
  for (const token of [anon, alice, bob, chloe]) {
    for (const [name, body] of [['read_colleague_contacts', {}], ['save_colleague_contacts', contactInput]]) {
      assert.equal((await request(rpcPath(name), { method: 'POST', token, body })).data?.code, '42501')
    }
  }
  await rpc('save_colleague_contacts', fanny, contactInput)
  const contacts = { Linda: contactInput.p_linda, Julie: contactInput.p_julie }
  assert.deepEqual(await rpc('read_colleague_contacts', fanny), contacts)
  assert.equal((await request(rpcPath('save_colleague_contacts'), { method: 'POST', token: fanny, body: { ...contactInput, p_lucie: 'invalide' } })).data?.code, '22023')
  assert.deepEqual(await rpc('read_colleague_contacts', fanny), contacts)
  assert.ok((await login('Linda', `${password}Linda`)).access_token)
  await rpc('save_colleague_contacts', fanny, { ...contactInput, p_linda: '' })
  assert.deepEqual(await rpc('read_colleague_contacts', fanny), { Julie: contactInput.p_julie })
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
  const setActive = (active) => get(`rest/v1/members?id=eq.${tested}`, { method: 'PATCH', token: admin, body: { active } })
  await setActive(false)
  assert.deepEqual(await official(alice), [])
  await get('auth/v1/logout?scope=global', { method: 'POST', token: alice })
  await get(`${adminUsers}/${tested}`, { method: 'PUT', token: admin, body: { password } })
  await rpc('require_password_change', admin, { p_member_id: tested })
  await setActive(true)
  assert.deepEqual(await rpc('account_state', alice), { active: false, must_change_password: false })
  assert.deepEqual(await official(alice), [])
  const recovered = await login('Linda')
  assert.deepEqual(await rpc('account_state', recovered.access_token), { active: true, must_change_password: true })
  const address = 'operator@example.test'
  const passphrase = `${password}Operator`
  const operatorId = await createOperator(address, passphrase)
  const operator = (await get('auth/v1/token?grant_type=password', { method: 'POST', body: { email: address, password: passphrase } })).access_token
  const denied = async (name, token, body = {}) => assert.equal((await request(rpcPath(name), { method: 'POST', token, body })).data?.code, '42501')
  await denied('provision_operator', fanny, { p_user_id: operatorId })
  await denied('admin_overview', fanny)
  await denied('admin_overview', operator)
  assert.equal(await rpc('request_email_code', operator), 'sent')
  assert.equal(await rpc('verify_email_code', operator, { p_code: await emailCode('Operator') }), 'verified')
  assert.deepEqual(await official(operator), [])
  assert.deepEqual(await get('rest/v1/messages', { token: operator }), [])
  await denied('read_colleague_contacts', operator)
  const overview = await rpc('admin_overview', operator)
  assert.equal(overview.members.length, 4)
  const fannyId = overview.members.find((member) => member.name === 'Fanny').id
  for (const active of [false, true]) {
    await rpc('admin_set_member_active', operator, { p_member_id: fannyId, p_active: active })
    assert.deepEqual(await official(fanny), [])
  }
  assert.deepEqual((await rpc('admin_overview', operator)).history.map((entry) => [entry.name, entry.active]), [['Fanny', true], ['Fanny', false]])
  console.log('Verified: real Auth tokens, email code, Fanny-only contacts, concurrent votes, account recovery and isolated audited operator access.')
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
  case 'operator': {
    let input = ''
    for await (const chunk of process.stdin) input += chunk
    let credentials
    try { credentials = JSON.parse(input) } catch { throw new Error('Invalid operator provisioning input.') }
    await createOperator(credentials.email, credentials.password)
    console.log('Local operator created.')
    break
  }
  default:
    throw new Error('Usage: docker compose run --rm fixtures seed|verify (operator provisioning: docker/create-operator.ps1)')
}
