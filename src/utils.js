export function newCode() {
  const chars = "bcdfghjkmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ123456789"
  let code = ""
  while (code.length < 8) {
    code += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return code
}

export async function checkCodes(user, loginCodes, newCodes) {
  const accounts = await new Promise(resolve => user.get("accounts", resolve))
  const existing = Object.keys(accounts || {})
  for (const code of newCodes) {
    if (existing.includes(code)) return false
    if (loginCodes.has(code)) return false
  }
  return true
}

export async function createLoginCodes(
  holster,
  user,
  loginCodes,
  opts,
  count,
  owner,
  account,
) {
  const newCodes = []
  let i = 0
  while (i++ < count) newCodes.push(newCode())

  if (
    !(await checkCodes(user, loginCodes, newCodes)) ||
    !(await checkHosts(newCodes, opts.federatedHosts))
  ) {
    // If a duplicate code is found, return false and the request can be tried
    // again. More likely that a federated host is not reachable though, so
    // the list will need updating before making the request again.
    return false
  }

  const secret = owner ? await holster.SEA.secret(account, user.is) : null
  for (const code of newCodes) {
    const login = {code, owner: owner ?? ""}
    const enc = await holster.SEA.encrypt(login, user.is)
    let err = await new Promise(resolve => {
      user.get("available").next("login_codes").put(enc, true, resolve)
    })
    if (err) {
      console.log(err)
      return false
    }

    console.log("New login code available", login)
    if (!owner) continue

    const shared = await holster.SEA.encrypt(code, secret)
    err = await new Promise(resolve => {
      user
        .get("shared")
        .next("login_codes")
        .next(owner)
        .put(shared, true, resolve)
    })
    if (err) {
      console.log(err)
      return false
    }
  }
  return true
}

// SEA.encrypt's own output shape - distinguishes a single encrypted value
// sitting directly at shared/<namespace>/<code> from a container of
// multiple such values keyed underneath it (shared/<namespace>/<code>/<key>).
function isEncrypted(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.ct === "string" &&
    typeof value.iv === "string" &&
    typeof value.s === "string" &&
    Object.keys(value).length === 3
  )
}

// Re-share any data in each provided namespace for the user identified by code.
export async function reshareOnMigration(
  user,
  holster,
  namespaces,
  code,
  oldAccount,
  newAccount,
) {
  const current = await new Promise(resolve => {
    user.get("accounts").next(code, resolve)
  })
  if (
    !current ||
    current.pub !== newAccount.pub ||
    current.prev !== oldAccount.pub
  ) {
    console.log(`reshareOnMigration: account mismatch for code ${code}`)
    return
  }

  const oldSecret = await holster.SEA.secret(oldAccount, user.is)
  const newSecret = await holster.SEA.secret(newAccount, user.is)
  for (const namespace of namespaces) {
    const shared = await new Promise(resolve => {
      user.get("shared").next(namespace).next(code, resolve)
    })
    if (!shared) continue

    if (isEncrypted(shared)) {
      const dec = await holster.SEA.decrypt(shared, oldSecret)
      const enc = await holster.SEA.encrypt(dec, newSecret)
      const err = await new Promise(resolve => {
        user.get("shared").next(namespace).next(code).put(enc, resolve)
      })
      if (err) console.log(err)
      continue
    }

    for (const [key, encrypted] of Object.entries(shared)) {
      if (!key || !encrypted) continue

      const dec = await holster.SEA.decrypt(encrypted, oldSecret)
      const enc = await holster.SEA.encrypt(dec, newSecret)
      const err = await new Promise(resolve => {
        user
          .get("shared")
          .next(namespace)
          .next(code)
          .next(key)
          .put(enc, resolve)
      })
      if (err) console.log(err)
    }
  }
}

export async function checkHosts(newCodes, federatedHosts) {
  // Check for a comma separated list of federated hosts that should be checked
  // for duplicate codes. Note that the other servers don't need to store the
  // codes, they just each need to check that the list they create doesn't
  // contain duplicates when they also want to store new codes.
  if (!federatedHosts) return true

  const urls = federatedHosts.split(",").map(url => url + "/check-codes")
  const results = await Promise.all(
    urls.map(async url => {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {"Content-Type": "application/json;charset=utf-8"},
          body: JSON.stringify({codes: newCodes}),
        })
        if (!res.ok) console.log(`checkHosts ${res.status} from ${res.url}`)
        return res.ok
      } catch (error) {
        console.log(
          `checkHosts ${url} unreachable: ${error.cause?.message ?? error.message}`,
        )
        return false
      }
    }),
  )
  return results.every(ok => ok)

  // Notes for further federated updates:
  // Other hosts can decide if they want to allow logins from federated user
  // accounts by listening to get("accounts").on() for each of the known
  // federated hosts and adding them to their own list of accounts. "host" is
  // provided in the account data to point users to their host server, but the
  // user could provide their email to another host to allow password resets
  // their too... it would just be stored on the other host account data the
  // same as it's stored here, without sharing between servers. That server
  // can replace the "host" field in their account data in that case, and can
  // store their own validation code.
}
