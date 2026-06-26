Holster-router provides [Express](https://expressjs.com) routers for [Holster](https://github.com/mblaney/holster) applications. It handles account management, invite codes, email validation and password reset, so that apps built on Holster don't need to reimplement this infrastructure.

### Install

```
npm install @mblaney/holster-router
```

Peer dependencies: `@mblaney/holster` and `express`.

### Usage

```js
import express from "express"
import Holster from "@mblaney/holster/src/holster.js"
import routerAdmin from "@mblaney/holster-router"

const username = "host"
const password = "password"

const holster = Holster({secure: true, port: 8765, userLimit: true})
const {router, admin} = routerAdmin(holster, {username, password})

// holster-router doesn't export an auth middleware so that consumers aren't
// locked into a specific implementation. A minimal example using the same
// credentials as the Holster host account:
function basicAuth(req, res, next) {
  const auth = (req.headers.authorization || "").split(" ")[1] || ""
  const [u, p] = Buffer.from(auth, "base64").toString().split(":")
  if (u === username && p === password) {
    next()
  } else {
    res.status(401).end()
  }
}

const app = express()
app.use(express.json())
app.use(router)
app.use("/private", basicAuth)
app.use("/private", admin)
app.listen(3000)
```

`routerAdmin` accepts an options object as a second parameter:

| Option | Description |
|---|---|
| `username` | Host account username (default: `host`) |
| `password` | Host account password (default: `password`) |
| `hostStorageLimit` | Storage limit in MB written to `.user_limit.json` on startup (default: `1024`) |
| `appHost` | Server URL used in email links and stored on account data (default: `http://localhost:3000`) |
| `mailFrom` | Sender address for outgoing email. If not set, email content is logged instead |
| `mailBcc` | BCC address copied on outgoing invite request emails |
| `federatedHosts` | Comma-separated list of other holster-router servers to check for duplicate invite codes |
| `accountDefaults` | An object merged into account data when an invite code is claimed. Use this to set app-specific fields on new accounts (e.g. `{feeds: 10, subscribed: 0}`) |

### Setup: creating a host account

All account data is stored under a single host account in Holster. This account must be created before starting the server. Use the Node [REPL](https://nodejs.org/en/learn/command-line/how-to-use-the-nodejs-repl):

```js
const {default: Holster} = await import("@mblaney/holster/src/holster.js")
const holster = Holster({port: 8765})
const user = holster.user()
user.create("host", "password", console.log)

// Log in and create an initial invite code so the first account can register:
user.auth("host", "password", console.log)
const enc = await holster.SEA.encrypt({code: "admin", owner: ""}, user.is)

// Wait for encrypt to finish, then store the code:
user.get("available").next("invite_codes").put(enc, true, console.log)
```

`console.log` is used as the callback and logs `null` on success. Use a real username and password, not the defaults shown here.

Pass the credentials used here into `routerAdmin` via the options parameter before starting the server. All private data in Holster is encrypted using these credentials, so keep them safe.

The first account registered is given the code `"admin"` and can then create invite codes for other accounts.

### Public routes

These routes are mounted by `router` and require no authentication.

- `GET /health` — Returns uptime, memory usage and timestamp.

- `GET /host-public-key` — Returns the host account's public key. The browser needs this to query data stored under the host's namespace in Holster. For example, after a user authenticates locally with Holster, the frontend can look up the user's invite code using the host public key:
  ```js
  const code = await new Promise(res => {
    user.get([host, "map"]).next("account:" + user.is.pub, res)
  })
  ```

- `POST /request-invite-code` — Sends an email to the provided address requesting an invite code from the host. Required: `email`.

- `POST /check-codes` — Used by federated hosts (see the `federatedHosts` option) to verify that a batch of invite codes does not collide with codes on this server. Required: `codes` (array of strings).

- `POST /check-invite-code` — Checks whether an invite code is available. Required: `code`.

- `POST /claim-invite-code` — Registers a new account against an invite code. Required: `code`, `pub`, `epub`, `username`, `email`. Sends a validation email. Also stores a mapping from the account's public key to its invite code so the frontend can retrieve the code after authenticating with Holster (see `/host-public-key` above).

- `POST /validate-email` — Validates an account email using the code sent during registration. Required: `code`, `validate`.

- `POST /reset-password` — Sends a password reset email. Required: `code`, `email`.

- `POST /update-password` — Updates account keys after a password reset. Required: `code`, `reset`, `pub`, `epub`, `username`, `name`. Re-encrypts any shared invite codes under the new key pair. Returns the previous public key so the frontend can migrate local data.

### Private routes

These routes are mounted by `admin` and should be protected by mounting an auth middleware at the same path (see Usage section above):

- `POST /private/create-invite-codes` — Creates invite codes and assigns them to an account. Required: `code`. Optional: `count` (default: 1). The account's email must be validated first.

- `POST /private/send-invite-code` — Emails an invite code to an address. Required: `code`, `email`.

- `POST /private/update-storage-limit` — Updates the Holster storage limit for an account in `.user_limit.json`. Required: `code`, `limit` (MB).

- `GET /private/performance` — Returns memory usage and process info.

### Email

Email is sent via [nodemailer](https://nodemailer.com) using sendmail. Set the `mailFrom` option to enable sending. If `mailFrom` is not set, the email content (including validation codes and reset links) is logged to stdout so you can access it during development.
