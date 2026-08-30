import { readFileSync } from 'node:fs'

import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const workflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))
const headlessLinuxGuide = readFileSync('docs/reference/headless-linux-server.md', 'utf8')

function readSystemdUnitBlocks(doc, unitName) {
  const escapedUnitName = unitName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [...doc.matchAll(new RegExp(`^# /etc/systemd/system/${escapedUnitName}$`, 'gm'))].map(
    (match) => {
      const start = match.index + match[0].length
      const end = doc.indexOf('```', start)
      const nextUnitHeaderOffset = doc.slice(start).search(/^# \/etc\/systemd\/system\/.+$/m)
      const nextUnitHeader = nextUnitHeaderOffset === -1 ? -1 : start + nextUnitHeaderOffset
      if (end === -1 || (nextUnitHeader !== -1 && end > nextUnitHeader)) {
        throw new Error(`Missing closing code fence for ${unitName}`)
      }
      return doc.slice(start, end)
    }
  )
}

describe('headless serve shutdown PR gate', () => {
  it('reads only exact, closed systemd unit blocks', () => {
    expect(
      readSystemdUnitBlocks('# /etc/systemd/system/orca-serveXservice\n```', 'orca-serve.service')
    ).toEqual([])
    expect(() =>
      readSystemdUnitBlocks('# /etc/systemd/system/orca-serve.service\n', 'orca-serve.service')
    ).toThrow('Missing closing code fence for orca-serve.service')
    expect(() =>
      readSystemdUnitBlocks(
        '# /etc/systemd/system/orca-serve.service\n' +
          'KillMode=mixed\n' +
          '# /etc/systemd/system/other.service\n```',
        'orca-serve.service'
      )
    ).toThrow('Missing closing code fence for orca-serve.service')
  })

  it('packages Linux artifacts before running the Docker signal oracle', () => {
    const steps = workflow.jobs.package.steps
    const packageStep = steps.find((step) => step.name === 'Package unpacked app')
    const markerStep = steps.find((step) => step.name === 'Verify root-package marker payloads')
    const shutdownStep = steps.find((step) => step.name === 'Verify headless serve signal shutdown')

    expect(workflow.jobs.package['timeout-minutes']).toBe(60)
    expect(packageStep.run).toContain('--linux AppImage deb rpm --x64 --publish never')
    expect(markerStep.run).toContain('dpkg-deb --fsys-tarfile')
    expect(markerStep.run).toContain('rpm2cpio')
    expect(steps.indexOf(markerStep)).toBeGreaterThan(steps.indexOf(packageStep))
    expect(shutdownStep.run).toBe(
      'node config/scripts/run-headless-serve-shutdown-docker.mjs --appimage dist/orca-linux.AppImage'
    )
    expect(steps.indexOf(shutdownStep)).toBeGreaterThan(steps.indexOf(markerStep))
  })

  it('keeps owned Xvfb alive during the documented systemd graceful stop', () => {
    const serveUnits = readSystemdUnitBlocks(headlessLinuxGuide, 'orca-serve.service')
    const ownedXvfbUnits = serveUnits.filter((unit) => !/^Environment=DISPLAY=/m.test(unit))
    const managedXvfbUnits = serveUnits.filter((unit) => /^Environment=DISPLAY=/m.test(unit))

    expect(ownedXvfbUnits).toHaveLength(1)
    expect(ownedXvfbUnits[0]).toMatch(/^ExecStart=.*orca-linux\.AppImage serve.*$/m)
    expect(ownedXvfbUnits[0]).toMatch(/^KillMode=mixed$/m)
    expect(managedXvfbUnits).toHaveLength(1)
    expect(managedXvfbUnits[0]).not.toMatch(/^KillMode=/m)
  })
})
