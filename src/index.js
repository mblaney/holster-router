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
  // inviteCodes is a map of invite codes and their (random) holster keys,
  // stored in memory to avoid decrypting them in each of the functions they're
  // required in.
  const inviteCodes = new Map()

  function mapInviteCodes() {
    if (!user.is) {
      console.log("mapInviteCodes: Host error")
      return
    }

    user
      .get("available")
      .next("invite_codes")
      .on(async codes => {
        if (!codes) return

        for (const [key, enc] of Object.entries(codes)) {
          const invite = await holster.SEA.decrypt(enc, user.is)
          if (invite && !inviteCodes.has(invite.code)) {
            invite.key = key
            inviteCodes.set(invite.code, invite)
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
      mapInviteCodes()
      await writeUserLimit(user.is.pub, hostStorageLimit)
    }
  })

  return {
    router: createRouter(holster, inviteCodes, mail, accountDefaults),
    admin: createAdmin(holster, inviteCodes, mail, opts.federatedHosts),
  }
}
