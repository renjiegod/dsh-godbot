import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { LINK_BUNDLE, bundleLink } from '../../scripts/build-link.mjs'

test('mobile-link.js is the build of src/link', async () => {
  assert.equal(await bundleLink(), readFileSync(LINK_BUNDLE, 'utf8'), 'mobile-link.js is stale: run `npm run build` and commit it')
})
