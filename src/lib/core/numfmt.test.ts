import { describe, expect, it } from 'vitest';
import { bfloat16ToNumber, halfToNumber, jsonScalar, shortestFloat } from './numfmt';

describe('shortestFloat', () => {
	it('prints float32 values with their shortest round-trip form', () => {
		expect(shortestFloat(Math.fround(0.1), 'float32')).toBe('0.1');
		expect(shortestFloat(Math.fround(3.14159), 'float32')).toBe('3.14159');
		expect(shortestFloat(Math.fround(1 / 3), 'float32')).toBe('0.33333334');
	});

	it('keeps integers and negative zero', () => {
		expect(shortestFloat(100, 'float32')).toBe('100');
		expect(shortestFloat(-0, 'float32')).toBe('-0');
	});

	it('handles float16 and bfloat16', () => {
		expect(shortestFloat(halfToNumber(0x2e66), 'float16')).toBe('0.1'); // 0.0999755859375
		expect(shortestFloat(halfToNumber(0x3c00), 'float16')).toBe('1');
		expect(shortestFloat(bfloat16ToNumber(0x3dcd), 'bfloat16')).toBe('0.1'); // 0.10009765625
	});

	it('round-trips random float32 values', () => {
		for (let i = 0; i < 2000; i++) {
			const x = Math.fround((Math.random() - 0.5) * 10 ** (Math.random() * 20 - 10));
			expect(Math.fround(Number(shortestFloat(x, 'float32')))).toBe(x);
		}
	});
});

describe('halfToNumber', () => {
	it('decodes special values', () => {
		expect(halfToNumber(0x7c00)).toBe(Infinity);
		expect(halfToNumber(0xfc00)).toBe(-Infinity);
		expect(halfToNumber(0x7e00)).toBeNaN();
		expect(halfToNumber(0x0001)).toBe(2 ** -24);
		expect(halfToNumber(0xc000)).toBe(-2);
	});
});

describe('jsonScalar', () => {
	it('quotes 64-bit ints and non-finite floats', () => {
		expect(jsonScalar('int64', 5)).toBe('"5"');
		expect(jsonScalar('uint64', 18446744073709551615n)).toBe('"18446744073709551615"');
		expect(jsonScalar('float32', NaN)).toBe('"NaN"');
		expect(jsonScalar('float32', -Infinity)).toBe('"-Infinity"');
		expect(jsonScalar('bool', true)).toBe('true');
		expect(jsonScalar('int32', -7)).toBe('-7');
	});
});
