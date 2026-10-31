import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  WORKBUDDY_DEVICE_ID_LENGTH,
  WORKBUDDY_DEVICE_SALT_LENGTH,
  deriveDeviceId,
  isDeviceId,
  isDeviceSalt,
} from '../src/device-id.ts'

/** A stand-in for a real salt: the shape is all these tests care about. */
const SALT = 'a'.repeat(WORKBUDDY_DEVICE_SALT_LENGTH)
const OTHER_SALT = 'b'.repeat(WORKBUDDY_DEVICE_SALT_LENGTH)

describe('deriveDeviceId', () => {
  it('is idempotent for one account, purpose and salt', () => {
    // The whole point: two process starts of the same install must agree, or
    // every restart looks like a new device (the "device hopping" the audit's
    // §5.4 warns about).
    expect(deriveDeviceId('u-1', 'machine', SALT)).toBe(deriveDeviceId('u-1', 'machine', SALT))
  })

  it('separates the two purposes', () => {
    // Same account, same salt, different header → different value. Sharing one
    // value across X-Machine-ID and X-Session-ID would claim the machine IS the
    // session, which no official client does.
    expect(deriveDeviceId('u-1', 'machine', SALT)).not.toBe(deriveDeviceId('u-1', 'session', SALT))
  })

  it('separates accounts, so a pool does not collapse into one device', () => {
    const ids = ['u-1', 'u-2', 'u-3'].map(uid => deriveDeviceId(uid, 'machine', SALT))
    expect(new Set(ids).size).toBe(3)
  })

  it('separates machines, so two installs of one account differ', () => {
    // A purely global function (`sha256(uid)`) would make every user of this
    // plugin derive the same id for the same account and form one identifiable
    // cohort. The salt is what prevents that — this assertion is the guard.
    expect(deriveDeviceId('u-1', 'machine', SALT)).not.toBe(deriveDeviceId('u-1', 'machine', OTHER_SALT))
  })

  it('does not degrade into a plain sha256 of the uid', () => {
    const naive = createHash('sha256').update('u-1').digest('hex').slice(0, WORKBUDDY_DEVICE_ID_LENGTH)
    expect(deriveDeviceId('u-1', 'machine', SALT)).not.toBe(naive)
  })

  it('is 36 lowercase hex characters', () => {
    const id = deriveDeviceId('u-1', 'machine', SALT)
    expect(id).toHaveLength(WORKBUDDY_DEVICE_ID_LENGTH)
    expect(isDeviceId(id)).toBe(true)
  })

  it('is empty without an account or without a salt', () => {
    // Both are normal states, not errors: an anonymous request has no account to
    // scope a device to, and an unreadable salt must not be replaced by an
    // in-process random value (see src/device-salt.ts).
    expect(deriveDeviceId('', 'machine', SALT)).toBe('')
    expect(deriveDeviceId('u-1', 'machine', '')).toBe('')
  })
})

describe('isDeviceId', () => {
  it('accepts exactly 36 lowercase hex characters', () => {
    expect(isDeviceId('0'.repeat(36))).toBe(true)
    expect(isDeviceId('abcdef0123456789abcdef0123456789abcd')).toBe(true)
  })

  it('rejects everything else', () => {
    for (const value of [
      '',
      '0'.repeat(35),
      '0'.repeat(37),
      'A'.repeat(36), // upstream-shaped ids are lowercase; uppercase would be a second format
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', // hyphenated v4, a different contract
      ` ${'0'.repeat(36)}`,
      'g'.repeat(36),
    ]) {
      expect(isDeviceId(value), value).toBe(false)
    }
  })
})

describe('isDeviceSalt', () => {
  it('accepts exactly 64 lowercase hex characters', () => {
    expect(isDeviceSalt(SALT)).toBe(true)
    expect(isDeviceSalt('0123456789abcdef'.repeat(4))).toBe(true)
  })

  it('rejects a salt of the wrong shape', () => {
    // A hand-edited or truncated salt must read as unreadable, never as "close
    // enough": using half a salt would silently change every derived id.
    for (const value of ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'z'.repeat(64)]) {
      expect(isDeviceSalt(value), value).toBe(false)
    }
  })
})
