import { randomBytes } from 'node:crypto'

/**
 * RFC 9562 UUIDv7: a 48-bit millisecond Unix timestamp in the high bits, then random bits with
 * the version/variant nibbles set per spec. Unlike `randomUUID()` (v4, used elsewhere here --
 * session ids, idempotency keys), v7 ids sort lexicographically by creation time, which is the
 * point for decision events: a buyer's decision log reads in occurrence order by id alone.
 */
export function randomUuidV7(): string {
  const bytes = randomBytes(16)
  const ts = BigInt(Date.now())
  for (let i = 0; i < 6; i++) {
    bytes.writeUInt8(Number((ts >> BigInt(40 - 8 * i)) & 0xffn), i)
  }
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x70, 6) // version 7
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8) // variant 10
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
