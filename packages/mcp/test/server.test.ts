import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'

import { DeepTokensError, type Fleet, type JobSnapshot } from '@deeptokens/core'

import { createServer } from '../src/server.js'

const snapshot = { id: 'j1', state: 'running' } as unknown as JobSnapshot

function fakeFleet(): Fleet {
  return {
    spawn: vi.fn(async () => Promise.resolve(snapshot)),
    run: vi.fn(async () => Promise.resolve({ job: snapshot, text: 'done' })),
    send: vi.fn(async () => Promise.resolve(snapshot)),
    wait: vi.fn(async () => Promise.resolve(snapshot)),
    status: vi.fn(() => snapshot),
    list: vi.fn(() => [snapshot]),
    collect: vi.fn(async () =>
      Promise.reject(new DeepTokensError('job-not-settled', 'Job j1 is running.')),
    ),
    kill: vi.fn(async () => Promise.resolve(snapshot)),
    models: vi.fn(async () =>
      Promise.resolve({ aliases: [], defaultModel: 'gpt', providers: [], available: [] }),
    ),
    close: vi.fn(async () => Promise.resolve()),
  }
}

async function connect(fleet: Fleet): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await createServer(fleet, '0.0.0-test').connect(serverSide)
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(clientSide)
  return client
}

const textOf = (result: Awaited<ReturnType<Client['callTool']>>): string => {
  const [first] = result.content as { type: string; text: string }[]
  return first?.text ?? ''
}

describe('deeptokens MCP server', () => {
  it('exposes the eight pi tools and its delegation instructions', async () => {
    const client = await connect(fakeFleet())
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'pi_collect',
      'pi_kill',
      'pi_models',
      'pi_run',
      'pi_send',
      'pi_spawn',
      'pi_status',
      'pi_wait',
    ])
    expect(client.getInstructions()).toContain('contractors')
  })

  it('passes a spec through without undefined fields and converts seconds', async () => {
    const fleet = fakeFleet()
    const client = await connect(fleet)
    const result = await client.callTool({
      name: 'pi_run',
      arguments: { task: 'do it', mode: 'write', timeoutSec: 20 },
    })
    expect(result.isError).not.toBe(true)
    expect(fleet.run).toHaveBeenCalledWith({ task: 'do it', mode: 'write' }, 20_000)
    expect(JSON.parse(textOf(result))).toMatchObject({ text: 'done' })
  })

  it('lists every job when pi_status gets no id', async () => {
    const fleet = fakeFleet()
    const client = await connect(fleet)
    await client.callTool({ name: 'pi_status', arguments: {} })
    expect(fleet.list).toHaveBeenCalled()
    expect(fleet.status).not.toHaveBeenCalled()
  })

  it('turns core errors into tool errors with their code', async () => {
    const client = await connect(fakeFleet())
    const result = await client.callTool({ name: 'pi_collect', arguments: { jobId: 'j1' } })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe('job-not-settled: Job j1 is running.')
  })

  it('rejects invalid input before it reaches the fleet', async () => {
    const fleet = fakeFleet()
    const client = await connect(fleet)
    const result = await client.callTool({ name: 'pi_spawn', arguments: { task: '' } })
    expect(result.isError).toBe(true)
    expect(fleet.spawn).not.toHaveBeenCalled()
  })
})
