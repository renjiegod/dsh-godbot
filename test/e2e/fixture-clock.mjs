// Used only in the isolated Host, to cross UTC billing windows without touching the system clock.
const epoch = Number(process.env.GODBOT_E2E_EPOCH)
if (epoch > 0) {
  const real = Date.now.bind(Date)
  const installed = real()
  Date.now = () => epoch + (real() - installed)
}
