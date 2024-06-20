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
  const sqlite3_db = path.join(root, 'db/sqlite3.db')

  return new Promise<{
    database: import('sqlite3').Database
    error: Error | null
  }>(resolve => {
    const db = new (sqlite3.verbose().Database)(sqlite3_db, error => {
      resolve({
        database: db,
        error,
      })
    })
  })
}

function initBetterSqlite3(BetterSqlite3: typeof import('better-sqlite3')) {
  const better_sqlite3_db = path.join(root, 'db/better-sqlite3.db')

  return new Promise<{
    database: import('better-sqlite3').Database
    error: Error | null
  }>(resolve => {
    const db = new BetterSqlite3(better_sqlite3_db, { verbose: console.log })
    // https://github.com/WiseLibs/better-sqlite3/blob/v11.1.0/docs/api.md#pragmastring-options---results
    db.pragma('cache_size = 32000')
    resolve({
      database: db,
      error: db.pragma('cache_size', { simple: true }) === 32000
        ? null
        : new Error('better-sqlite3 initialize failed'),
    })
  })
}

beforeAll(async () => {
  for (const name of ['dist', 'db']) {
    fs.rmSync(path.join(root, name), { recursive: true, force: true })
  }
  fs.mkdirSync(path.join(root, 'db'), { recursive: true })

  await build({ configFile: path.join(root, 'vite.config.ts') })
})

test('vite-plugin-native', async () => {
  const main = require('./fixtures/dist/main')
  const fsevents = main.fsevents
  const sqlite3 = main.sqlite3
  const sqlite3DB = await initSqlite3(main.sqlite3)
  const better_sqlite3DB = await initBetterSqlite3(main.better_sqlite3)

  expect(Object.getOwnPropertyNames(fsevents).filter(name => name !== 'default').reverse())
    .toEqual(Object.getOwnPropertyNames(require('fsevents')))
  // `require('sqlite3').path` will only be available after call `initSqlite3()`.
  expect(Object.getOwnPropertyNames(sqlite3).filter(name => name !== 'default'))
    .toEqual(Object.getOwnPropertyNames(require('sqlite3')).filter(name => name !== 'path'))
  expect(sqlite3DB.database && typeof sqlite3DB.database).eq('object')
  expect(sqlite3DB.error).null
  expect(better_sqlite3DB.database && typeof better_sqlite3DB.database).eq('object')
  expect(better_sqlite3DB.error).null
})
