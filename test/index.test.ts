import fs from 'node:fs'
import path from 'node:path'
import { build } from 'vite'
import {
  beforeAll,
  expect,
  test,
} from 'vitest'

const root = path.join(__dirname, 'fixtures')

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
  const sqlite3DB = await main.initSqlite3()
  const better_sqlite3DB = await main.initBetterSqlite3()

  const fseventsKeys1 = Object.getOwnPropertyNames(fsevents).filter(name => name !== 'default')
  // esm export members will be auto sort.
  const fseventsKeys2 = Object.getOwnPropertyNames(require('fsevents')).sort((a, b) => a.localeCompare(b))
  expect(fseventsKeys1).toEqual(fseventsKeys2)

  const sqlite3Keys1 = Object.getOwnPropertyNames(sqlite3).filter(name => name !== 'default')
  // `require('sqlite3').path` will only be available after call `initSqlite3()`.
  const sqlite3Keys2 = Object.getOwnPropertyNames(require('sqlite3')).filter(name => name !== 'path')
  expect(sqlite3Keys1).toEqual(sqlite3Keys2)
  expect(sqlite3DB.database && typeof sqlite3DB.database).eq('object')
  expect(sqlite3DB.error).null

  expect(better_sqlite3DB.database && typeof better_sqlite3DB.database).eq('object')
  expect(better_sqlite3DB.error).null
})
