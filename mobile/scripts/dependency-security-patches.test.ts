import { generateKeyPairSync } from 'node:crypto'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

describe('installed mobile dependency security patches', () => {
  it.each([true, false])(
    'rejects extra DigestAlgorithm elements with NULL parameters: %s',
    (parameters) => {
      const require = createRequire(import.meta.url)
      const expoRequire = createRequire(require.resolve('expo'))
      const cliRequire = createRequire(expoRequire.resolve('@expo/cli'))
      const forge = cliRequire('node-forge')
      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024, publicExponent: 3 })
      const key = forge.pki.privateKeyFromPem(
        privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
      )
      const publicKey = forge.pki.setRsaPublicKey(key.n, key.e)
      const md = forge.md.sha256.create().update('release payload')
      const digest = md.digest().getBytes()
      expect(publicKey.verify(digest, key.sign(md))).toBe(true)
      const { asn1 } = forge
      const element = (type: number, value: unknown, constructed = false) =>
        asn1.create(asn1.Class.UNIVERSAL, type, constructed, value)
      const algorithm = element(
        asn1.Type.SEQUENCE,
        [
          element(asn1.Type.OID, asn1.oidToDer(forge.pki.oids.sha256).getBytes()),
          ...(parameters ? [element(asn1.Type.NULL, '')] : [])
        ],
        true
      )
      const digestInfo = element(
        asn1.Type.SEQUENCE,
        [algorithm, element(asn1.Type.OCTETSTRING, digest)],
        true
      )
      const valid = key.sign(asn1.toDer(digestInfo).getBytes(), 'NONE')
      expect(publicKey.verify(digest, valid)).toBe(true)
      algorithm.value.push(element(asn1.Type.OCTETSTRING, 'unexpected padding'))
      const signature = key.sign(asn1.toDer(digestInfo).getBytes(), 'NONE')
      expect(() => publicKey.verify(digest, signature)).toThrow('DigestInfo')
    }
  )
})
