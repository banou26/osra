import type { RevivableContext, UnderlyingType, BoxedBuffer } from './utils.js'
import type { TypedArray, TypedArrayType } from '../utils/type-guards.js'

import { BoxBase, boxBuffer, reviveBuffer } from './utils.js'
import {
  isTypedArray,
  typedArrayToType,
  typedArrayTypeToTypedArrayConstructor,
} from '../utils/type-guards.js'

export const type = 'typedArray' as const

/** Never claims a primitive, so the walker can skip this module for primitive leaves. */
export const objectsOnly = true

type BoxedTypedArray<T extends TypedArray, T2 extends RevivableContext> =
  & typeof BoxBase
  & { type: typeof type }
  & { typedArrayType: TypedArrayType }
  & BoxedBuffer<T2>
  & { [UnderlyingType]: T }

export const isType = isTypedArray

export const box = <T extends TypedArray, T2 extends RevivableContext>(
  value: T,
  context: T2,
): BoxedTypedArray<T, T2> => {
  // ship exactly the view's window: the whole backing buffer loses byteOffset/length on revive
  const aligned = value.byteOffset === 0 && value.byteLength === value.buffer.byteLength
  const buffer = aligned
    ? value.buffer as ArrayBuffer
    : (value.buffer as ArrayBuffer).slice(value.byteOffset, value.byteOffset + value.byteLength)
  return {
    ...BoxBase,
    type,
    typedArrayType: typedArrayToType(value),
    ...boxBuffer(buffer, context),
  } as unknown as BoxedTypedArray<T, T2>
}

export const revive = <T extends BoxedTypedArray<TypedArray, RevivableContext>>(
  value: T,
  _context: RevivableContext,
): T[UnderlyingType] =>
  new (typedArrayTypeToTypedArrayConstructor(value.typedArrayType))(reviveBuffer(value)) as T[UnderlyingType]

const typeCheck = () => {
  const uint8Boxed = box(new Uint8Array(10), {} as RevivableContext)
  const uint8Revived = revive(uint8Boxed, {} as RevivableContext)
  const expectedUint8: Uint8Array = uint8Revived
  // @ts-expect-error - wrong typed array type
  const wrongType: Int32Array = uint8Revived

  const float32Boxed = box(new Float32Array(10), {} as RevivableContext)
  const float32Revived = revive(float32Boxed, {} as RevivableContext)
  const expectedFloat32: Float32Array = float32Revived
  // @ts-expect-error - wrong typed array type
  const wrongFloat: Uint8Array = float32Revived

  // @ts-expect-error - cannot box non-TypedArray
  box('not a typed array', {} as RevivableContext)
}
