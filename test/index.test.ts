import fs from 'node:fs'
import path from 'node:path'
import { build } from 'vite'
import {
  beforeAll,
  expect,
  test,
} from 'vitest'

const root = path.join(__dirname, 'fixtures')

function initSqlite3(sqlite3: typeof import('sqlite3')) {
  const database = path.join(root, 'db.sqlite3')

  return new Promise<{
    database: import('sqlite3').Database
    error: Error | null
  }>(resolve => {
    const _database = new (sqlite3.verbose().Database)(database, error => {
      resolve({
        database: _database,
        error,
      })
    })
  })
}

beforeAll(async () => {
  for (const name of ['dist', 'dist-native', 'db.sqlite3']) {
    fs.rmSync(path.join(root, name), { recursive: true, force: true })
  }

  await build({ configFile: path.join(root, 'vite.config.ts') })
})

test('vite-plugin-native', async () => {
  const main = require('./fixtures/dist/main')
  const sqlite3 = await initSqlite3(main.sqlite3)

  expect(sqlite3.error).null
})
