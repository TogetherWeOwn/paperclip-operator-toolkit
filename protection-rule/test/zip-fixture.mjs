// Shared zip builder for the offline suite. Builds the SAME minimal
// stored-entry archive the production reader accepts: one uncompressed entry,
// no encryption, no data descriptor, central directory with the entry's sizes.
//
// The builder and the reader intentionally share no code: if both sides shared
// a helper, a bug in the helper would verify itself. This file constructs raw
// bytes field by field; src/evidence.js parses them field by field.

/**
 * Build a minimal stored-entry zip holding exactly the given text entries.
 *
 * @param {string[]} texts  entry payloads; names are `entry-<n>.json`
 * @returns {Uint8Array}
 */
export function zipOfTexts(texts) {
  const parts = []
  const centrals = []
  let offset = 0
  texts.forEach((manifestText, index) => {
    const data = new TextEncoder().encode(manifestText)
    const name = new TextEncoder().encode(`entry-${index}.json`)
    const local = new Uint8Array(30 + name.length + data.length)
    const view = new DataView(local.buffer)
    view.setUint32(0, 0x04034b50, true) // local file header signature
    view.setUint16(4, 20, true) // version needed
    view.setUint16(6, 0, true) // flags: no encryption, no descriptor
    view.setUint16(8, 0, true) // method: stored
    view.setUint32(14, 0, true) // crc (unchecked by the reader)
    view.setUint32(18, data.length, true)
    view.setUint32(22, data.length, true)
    view.setUint16(26, name.length, true)
    view.setUint16(28, 0, true) // extra length
    local.set(name, 30)
    local.set(data, 30 + name.length)
    parts.push(local)

    const central = new Uint8Array(46 + name.length)
    const cview = new DataView(central.buffer)
    cview.setUint32(0, 0x02014b50, true) // central directory signature
    cview.setUint16(4, 20 << 8 | 20, true) // version made by / needed
    cview.setUint16(8, 0, true) // flags
    cview.setUint16(10, 0, true) // method: stored
    // Central layout: crc@14, csize@20, usize@24, namelen@28, extralen@30,
    // commentlen@32, headoff@42.
    cview.setUint32(14, 0, true) // crc (unchecked by the reader)
    cview.setUint32(20, data.length, true)
    cview.setUint32(24, data.length, true)
    cview.setUint16(28, name.length, true)
    cview.setUint16(30, 0, true) // extra length
    cview.setUint16(32, 0, true) // comment length
    // disk/start/intattr/extattr stay zero; header offset at 42.
    cview.setUint32(42, offset, true)
    central.set(name, 46)
    centrals.push(central)
    offset += local.length
  })
  const centralDir = Buffer.concat(centrals.map((c) => Buffer.from(c)))
  const end = new Uint8Array(22)
  const eview = new DataView(end.buffer)
  eview.setUint32(0, 0x06054b50, true) // end of central directory
  eview.setUint16(8, texts.length, true)
  eview.setUint16(10, texts.length, true)
  eview.setUint32(12, centralDir.length, true)
  eview.setUint32(16, offset, true)
  return Uint8Array.from(Buffer.concat([...parts.map((p) => Buffer.from(p)), centralDir, Buffer.from(end)]))
}

/**
 * Build a one-entry archive holding the given manifest text.
 *
 * @param {string} manifestText
 * @returns {Uint8Array}
 */
export function zipOf(manifestText) {
  return zipOfTexts([manifestText])
}
