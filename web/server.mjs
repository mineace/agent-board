// The browser board's server. The plugin starts it and is the board's only writer:
// this serves the page and the board files, and hands what the page asks for to the
// plugin as one JSON line on stdout. It ends with the session that started it.
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [port, host, boardFile, viewFile] = process.argv.slice(2)
const here = dirname(fileURLToPath(import.meta.url))
// Changes need this token, which only the page served here holds: another site cannot read it.
const token = randomBytes(24).toString('hex')
const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, `${host}:${port}`])
const MAX_BODY = 256 * 1024

const readJson = async (path, fallback) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

const send = (res, status, type, body) => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(body)
}

const body = req =>
  new Promise((resolve, reject) => {
    let size = 0
    const parts = []
    req.on('data', part => {
      size += part.length
      if (size > MAX_BODY) reject(new Error('too large'))
      else parts.push(part)
    })
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
    req.on('error', reject)
  })

const server = createServer(async (req, res) => {
  // A page on another site that renamed itself to this address (DNS rebinding) is refused.
  if (!allowedHosts.has(req.headers.host ?? '')) return send(res, 403, 'text/plain', 'Forbidden host')
  const url = new URL(req.url ?? '/', 'http://localhost')
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      const page = await readFile(join(here, 'index.html'), 'utf8')
      return send(res, 200, 'text/html; charset=utf-8', page.replace('__BOARD_TOKEN__', token))
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const [board, view] = await Promise.all([readJson(boardFile, { nextId: 1, cards: [] }), readJson(viewFile, {})])
      return send(res, 200, 'application/json', JSON.stringify({ board, view }))
    }
    if (req.method === 'POST' && url.pathname === '/api/action') {
      if (req.headers['x-board-token'] !== token) return send(res, 403, 'text/plain', 'Bad token')
      const action = JSON.parse(await body(req))
      if (!action || typeof action !== 'object' || typeof action.op !== 'string') return send(res, 400, 'text/plain', 'Bad action')
      process.stdout.write(`${JSON.stringify(action)}\n`)
      return send(res, 202, 'application/json', '{"ok":true}')
    }
    send(res, 404, 'text/plain', 'Not found')
  } catch (err) {
    send(res, 400, 'text/plain', String(err?.message ?? err))
  }
})

server.on('error', err => {
  process.stderr.write(`${err.code === 'EADDRINUSE' ? `port ${port} is in use` : err.message}\n`)
  process.exit(1)
})
server.listen(Number(port), host, () => process.stderr.write(`listening on http://localhost:${port}\n`))
