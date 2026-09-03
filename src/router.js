import express from "express"
import {
  newCode,
  checkCodes,
  createLoginCodes,
  reshareOnMigration,
} from "./utils.js"

export function createRouter(holster, loginCodes, mail, accountDefaults, opts) {
  const user = holster.user()
  const router = express.Router()

  function signupPoolSize() {
    let count = 0
    for (const login of loginCodes.values()) {
      if (!login.owner && login.code !== "admin") count++
    }
    return count
  }

  if (opts.signup) {
    const interval = setInterval(() => {
      const availableLoginCodes = opts.availableLoginCodes ?? 10
      const count = availableLoginCodes - signupPoolSize()
      // Replenish when half available, batching federated host checks
      // instead of checking on every signup.
      if (count >= availableLoginCodes / 2) {
        createLoginCodes(holster, user, loginCodes, opts, count)
      }
    }, 60000)
    // Don't let this timer alone keep the process alive.
    interval.unref()
  }

  function validateRegistration(body) {
    if (!body.pub) return {status: 400, message: "Public key required"}
    if (!body.epub) return {status: 400, message: "Epub key required"}
    if (!body.username) return {status: 400, message: "Username required"}
    if (!/^\w+$/.test(body.username)) {
      return {
        status: 400,
        message: "Username must contain only numbers, letters and underscore",
      }
    }
    if (!body.email) return {status: 400, message: "Email required"}
    return null
  }

  // Creates an account for a claimed login code, used by both
  // /verify-login-code (code supplied by the caller) and /signup (code
  // reserved from the ownerless pool by the caller). Assumes body has
  // already passed validateRegistration and the caller has already removed
  // login from loginCodes. Returns null on success, or {status, message} to
  // send as an error response.
  async function registerAccount(login, code, body) {
    if (!user.is) return {status: 500, message: "Host error"}

    const validate = newCode()
    const encValidate = await holster.SEA.encrypt(validate, user.is)
    const encEmail = await holster.SEA.encrypt(body.email, user.is)
    const data = {
      ...accountDefaults,
      pub: body.pub,
      epub: body.epub,
      username: body.username,
      name: body.username,
      email: encEmail,
      validate: encValidate,
      ref: login.owner,
    }
    let err = await new Promise(resolve => {
      user.get("accounts").next(code).put(data, resolve)
    })
    if (err) {
      console.log(err)
      return {status: 500, message: "Host error"}
    }

    // Also map the code to the user's public key to make login easier.
    err = await new Promise(resolve => {
      user
        .get("map")
        .next("account:" + body.pub)
        .put(code, resolve)
    })
    if (err) {
      console.log(err)
      return {status: 500, message: "Host error"}
    }

    mail.validateEmail(body.username, body.email, code, validate)
    // Remove login code as it's no longer available.
    err = await new Promise(resolve => {
      user
        .get("available")
        .next("login_codes")
        .next(login.key)
        .put(null, resolve)
    })
    if (err) {
      console.log(err)
      return {status: 500, message: "Host error"}
    }

    // Ownerless (signup pool) and "admin" codes have no referring account, so
    // there's no shared login code entry to clean up.
    if (!login.owner || code === "admin") return null

    // Also remove from shared codes of the login owner.
    const account = await new Promise(resolve => {
      user.get("accounts").next(login.owner, resolve)
    })
    if (!account || !account.epub) {
      console.log(`Account not found for login.owner: ${login.owner}`)
      return null
    }

    user
      .get("shared")
      .next("login_codes")
      .next(login.owner, async codes => {
        if (!codes) return

        const secret = await holster.SEA.secret(account, user.is)
        let found = false
        for (const [key, encrypted] of Object.entries(codes)) {
          if (found) break
          if (!key || !encrypted) continue

          const shared = await holster.SEA.decrypt(encrypted, secret)
          if (code === shared) {
            found = true
            user
              .get("shared")
              .next("login_codes")
              .next(login.owner)
              .next(key)
              .put(null, err => {
                if (err) console.log(err)
              })
          }
        }
      })
    return null
  }

  router.get("/health", (req, res) => {
    const memUsage = process.memoryUsage()
    res.json({
      status: "ok",
      uptime: Math.round(process.uptime()),
      memory: Math.round(memUsage.rss / 1024 / 1024),
      timestamp: Date.now(),
    })
  })

  // The host public key is requested by the browser so that it knows where to
  // get data from (all data is stored under user accounts when using the
  // secure flag in Holster opts).
  router.get("/host-public-key", (req, res) => {
    if (user.is) {
      res.send(user.is.pub)
      return
    }

    res.status(404).send("Host public key not found")
  })

  router.post("/request-login-code", (req, res) => {
    if (!req.body.email) {
      res.status(400).send("email required")
      return
    }

    mail.requestLogin(req.body.email)
    res.send("Login code requested")
  })

  router.post("/signup", async (req, res) => {
    if (!opts.signup) {
      res.send("Signup is not available")
      return
    }

    const validationError = validateRegistration(req.body)
    if (validationError) {
      res.status(validationError.status).send(validationError.message)
      return
    }

    // Reserve a pool code synchronously (no await before this point) so a
    // concurrent /signup request can't claim the same one.
    let login
    for (const [code, entry] of loginCodes) {
      if (!entry.owner && code !== "admin") {
        login = entry
        loginCodes.delete(code)
        break
      }
    }
    if (!login) {
      res
        .status(503)
        .send("Signup is not available, please try again in a few minutes")
      return
    }

    const error = await registerAccount(login, login.code, req.body)
    if (error) {
      res.status(error.status).send(error.message)
      return
    }
    res.end()
  })

  router.post("/check-codes", async (req, res) => {
    if (!req.body.codes || req.body.codes.length === 0) {
      res.status(400).send("codes required")
      return
    }
    if (!user.is) {
      res.status(500).send("Host error")
      return
    }
    if (await checkCodes(user, loginCodes, req.body.codes)) {
      res.end() // ok
      return
    }

    res.status(400).send("duplicate code found")
  })

  router.post("/check-login-code", (req, res) => {
    const code = req.body.code || "admin"
    if (loginCodes.has(code)) {
      res.end() // ok
      return
    }
    if (!user.is) {
      res.status(500).send("Host error")
      return
    }

    // This just provides relevant errors.
    user.get("accounts").next(code, used => {
      if (used) {
        if (code === "admin") {
          res.status(400).send("Please provide a login code")
          return
        }
        res.status(400).send("Login code already used")
        return
      }
      res.status(404).send("Login code not found")
    })
  })

  router.post("/verify-login-code", async (req, res) => {
    const code = req.body.code || "admin"
    const login = loginCodes.get(code)
    if (!login) {
      res.status(404).send("Login code not found")
      return
    }

    const validationError = validateRegistration(req.body)
    if (validationError) {
      res.status(validationError.status).send(validationError.message)
      return
    }

    // Delete synchronously (no await before this point) so a concurrent
    // request with the same code can't also pass the loginCodes.get check
    // above.
    loginCodes.delete(code)

    const error = await registerAccount(login, code, req.body)
    if (error) {
      res.status(error.status).send(error.message)
      return
    }
    res.end()
  })

  router.post("/validate-email", async (req, res) => {
    const code = req.body.code
    if (!code) {
      res.status(400).send("Login code required")
      return
    }
    if (!req.body.validate) {
      res.status(400).send("Validation code required")
      return
    }
    if (!user.is) {
      res.status(500).send("Host error")
      return
    }

    const account = await new Promise(resolve => {
      user.get("accounts").next(code, resolve)
    })
    if (!account) {
      res.status(404).send("Account not found")
      return
    }
    if (!account.validate) {
      res.send("Email already validated")
      return
    }

    const validate = await holster.SEA.decrypt(account.validate, user.is)
    if (validate !== req.body.validate) {
      res.status(400).send("Validation code does not match")
      return
    }

    user
      .get("accounts")
      .next(code)
      .put({validate: null}, err => {
        if (err) {
          console.log(err)
          res.status(500).send("Host error")
          return
        }

        res.send("Email validated")
      })
  })

  router.post("/reset-password", async (req, res) => {
    const code = req.body.code
    if (!code) {
      res.status(400).send("Login code required")
      return
    }
    if (!req.body.email) {
      res.status(400).send("Email required")
      return
    }
    if (!user.is) {
      res.status(500).send("Host error")
      return
    }

    const account = await new Promise(resolve => {
      user.get("accounts").next(code, resolve)
    })
    if (!account) {
      res.status(404).send("Account not found")
      return
    }

    let increment = 0
    const match = account.username.match(/\.(\d)$/)
    if (match) increment = Number(match[1])
    if (increment === 9) {
      res.status(400).send("Too many password resets")
      return
    }

    const email = await holster.SEA.decrypt(account.email, user.is)
    if (email !== req.body.email) {
      res.status(400).send("Email does not match login code")
      return
    }
    if (account.validate) {
      res.status(400).send("Please validate your email first")
      return
    }

    const reset = newCode()
    const remaining = 8 - increment
    const data = {
      reset: await holster.SEA.encrypt(reset, user.is),
      expiry: Date.now() + 86400000,
    }
    user
      .get("accounts")
      .next(code)
      .put(data, err => {
        if (err) {
          console.log(err)
          res.status(500).send("Host error")
          return
        }

        mail.resetPassword(account.name, remaining, email, code, reset)
        res.send("Reset password email sent")
      })
  })

  router.post("/update-password", async (req, res) => {
    const code = req.body.code
    if (!code) {
      res.status(400).send("Login code required")
      return
    }
    if (!req.body.reset) {
      res.status(400).send("Reset code required")
      return
    }
    if (!req.body.pub) {
      res.status(400).send("Public key required")
      return
    }
    if (!req.body.epub) {
      res.status(400).send("Epub key required")
      return
    }
    if (!req.body.username) {
      res.status(400).send("Username required")
      return
    }
    if (!req.body.name) {
      res.status(400).send("Display Name required")
      return
    }
    if (!user.is) {
      res.status(500).send("Host error")
      return
    }

    const account = await new Promise(resolve => {
      user.get("accounts").next(code, resolve)
    })
    if (!account) {
      res.status(404).send("Account not found")
      return
    }
    if (!account.reset) {
      res.status(404).send("Reset code not found")
      return
    }
    if (!account.expiry || account.expiry < Date.now()) {
      res.status(400).send("Reset code has expired")
      return
    }

    const reset = await holster.SEA.decrypt(account.reset, user.is)
    if (reset !== req.body.reset) {
      res.status(400).send("Reset code does not match")
      return
    }

    const data = {
      pub: req.body.pub,
      epub: req.body.epub,
      username: req.body.username,
      name: req.body.name,
      prev: account.pub,
    }
    user
      .get("accounts")
      .next(code)
      .put(data, err => {
        if (err) {
          console.log(err)
          res.status(500).send("Host error")
          return
        }

        user
          .get("map")
          .next("account:" + req.body.pub)
          .put(code, async err => {
            if (err) {
              console.log(err)
              res.status(500).send("Host error")
              return
            }

            // A Holster password update is a migration from an old public
            // key on the account to a new public key provided in the request.
            await reshareOnMigration(
              user,
              holster,
              opts.shared ?? ["login_codes"],
              code,
              account,
              data,
            )
            res.send(account.pub)
          })
      })
  })

  return router
}
