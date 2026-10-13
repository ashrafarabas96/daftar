/**
 * What a carrier must BE before any of its fields are read, as ONE definition.
 *
 * Every gate in this package reads the caller's object, once to CHECK a field
 * and again to USE it. That is sound only while a field cannot answer twice,
 * and the coordinator's diff review of `3f56c62` measured six ways it can
 * (`B-1`): an own ACCESSOR returns whatever its getter decides on each read, so
 * a quote passed the approval gate and the intent then emitted a discount of
 * `4000` that no confirmed quote granted. The same review measured a second
 * family (`B-2`): `RegExp#test` and `BigInt` STRINGIFY their argument, so a
 * `String` object, an object with a `toString`, or a one-element array passed
 * every amount, instant and currency check with an identical digest — and
 * because the builder copied those leaves by reference and froze only the top
 * level, a frozen quote could still be rewritten after it was digested.
 *
 * Both families are one shape: a field read more than once, or read as a
 * primitive without being one. So this module states the discipline once —
 *
 * 1. refuse a carrier whose fields cannot be read stably: a Proxy, a
 *    non-`Object.prototype` prototype, or an own accessor, naming the field;
 * 2. refuse an array that is not plain and dense, naming the key or position;
 * 3. refuse a leaf that is not a primitive, naming the field;
 * 4. return a FROZEN SNAPSHOT of the declared fields, copied by value, which is
 *    the only thing a caller may read afterwards.
 *
 * — and the gates map it onto their own refusals. The faults are raised as
 * `CarrierFault`, not as an `OrderError`, because the SUBJECT of a refusal
 * belongs to the gate that knows what it is looking at ("a quote", "a quote
 * LINE", "a checkout position") and this module does not. Every catch site maps
 * it; a fault that escaped unmapped would read as a client error with no
 * subject, so the suite carries a case per kind.
 */
import { types as nodeTypes } from 'node:util';

/** Why a carrier cannot be read as its own data. One per family, so a caller can map it to its own subject. */
export type CarrierFaultKind = 'proxy' | 'prototype' | 'null-prototype' | 'accessor' | 'not-primitive' | 'not-array' | 'sparse' | 'undeclared' | 'too-long';

/** A carrier-level refusal, before any domain meaning is attached. `field` is the key, index or field name where one exists. */
export class CarrierFault extends Error {
  constructor(
    readonly kind: CarrierFaultKind,
    readonly field: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'CarrierFault';
  }
}

/**
 * Refuse a Proxy.
 *
 * Asked of the RUNTIME, not of the object: a Proxy forwards `getPrototypeOf`,
 * `ownKeys` and `isArray` to its target, so no structural check can see it.
 * `types.isProxy` is also not realm-sensitive, unlike a prototype comparison,
 * so a cross-realm Proxy is caught too.
 */
export function assertNotProxyCarrier(carrier: object): void {
  if (nodeTypes.isProxy(carrier)) {
    throw new CarrierFault('proxy', null, 'a carrier is a Proxy, so a field read from it need not be the field that was checked');
  }
}

/**
 * Refuse a carrier whose fields could be answered for by anything but its own data.
 *
 * A prototype carrying data answers for a field that is nowhere in the
 * carrier's own keys. An own ACCESSOR answers with whatever its getter returns
 * on each read — the `B-1` family. Both are refused, by name where a name
 * exists.
 *
 * EVERY own key is examined, not only the declared ones, so an accessor on an
 * undeclared key is reported as the accessor it is rather than as a mere extra
 * field; the undeclared-field refusal then runs in the caller over a carrier
 * that could be read at all.
 *
 * The cost is stated rather than discovered: an `Object.create(null)` carrier,
 * an ORM entity and any class instance are refused, and a getter is refused
 * even when it is honest. A caller holding one of those maps it to the declared
 * shape first.
 */
export function assertReadableCarrier(carrier: unknown): void {
  // `null` and a primitive are refused BY NAME here. `Object.getPrototypeOf(null)`
  // throws a `TypeError`, and a caller cannot act on a `TypeError`: the
  // coordinator's `R-C4` is exactly this, a null quote or a null line reaching a
  // gate and crashing instead of being refused.
  if (carrier === null || (typeof carrier !== 'object' && typeof carrier !== 'function')) {
    throw new CarrierFault('prototype', null, carrier === null ? 'a carrier is null' : 'a carrier is not an object');
  }
  assertNotProxyCarrier(carrier);
  const proto = Object.getPrototypeOf(carrier) as object | null;
  if (proto === null) {
    throw new CarrierFault('null-prototype', null, "a carrier's prototype is null");
  }
  if (proto !== Object.prototype) {
    throw new CarrierFault('prototype', null, "a carrier's prototype is not Object.prototype");
  }
  assertOwnDataFields(carrier);
}

/** Refuse an own accessor on any key, naming it. Split out so an array's indices get the same treatment. */
export function assertOwnDataFields(carrier: object): void {
  for (const key of Reflect.ownKeys(carrier)) {
    const descriptor = Object.getOwnPropertyDescriptor(carrier, key);
    if (descriptor === undefined) continue;
    if (!('value' in descriptor)) {
      throw new CarrierFault('accessor', String(key), 'a carrier field is an accessor, so it can answer the check and the use differently');
    }
  }
}

/** Index keys of an array, as strings. A hole is not an own key, which is why presence is what gets checked. */
const INDEX_KEY = /^(0|[1-9]\d*)$/;

/**
 * Refuse an array that is not a plain, dense array of its own data.
 *
 * Positions are judged by PRESENCE rather than by `length`, because a hole is
 * not an own key: `[a, , c]` and a `length` of 3 are not the same array, and the
 * second hands a gate an `undefined` element (`F-40`).
 */
export function assertReadableArray(value: unknown, maxLength?: number): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new CarrierFault('not-array', null, 'a field that must be an array is not one');
  }
  const array = value as unknown[];
  assertNotProxyCarrier(array);
  if (Object.getPrototypeOf(array) !== Array.prototype) {
    throw new CarrierFault('prototype', null, "an array's prototype is not Array.prototype");
  }
  // THE BOUND COMES BEFORE THE WALK (`R-C2`). The previous guard built a `Set`
  // of every index key before any limit was consulted, so a SPARSE array with
  // `length = 2e7` — twenty bytes of input — spent 23 seconds and then died on
  // an unnamed `RangeError`. A refusal that costs more than the request is a
  // refusal an attacker can afford to ask for.
  // The fault has its OWN kind rather than sharing `undeclared`, so a caller can
  // map "too many" to the limit its own authority states — `order.checkout_line_limit`
  // is the sales authority's refusal and must not become a carrier fault just
  // because the bound now runs earlier (`C-F`). A shared kind would have made
  // the two indistinguishable at the catch site, which is how a refusal quietly
  // changes its name.
  if (maxLength !== undefined && array.length > maxLength) {
    throw new CarrierFault('too-long', String(array.length), 'an array declares more positions than this contract admits');
  }
  for (const key of Reflect.ownKeys(array)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !INDEX_KEY.test(key)) {
      throw new CarrierFault('undeclared', String(key), 'an array carries an own key that is not one of its indices');
    }
    const descriptor = Object.getOwnPropertyDescriptor(array, key);
    if (descriptor !== undefined && !('value' in descriptor)) {
      throw new CarrierFault('accessor', key, 'an array index is an accessor, so it can answer the check and the use differently');
    }
  }
  for (let index = 0; index < array.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(array, index)) {
      throw new CarrierFault('sparse', String(index), 'an array is sparse, so a position it reports is not a value it holds');
    }
  }
  return array;
}

/** Whether a value may be copied into a snapshot by value. `undefined` is not one: an absent field is not a value. */
function isPrimitiveLeaf(value: unknown): boolean {
  if (value === null) return true;
  const kind = typeof value;
  return kind === 'string' || kind === 'number' || kind === 'boolean' || kind === 'bigint';
}

/**
 * Refuse a leaf that is not a primitive, NAMING the field.
 *
 * This runs BEFORE any regex or `BigInt`, which is the whole point: both coerce,
 * so by the time a pattern has matched, what matched was a string the runtime
 * made up out of an object the caller still owns and can rewrite.
 */
export function requirePrimitiveLeaf(value: unknown, field: string): string | number | boolean | bigint | null {
  if (!isPrimitiveLeaf(value)) {
    throw new CarrierFault(
      'not-primitive',
      field,
      'a field that must be a primitive is an object; a regex or BigInt would stringify it while the caller kept the object',
    );
  }
  return value as string | number | boolean | bigint | null;
}

/** Refuse a field that must be a string, naming it. `RegExp#test` would have accepted an object. */
export function requireStringLeaf(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new CarrierFault('not-primitive', field, 'a field that must be a string is not a string');
  }
  return value;
}

/**
 * Copy the declared fields into a FROZEN snapshot, by value.
 *
 * Every leaf is a primitive by here or the copy refuses, so the snapshot is
 * frozen ALL THE WAY DOWN rather than only at the top — a frozen carrier whose
 * leaves were shared objects could still be rewritten after it was digested,
 * which is what `B-2` measured. An array-valued field is copied element by
 * element and frozen, so the caller's array cannot be the snapshot's.
 */
export function snapshotFields<T>(
  carrier: object,
  fields: readonly string[],
  arrayFields: readonly string[] = [],
  maxArrayLength?: number,
  nestedFields: readonly string[] = [],
): T {
  // THE CARRIER IS CHECKED FIRST, in this one place, so no caller can take a
  // snapshot of something it has not proved readable. My own first revision of
  // this module left that to each call site and a Proxy CONFIRMATION was
  // accepted: `Reflect.ownKeys` forwards through a Proxy and every value the
  // trap returned was a primitive, so the copy looked clean. Caught by this
  // package's own case for `R-C3`, which is the only reason it is not in the
  // commit.
  assertReadableCarrier(carrier);
  const kept: Record<string, unknown> = {};
  const arrays = new Set(arrayFields);
  // A NESTED field is declared but not copied here: its own snapshot is taken by
  // the caller, which knows what shape it is. It is named rather than ignored so
  // the undeclared check below still refuses anything the contract does not list.
  const nested = new Set(nestedFields);
  // An UNDECLARED own key is refused rather than dropped, which is the `R-16`
  // rule applied to every carrier this module snapshots: the coordinator's C9
  // measured a confirmation carrying `documentFeeMinor` being accepted, and a
  // snapshot that simply ignores it is the silent stripping `R-16` was about.
  const declared = new Set<string>([...fields, ...nestedFields]);
  for (const key of Reflect.ownKeys(carrier)) {
    if (typeof key !== 'string' || !declared.has(key)) {
      throw new CarrierFault('undeclared', String(key), 'a carrier holds a field this contract does not cover, so nothing attests to it');
    }
  }
  for (const field of fields) {
    if (nested.has(field)) continue;
    const value = (carrier as Record<string, unknown>)[field];
    if (arrays.has(field)) {
      const source = assertReadableArray(value, maxArrayLength);
      kept[field] = Object.freeze(source.map((element, index) => requirePrimitiveLeaf(element, `${field}[${index}]`)));
      continue;
    }
    kept[field] = requirePrimitiveLeaf(value, field);
  }
  return Object.freeze(kept) as T;
}
