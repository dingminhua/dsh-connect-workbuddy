import { clearHostHeartbeat, writeHostHeartbeat } from '../../src/host-heartbeat.ts'

const owners = new Map()
process.on('message', async request => {
  try {
    if (request.home !== undefined) process.env.DSH_HOME = request.home
    if (request.action === 'write') owners.set(request.name, await writeHostHeartbeat())
    if (request.action === 'clear') await clearHostHeartbeat(owners.get(request.name))
    process.send({ id: request.id, ok: true, pid: process.pid })
    if (request.action === 'exit') process.disconnect()
  } catch (error) {
    process.send({ id: request.id, ok: false, error: { code: error.code, message: error.message } })
  }
})
process.send({ ready: true })
