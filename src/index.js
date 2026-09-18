import {createRouter} from "./router.js"
import {createAdmin, writeUserLimit} from "./admin.js"
import {createMail} from "./mail.js"

// Defense in depth for errors outside any request entirely (background
// timers, startup code) - e.g. mapLoginCodes()'s own .on() listener
// below, or a consuming app's periodic tasks. Registered once here since
// routerAdmin() is the one entry point every consumer already calls.
process.on("unhandledRejection", err => {
  console.error("Unhandled rejection:", err)
})
process.on("uncaughtException", err => {
  console.error("Uncaught exception:", err)
})

export default function routerAdmin(holster, opts = {}) {
  const username = opts.username ?? "host"
  const password = opts.password ?? "password"
  const appHost = opts.appHost ?? "http://localhost:3000"
  const hostStorageLimit = opts.hostStorageLimit ?? 1024
  const accountDefaults = {...opts.accountDefaults, host: appHost}
  const mail = createMail({...opts, appHost})

  const user = holster.user()
  // loginCodes is a map of login codes and their (random) holster keys,
  // stored in memory to avoid decrypting them in each of the functions they're
  // required in.
  const loginCodes = new Map()

  function mapLoginCodes() {
    if (!user.is) {
      console.log("mapLoginCodes: Host error")
      return
    }

    user
      .get("available")
      .next("login_codes")
      .on(async codes => {
        if (!codes) return

        for (const [key, enc] of Object.entries(codes)) {
          const login = await holster.SEA.decrypt(enc, user.is)
          if (login && !loginCodes.has(login.code)) {
            login.key = key
            loginCodes.set(login.code, login)
          }
        }
      }, true)
  }

  console.log("Trying auth credentials for " + username)
  user.auth(username, password, async err => {
    if (err) {
      console.log(err)
    } else {
      console.log(username + " logged in")
      mapLoginCodes()
      await writeUserLimit(user.is.pub, hostStorageLimit)
      opts.authenticated?.()
    }
  })

  return {
    router: createRouter(holster, loginCodes, mail, accountDefaults, opts),
    admin: createAdmin(holster, loginCodes, mail, opts),
    utils: {mail: mail.send, writeUserLimit},
  }
}
