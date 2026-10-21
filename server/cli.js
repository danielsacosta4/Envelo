#!/usr/bin/env node
'use strict';

// Admin commands, run on the server itself:
//
//   envelo users                     list accounts
//   envelo reset-password <email>    set a temporary password (changed at next sign-in)
//   envelo reset-2fa <email>         turn off two-step sign-in for someone who lost their phone
//   envelo delete-user <email>       delete an account and its data
//   envelo invite <email>            let someone create an account
//   envelo registration [open|invite|closed]   who may create an account
//
// They talk to the running server on this machine, proving themselves with
// the token the server writes to DATA_DIR/admin.token.

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.DATA_DIR || '/var/lib/envelo';
const PORT = Number(process.env.PORT || 3000);

function usage() {
  console.log(`Envelo admin

  envelo users                     list accounts
  envelo reset-password <email>    give someone a temporary password
  envelo reset-2fa <email>         turn off two-step sign-in for someone
  envelo delete-user <email>       delete an account and all its data
  envelo invite <email>            let someone create an account
  envelo registration [mode]       show or set who may sign up:
                                   open, invite (default) or closed
`);
}

async function call(command, body = {}) {
  let token;
  try {
    // The data folder belongs to the service user, so the token file is
    // opened without following links and must be a small plain file: this
    // command runs as root and must not be tricked into sending another file.
    const fd = fs.openSync(path.join(DATA_DIR, 'admin.token'), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size > 200) throw new Error('not a token');
      token = fs.readFileSync(fd, 'utf8').trim();
    } finally {
      fs.closeSync(fd);
    }
    if (!/^[0-9a-f]{20,100}$/.test(token)) throw new Error('not a token');
  } catch {
    throw new Error(`Cannot read ${path.join(DATA_DIR, 'admin.token')}. Run this as root on the Envelo server while Envelo is running.`);
  }
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${PORT}/api/admin/${command}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': token },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(`Envelo is not answering on port ${PORT}. Is it running? (systemctl status envelo)`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Failed (${res.status}).`);
  return data;
}

async function main() {
  const [command, email] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') return usage();
  const needEmail = ['reset-password', 'reset-2fa', 'delete-user', 'invite'];
  if (needEmail.includes(command) && !email) throw new Error(`Usage: envelo ${command} <email>`);
  if (command === 'users') {
    const { users, invites = [], registration } = await call('users');
    if (!users.length) console.log('No accounts yet.');
    for (const u of users) console.log(`${u.email}${u.twofa ? '  (two-step sign-in on)' : ''}  created ${String(u.createdAt || '').slice(0, 10)}`);
    if (invites.length) console.log(`Invited, no account yet: ${invites.join(', ')}`);
    if (registration) console.log(`Sign-up: ${registration}`);
  } else if (command === 'invite') {
    const r = await call('invite', { email });
    console.log(`${r.email} can now create an account.`);
  } else if (command === 'registration') {
    if (!email) {
      const { registration } = await call('users');
      console.log(`Sign-up is ${registration}. Change it with: envelo registration open|invite|closed`);
    } else {
      const r = await call('registration', { mode: email });
      console.log(`Sign-up is now ${r.registration}.`);
    }
  } else if (command === 'reset-password') {
    const r = await call('reset-password', { email });
    console.log(`Temporary password for ${r.email}: ${r.temporaryPassword}`);
    console.log('They will choose a new one when they sign in. Their other sessions were signed out.');
  } else if (command === 'reset-2fa') {
    const r = await call('reset-2fa', { email });
    console.log(`Two-step sign-in is off for ${r.email}. They can turn it on again in Settings.`);
  } else if (command === 'delete-user') {
    const r = await call('delete-user', { email });
    console.log(`Deleted ${r.email} and all their data.`);
  } else {
    usage();
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
