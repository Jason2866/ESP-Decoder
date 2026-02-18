// @ts-check

import { describe, expect, it } from 'vitest'

import { parseMiResultRecord, parseMiTupleList, stripMiList } from './gdbMi.js'

describe('gdbMi', () => {
  it('should keep backslashes in Windows paths when parsing MI tuples', () => {
    const raw =
      '^done,stack=[frame={level="0",fullname="C:\\\\Users\\\\xxx\\\\dev\\\\git\\\\boardlab\\\\test_workspace\\\\esp32backtracetest\\\\module2.cpp"}]'
    const record = parseMiResultRecord(raw)
    const frames = parseMiTupleList(stripMiList(record.stack), 'frame')
    expect(frames).toStrictEqual([
      {
        level: '0',
        fullname: String.raw`C:\Users\xxx\dev\git\boardlab\test_workspace\esp32backtracetest\module2.cpp`,
      },
    ])
    expect(frames[0].fullname.includes('\t')).toBe(false)
  })

  it('should decode escaped control chars in MI strings', () => {
    const record = parseMiResultRecord(
      '^done,msg="line1\\nline2\\t\\"quoted\\""'
    )
    expect(record.msg).toBe('line1\nline2\t"quoted"')
  })
})
