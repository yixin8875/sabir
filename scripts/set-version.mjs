#!/usr/bin/env node
// Keeps every version field in lockstep before a release tag.
//
//   node scripts/set-version.mjs 0.4.2   # write 0.4.2 everywhere
//   node scripts/set-version.mjs --check # fail if they differ from tauri.conf.json
//
// The Tauri version is the source of truth: the updater compares it with
// latest.json, and the release workflow refuses tags that disagree with it.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const appDir = join(root, 'apps/desktop')
const tauriDir = join(appDir, 'src-tauri')

const files = {
  packageJson: join(appDir, 'package.json'),
  tauriConf: join(tauriDir, 'tauri.conf.json'),
  cargoToml: join(tauriDir, 'Cargo.toml'),
}

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function cargoVersion() {
  const text = readFileSync(files.cargoToml, 'utf8')
  const match = text.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)
  if (!match) throw new Error('Cargo.toml has no [package] version')
  return match[1]
}

function setCargoVersion(version) {
  const text = readFileSync(files.cargoToml, 'utf8')
  const next = text.replace(
    /^(\[package\][\s\S]*?^version\s*=\s*")[^"]+(")/m,
    `$1${version}$2`,
  )
  writeFileSync(files.cargoToml, next)
}

const arg = process.argv[2]

if (arg === '--check') {
  const expected = readJson(files.tauriConf).version
  const actual = {
    'tauri.conf.json': expected,
    'package.json': readJson(files.packageJson).version,
    'Cargo.toml': cargoVersion(),
  }
  const wrong = Object.entries(actual).filter(([, value]) => value !== expected)
  if (wrong.length > 0) {
    for (const [file, value] of wrong) {
      console.error(`${file}: ${value} (expected ${expected})`)
    }
    process.exit(1)
  }
  console.log(`all versions match ${expected}`)
  process.exit(0)
}

if (!arg || !SEMVER.test(arg)) {
  console.error('usage: node scripts/set-version.mjs <x.y.z | --check>')
  process.exit(1)
}

const packageJson = readJson(files.packageJson)
if (packageJson.version !== arg) {
  packageJson.version = arg
  writeJson(files.packageJson, packageJson)
}
const tauriConf = readJson(files.tauriConf)
if (tauriConf.version !== arg) {
  tauriConf.version = arg
  writeJson(files.tauriConf, tauriConf)
}
if (cargoVersion() !== arg) setCargoVersion(arg)

console.log(`version ${arg} written to package.json, tauri.conf.json and Cargo.toml`)
