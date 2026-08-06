import {describe, test} from "node:test"
import assert from "node:assert/strict"
import fs from "fs"
import express from "express"
import {createTestUser as createUser} from "./setup.js"
import {createRouter} from "../src/router.js"
import {newCode} from "../src/utils.js"

const dirs = []
async function createTestUser() {
  const result = await createUser()
  dirs.push(result.dir)
  return result
}

// Router tests exercise /signup and /verify-login-code's own logic
// (validation, pool reservation, registerAccount), not createLoginCodes'
// storage mechanics in src/utils.js (already covered in utils.test.js), so
// pool entries are constructed directly rather than seeded through real
// storage writes.
function createLoginCodes(count = 1, owner = "") {
  const loginCodes = new Map()
  for (let i = 0; i < count; i++) {
    const code = newCode()
    loginCodes.set(code, {code, owner, key: `test-key-${newCode()}`})
  }
  return loginCodes
}

function createMailStub() {
  return {
    calls: [],
    requestLogin(...args) {
      this.calls.push(["requestLogin", ...args])
    },
    validateEmail(...args) {
      this.calls.push(["validateEmail", ...args])
    },
  }
}

// Mounts createRouter on a real listening server so tests exercise it over
// HTTP. Registers the server to be closed via t.after, so a failed
// assertion doesn't leave it open (node --test won't exit while a listening
// server is still open).
async function startTestRouter(
  t,
  {
    holster,
    user,
    loginCodes = new Map(),
    mail = createMailStub(),
    accountDefaults = {},
    opts = {},
  },
) {
  const app = express()
  app.use(express.json())
  app.use(createRouter(holster, loginCodes, mail, accountDefaults, opts))
  const server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s))
  })
  t.after(() => new Promise(resolve => server.close(resolve)))

  const {port} = server.address()
  return {url: `http://localhost:${port}`, mail, loginCodes}
}

function post(url, path, body) {
  return fetch(url + path, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(body),
  })
}

function registrationBody(name) {
  return {
    pub: `pub-${name}`,
    epub: `epub-${name}`,
    username: name,
    email: `${name}@test.com`,
  }
}

describe("/signup", () => {
  test("responds without consuming a code when signup is disabled", async t => {
    const {holster, user} = await createTestUser()
    const {url} = await startTestRouter(t, {holster, user, opts: {}})

    const res = await post(url, "/signup", registrationBody("alice"))
    assert.equal(await res.text(), "Signup is not available")
  })

  test("returns 400 and leaves the pool untouched on invalid input", async t => {
    const {holster, user} = await createTestUser()
    const loginCodes = createLoginCodes()
    const [code] = loginCodes.keys()
    const {url} = await startTestRouter(t, {
      holster,
      user,
      loginCodes,
      opts: {signup: true},
    })

    const bad = await post(url, "/signup", {
      ...registrationBody("alice"),
      username: "",
    })
    assert.equal(bad.status, 400)

    // The pool code should still be there for a valid request.
    const good = await post(url, "/signup", registrationBody("alice"))
    assert.equal(good.status, 200)
    assert.equal(loginCodes.has(code), false)
  })

  test("returns 503 when the pool is empty", async t => {
    const {holster, user} = await createTestUser()
    const {url} = await startTestRouter(t, {
      holster,
      user,
      opts: {signup: true},
    })

    const res = await post(url, "/signup", registrationBody("alice"))
    assert.equal(res.status, 503)
  })

  test("does not hand out the admin code", async t => {
    const {holster, user} = await createTestUser()
    const loginCodes = new Map([["admin", {code: "admin", owner: ""}]])
    const {url} = await startTestRouter(t, {
      holster,
      user,
      loginCodes,
      opts: {signup: true},
    })

    const res = await post(url, "/signup", registrationBody("alice"))
    assert.equal(res.status, 503)
  })

  test("registers an account and sends a validation email", async t => {
    const {holster, user} = await createTestUser()
    const loginCodes = createLoginCodes()
    const [code] = loginCodes.keys()
    const {url, mail} = await startTestRouter(t, {
      holster,
      user,
      loginCodes,
      opts: {signup: true},
    })

    const res = await post(url, "/signup", registrationBody("alice"))
    assert.equal(res.status, 200)

    const account = await new Promise(resolve => {
      user.get("accounts").next(code, resolve)
    })
    assert.equal(account.pub, "pub-alice")
    assert.equal(account.username, "alice")

    assert.equal(mail.calls.length, 1)
    assert.equal(mail.calls[0][0], "validateEmail")
    assert.equal(loginCodes.has(code), false)
  })

  test("concurrent requests can't both claim the same code", async t => {
    const {holster, user} = await createTestUser()
    const loginCodes = createLoginCodes()
    const {url} = await startTestRouter(t, {
      holster,
      user,
      loginCodes,
      opts: {signup: true},
    })

    // With a single pool code, two concurrent requests must resolve to one
    // 200 and one 503 (pool exhausted). Before the fix, both requests would
    // see the same unclaimed code and both succeed. No storage read-back
    // here, since holster is eventually consistent and a read straight
    // after a write isn't guaranteed to reflect it yet.
    const [resA, resB] = await Promise.all([
      post(url, "/signup", registrationBody("alice")),
      post(url, "/signup", registrationBody("bob")),
    ])
    assert.deepEqual([resA.status, resB.status].sort(), [200, 503])
  })
})

describe("/verify-login-code", () => {
  test("returns 404 for an unknown code", async t => {
    const {holster, user} = await createTestUser()
    const {url} = await startTestRouter(t, {holster, user})

    const res = await post(url, "/verify-login-code", {
      code: "missing",
      ...registrationBody("alice"),
    })
    assert.equal(res.status, 404)
  })

  test("returns 400 and leaves the code claimable on invalid input", async t => {
    const {holster, user} = await createTestUser()
    const loginCodes = createLoginCodes()
    const [code] = loginCodes.keys()
    const {url} = await startTestRouter(t, {holster, user, loginCodes})

    const bad = await post(url, "/verify-login-code", {
      code,
      ...registrationBody("alice"),
      username: "",
    })
    assert.equal(bad.status, 400)

    const good = await post(url, "/verify-login-code", {
      code,
      ...registrationBody("alice"),
    })
    assert.equal(good.status, 200)
  })

  test("registers an account for the given code", async t => {
    const {holster, user} = await createTestUser()
    const loginCodes = createLoginCodes()
    const [code] = loginCodes.keys()
    const {url, mail} = await startTestRouter(t, {holster, user, loginCodes})

    const res = await post(url, "/verify-login-code", {
      code,
      ...registrationBody("alice"),
    })
    assert.equal(res.status, 200)

    const account = await new Promise(resolve => {
      user.get("accounts").next(code, resolve)
    })
    assert.equal(account.pub, "pub-alice")
    assert.equal(mail.calls[0][0], "validateEmail")
    assert.equal(loginCodes.has(code), false)
  })
})

test("cleanup", (t, done) => {
  const remaining = [...dirs]
  const next = err => {
    if (err || !remaining.length) return done(err)
    fs.rm(remaining.shift(), {recursive: true, force: true}, next)
  }
  // Holster relays writes over the mocked websocket asynchronously, so a
  // put's callback can fire before the data is durably on disk. Give
  // in-flight writes from the last test a moment to settle before removing
  // its directory.
  setTimeout(next, 500)
})
