import express from "express"
import fs from "fs/promises"
import {createLoginCodes} from "./utils.js"

const USER_LIMIT_FILE = ".user_limit.json"

export async function writeUserLimit(pub, limit) {
  let data = {}
  try {
    data = JSON.parse(await fs.readFile(USER_LIMIT_FILE, "utf8"))
  } catch (err) {
    if (err.code !== "ENOENT")
      console.log("Error reading user limit file:", err.message)
  }
  if (data[pub] !== limit) {
    data[pub] = limit
    try {
      await fs.writeFile(USER_LIMIT_FILE, JSON.stringify(data), "utf8")
    } catch (err) {
      console.log("Error writing user limit file:", err.message)
    }
  }
}

export function createAdmin(holster, loginCodes, mail, opts) {
  const user = holster.user()

  const admin = express.Router()

  admin.post("/create-login-codes", async (req, res) => {
    const code = req.body.code
    if (!code) {
      res.status(400).send("code required")
      return
    }
    if (!user.is) {
      res.status(500).send("Host error")
      return
    }

    const account = await new Promise(resolve => {
      user.get("accounts").next(code, resolve)
    })
    if (!account || !account.epub) {
      res.status(404).send("Account not found")
      return
    }
    if (account.validate) {
      res.status(400).send("Email not validated")
      return
    }

    if (
      await createLoginCodes(
        holster,
        user,
        loginCodes,
        opts,
        req.body.count || 1,
        code,
        account,
      )
    ) {
      res.end()
      return
    }

    res
      .status(500)
      .send("Error creating codes. Please check logs for errors and try again")
  })

  admin.post("/send-login-code", (req, res) => {
    const code = req.body.code
    if (!code) {
      res.status(400).send("code required")
      return
    }
    const email = req.body.email
    if (!email) {
      res.status(400).send("email required")
      return
    }
    mail.sendLoginCode(code, email)
    res.end()
  })

  admin.post("/update-storage-limit", async (req, res) => {
    const code = req.body.code
    if (!code) {
      res.status(400).send("code required")
      return
    }
    const limit = req.body.limit
    if (typeof limit !== "number") {
      res.status(400).send("limit required")
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
    if (account.validate) {
      res.status(400).send("Email not validated")
      return
    }

    await writeUserLimit(account.pub, limit)
    res.end()
  })

  admin.get("/performance", (req, res) => {
    const memUsage = process.memoryUsage()
    res.json({
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
      memory: {
        rss: Math.round(memUsage.rss / 1024 / 1024),
        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
        heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
        external: Math.round(memUsage.external / 1024 / 1024),
      },
      process: {
        pid: process.pid,
        version: process.version,
        platform: process.platform,
      },
    })
  })

  return admin
}
