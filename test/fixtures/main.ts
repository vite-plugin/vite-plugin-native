import path from 'node:path'

// TODO: https://github.com/serialport/node-serialport/issues/2464
// import * as serialport from 'serialport'
import * as fsevents from 'fsevents'
import sqlite3 from 'sqlite3'
import BetterSqlite3 from 'better-sqlite3'

export {
  fsevents,
  sqlite3,
}

const root = path.join(__dirname, '..')

export function initSqlite3() {
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

export function initBetterSqlite3() {
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
