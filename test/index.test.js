import {describe, test} from "node:test"
import assert from "node:assert/strict"
import fs from "fs"
import {createTestUser} from "./setup.js"
import routerAdmin from "../src/index.js"

const dirs = []

describe("routerAdmin authenticated option", () => {
  test("is called once the host account logs in successfully", async () => {
    const {holster, dir} = await createTestUser()
    dirs.push(dir)

    // createTestUser already logs the same holster.user() singleton in as
    // testuser/testpassword - routerAdmin() re-authenticating with the
    // same real credentials is a second, idempotent login, which is what
    // "authenticated" should fire from here.
    await new Promise(resolve => {
      routerAdmin(holster, {
        username: "testuser",
        password: "testpassword",
        authenticated: resolve,
      })
    })
  })

  test("is not called when the credentials are wrong", async () => {
    const {holster, dir} = await createTestUser()
    dirs.push(dir)

    let called = false
    routerAdmin(holster, {
      username: "testuser",
      password: "wrongpassword",
      authenticated: () => {
        called = true
      },
    })

    // No event to await for a failed login, so give the (mocked, local)
    // auth attempt a moment to resolve before checking.
    await new Promise(resolve => setTimeout(resolve, 500))
    assert.equal(called, false)
  })

  test("is optional - routerAdmin works without it", async () => {
    const {holster, dir} = await createTestUser()
    dirs.push(dir)

    const {router, admin} = routerAdmin(holster, {
      username: "testuser",
      password: "testpassword",
    })
    assert.ok(router)
    assert.ok(admin)
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
