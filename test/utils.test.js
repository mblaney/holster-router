import {describe, test} from "node:test"
import assert from "node:assert/strict"
import fs from "fs"
import {createTestUser as createUser, loadLoginCodes} from "./setup.js"
import {newCode, checkCodes, createLoginCodes} from "../src/utils.js"

const dirs = []
async function createTestUser() {
  const result = await createUser()
  dirs.push(result.dir)
  return result
}

describe("checkCodes", () => {
  test("returns true for a new code", async () => {
    const {user} = await createTestUser()
    assert.equal(await checkCodes(user, new Map(), [newCode()]), true)
  })

  test("returns false for a code already in accounts", async () => {
    const {user} = await createTestUser()
    const code = newCode()
    await new Promise(resolve =>
      user.get("accounts").next(code).put({pub: "test"}, resolve),
    )
    assert.equal(await checkCodes(user, new Map(), [code]), false)
  })

  test("returns false for a code in loginCodes", async () => {
    const {user} = await createTestUser()
    const code = newCode()
    const loginCodes = new Map([[code, {code, owner: "owner"}]])
    assert.equal(await checkCodes(user, loginCodes, [code]), false)
  })

  test("returns false if any code in a batch is a duplicate", async () => {
    const {user} = await createTestUser()
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
    const {holster, user} = await createTestUser()
    const ok = await createLoginCodes(holster, user, new Map(), {}, 3)
    assert.equal(ok, true)

    const loginCodes = await loadLoginCodes(holster, user)
    assert.equal(loginCodes.size, 3)
    for (const login of loginCodes.values()) assert.equal(login.owner, "")
  })

  test("ownerless codes have no shared login code entry", async () => {
    const {holster, user} = await createTestUser()
    await createLoginCodes(holster, user, new Map(), {}, 1)

    const shared = await new Promise(resolve => {
      user.get("shared").next("login_codes", resolve)
    })
    assert.ok(!shared)
  })

  test("codes created for an owner are also shared to that owner", async () => {
    const {holster, user} = await createTestUser()
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
    const {holster, user} = await createTestUser()
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
