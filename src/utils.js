export function newCode() {
  const chars = "bcdfghjkmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ123456789"
  let code = ""
  while (code.length < 8) {
    code += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return code
}

export async function checkCodes(user, inviteCodes, newCodes) {
  const accounts = await new Promise(resolve => user.get("accounts", resolve))
  const existing = Object.keys(accounts || {})
  for (const code of newCodes) {
    if (existing.includes(code)) return false
    if (inviteCodes.has(code)) return false
  }
  return true
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
        console.log(error)
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
