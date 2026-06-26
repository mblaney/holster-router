import express from "express"
import {newCode, checkCodes} from "./utils.js"

export function createRouter(holster, inviteCodes, mail, accountDefaults) {
  const user = holster.user()
  const router = express.Router()

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

  router.post("/request-invite-code", (req, res) => {
    if (!req.body.email) {
      res.status(400).send("email required")
      return
    }

    mail.requestInvite(req.body.email)
    res.send("Invite code requested")
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
    if (await checkCodes(user, inviteCodes, req.body.codes)) {
      res.end() // ok
      return
    }

    res.status(400).send("duplicate code found")
  })

  router.post("/check-invite-code", (req, res) => {
    const code = req.body.code || "admin"
    if (inviteCodes.has(code)) {
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
          res.status(400).send("Please provide an invite code")
          return
        }
        res.status(400).send("Invite code already used")
        return
      }
      res.status(404).send("Invite code not found")
    })
  })

  router.post("/claim-invite-code", async (req, res) => {
    const code = req.body.code || "admin"
    const invite = inviteCodes.get(code)
    if (!invite) {
      res.status(404).send("Invite code not found")
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
    if (!/^\w+$/.test(req.body.username)) {
      res
        .status(400)
        .send("Username must contain only numbers, letters and underscore")
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

    const validate = newCode()
    const encValidate = await holster.SEA.encrypt(validate, user.is)
    const encEmail = await holster.SEA.encrypt(req.body.email, user.is)
    const data = {
      ...accountDefaults,
      pub: req.body.pub,
      epub: req.body.epub,
      username: req.body.username,
      name: req.body.username,
      email: encEmail,
      validate: encValidate,
      ref: invite.owner,
    }
    let err = await new Promise(resolve => {
      user.get("accounts").next(code).put(data, resolve)
    })
    if (err) {
      console.log(err)
      res.status(500).send("Host error")
      return
    }

    // Also map the code to the user's public key to make login easier.
    err = await new Promise(resolve => {
      user
        .get("map")
        .next("account:" + req.body.pub)
        .put(code, resolve)
    })
    if (err) {
      console.log(err)
      res.status(500).send("Host error")
      return
    }

    mail.validateEmail(req.body.username, req.body.email, code, validate)
    // Remove invite code as it's no longer available.
    err = await new Promise(resolve => {
      user
        .get("available")
        .next("invite_codes")
        .next(invite.key)
        .put(null, resolve)
    })
    if (err) {
      console.log(err)
      res.status(500).send("Host error")
      return
    }

    inviteCodes.delete(code)
    if (code === "admin") {
      res.end()
      return
    }

    // Also remove from shared codes of the invite owner.
    const account = await new Promise(resolve => {
      user.get("accounts").next(invite.owner, resolve)
    })
    if (!account || !account.epub) {
      console.log(`Account not found for invite.owner: ${invite.owner}`)
      res.end()
      return
    }

    user
      .get("shared")
      .next("invite_codes")
      .next(invite.owner, async codes => {
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
              .next("invite_codes")
              .next(invite.owner)
              .next(key)
              .put(null, err => {
                if (err) console.log(err)
              })
          }
        }
      })
    res.end()
  })

  router.post("/validate-email", async (req, res) => {
    const code = req.body.code
    if (!code) {
      res.status(400).send("Invite code required")
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
      res.status(400).send("Invite code required")
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
      res.status(400).send("Email does not match invite code")
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
      res.status(400).send("Invite code required")
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
          .put(code, err => {
            if (err) {
              console.log(err)
              res.status(500).send("Host error")
              return
            }

            // Also update shared invite codes for this account.
            user
              .get("shared")
              .next("invite_codes")
              .next(code, async codes => {
                if (codes) {
                  const oldSecret = await holster.SEA.secret(account, user.is)
                  const newSecret = await holster.SEA.secret(data, user.is)
                  for (const [key, encrypted] of Object.entries(codes)) {
                    if (!key || !encrypted) continue

                    const dec = await holster.SEA.decrypt(encrypted, oldSecret)
                    const shared = await holster.SEA.encrypt(dec, newSecret)
                    const err = await new Promise(resolve => {
                      user
                        .get("shared")
                        .next("invite_codes")
                        .next(code)
                        .next(key)
                        .put(shared, resolve)
                    })
                    if (err) console.log(err)
                  }
                }
                res.send(account.pub)
              })
          })
      })
  })

  return router
}
