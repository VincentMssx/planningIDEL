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
async function expectDenied(path, options) {
  const result = await request(path, options)
  assert.equal(result.ok, false, `${path} must deny access`)
  assert.equal(result.data?.code, '42501', `${path}: HTTP ${result.status}`)
}
const denied = (name, token, body = {}) => expectDenied(rpcPath(name), { method: 'POST', token, body })
const official = (token) => get('rest/v1/assignments?order=day,tour', { token })
const chat = (token) => get('rest/v1/messages?select=id,member_id,body,proposal_id,proposal_day', { token })
const post = (token, p_body) => rpc('post_message', token, { p_body })
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
  const csv = ['date,tournee_1,tournee_2', ...days.map((day, i) => `${day},${i === 180 ? ',' : i % 2 ? 'J,Lu' : 'L,F'}`)].join('\n')
  const { rows, errors } = validate(csv)
  assert.deepEqual(errors, [])
  const count = (await official(admin)).length
  if (!count) assert.equal(await rpc('import_schedule', admin, { p_rows: rows }), 362)
  else assert.equal(count, 362)
  return rows
}

const passwordLogin = (address, pwd) => get('auth/v1/token?grant_type=password', { method: 'POST', body: { email: address, password: pwd } })
const login = (name, pwd = password) => passwordLogin(email(name), pwd)

function totpCode(base32Secret) {
  assert.ok(typeof base32Secret === 'string' && /^[A-Z2-7]+=*$/.test(base32Secret), 'Expected a Base32 fixture TOTP secret.')
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const bytes = []
  let value = 0
  let bits = 0
  for (const char of base32Secret.replace(/=+$/, '')) {
    value = (value << 5) | alphabet.indexOf(char)
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push(value >>> bits)
      value &= (1 << bits) - 1
    }
  }
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)))
  const digest = createHmac('sha1', Buffer.from(bytes)).update(counter).digest()
  const offset = digest[digest.length - 1] & 0x0f
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}

async function verifyTotp(token, factor) {
  const path = `auth/v1/factors/${factor.id}`
  const { id } = await get(`${path}/challenge`, { method: 'POST', token, body: {} })
  const { access_token } = await get(`${path}/verify`, {
    method: 'POST', token, body: { challenge_id: id, code: totpCode(factor.totp.secret) },
  })
  return access_token
}

const jwtClaims = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))

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
    assert.deepEqual(await chat(token), [])
    await denied('post_message', token, { p_body: 'Local fixture' })
    for (const [name, body] of [['request_email_code', {}], ['verify_email_code', { p_code: '000000' }]]) {
      assert.equal((await request(rpcPath(name), { method: 'POST', token, body })).status, 404)
    }
    assert.equal((await request(rpcPath('complete_password_change'), { method: 'POST', token, body: {} })).ok, false)
    await get('auth/v1/user', { method: 'PUT', token, body: { password: `${password}${name}` } })
    await rpc('complete_password_change', token)
    assert.deepEqual(await rpc('account_state', token), { active: true, must_change_password: false })
    assert.equal((await official(token)).length, 362)
    tokens.push(token)
    users.push(session.user.id)
  }

  const [alice, bob, chloe, fanny] = tokens
  const freeDay = days.at(-1)
  const blanks = (await official(alice)).filter((a) => a.day === freeDay)
  assert.deepEqual(blanks.map((a) => a.member_id), [null, null])
  const claim = (token) => request(rpcPath('claim_unassigned_slot'), { method: 'POST', token, body: { p_day: freeDay, p_tour: 1 } })
  assert.equal((await claim(chloe)).ok, false)
  const claims = await Promise.all([claim(alice), claim(bob)])
  assert.equal(claims.filter((r) => r.ok).length, 1)
  const claimed = (await official(alice)).filter((a) => a.day === freeDay)
  assert.equal(claimed[0].member_id, users[claims.findIndex((r) => r.ok)])
  assert.equal(claimed[1].member_id, null)
  for (const [name, body] of [['read_colleague_contacts', {}], ['save_colleague_contacts', { p_linda: '', p_julie: '', p_lucie: '' }]]) {
    assert.equal((await request(rpcPath(name), { method: 'POST', token: fanny, body })).status, 404)
  }
  assert.equal((await request(rpcPath('import_schedule'), { method: 'POST', token: alice, body: { p_rows: [] } })).ok, false)
  assert.equal((await request('rest/v1/assignments?tour=eq.1', { method: 'PATCH', token: alice, body: { version: 99 } })).ok, false)
  const planning = await official(alice)
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Paris' }).format(new Date())
  const first = planning.find((a) => a.tour === 1 && a.day > today && planning.some((b) => b.tour === a.tour && b.day > a.day && b.day.slice(0, 7) !== a.day.slice(0, 7) && b.member_id !== a.member_id))
  const second = first && planning.find((a) => a.tour === 1 && a.day > first.day && a.day.slice(0, 7) !== first.day.slice(0, 7) && a.member_id !== first.member_id)
  assert.ok(first && second, 'Two future months are needed for the exchange scenario.')
  const create = { p_tour: 1, p_day: first.day, p_other_day: second.day }
  const concurrent = await Promise.all([chloe, fanny].map((token) => request(rpcPath('create_proposal'), { method: 'POST', token, body: create })))
  assert.equal(concurrent.filter((result) => result.ok).length, 1)
  const winner = concurrent.findIndex((result) => result.ok)
  const id = concurrent[winner].data
  assert.equal(concurrent[1 - winner].data?.code, '22023')
  const proposal = async (id) => (await get(`rest/v1/proposals?id=eq.${id}&select=author_id,status`, { token: alice }))[0]
  const votes = (id) => get(`rest/v1/votes?proposal_id=eq.${id}&select=member_id,approve`, { token: alice })
  const audit = (id, kind) => get(`rest/v1/audit?proposal_id=eq.${id}&kind=eq.${kind}&select=actor_id,days,details`, { token: alice })
  const voteError = async (token, body, code) => {
    const result = await request(rpcPath('cast_vote'), { method: 'POST', token, body })
    assert.equal(result.ok, false)
    assert.equal(result.data?.code, code)
  }
  assert.deepEqual(await proposal(id), { author_id: users[2 + winner], status: 'pending' })
  assert.deepEqual(await votes(id), [])
  assert.deepEqual(await audit(id, 'vote'), [])
  for (const token of [chloe, fanny]) {
    await voteError(token, { p_proposal_id: id, p_approve: true }, '42501')
    await voteError(token, { p_proposal_id: id, p_approve: false, p_reason: 'unavailable' }, '42501')
  }
  const accept = (token) => rpc('cast_vote', token, { p_proposal_id: id, p_approve: true })
  assert.equal(await accept(alice), 'pending')
  assert.equal(await accept(alice), 'pending')
  assert.deepEqual(await votes(id), [{ member_id: users[0], approve: true }])
  assert.equal((await audit(id, 'vote')).length, 1)
  assert.deepEqual(await official(alice), planning)
  assert.deepEqual(await Promise.all([accept(bob), accept(bob)]), ['accepted', 'accepted'])
  assert.equal((await votes(id)).length, 2)
  assert.equal((await audit(id, 'vote')).length, 2)
  const acceptedAudit = await audit(id, 'accepted')
  assert.equal(acceptedAudit.length, 1)
  assert.equal(acceptedAudit[0].actor_id, users[1])
  assert.deepEqual(acceptedAudit[0].days, [first.day, second.day])
  const updated = await official(alice)
  const slot = (day) => updated.find((a) => a.day === day && a.tour === 1)
  assert.equal(slot(first.day).member_id, second.member_id)
  assert.equal(slot(second.day).member_id, first.member_id)
  assert.equal(slot(first.day).version, first.version + 1)
  assert.equal(slot(second.day).version, second.version + 1)
  const replace = { p_tour: 1, p_day: first.day, p_after_id: first.member_id }
  for (const [i, token] of tokens.entries()) {
    const draft = await rpc('create_proposal', token, replace)
    assert.deepEqual(await proposal(draft), { author_id: users[i], status: 'pending' })
    assert.deepEqual(await votes(draft), [])
    assert.equal(await rpc('withdraw_proposal', token, { p_proposal_id: draft }), 'withdrawn')
  }
  await expectDenied('rest/v1/messages', { token: anon })
  await denied('post_message', anon, { p_body: 'Local fixture' })
  await expectDenied('rest/v1/messages', { method: 'POST', token: alice, body: { member_id: users[1], body: 'Local fixture' } })
  for (const p_body of ['', ' \t\n ', 'a'.repeat(2001)]) {
    const invalid = await request(rpcPath('post_message'), { method: 'POST', token: alice, body: { p_body } })
    assert.equal(invalid.data?.code, '22023')
  }
  const messageId = await post(alice, '  Local fixture  ')
  assert.deepEqual(await chat(bob), [{ id: messageId, member_id: users[0], body: 'Local fixture', proposal_id: null, proposal_day: null }])
  for (const [reason, label] of Object.entries({ unavailable: 'Indisponible', schedule_conflict: 'Conflit de planning', keep_schedule: 'Conserver le planning actuel' })) {
    const refused = await rpc('create_proposal', alice, { ...create, p_day: second.day, p_other_day: first.day })
    const reject = { p_proposal_id: refused, p_approve: false }
    if (reason === 'unavailable') {
      await voteError(alice, reject, '22023')
      for (const invalid of [null, '', ' \n ', 'Not available.', 'unknown', 'Unavailable', ' unavailable', 'unavailable ']) {
        await voteError(alice, { ...reject, p_reason: invalid }, '22023')
      }
      assert.equal((await proposal(refused)).status, 'pending')
      assert.deepEqual(await votes(refused), [])
      assert.deepEqual(await audit(refused, 'vote'), [])
      assert.deepEqual(await audit(refused, 'rejected'), [])
    }
    const refuse = () => rpc('cast_vote', alice, { ...reject, p_reason: reason })
    assert.deepEqual(await Promise.all([refuse(), refuse()]), ['rejected', 'rejected'])
    await voteError(alice, { ...reject, p_approve: true }, '22023')
    await voteError(chloe, { ...reject, p_reason: reason }, '42501')
    assert.equal((await proposal(refused)).status, 'rejected')
    assert.deepEqual(await official(alice), updated)
    assert.deepEqual(await votes(refused), [{ member_id: users[0], approve: false }])
    const refusalVote = await audit(refused, 'vote')
    assert.equal(refusalVote.length, 1)
    assert.deepEqual(refusalVote[0].details, { approve: false, reason_code: reason })
    const refusalAudit = await audit(refused, 'rejected')
    assert.equal(refusalAudit.length, 1)
    assert.equal(refusalAudit[0].actor_id, users[0])
    assert.deepEqual(refusalAudit[0].days, [first.day, second.day])
    assert.equal(refusalAudit[0].details.reason_code, reason)
    assert.equal(Object.hasOwn(refusalAudit[0].details, 'reason'), false)
    assert.equal(refusalAudit[0].details.lines.length, 2)
    const linked = (await chat(bob)).filter((message) => message.proposal_id === refused)
    assert.equal(linked.length, 1)
    assert.equal(linked[0].proposal_day, first.day)
    assert.equal(linked[0].member_id, users[0])
    assert.ok(linked[0].body.endsWith(`\nMotif : ${label}`))
  }
  await expectDenied('rest/v1/messages', { token: admin })

  const tested = users[0]
  const setActive = (active) => get(`rest/v1/members?id=eq.${tested}`, { method: 'PATCH', token: admin, body: { active } })
  await setActive(false)
  assert.deepEqual(await official(alice), [])
  assert.deepEqual(await chat(alice), [])
  await denied('post_message', alice, { p_body: 'Local fixture' })
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
  const enrollmentToken = (await passwordLogin(address, passphrase)).access_token
  await denied('provision_operator', fanny, { p_user_id: operatorId })
  await denied('admin_overview', fanny)
  const operatorState = async (token, factorId, verified) => assert.deepEqual(await rpc('account_state', token), {
    active: true, must_change_password: false, operator: true, verified,
    operator_session_fresh: true, operator_factor_id: factorId,
  })
  await operatorState(enrollmentToken, null, false)
  await denied('admin_overview', enrollmentToken)
  const factor = await get('auth/v1/factors', {
    method: 'POST', token: enrollmentToken, body: { factor_type: 'totp', friendly_name: 'Local fixture' },
  })
  assert.equal(factor.type, 'totp')
  assert.ok(typeof factor.id === 'string' && factor.id, 'Expected a fixture factor ID.')
  const beforeApproval = await verifyTotp(enrollmentToken, factor)
  assert.equal(jwtClaims(beforeApproval).aal, 'aal2')
  await operatorState(beforeApproval, null, false)
  await denied('admin_overview', beforeApproval)
  const approval = { p_operator_id: operatorId, p_factor_id: factor.id }
  for (const token of [anon, fanny, beforeApproval]) await denied('approve_operator_totp', token, approval)
  await rpc('approve_operator_totp', admin, approval)
  assert.deepEqual(await rpc('account_state', beforeApproval), { active: false, must_change_password: false })
  await denied('admin_overview', beforeApproval)

  const passwordOnly = (await passwordLogin(address, passphrase)).access_token
  await operatorState(passwordOnly, factor.id, false)
  await denied('admin_overview', passwordOnly)
  const operator = await verifyTotp(passwordOnly, factor)
  const passwordClaims = jwtClaims(passwordOnly)
  const operatorClaims = jwtClaims(operator)
  assert.equal(passwordClaims.aal, 'aal1')
  assert.equal(operatorClaims.aal, 'aal2')
  assert.ok(passwordClaims.session_id)
  assert.equal(operatorClaims.session_id, passwordClaims.session_id)
  await operatorState(operator, factor.id, true)
  await operatorState(passwordOnly, factor.id, false)
  await denied('admin_overview', passwordOnly)
  assert.deepEqual(await official(operator), [])
  await denied('create_proposal', operator, replace)
  assert.deepEqual(await chat(operator), [])
  await denied('post_message', operator, { p_body: 'Local fixture' })
  const overview = await rpc('admin_overview', operator)
  assert.equal(overview.members.length, 4)
  const fannyId = overview.members.find((member) => member.name === 'Fanny').id
  for (const active of [false, true]) {
    await rpc('admin_set_member_active', operator, { p_member_id: fannyId, p_active: active })
    assert.deepEqual(await official(fanny), [])
  }
  assert.deepEqual((await rpc('admin_overview', operator)).history.map((entry) => [entry.name, entry.active]), [['Fanny', true], ['Fanny', false]])
  console.log('Verified: member password login, restricted group chat, participant votes with refusal notices, account recovery, and isolated audited operator access with approved TOTP.')
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
