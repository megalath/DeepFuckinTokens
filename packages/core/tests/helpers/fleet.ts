import { fileURLToPath } from 'node:url'

import { openFleet, parseConfig, type DeepTokensConfigInput } from '../../index.js'
import { fakeTransport, type FakeTransportOptions, type Script } from './fake-transport.js'
import { tmpRepo } from './repo.js'

/** A fleet on a throwaway repo whose workers are scripted in-process: no pi, no network. */
export async function scriptedFleet(
  script: Script,
  config: DeepTokensConfigInput = {},
  transportOptions: FakeTransportOptions = {},
) {
  const { root, agentDir } = await tmpRepo()
  const transport = fakeTransport(script, transportOptions)
  const fleet = await openFleet({
    cwd: root,
    config: parseConfig({ agentDir, ...config }),
    transport,
  })
  return { fleet, transport, root, agentDir }
}

const FAKE_PI = fileURLToPath(new URL('../fixtures/fake-pi.mjs', import.meta.url))

/**
 * A fleet whose workers are real child processes running the fake pi, so the whole pi adapter
 * (process handling, JSONL framing, wire parsing) is exercised. Set FAKE_PI_MODE before a job starts.
 */
export async function fakePiFleet(config: DeepTokensConfigInput = {}) {
  const { root, agentDir } = await tmpRepo()
  const fleet = await openFleet({
    cwd: root,
    config: parseConfig({ agentDir, piCliPath: FAKE_PI, ...config }),
  })
  return { fleet, root, agentDir }
}

export const tick = async (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve)
  })
