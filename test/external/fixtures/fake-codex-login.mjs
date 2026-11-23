// A fake `codex login --device-auth`: it prints the device link and a one-time
// code the way Codex 0.171 does, then ends signed in a moment later, or fails.
import { writeFileSync } from 'node:fs'
console.log('Follow these steps to sign in with ChatGPT using device code authorization:\n')
console.log('1. Open this link in your browser and sign in to your account')
console.log('   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n')
console.log('2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m')
console.log('   \x1b[94mWXYZ-12345\x1b[0m\n')
setTimeout(() => {
  if (process.env.FAKE_DEVICE_FAIL) {
    console.error('Error: device code authorization is disabled for this account')
    process.exit(1)
  }
  writeFileSync(process.env.FAKE_SIGNED_IN, 'device')
  console.log('Successfully logged in')
  process.exit(0)
}, Number(process.env.FAKE_DEVICE_DELAY ?? 300))
