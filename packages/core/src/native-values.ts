import { isUnitlessProperty } from './units.js';
import { isReservedCustomPropertyName, isValidCustomPropertyName } from './safety.js';
import { NativeStyleError } from './native-diagnostic.js';
import type { SlotUnit, StyleValue } from './native-ir.js';

export function nativeProperty(input: string): string {
  if (input.startsWith('--')) {
    if (!isValidCustomPropertyName(input) || isReservedCustomPropertyName(input)) {
      throw new NativeStyleError({ code: 'QS1201', message: `Invalid or reserved custom property ${JSON.stringify(input)}.` });
    }
    return input;
  }
  const kebab = input.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  const property = kebab.startsWith('ms-') ? `-${kebab}` : kebab;
  if (!/^-?[a-z][a-z0-9-]*$/.test(property)) {
    throw new NativeStyleError({ code: 'QS1101', message: `Invalid CSS property ${JSON.stringify(input)}.` });
  }
  return property;
}

export function nativeSlotUnit(property: string): SlotUnit {
  const canonical = nativeProperty(property);
  return canonical.startsWith('--') ? 'raw' : isUnitlessProperty(canonical) ? 'unitless' : 'length';
}

/** Shared static/dynamic number contract; strings retain their meaningful token whitespace. */
export function nativeStaticValue(property: string, value: string | number): StyleValue {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new NativeStyleError({ code: 'QS1102', message: 'A static CSS number must be finite.' });
  }
  return { kind: 'static', css: typeof value === 'number'
    ? `${Object.is(value, -0) ? 0 : value}${nativeSlotUnit(property) === 'length' ? 'px' : ''}`
    : value.trim() };
}

/** Build-time reference evaluator. The frontend emits an equivalent inline expression. */
export function evaluateNativeSlot(unit: SlotUnit, value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `${Object.is(value, -0) ? 0 : value}${unit === 'length' ? 'px' : ''}`;
  }
  return undefined;
}
