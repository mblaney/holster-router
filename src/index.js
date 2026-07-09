import {createRouter} from "./router.js"
import {createAdmin, writeUserLimit} from "./admin.js"
import {createMail} from "./mail.js"

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
    }
  })

  return {
    router: createRouter(holster, loginCodes, mail, accountDefaults),
    admin: createAdmin(holster, loginCodes, mail, opts.federatedHosts),
  }
}
