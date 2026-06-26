import {describe, test} from "node:test"
import assert from "node:assert/strict"
import fs from "fs"
import {createTestUser, testDirs} from "./setup.js"
import {newCode, checkCodes} from "../src/utils.js"

describe("checkCodes", () => {
  test("returns true for a new code", async () => {
    const user = await createTestUser()
    assert.equal(await checkCodes(user, new Map(), [newCode()]), true)
  })

  test("returns false for a code already in accounts", async () => {
    const user = await createTestUser()
    const code = newCode()
    await new Promise(resolve =>
      user.get("accounts").next(code).put({pub: "test"}, resolve),
    )
    assert.equal(await checkCodes(user, new Map(), [code]), false)
  })

  test("returns false for a code in inviteCodes", async () => {
    const user = await createTestUser()
    const code = newCode()
    const inviteCodes = new Map([[code, {code, owner: "owner"}]])
    assert.equal(await checkCodes(user, inviteCodes, [code]), false)
  })

  test("returns false if any code in a batch is a duplicate", async () => {
    const user = await createTestUser()
    const existing = newCode()
    await new Promise(resolve =>
      user.get("accounts").next(existing).put({pub: "test"}, resolve),
    )
    assert.equal(
      await checkCodes(user, new Map(), [newCode(), existing, newCode()]),
      false,
    )
  })

  test("cleanup", (t, done) => {
    const dirs = [...testDirs]
    const next = err => {
      if (err || !dirs.length) return done(err)
      fs.rm(dirs.shift(), {recursive: true, force: true}, next)
    }
    next()
  })
})
