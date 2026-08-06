import {Server} from "mock-socket"
import Holster from "@mblaney/holster/src/holster.js"
import {createLoginCodes} from "../src/utils.js"

// Each createTestUser call gets its own isolated server on a unique port so
// tests that run concurrently don't share state.
let nextPort = 9200

/**
 * Create and authenticate a test Holster user.
 *
 * Creates a mock-socket Server (which patches globalThis.WebSocket so that
 * Holster's peer connections are routed through it), then creates a Holster
 * server instance backed by that socket, registers the test user, and
 * authenticates. Returns {holster, user, dir}. dir is the storage directory
 * on disk; each test file is responsible for removing the dirs it created
 * (node --test runs files concurrently, so a shared cleanup list would race).
 */
export async function createTestUser() {
  const port = nextPort++
  const file = `test/holster-router-test-${port}`
  const wss = new Server(`ws://localhost:${port}`)
  const holster = Holster({wss, file})
  const user = holster.user()

  await new Promise((resolve, reject) => {
    user.create("testuser", "testpassword", err => {
      if (err && !err.includes("already exists")) reject(new Error(err))
      else resolve()
    })
  })

  await new Promise((resolve, reject) => {
    user.auth("testuser", "testpassword", err => {
      if (err) reject(new Error(err))
      else resolve()
    })
  })

  return {holster, user, dir: file}
}

/**
 * Reads back every code under available.login_codes and decrypts it, the
 * same way index.js's mapLoginCodes listener populates loginCodes from
 * storage. Used by tests to build a loginCodes Map after seeding codes with
 * createLoginCodes.
 */
export async function loadLoginCodes(holster, user) {
  const loginCodes = new Map()
  const codes = await new Promise(resolve => {
    user.get("available").next("login_codes", resolve)
  })
  if (!codes) return loginCodes

  for (const [key, enc] of Object.entries(codes)) {
    const login = await holster.SEA.decrypt(enc, user.is)
    if (login) {
      login.key = key
      loginCodes.set(login.code, login)
    }
  }
  return loginCodes
}
