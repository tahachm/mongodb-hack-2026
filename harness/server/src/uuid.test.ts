import { describe, expect, it } from 'vitest'
import { randomUuidV7 } from './uuid.js'

describe('randomUuidV7', () => {
  it('produces well-formed, version-7 UUIDs', () => {
    const id = randomUuidV7()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
