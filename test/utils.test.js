import {describe, test} from "node:test"
import assert from "node:assert/strict"
import fs from "fs"
import {createTestUser, loadLoginCodes} from "./setup.js"
import {
  newCode,
  checkCodes,
  createLoginCodes,
  reshareOnMigration,
} from "../src/utils.js"

const dirs = []

describe("checkCodes", () => {
  test("returns true for a new code", async () => {
    const {user, dir} = await createTestUser()
    dirs.push(dir)
    assert.equal(await checkCodes(user, new Map(), [newCode()]), true)
  })

  test("returns false for a code already in accounts", async () => {
    const {user, dir} = await createTestUser()
    dirs.push(dir)
    const code = newCode()
    await new Promise(resolve =>
      user.get("accounts").next(code).put({pub: "test"}, resolve),
    )
    assert.equal(await checkCodes(user, new Map(), [code]), false)
  })

  test("returns false for a code in loginCodes", async () => {
    const {user, dir} = await createTestUser()
    dirs.push(dir)
    const code = newCode()
    const loginCodes = new Map([[code, {code, owner: "owner"}]])
    assert.equal(await checkCodes(user, loginCodes, [code]), false)
  })

  test("returns false if any code in a batch is a duplicate", async () => {
    const {user, dir} = await createTestUser()
    dirs.push(dir)
    const existing = newCode()
    await new Promise(resolve =>
      user.get("accounts").next(existing).put({pub: "test"}, resolve),
    )
    assert.equal(
      await checkCodes(user, new Map(), [newCode(), existing, newCode()]),
      false,
    )
  })
})

describe("createLoginCodes", () => {
  test("creates the requested number of ownerless codes", async () => {
    const {holster, user, dir} = await createTestUser()
    dirs.push(dir)
    const ok = await createLoginCodes(holster, user, new Map(), {}, 3)
    assert.equal(ok, true)

    const loginCodes = await loadLoginCodes(holster, user)
    assert.equal(loginCodes.size, 3)
    for (const login of loginCodes.values()) assert.equal(login.owner, "")
  })

  test("ownerless codes have no shared login code entry", async () => {
    const {holster, user, dir} = await createTestUser()
    dirs.push(dir)
    await createLoginCodes(holster, user, new Map(), {}, 1)

    const shared = await new Promise(resolve => {
      user.get("shared").next("login_codes", resolve)
    })
    assert.ok(!shared)
  })

  test("codes created for an owner are also shared to that owner", async () => {
    const {holster, user, dir} = await createTestUser()
    dirs.push(dir)
    const owner = newCode()
    const account = await holster.SEA.pair()
    const ok = await createLoginCodes(
      holster,
      user,
      new Map(),
      {},
      2,
      owner,
      account,
    )
    assert.equal(ok, true)

    const loginCodes = await loadLoginCodes(holster, user)
    assert.equal(loginCodes.size, 2)
    for (const login of loginCodes.values()) assert.equal(login.owner, owner)

    const shared = await new Promise(resolve => {
      user.get("shared").next("login_codes").next(owner, resolve)
    })
    assert.equal(Object.keys(shared || {}).length, 2)
  })

  test("returns false and stores nothing when a federated host check fails", async () => {
    const {holster, user, dir} = await createTestUser()
    dirs.push(dir)
    const ok = await createLoginCodes(
      holster,
      user,
      new Map(),
      {
        federatedHosts: "http://localhost:1",
      },
      2,
    )
    assert.equal(ok, false)

    const loginCodes = await loadLoginCodes(holster, user)
    assert.equal(loginCodes.size, 0)
  })
})

describe("reshareOnMigration", () => {
  // Seeds accounts/<code> the way /update-password already has by the time
  // it calls reshareOnMigration (the new record in place, prev pointing at
  // the old pub), then seeds one shared entry per given namespace,
  // encrypted for oldAccount - set: true, matching createLoginCodes' own
  // use of .put(data, true, cb), since a real shared/<namespace>/<code>
  // node holds however many randomly-keyed entries a real owner would
  // have accumulated, not one fixed key.
  async function seedMigratedAccount(holster, user, namespaces, code) {
    const oldAccount = await holster.SEA.pair()
    const newAccount = await holster.SEA.pair()
    await new Promise(resolve => {
      user
        .get("accounts")
        .next(code)
        .put({pub: newAccount.pub, prev: oldAccount.pub}, resolve)
    })

    const oldSecret = await holster.SEA.secret(oldAccount, user.is)
    for (const namespace of namespaces) {
      const enc = await holster.SEA.encrypt("secret data", oldSecret)
      await new Promise(resolve => {
        user.get("shared").next(namespace).next(code).put(enc, true, resolve)
      })
    }
    return {oldAccount, newAccount}
  }

  // Every entry under shared/<namespace>/<code> should now decrypt with
  // newAccount's own secret - there's exactly one here (seedMigratedAccount
  // only ever seeds one), so this reads whichever random key it landed on.
  async function readSharedEntry(user, namespace, code) {
    const shared = await new Promise(resolve => {
      user.get("shared").next(namespace).next(code, resolve)
    })
    const [enc] = Object.values(shared || {})
    return enc
  }

  test("re-encrypts a shared entry so it's only readable with the new key", async () => {
    const {holster, user, dir} = await createTestUser()
    dirs.push(dir)
    const code = newCode()
    const {oldAccount, newAccount} = await seedMigratedAccount(
      holster,
      user,
      ["login_codes"],
      code,
    )

    await reshareOnMigration(
      user,
      holster,
      ["login_codes"],
      code,
      oldAccount,
      newAccount,
    )

    const enc = await readSharedEntry(user, "login_codes", code)
    const newSecret = await holster.SEA.secret(newAccount, user.is)
    assert.equal(await holster.SEA.decrypt(enc, newSecret), "secret data")

    const oldSecret = await holster.SEA.secret(oldAccount, user.is)
    assert.equal(await holster.SEA.decrypt(enc, oldSecret), null)
  })

  test("re-encrypts every given namespace, not just login_codes", async () => {
    const {holster, user, dir} = await createTestUser()
    dirs.push(dir)
    const code = newCode()
    const {oldAccount, newAccount} = await seedMigratedAccount(
      holster,
      user,
      ["login_codes", "pending_subdomains"],
      code,
    )

    await reshareOnMigration(
      user,
      holster,
      ["login_codes", "pending_subdomains"],
      code,
      oldAccount,
      newAccount,
    )

    const newSecret = await holster.SEA.secret(newAccount, user.is)
    for (const namespace of ["login_codes", "pending_subdomains"]) {
      const enc = await readSharedEntry(user, namespace, code)
      assert.equal(await holster.SEA.decrypt(enc, newSecret), "secret data")
    }
  })

  test("re-encrypts a single value sitting directly at shared/<namespace>/<code>", async () => {
    const {holster, user, dir} = await createTestUser()
    dirs.push(dir)
    const code = newCode()
    const oldAccount = await holster.SEA.pair()
    const newAccount = await holster.SEA.pair()
    await new Promise(resolve => {
      user
        .get("accounts")
        .next(code)
        .put({pub: newAccount.pub, prev: oldAccount.pub}, resolve)
    })

    const oldSecret = await holster.SEA.secret(oldAccount, user.is)
    const enc = await holster.SEA.encrypt(5, oldSecret)
    await new Promise(resolve => {
      user.get("shared").next("domain_limit").next(code).put(enc, resolve)
    })

    await reshareOnMigration(
      user,
      holster,
      ["domain_limit"],
      code,
      oldAccount,
      newAccount,
    )

    const updated = await new Promise(resolve => {
      user.get("shared").next("domain_limit").next(code, resolve)
    })
    const newSecret = await holster.SEA.secret(newAccount, user.is)
    assert.equal(await holster.SEA.decrypt(updated, newSecret), 5)
    assert.equal(await holster.SEA.decrypt(updated, oldSecret), null)
  })

  test("does nothing when the account's own pub/prev don't match what's claimed", async () => {
    const {holster, user, dir} = await createTestUser()
    dirs.push(dir)
    const code = newCode()
    const {oldAccount, newAccount} = await seedMigratedAccount(
      holster,
      user,
      ["login_codes"],
      code,
    )
    const impostor = await holster.SEA.pair()

    // Claiming a different old account than accounts/<code>.prev actually
    // records should refuse to touch the shared entry at all.
    await reshareOnMigration(
      user,
      holster,
      ["login_codes"],
      code,
      impostor,
      newAccount,
    )

    const enc = await readSharedEntry(user, "login_codes", code)
    const oldSecret = await holster.SEA.secret(oldAccount, user.is)
    assert.equal(await holster.SEA.decrypt(enc, oldSecret), "secret data")
  })

  test("does nothing for a namespace with no shared data", async () => {
    const {holster, user, dir} = await createTestUser()
    dirs.push(dir)
    const code = newCode()
    const oldAccount = await holster.SEA.pair()
    const newAccount = await holster.SEA.pair()
    await new Promise(resolve => {
      user
        .get("accounts")
        .next(code)
        .put({pub: newAccount.pub, prev: oldAccount.pub}, resolve)
    })

    // Just confirming this doesn't throw with nothing to re-encrypt.
    await reshareOnMigration(
      user,
      holster,
      ["login_codes"],
      code,
      oldAccount,
      newAccount,
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
