import {describe, test} from "node:test"
import assert from "node:assert/strict"
import fs from "fs"
import express from "express"
import {createTestUser} from "./setup.js"
import {createRouter} from "../src/router.js"
import {newCode} from "../src/utils.js"

const dirs = []

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
    resetPassword(...args) {
      this.calls.push(["resetPassword", ...args])
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

// A real signed request, since the server now verifies it against the
// claimed pub. Pass an existing pair for tests that need to reuse or
// later reference the same keys (e.g. SEA.secret elsewhere).
async function signedBody(
  holster,
  {username = "alice", email = `${username}@example.com`, timestamp} = {},
  pair,
) {
  const keys = pair ?? (await holster.SEA.pair())
  const signed = await holster.SEA.sign(
    {username, email, timestamp: timestamp ?? Date.now()},
    keys,
  )
  return {pub: keys.pub, epub: keys.epub, signed}
}

describe("/signup", () => {
  test("responds without consuming a code when signup is disabled", async t => {
    const {holster, user, dir} = await createTestUser()
    dirs.push(dir)
    const {url} = await startTestRouter(t, {holster, user, opts: {}})

    const res = await post(url, "/signup", await signedBody(holster))
    assert.equal(res.status, 403)
    assert.equal(await res.text(), "Signup is not available")
  })

  test("returns 400 and leaves the pool untouched on invalid input", async t => {
    const {holster, user, dir} = await createTestUser()
    dirs.push(dir)
    const loginCodes = createLoginCodes()
    const [code] = loginCodes.keys()
    const {url} = await startTestRouter(t, {
      holster,
      user,
      loginCodes,
      opts: {signup: true},
    })

    const bad = await post(
      url,
      "/signup",
      await signedBody(holster, {username: "", email: "alice@example.com"}),
    )
    assert.equal(bad.status, 400)

    // The pool code should still be there for a valid request.
    const good = await post(url, "/signup", await signedBody(holster))
    assert.equal(good.status, 200)
    assert.equal(loginCodes.has(code), false)
  })

  test("returns 503 when the pool is empty", async t => {
    const {holster, user, dir} = await createTestUser()
    dirs.push(dir)
    const {url} = await startTestRouter(t, {
      holster,
      user,
      opts: {signup: true},
    })

    const res = await post(url, "/signup", await signedBody(holster))
    assert.equal(res.status, 503)
  })

  test("does not hand out the admin code", async t => {
    const {holster, user, dir} = await createTestUser()
    dirs.push(dir)
    const loginCodes = new Map([["admin", {code: "admin", owner: ""}]])
    const {url} = await startTestRouter(t, {
      holster,
      user,
      loginCodes,
      opts: {signup: true},
    })

    const res = await post(url, "/signup", await signedBody(holster))
    assert.equal(res.status, 503)
  })

  test("registers an account and sends a validation email", async t => {
    const {holster, user, dir} = await createTestUser()
    dirs.push(dir)
    const loginCodes = createLoginCodes()
    const [code] = loginCodes.keys()
    const {url, mail} = await startTestRouter(t, {
      holster,
      user,
      loginCodes,
      opts: {signup: true},
    })

    const body = await signedBody(holster)
    const res = await post(url, "/signup", body)
    assert.equal(res.status, 200)

    const account = await user.get("accounts").next(code)
    assert.equal(account.pub, body.pub)
    assert.equal(account.username, "alice")

    assert.equal(mail.calls.length, 1)
    assert.equal(mail.calls[0][0], "validateEmail")
    assert.equal(loginCodes.has(code), false)
  })

  test("concurrent requests can't both claim the same code", async t => {
    const {holster, user, dir} = await createTestUser()
    dirs.push(dir)
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
    const [bodyA, bodyB] = await Promise.all([
      signedBody(holster),
      signedBody(holster, {username: "bob"}),
    ])
    const [resA, resB] = await Promise.all([
      post(url, "/signup", bodyA),
      post(url, "/signup", bodyB),
    ])
    assert.deepEqual([resA.status, resB.status].sort(), [200, 503])
  })

  test("rate limits repeated attempts from the same caller", async t => {
    const {holster, user, dir} = await createTestUser()
    dirs.push(dir)
    const loginCodes = createLoginCodes(10)
    const {url} = await startTestRouter(t, {
      holster,
      user,
      loginCodes,
      opts: {signup: true},
    })

    const statuses = []
    for (let i = 0; i < 6; i++) {
      const res = await post(
        url,
        "/signup",
        await signedBody(holster, {username: `user${i}`}),
      )
      statuses.push(res.status)
    }
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429])
  })

  test("rejects a request signed by a different key than the one claimed", async t => {
    const {holster, user, dir} = await createTestUser()
    dirs.push(dir)
    const loginCodes = createLoginCodes()
    const {url} = await startTestRouter(t, {
      holster,
      user,
      loginCodes,
      opts: {signup: true},
    })

    const body = await signedBody(holster)
    const otherPair = await holster.SEA.pair()
    const res = await post(url, "/signup", {...body, pub: otherPair.pub})
    assert.equal(res.status, 400)
    assert.equal(await res.text(), "Invalid request")
  })

  test("rejects a signed request whose timestamp has expired", async t => {
    const {holster, user, dir} = await createTestUser()
    dirs.push(dir)
    const loginCodes = createLoginCodes()
    const {url} = await startTestRouter(t, {
      holster,
      user,
      loginCodes,
      opts: {signup: true},
    })

    const body = await signedBody(holster, {
      timestamp: Date.now() - 10 * 60000,
    })
    const res = await post(url, "/signup", body)
    assert.equal(res.status, 400)
    assert.equal(await res.text(), "Request expired")
  })
})

describe("/request-login-code", () => {
  test("requests a login code for a valid email", async t => {
    const {holster, user, dir} = await createTestUser()
    dirs.push(dir)
    const {url, mail} = await startTestRouter(t, {holster, user})

    const res = await post(url, "/request-login-code", {
      email: "alice@example.com",
    })
    assert.equal(res.status, 200)
    assert.equal(mail.calls.length, 1)
    assert.deepEqual(mail.calls[0], ["requestLogin", "alice@example.com"])
  })

  test("rate limits repeated requests for the same email", async t => {
    const {holster, user, dir} = await createTestUser()
    dirs.push(dir)
    const {url, mail} = await startTestRouter(t, {holster, user})

    const first = await post(url, "/request-login-code", {
      email: "alice@example.com",
    })
    assert.equal(first.status, 200)

    const second = await post(url, "/request-login-code", {
      email: "alice@example.com",
    })
    assert.equal(second.status, 429)
    assert.equal(mail.calls.length, 1)
  })

  test("rate limits repeated requests from the same caller, even for different emails", async t => {
    const {holster, user, dir} = await createTestUser()
    dirs.push(dir)
    const {url, mail} = await startTestRouter(t, {holster, user})

    const statuses = []
    for (let i = 0; i < 6; i++) {
      const res = await post(url, "/request-login-code", {
        email: `user${i}@example.com`,
      })
      statuses.push(res.status)
    }
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429])
    assert.equal(mail.calls.length, 5)
  })
})

describe("/verify-login-code", () => {
  test("returns 404 for an unknown code", async t => {
    const {holster, user, dir} = await createTestUser()
    dirs.push(dir)
    const {url} = await startTestRouter(t, {holster, user})

    const res = await post(url, "/verify-login-code", {
      code: "missing",
      ...(await signedBody(holster)),
    })
    assert.equal(res.status, 404)
  })

  test("returns 400 and leaves the code claimable on invalid input", async t => {
    const {holster, user, dir} = await createTestUser()
    dirs.push(dir)
    const loginCodes = createLoginCodes()
    const [code] = loginCodes.keys()
    const {url} = await startTestRouter(t, {holster, user, loginCodes})

    const bad = await post(url, "/verify-login-code", {
      code,
      ...(await signedBody(holster, {
        username: "",
        email: "alice@example.com",
      })),
    })
    assert.equal(bad.status, 400)

    const good = await post(url, "/verify-login-code", {
      code,
      ...(await signedBody(holster)),
    })
    assert.equal(good.status, 200)
  })

  test("registers an account for the given code", async t => {
    const {holster, user, dir} = await createTestUser()
    dirs.push(dir)
    const loginCodes = createLoginCodes()
    const [code] = loginCodes.keys()
    const {url, mail} = await startTestRouter(t, {holster, user, loginCodes})

    const body = await signedBody(holster)
    const res = await post(url, "/verify-login-code", {code, ...body})
    assert.equal(res.status, 200)

    const account = await user.get("accounts").next(code)
    assert.equal(account.pub, body.pub)
    assert.equal(mail.calls[0][0], "validateEmail")
    assert.equal(loginCodes.has(code), false)
  })
})

describe("/update-password", () => {
  async function registerAndValidate(holster, url, mail, loginCodes, name) {
    const [code] = loginCodes.keys()
    const pair = await holster.SEA.pair()
    const body = await signedBody(holster, {username: name}, pair)
    await post(url, "/verify-login-code", {code, ...body})
    const validateCall = mail.calls.find(call => call[0] === "validateEmail")
    await post(url, "/validate-email", {code, validate: validateCall[4]})
    return {code, pub: body.pub, epub: body.epub}
  }

  async function requestReset(url, mail, code, email) {
    await post(url, "/reset-password", {code, email})
    const resetCall = mail.calls.find(
      call => call[0] === "resetPassword" && call[4] === code,
    )
    return resetCall[5]
  }

  test("updates the account's pub/epub and re-shares its login_codes entries", async t => {
    const {holster, user, dir} = await createTestUser()
    dirs.push(dir)
    const loginCodes = createLoginCodes()
    const {url, mail} = await startTestRouter(t, {holster, user, loginCodes})

    const {code, pub, epub} = await registerAndValidate(
      holster,
      url,
      mail,
      loginCodes,
      "alice",
    )

    // Seed a shared login-code entry the way createLoginCodes would,
    // encrypted for alice's current (about-to-be-old) key.
    const oldSecret = await holster.SEA.secret({pub, epub}, user.is)
    const enc = await holster.SEA.encrypt("shared-code", oldSecret)
    await user.get("shared").next("login_codes").next(code).put(enc, true)

    const reset = await requestReset(url, mail, code, "alice@example.com")
    const newPair = await holster.SEA.pair()
    const newBody = await signedBody(holster, {username: "alice-new"}, newPair)
    const res = await post(url, "/update-password", {
      code,
      reset,
      pub: newBody.pub,
      epub: newBody.epub,
      username: "alice",
      name: "Alice",
    })
    assert.equal(res.status, 200)

    const account = await user.get("accounts").next(code)
    assert.equal(account.pub, newBody.pub)
    assert.equal(account.prev, pub)
    // The reset code is single-use - a successful update clears it so the
    // same emailed link can't be replayed later.
    assert.equal(account.reset, null)
    assert.equal(account.expiry, null)

    // The old pub's map entry is superseded, not left dangling.
    const oldMapping = await user.get("map").next("account:" + pub)
    assert.equal(oldMapping, null)
    const newMapping = await user.get("map").next("account:" + newBody.pub)
    assert.equal(newMapping, code)

    const shared = await user.get("shared").next("login_codes").next(code)
    const [sharedEnc] = Object.values(shared)
    const newSecret = await holster.SEA.secret(
      {pub: newBody.pub, epub: newBody.epub},
      user.is,
    )
    assert.equal(await holster.SEA.decrypt(sharedEnc, newSecret), "shared-code")
  })

  test("also re-shares any additional namespace passed via opts.shared", async t => {
    const {holster, user, dir} = await createTestUser()
    dirs.push(dir)
    const loginCodes = createLoginCodes()
    const {url, mail} = await startTestRouter(t, {
      holster,
      user,
      loginCodes,
      opts: {shared: ["login_codes", "pending_subdomains"]},
    })

    const {code, pub, epub} = await registerAndValidate(
      holster,
      url,
      mail,
      loginCodes,
      "alice",
    )

    const oldSecret = await holster.SEA.secret({pub, epub}, user.is)
    const enc = await holster.SEA.encrypt("pending-request", oldSecret)
    await user
      .get("shared")
      .next("pending_subdomains")
      .next(code)
      .put(enc, true)

    const reset = await requestReset(url, mail, code, "alice@example.com")
    const newPair = await holster.SEA.pair()
    const newBody = await signedBody(holster, {username: "alice-new"}, newPair)
    await post(url, "/update-password", {
      code,
      reset,
      pub: newBody.pub,
      epub: newBody.epub,
      username: "alice",
      name: "Alice",
    })

    const shared = await user
      .get("shared")
      .next("pending_subdomains")
      .next(code)
    const [sharedEnc] = Object.values(shared)
    const newSecret = await holster.SEA.secret(
      {pub: newBody.pub, epub: newBody.epub},
      user.is,
    )
    assert.equal(
      await holster.SEA.decrypt(sharedEnc, newSecret),
      "pending-request",
    )
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
