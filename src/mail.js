import nodemailer from "nodemailer"

export function createMail(opts = {}) {
  function send(email, subject, message, bcc) {
    if (!opts.mailFrom) {
      console.log("email", email)
      console.log("subject", subject)
      console.log("message", message)
      return
    }

    const data = {from: opts.mailFrom, to: email, subject, text: message, bcc}
    nodemailer.createTransport({sendmail: true}).sendMail(data, (err, info) => {
      if (err) {
        console.log("sendmail returned an error:")
        console.log(err)
        return
      }
      console.log("mail", info)
    })
  }

  function requestInvite(email) {
    const message = `Thanks for requesting an invite code at ${opts.appHost}

There is a waiting list to create new accounts, an invite code will be sent to your email address ${email} when it becomes available.`
    // If mailFrom is not set then the message is already logged.
    if (opts.mailFrom && !opts.mailBcc) console.log("Invite request", email)
    send(email, "Invite request", message, opts.mailBcc)
  }

  function sendInviteCode(code, email) {
    const message = `Hello, thanks for waiting!

You can now create an account at ${opts.appHost}/register using your invite code ${code}
`
    send(email, "Invite code", message)
  }

  function validateEmail(name, email, code, validate) {
    const message = `Hello ${name}

Thanks for creating an account at ${opts.appHost}

Please validate your email at ${opts.appHost}/validate-email?code=${code}&validate=${validate}

If you ever need to reset your password you will then be able to use ${opts.appHost}/reset-password with the code ${code}
`
    send(email, "Validate your email", message)
  }

  function resetPassword(name, remaining, email, code, reset) {
    const message = `Hello ${name}

You can now update your password at ${opts.appHost}/update-password?username=${name}&code=${code}&reset=${reset}

This link will be valid to use for the next 24 hours.

${remaining <= 5 ? `Note that you can only reset your password ${remaining} more time${remaining != 1 ? "s" : ""}.` : ""}
`
    send(email, "Update your password", message)
  }

  return {requestInvite, sendInviteCode, validateEmail, resetPassword}
}
